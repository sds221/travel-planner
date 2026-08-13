import type { PriceProvider, PriceInfo } from './types'
import { toCents, describeHotel, matchName } from './price-llm'

/**
 * 带联网搜索的房价查询 —— 火山方舟(豆包) Responses API。
 *
 * 这是唯一能拿到接近实时价格的实现。区别于 price-llm.ts：
 *   price-llm  = 模型记忆里的价格，无来源，不可核实
 *   price-search = 模型现场搜网页拿到的价格，带 URL，用户能自己点开核对
 *
 * 为什么不用 AI SDK：web_search 是方舟 Responses API（/api/v3/responses）
 * 的内置工具，走的不是 chat/completions。AI SDK 的 openai-compatible
 * provider 打的是后者，拿不到这个能力，所以这里直接发 HTTP 请求。
 *
 * 文档：https://www.volcengine.com/docs/82379/1756990
 *
 * 即便如此价格也不是可下单的报价 —— 搜到的是各平台的展示价，
 * 真实房费取决于日期、房型、会员等级。source 标 'search'，
 * UI 仍然提示以订房平台为准。
 */

const ARK_RESPONSES_URL = 'https://ark.cn-beijing.volces.com/api/v3/responses'

/**
 * 账号层面的永久性错误。
 *
 * 联网搜索在方舟是要单独开通的付费插件（不随模型一起给），没开通时
 * 返回 ToolNotOpen。这类错误重试一万次也一样，而每批要等几十秒 ——
 * 一次酒店搜索分好几批就是几分钟的白等。识别出来直接停用这一级。
 */
const PERMANENT_ERROR = /ToolNotOpen|AuthenticationError|InvalidApiKey|AccountOverdue|has not activated/i

function describeDisabled(raw: string): string {
  if (/ToolNotOpen|has not activated/i.test(raw)) {
    return '账号未开通联网搜索（https://console.volcengine.com/common-buy/CC_content_plugin）'
  }
  if (/AccountOverdue/i.test(raw)) return '方舟账号欠费'
  return 'ARK_API_KEY 无效或无权限'
}

/** 让模型只输出这个结构，省掉解析自然语言 */
const OUTPUT_CONTRACT = `严格只输出 JSON，不要 markdown 代码块，不要任何解释文字。格式：
{"hotels":[{"name":"原样复制输入的酒店名","minYuan":数字,"maxYuan":数字,"confidence":"high|medium|low","reasoning":"依据一句话","sourceUrl":"查到价格的网页链接，没有就留空字符串"}]}`

interface ArkOutputItem {
  type: string
  content?: { type: string; text?: string; annotations?: ArkAnnotation[] }[]
}

interface ArkAnnotation {
  type: string
  url?: string
  title?: string
}

interface ArkResponse {
  output?: ArkOutputItem[]
  error?: { message?: string; code?: string }
}

interface ParsedHotel {
  name: string
  minYuan: number
  maxYuan: number
  confidence: string
  reasoning: string
  sourceUrl?: string
}

/**
 * 从模型回复里抠出 JSON。
 * 即便要求了纯 JSON，模型仍可能包一层 ```json 或者前面加一句话，
 * 所以取第一个 { 到最后一个 } 之间的内容。
 */
export function extractJson(text: string): unknown | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1))
  } catch {
    return null
  }
}

/** 把方舟的 output 数组摊平成文本 + 引用来源 */
export function flattenArkOutput(body: ArkResponse): {
  text: string
  citations: { title: string; url: string }[]
} {
  let text = ''
  const citations: { title: string; url: string }[] = []
  const seen = new Set<string>()

  for (const item of body.output ?? []) {
    // 只取 message 的文本。豆包的 reasoning 模型会额外返回 type='reasoning'
    // 的条目（思考过程），把它拼进来会污染要解析的 JSON。
    if (item.type && item.type !== 'message') continue

    for (const part of item.content ?? []) {
      if (part.text) text += part.text
      for (const ann of part.annotations ?? []) {
        // web_search 的引用以 annotation 形式回来
        if (ann.url && !seen.has(ann.url)) {
          seen.add(ann.url)
          citations.push({ title: ann.title ?? ann.url, url: ann.url })
        }
      }
    }
  }

  return { text, citations }
}

export class ArkSearchPriceProvider implements PriceProvider {
  readonly name = 'ark-search-price'
  readonly source = 'search' as const

  /** 非 null 表示这一级已永久停用，值是原因 */
  private disabled: string | null = null

  constructor(
    private readonly apiKey: string,
    /** 方舟的推理接入点 ID 或模型名 */
    private readonly model: string,
    private readonly fetchImpl: typeof fetch = fetch,
    /** 联网搜索比纯推理慢得多，批次要小 */
    private readonly batchSize = 6,
  ) {
    if (!apiKey) throw new Error('ARK_API_KEY 未配置')
  }

  /** 供上层在 UI 上解释"为什么没有联网查价" */
  get unavailableReason(): string | null {
    return this.disabled
  }

  async lookup(params: {
    city: string
    hotels: { name: string; brand?: string; starRating?: number; district?: string }[]
    checkInDate?: string
    nights?: number
  }): Promise<Map<string, PriceInfo>> {
    const out = new Map<string, PriceInfo>()
    if (params.hotels.length === 0) return out

    for (let i = 0; i < params.hotels.length; i += this.batchSize) {
      // 已知不可用就别再发请求了 —— 每批要等几十秒
      if (this.disabled) break

      const batch = params.hotels.slice(i, i + this.batchSize)
      try {
        for (const [k, v] of await this.askBatch(params, batch)) out.set(k, v)
      } catch {
        // 单批失败（限流/超时）不影响其它批，缺的项由上层降级
      }
    }
    return out
  }

  private async askBatch(
    params: { city: string; checkInDate?: string; nights?: number },
    batch: { name: string; brand?: string; starRating?: number; district?: string }[],
  ): Promise<Map<string, PriceInfo>> {
    const prompt = [
      `搜索以下${params.city}酒店当前的每晚房价（标准间/大床房）：`,
      ...batch.map((h, i) => `${i + 1}. ${describeHotel(h)}`),
      '',
      params.checkInDate
        ? `入住日期：${params.checkInDate}${params.nights ? `，住 ${params.nights} 晚` : ''}`
        : '按近期平日价格查询',
      '',
      '用联网搜索查各订房平台的实际报价，不要凭记忆估算。',
      OUTPUT_CONTRACT,
    ].join('\n')

    const res = await this.fetchImpl(ARK_RESPONSES_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: this.model,
        input: prompt,
        // 方舟内置的联网搜索工具，可以和自定义 function 并存
        tools: [{ type: 'web_search' }],
        stream: false,
      }),
      signal: AbortSignal.timeout(90_000),
    })

    // 有些错误（没开通联网搜索、key 无效）在账号层面是永久的，
    // 逐批重试只是白等。识别出来后标记 disabled，后续批次直接跳过。
    const bodyText = await res.text()
    if (!res.ok) {
      if (PERMANENT_ERROR.test(bodyText)) {
        this.disabled = describeDisabled(bodyText)
        throw new Error(`方舟联网查价不可用：${this.disabled}`)
      }
      throw new Error(`方舟查价失败 HTTP ${res.status}: ${bodyText.slice(0, 200)}`)
    }

    const body = JSON.parse(bodyText) as ArkResponse
    if (body.error) {
      const msg = body.error.message ?? body.error.code ?? 'unknown'
      if (PERMANENT_ERROR.test(bodyText)) this.disabled = describeDisabled(bodyText)
      throw new Error(`方舟查价失败: ${msg}`)
    }

    const { text, citations } = flattenArkOutput(body)
    const parsed = extractJson(text) as { hotels?: ParsedHotel[] } | null
    if (!parsed?.hotels) throw new Error('方舟返回的内容里没有可解析的 JSON')

    const out = new Map<string, PriceInfo>()
    const asOf = new Date().toISOString().slice(0, 10)

    for (const item of parsed.hotels) {
      if (typeof item?.name !== 'string') continue
      const matched = matchName(item.name, batch)
      if (!matched) continue

      const minCents = toCents(Math.min(item.minYuan, item.maxYuan))
      const maxCents = toCents(Math.max(item.minYuan, item.maxYuan))
      if (minCents === null || maxCents === null) continue

      // 这家店自己的来源链接优先，没有就带上整批的搜索引用
      const own = item.sourceUrl
        ? [{ title: '价格来源', url: item.sourceUrl }]
        : citations.slice(0, 3)

      out.set(matched, {
        minCents,
        maxCents,
        source: 'search',
        basis: [`联网搜索(${item.confidence ?? 'medium'})`, item.reasoning ?? ''].filter(Boolean),
        citations: own,
        asOf,
      })
    }

    return out
  }
}
