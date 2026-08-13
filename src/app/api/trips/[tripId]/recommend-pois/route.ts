import { z } from 'zod'
import { okAs, fail, failFromError, parseBody } from '@/lib/api'
import type { RecommendPoisData } from '@/types/api'
import { getTrip, listTripPois, tripDayCount } from '@/lib/db/trips'
import { recommendPois } from '@/lib/agent/tasks/recommend-pois'
import { getPoisByIds } from '@/lib/db/queries'

/**
 * 第一步的 agent 入口：根据自然语言需求推荐景点。
 *
 * 只推荐，不落到 trip_pois —— 用户勾选后走 POST /pois 才算选中。
 * 这样 agent 的推荐是可以被拒绝的，不会污染用户的选择。
 */

const schema = z.object({
  message: z.string().max(500).default(''),
})

export async function POST(req: Request, { params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params
  const body = await parseBody(req, schema)
  if (!body.ok) return body.response

  try {
    const trip = await getTrip(tripId)
    if (!trip) return fail('行程不存在', 404)

    const existing = await listTripPois(tripId)
    const result = await recommendPois({
      city: trip.city,
      days: tripDayCount(trip, existing.length),
      partySize: trip.partySize,
      userMessage: body.data.message,
      existingNames: existing.map((e) => e.poi.name),
      tripId,
      userId: trip.userId,
    })

    // agent 可能引用了不存在的 id（幻觉）。这里做一次校验后再回前端，
    // 否则用户勾选时才报错，体验更差。
    const ids = result.output.recommendations.map((r) => r.poiId)
    const real = await getPoisByIds(ids)
    const realIds = new Set(real.map((p) => p.id))
    const byId = new Map(real.map((p) => [p.id, p]))

    const valid = result.output.recommendations.filter((r) => realIds.has(r.poiId))
    const hallucinated = result.output.recommendations.length - valid.length

    return okAs<RecommendPoisData>({
      runId: result.runId,
      summary: result.output.summary,
      unresolved: result.output.unresolved,
      recommendations: valid.map((r) => {
        const poi = byId.get(r.poiId)!
        return {
          ...r,
          district: poi.district,
          address: poi.address,
          rating: poi.rating,
          tags: poi.tags ?? [],
          location: poi.location,
          alreadySelected: existing.some((e) => e.poiId === r.poiId),
        }
      }),
      ...(hallucinated > 0 ? { note: `已过滤 ${hallucinated} 条无效推荐` } : {}),
    })
  } catch (err) {
    return failFromError(err)
  }
}
