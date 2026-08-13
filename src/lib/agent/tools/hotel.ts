import { tool } from 'ai'
import { z } from 'zod'
import { getHotelProvider, getMapProvider } from '../../providers'
import { findHotelsNear, upsertPois } from '../../db/queries'
import { budgetFitScore } from '../../providers/hotel-pricing'
import { haversine } from '../../providers/amap'
import type { LatLng } from '../../providers/types'

/**
 * 第二步（选酒店）的工具集。
 *
 * "合适位置"的定义：到已选景点集合的加权平均通勤距离最短。用重心搜索
 * 再按到各景点的实际距离打分，比单纯"离市中心近"准得多 —— 用户去迪士尼
 * 和外滩，最优住处未必在人民广场。
 *
 * 价格是估算的（见 hotel-pricing.ts）。工具返回里带 priceEstimated，
 * prompt 里也会强调，避免 agent 对用户断言房价。
 */

/** 价格来源的可信度排序，用于判断本地缓存是否该被更好的来源替换 */
const SOURCE_RANK: Record<string, number> = { formula: 0, llm: 1, search: 2, ota: 3 }

/** 房价的保鲜期。超过这个时间就算来源够好也重查 */
const PRICE_MAX_AGE_MS = 24 * 3600 * 1000

/**
 * 判断是否需要重新查价。两种情况：
 *   1. 库里的价格来源比当前 provider 能提供的差（之前没配联网查价）；
 *   2. 价格太旧了。
 */
export function needsPriceRefresh(
  rows: { priceSource: string; priceMinCents: number | null; priceUpdatedAt: Date | null }[],
  best: string,
  now = Date.now(),
): boolean {
  const bestRank = SOURCE_RANK[best] ?? 0
  return rows.some((r) => {
    if (r.priceMinCents === null) return true
    if ((SOURCE_RANK[r.priceSource] ?? 0) < bestRank) return true
    // formula 是纯函数算出来的，不会过期，没必要因为时间重查
    if (r.priceSource === 'formula') return false
    const age = r.priceUpdatedAt ? now - new Date(r.priceUpdatedAt).getTime() : Infinity
    return age > PRICE_MAX_AGE_MS
  })
}

/** 按这批结果里实际出现的价格来源，给 agent 一句准确的可信度说明 */
function priceNoteFor(sources: string[]): string {
  const kinds = new Set(sources)
  const parts: string[] = []

  if (kinds.has('search')) {
    parts.push('标注 search 的价格是联网搜索订房平台得到的，可以向用户复述，但要说明会随日期房型浮动')
  }
  if (kinds.has('llm')) {
    parts.push('标注 llm 的价格来自模型对市场行情的判断，没有实时来源，只能说"大概什么价位"')
  }
  if (kinds.has('formula')) {
    parts.push('标注 formula 的价格是按星级品牌推算的粗估，只能用于比较档位，不可当报价')
  }
  if (kinds.has('ota')) {
    parts.push('标注 ota 的价格来自订房平台接口，是可下单价格')
  }
  if (parts.length === 0) return '这批结果没有价格数据，只能按位置和星级推荐'

  return parts.join('；') + '。价格为空的酒店表示没查到，不要编造。'
}

export function makeHotelTools(params: {
  city: string
  /** 已选景点的坐标，用于打分 */
  poiPoints: { id: string; name: string; location: LatLng }[]
  center: LatLng
  /** 入住日期，传给查价用于区分平日/周末/旺季 */
  checkInDate?: string
}) {
  const { city, poiPoints, center, checkInDate } = params

  return {
    searchHotels: tool({
      description:
        '在已选景点的地理重心附近搜索酒店，按预算、品牌、星级过滤。' +
        '每条结果带 priceSource 说明价格来自联网搜索(search)、行情判断(llm) ' +
        '还是系数推算(formula)，写文案时必须按对应口径。',
      inputSchema: z.object({
        radiusMeters: z
          .number()
          .int()
          .min(500)
          .max(20000)
          .default(4000)
          .describe('搜索半径。景点分散时应放大'),
        maxPriceCents: z
          .number()
          .int()
          .optional()
          .describe('每晚预算上限（分）。1 元 = 100 分'),
        brands: z.array(z.string()).optional().describe('用户偏好的品牌名，如 ["全季","亚朵"]'),
        minStar: z.number().int().min(1).max(5).optional(),
        limit: z.number().int().min(1).max(20).default(10),
      }),
      execute: async ({ radiusMeters, maxPriceCents, brands, minStar, limit }) => {
        const query = { city, center, radiusMeters, maxPriceCents, brands, minStar }

        // 本地库先查一遍：同城搜过的酒店不必再打高德
        let rows = await findHotelsNear({ ...query, limit: limit * 2 })

        // 除了"数量不够"，价格陈旧也要重搜。
        // 老数据可能是上次没配联网查价时存的 formula 粗估，
        // 或者存了很久房价已经变了 —— 两种情况都该刷新，
        // 否则本地缓存会永久压住更好的价格来源。
        const provider = await getHotelProvider()
        if (rows.length < limit || needsPriceRefresh(rows, provider.priceSource)) {
          const found = await provider.searchHotels({ ...query, limit: 25, checkInDate })
          await upsertPois(found, { kind: 'hotel', source: 'amap' })
          rows = await findHotelsNear({ ...query, limit: limit * 2 })
        }

        const scored = rows.map((h) => {
          // 到每个景点的直线距离：均值决定通勤成本，最大值暴露"有个点特别远"
          const dists = poiPoints.map((p) => haversine(h.location, p.location))
          const avg = dists.length > 0 ? dists.reduce((a, b) => a + b, 0) / dists.length : 0
          const worst = dists.length > 0 ? Math.max(...dists) : 0

          const priceMid =
            h.priceMinCents !== null && h.priceMaxCents !== null
              ? (h.priceMinCents + h.priceMaxCents) / 2
              : null

          const fit =
            maxPriceCents && h.priceMinCents !== null && h.priceMaxCents !== null
              ? budgetFitScore(
                  { minCents: h.priceMinCents, maxCents: h.priceMaxCents },
                  maxPriceCents,
                )
              : 0.5

          // 位置分：平均 2km 内接近满分，8km 以上基本不可接受
          const locationScore = Math.max(0, 1 - Math.max(0, avg - 2000) / 6000)
          const brandBonus = brands && h.brand && brands.includes(h.brand) ? 0.1 : 0
          const starScore = h.starRating ? Math.min(1, h.starRating / 5) : 0.5

          return {
            id: h.id,
            name: h.name,
            brand: h.brand,
            starRating: h.starRating,
            address: h.address,
            lng: h.location.lng,
            lat: h.location.lat,
            priceMinCents: h.priceMinCents,
            priceMaxCents: h.priceMaxCents,
            priceSource: h.priceSource,
            priceBasis: h.priceBasis ?? [],
            avgDistanceToPoisMeters: Math.round(avg),
            worstDistanceToPoiMeters: Math.round(worst),
            distanceToCenterMeters: Math.round(h.distanceMeters),
            score:
              Number((locationScore * 0.45 + fit * 0.35 + starScore * 0.2 + brandBonus).toFixed(4)),
            priceMidCents: priceMid,
          }
        })

        scored.sort((a, b) => b.score - a.score)
        const top = scored.slice(0, limit)

        return {
          center,
          // 按来源分别说明可信度：search 的价格查过网页可以复述，
          // formula 的只是量级估计，不能当报价说。混在一起讲会让
          // agent 要么对估价过度自信，要么对查到的真价格过度保守。
          priceNote: priceNoteFor(top.map((h) => h.priceSource)),
          hotels: top,
        }
      },
    }),

    /**
     * 让 agent 能验证"这家酒店到景点到底多久"。直线距离在有江/山阻隔的
     * 城市会严重低估，真实通勤时间才是用户体感。
     */
    checkCommute: tool({
      description: '查某个酒店到已选景点的真实通勤时间，用于验证位置是否合适。',
      inputSchema: z.object({
        hotelLng: z.number(),
        hotelLat: z.number(),
        mode: z.enum(['driving', 'transit', 'walking', 'cycling']).default('transit'),
      }),
      execute: async ({ hotelLng, hotelLat, mode }) => {
        if (poiPoints.length === 0) return { legs: [] }
        const map = await getMapProvider()
        try {
          const m = await map.distanceMatrix({
            origins: [{ lng: hotelLng, lat: hotelLat }],
            destinations: poiPoints.map((p) => p.location),
            mode,
            city,
          })
          const minutes = m.durationSeconds[0] ?? []
          const meters = m.distanceMeters[0] ?? []
          return {
            mode,
            legs: poiPoints.map((p, i) => ({
              poiName: p.name,
              minutes: Math.round((minutes[i] ?? 0) / 60),
              meters: Math.round(meters[i] ?? 0),
            })),
          }
        } catch (err) {
          return { error: err instanceof Error ? err.message : '通勤查询失败', legs: [] }
        }
      },
    }),
  }
}
