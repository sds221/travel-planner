import type { PriceProvider, PriceInfo } from './types'
import { estimateNightlyPrice } from './hotel-pricing'

/**
 * 公式估价 —— 兜底实现，不需要任何外部服务。
 *
 * 保留它的理由：LLM 查价会失败（限流、超时、没配 key），而酒店列表
 * 不该因为查不到价格就整个空掉。位置信息本身是有价值的，价格标成
 * "粗估"照样能让用户比较档位。
 *
 * 准确度排序：ota > search > llm > formula。这是最后一档。
 */
export class FormulaPriceProvider implements PriceProvider {
  readonly name = 'formula'
  readonly source = 'formula' as const

  async lookup(params: {
    city: string
    hotels: { name: string; brand?: string; starRating?: number }[]
  }): Promise<Map<string, PriceInfo>> {
    const out = new Map<string, PriceInfo>()
    for (const h of params.hotels) {
      const est = estimateNightlyPrice({
        name: h.name,
        city: params.city,
        brand: h.brand,
        starRating: h.starRating,
      })
      out.set(h.name, {
        minCents: est.minCents,
        maxCents: est.maxCents,
        source: 'formula',
        basis: est.basis,
      })
    }
    return out
  }
}
