import { generateObject, type LanguageModel } from 'ai'
import { z } from 'zod'
import type { PriceProvider, PriceInfo } from './types'

/**
 * 用大模型查房价。
 *
 * ⚠️ 关于"实时"这件事必须说清楚：DeepSeek 的 API 没有联网能力（联网只在
 * 网页版/App），所以这个 provider 拿到的是模型训练数据里的记忆价格，
 * 不是实时挂牌价。它比 price-formula 的系数表强在懂品牌调性和商圈差异
 * （知道"外滩的全季比郊区的全季贵"），但同样无法核实，source 标为 'llm'。
 *
 * 要真正的实时价格用 price-search.ts（火山方舟/豆包带 web_search）。
 *
 * 这里刻意用 generateObject 而不是走 ReAct：查价是一次性的结构化提取，
 * 没有多步推理，套 agent 循环只是白烧 token。
 */

const priceSchema = z.object({
  hotels: z.array(
    z.object({
      name: z.string().describe('必须和输入的酒店名完全一致，用于对应结果'),
      /** 用元而不是分：模型对"分"这个单位容易搞错两个数量级 */
      minYuan: z.number().describe('每晚最低价（元），标准间/大床房'),
      maxYuan: z.number().describe('每晚最高价（元）'),
      confidence: z.enum(['high', 'medium', 'low']).describe('对这个价位的确信程度'),
      reasoning: z.string().describe('一句话说明依据，如"该品牌在此商圈的常见价位"'),
    }),
  ),
})

/** 元 → 分，并做合理性检查 */
export function toCents(yuan: number): number | null {
  if (!Number.isFinite(yuan) || yuan <= 0) return null
  // 国内酒店单晚 30 元以下或 20 万元以上基本可以判定模型输错了单位
  if (yuan < 30 || yuan > 200_000) return null
  return Math.round(yuan * 100)
}

/** 把酒店的已知信息拼成一行，给模型定位这家店 */
export function describeHotel(h: {
  name: string
  brand?: string
  starRating?: number
  district?: string
}): string {
  const attrs = [
    h.brand ? `品牌:${h.brand}` : null,
    h.starRating ? `${h.starRating}星` : null,
    h.district,
  ].filter((x): x is string => !!x)
  return attrs.length > 0 ? `${h.name}（${attrs.join(' / ')}）` : h.name
}

/** 模型偶尔改写酒店名，宽松匹配回输入项 */
export function matchName(returned: string, batch: { name: string }[]): string | null {
  const exact = batch.find((h) => h.name === returned)
  if (exact) return exact.name
  const fuzzy = batch.find((h) => h.name.includes(returned) || returned.includes(h.name))
  return fuzzy?.name ?? null
}

export class LlmPriceProvider implements PriceProvider {
  readonly name: string
  readonly source = 'llm' as const

  constructor(
    private readonly model: LanguageModel,
    /** 一次问多少家。太多会让模型敷衍，太少浪费往返 */
    private readonly batchSize = 12,
  ) {
    this.name = 'llm-price'
  }

  async lookup(params: {
    city: string
    hotels: { name: string; brand?: string; starRating?: number; district?: string }[]
    checkInDate?: string
    nights?: number
  }): Promise<Map<string, PriceInfo>> {
    const out = new Map<string, PriceInfo>()
    if (params.hotels.length === 0) return out

    // 分批：一次问几十家时模型会开始复制粘贴同一个价位
    for (let i = 0; i < params.hotels.length; i += this.batchSize) {
      const batch = params.hotels.slice(i, i + this.batchSize)
      try {
        const filled = await this.askBatch(params, batch)
        for (const [k, v] of filled) out.set(k, v)
      } catch {
        // 某一批失败不影响其它批。缺失的项由上层退回公式估价。
      }
    }

    return out
  }

  private async askBatch(
    params: { city: string; checkInDate?: string; nights?: number },
    batch: { name: string; brand?: string; starRating?: number; district?: string }[],
  ): Promise<Map<string, PriceInfo>> {
    const listing = batch.map((h, idx) => `${idx + 1}. ${describeHotel(h)}`).join('\n')

    const result = await generateObject({
      model: this.model,
      schema: priceSchema,
      system:
        '你是熟悉中国酒店市场行情的分析师。给出的价格要贴合该品牌在该城市该商圈的实际水平，' +
        '不要所有酒店都给同一个价位区间。不确定的标 confidence: low，不要编造精确数字。',
      prompt: [
        `城市：${params.city}`,
        params.checkInDate ? `入住日期：${params.checkInDate}` : '入住日期：未指定，按平日均价',
        params.nights ? `住 ${params.nights} 晚` : null,
        '',
        '请给出以下酒店的每晚房价区间（标准间/大床房，含税不含早）：',
        listing,
        '',
        'name 字段必须原样复制上面的酒店名，不要改写或补全。',
      ]
        .filter((x) => x !== null)
        .join('\n'),
      // 查价不需要发散
      temperature: 0.2,
      abortSignal: AbortSignal.timeout(45_000),
    })

    const out = new Map<string, PriceInfo>()

    for (const item of result.object.hotels) {
      const matched = matchName(item.name, batch)
      if (!matched) continue

      // 模型有时把 min/max 写反
      const minCents = toCents(Math.min(item.minYuan, item.maxYuan))
      const maxCents = toCents(Math.max(item.minYuan, item.maxYuan))
      if (minCents === null || maxCents === null) continue

      out.set(matched, {
        minCents,
        maxCents,
        source: 'llm',
        basis: [`模型判断(${item.confidence})`, item.reasoning],
      })
    }

    return out
  }
}
