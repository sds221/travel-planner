import { z } from 'zod'
import { ok, fail, failFromError, parseBody } from '@/lib/api'
import { getTrip, listTripPois, tripDayCount, centroidOf, updateTrip } from '@/lib/db/trips'
import { recommendHotels } from '@/lib/agent/tasks/recommend-hotels'
import { getPoisByIds } from '@/lib/db/queries'

/**
 * 第二步的 agent 入口。
 *
 * 强制依赖第一步：没选景点就没有搜索中心，"合适位置"无从判断。
 * 直接返回 409 而不是退化成"搜市中心"，因为后者会给出看似合理
 * 但实际很差的推荐，用户不会意识到问题出在没选景点。
 */

const schema = z.object({
  budgetCents: z.number().int().min(0).nullable().optional(),
  budgetPerNight: z.boolean().optional(),
  brands: z.array(z.string().max(32)).max(10).optional(),
  message: z.string().max(500).optional(),
})

export async function POST(req: Request, { params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params
  const body = await parseBody(req, schema)
  if (!body.ok) return body.response

  try {
    const trip = await getTrip(tripId)
    if (!trip) return fail('行程不存在', 404)

    const tripPois = await listTripPois(tripId)
    if (tripPois.length === 0) {
      return fail('请先在第一步选择景点，酒店推荐需要根据景点位置来判断', 409)
    }

    // 预算和品牌偏好在这里落库：用户下次进来不用重填
    const patch: Parameters<typeof updateTrip>[1] = {}
    if (body.data.budgetCents !== undefined) patch.hotelBudgetCents = body.data.budgetCents
    if (body.data.budgetPerNight !== undefined) patch.budgetPerNight = body.data.budgetPerNight
    if (body.data.brands !== undefined) patch.preferredBrands = body.data.brands
    if (Object.keys(patch).length > 0) await updateTrip(tripId, patch)

    const center = centroidOf(tripPois.map((p) => p.poi.location))!
    const days = tripDayCount(trip, tripPois.length)

    const result = await recommendHotels({
      city: trip.city,
      center,
      poiPoints: tripPois.map((p) => ({ id: p.poiId, name: p.poi.name, location: p.poi.location })),
      // n 天行程住 n-1 晚
      nights: Math.max(1, days - 1),
      budgetCents: body.data.budgetCents ?? trip.hotelBudgetCents,
      budgetPerNight: body.data.budgetPerNight ?? trip.budgetPerNight,
      preferredBrands: body.data.brands ?? trip.preferredBrands ?? [],
      // 有出发日期就按那天查价：周末和旺季房价差别很大，
      // 拿平日均价给用户会低估预算
      checkInDate: trip.startDate ?? undefined,
      userMessage: body.data.message,
      tripId,
      userId: trip.userId,
    })

    const ids = result.output.recommendations.map((r) => r.poiId)
    const real = await getPoisByIds(ids)
    const byId = new Map(real.map((p) => [p.id, p]))
    const valid = result.output.recommendations.filter((r) => byId.has(r.poiId))

    return ok({
      runId: result.runId,
      summary: result.output.summary,
      budgetVerdict: result.output.budgetVerdict,
      center,
      nights: Math.max(1, days - 1),
      recommendations: valid.map((r) => {
        const poi = byId.get(r.poiId)!
        // 价格字段以库里的为准而不是用 agent 复述的：模型转述数字时会出错，
        // 而 priceSource/citations 决定了 UI 敢不敢把价格当真，不能让它经手。
        return {
          ...r,
          nightlyCents:
            poi.priceMinCents !== null && poi.priceMaxCents !== null
              ? Math.round((poi.priceMinCents + poi.priceMaxCents) / 2)
              : null,
          brand: poi.brand,
          starRating: poi.starRating,
          address: poi.address,
          location: poi.location,
          priceMinCents: poi.priceMinCents,
          priceMaxCents: poi.priceMaxCents,
          priceSource: poi.priceSource,
          priceCitations: poi.priceCitations,
        }
      }),
    })
  } catch (err) {
    return failFromError(err)
  }
}
