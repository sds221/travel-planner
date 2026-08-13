import type {
  HotelProvider,
  HotelResult,
  LatLng,
  MapProvider,
  PriceProvider,
  PriceSource,
} from './types'
import { inferBrand, inferStarRating } from './hotel-pricing'

/**
 * 高德 POI 提供酒店的真实位置/品牌/星级，房价由 PriceProvider 查。
 *
 * 拆成两个数据源是因为它们的可信度完全不同：位置是确定的事实，
 * 价格取决于用哪个 provider（联网搜索 / 模型记忆 / 公式推算），
 * 逐条标在 priceSource 上一路传到 UI。
 */
export class AmapHotelProvider implements HotelProvider {
  readonly name = 'amap-hotel'
  readonly priceSource: PriceSource

  constructor(
    private readonly map: MapProvider,
    private readonly prices: PriceProvider,
  ) {
    this.priceSource = prices.source
  }

  async searchHotels(params: {
    city: string
    center: LatLng
    radiusMeters: number
    brands?: string[]
    minStar?: number
    maxPriceCents?: number
    limit?: number
    checkInDate?: string
  }): Promise<HotelResult[]> {
    const { city, center, radiusMeters, brands, minStar, maxPriceCents, checkInDate } = params
    const limit = params.limit ?? 20

    // 有品牌偏好时按品牌名逐个搜，召回比笼统搜"酒店"精准得多
    const queries = brands && brands.length > 0 ? brands.slice(0, 5) : [undefined]

    // 第一步：拿到候选酒店的位置和属性（不含价格）
    const candidates = new Map<
      string,
      Omit<HotelResult, 'priceSource'> & { brand?: string; starRating?: number }
    >()

    for (const brandQuery of queries) {
      const pois = await this.map.searchPoi({
        city,
        keywords: brandQuery,
        types: '住宿服务',
        around: { center, radiusMeters },
        limit: brandQuery ? 10 : 25,
      })

      for (const p of pois) {
        if (candidates.has(p.externalId)) continue

        const brand = inferBrand(p.name)
        const starRating = inferStarRating(p.name, p.tags)

        // 星级过滤在查价之前做：查价是贵操作，别为被筛掉的店付钱
        if (minStar !== undefined && (starRating ?? 0) < minStar) continue

        candidates.set(p.externalId, { ...p, brand, starRating })
      }
    }

    if (candidates.size === 0) return []

    // 第二步：批量查价。只查会被展示的那些 —— 联网查价按次计费，
    // 对 25 家里注定排不上号的也查一遍纯属浪费。
    const shortlist = [...candidates.values()].slice(0, Math.max(limit, 12))
    const priced = await this.prices.lookup({
      city,
      hotels: shortlist.map((h) => ({
        name: h.name,
        brand: h.brand,
        starRating: h.starRating,
        district: h.district,
      })),
      checkInDate,
    })

    const out: HotelResult[] = []
    for (const h of shortlist) {
      const price = priced.get(h.name)

      // 查不到价的店照样返回：位置信息本身有价值，
      // 让用户看到"这家没查到价"比整条不显示更有用。
      if (
        price &&
        maxPriceCents !== undefined &&
        // 用区间下界过滤：下界都超预算才排除，避免把区间宽的店全砍掉
        price.minCents > maxPriceCents
      ) {
        continue
      }

      out.push({
        ...h,
        priceMinCents: price?.minCents,
        priceMaxCents: price?.maxCents,
        priceSource: price?.source ?? 'formula',
        priceBasis: price?.basis,
        priceCitations: price?.citations,
      })
    }

    return out.slice(0, limit)
  }
}
