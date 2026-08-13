import { z } from 'zod'
import { ok, fail, failFromError, parseBody } from '@/lib/api'
import {
  getTrip,
  listTripPois,
  addTripPois,
  removeTripPoi,
  updateTripPoi,
  updateTrip,
} from '@/lib/db/trips'
import { getPoisByIds, upsertUserPoi, upsertPois } from '@/lib/db/queries'
import { getMapProvider } from '@/lib/providers'

/** 第一步的产出：已选景点列表 */
export async function GET(_req: Request, { params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params
  try {
    return ok(await listTripPois(tripId))
  } catch (err) {
    return failFromError(err)
  }
}

/**
 * 有景点了就可以进入第二步。
 * 两个分支（勾选推荐 / 自定义输入）都要走，自定义那条会提前 return，
 * 所以抽出来而不是放在函数末尾 —— 之前漏掉过一次。
 */
async function advanceToHotelStep(current: string, tripId: string): Promise<void> {
  if (current === 'draft_pois') {
    await updateTrip(tripId, { status: 'draft_hotel' })
  }
}

const addSchema = z.union([
  // 从推荐列表里勾选：已经有 id
  z.object({
    mode: z.literal('existing'),
    poiIds: z.array(z.string().uuid()).min(1).max(30),
    priority: z.number().int().min(1).max(5).optional(),
  }),
  // 用户自己补充：只有名字，需要先解析坐标
  z.object({
    mode: z.literal('custom'),
    name: z.string().min(1).max(60),
    priority: z.number().int().min(1).max(5).optional(),
    dwellMinutes: z.number().int().min(15).max(600).optional(),
  }),
])

export async function POST(req: Request, { params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params
  const body = await parseBody(req, addSchema)
  if (!body.ok) return body.response

  try {
    const trip = await getTrip(tripId)
    if (!trip) return fail('行程不存在', 404)

    if (body.data.mode === 'existing') {
      const found = await getPoisByIds(body.data.poiIds)
      if (found.length !== body.data.poiIds.length) {
        return fail('部分景点 id 不存在，可能是推荐结果已过期，请重新推荐')
      }
      await addTripPois(
        tripId,
        found.map((p) => ({
          poiId: p.id,
          addedBy: p.source,
          priority: body.data.mode === 'existing' ? body.data.priority : undefined,
        })),
      )
    } else {
      // 自定义输入：先走高德解析。解析不出来就明确拒绝，不存一个没坐标的点 ——
      // 没坐标进不了距离矩阵，会在第三步以更难懂的方式失败。
      const map = await getMapProvider()
      const candidates = await map.geocode({ city: trip.city, address: body.data.name })
      if (candidates.length === 0) {
        return fail(`在${trip.city}没找到"${body.data.name}"，换个更完整的名称试试`, 404)
      }

      const first = candidates[0]!
      const isGeocodeOnly = first.externalId.startsWith('geo:')
      const saved = isGeocodeOnly
        ? await upsertUserPoi({
            name: body.data.name,
            city: trip.city,
            location: first.location,
            address: first.address,
            dwellMinutes: body.data.dwellMinutes ?? first.dwellMinutes,
          })
        : (await upsertPois([first], { kind: 'attraction', source: 'amap' }))[0]!

      await addTripPois(tripId, [
        { poiId: saved.id, addedBy: saved.source, priority: body.data.priority },
      ])
      await advanceToHotelStep(trip.status, tripId)

      // 多个候选时把其余的回给前端，让用户确认选错了可以改
      return ok({
        added: saved,
        otherCandidates: candidates.slice(1, 4).map((c) => ({
          name: c.name,
          address: c.address ?? null,
          district: c.district ?? null,
        })),
      })
    }

    await advanceToHotelStep(trip.status, tripId)
    return ok(await listTripPois(tripId))
  } catch (err) {
    return failFromError(err)
  }
}

const patchSchema = z.object({
  poiId: z.string().uuid(),
  priority: z.number().int().min(1).max(5).optional(),
  pinnedDayIndex: z.number().int().min(0).max(13).nullable().optional(),
  dwellMinutesOverride: z.number().int().min(15).max(600).nullable().optional(),
  note: z.string().max(200).optional(),
})

export async function PATCH(req: Request, { params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params
  const body = await parseBody(req, patchSchema)
  if (!body.ok) return body.response
  try {
    const { poiId, ...patch } = body.data
    await updateTripPoi(tripId, poiId, patch)
    return ok(await listTripPois(tripId))
  } catch (err) {
    return failFromError(err)
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params
  const poiId = new URL(req.url).searchParams.get('poiId')
  if (!poiId) return fail('缺少 poiId')
  try {
    await removeTripPoi(tripId, poiId)
    return ok(await listTripPois(tripId))
  } catch (err) {
    return failFromError(err)
  }
}
