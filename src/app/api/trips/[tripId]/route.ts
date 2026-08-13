import { z } from 'zod'
import { ok, fail, failFromError, parseBody } from '@/lib/api'
import {
  getTrip,
  updateTrip,
  listTripPois,
  getItinerary,
  tripDayCount,
  markStale,
} from '@/lib/db/trips'
import { getPoisByIds } from '@/lib/db/queries'

/** 行程全貌：一次拿到三个步骤的状态，前端不用打三个请求 */
export async function GET(_req: Request, { params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params
  try {
    const trip = await getTrip(tripId)
    if (!trip) return fail('行程不存在', 404)

    const [tripPois, itinerary] = await Promise.all([listTripPois(tripId), getItinerary(tripId)])
    const hotel = trip.hotelPoiId ? (await getPoisByIds([trip.hotelPoiId]))[0] ?? null : null

    return ok({
      trip,
      days: tripDayCount(trip, tripPois.length),
      pois: tripPois,
      hotel,
      itinerary,
    })
  } catch (err) {
    return failFromError(err)
  }
}

const patchSchema = z.object({
  title: z.string().min(1).max(80).optional(),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  partySize: z.number().int().min(1).max(20).optional(),
  hotelBudgetCents: z.number().int().min(0).nullable().optional(),
  budgetPerNight: z.boolean().optional(),
  preferredBrands: z.array(z.string().max(32)).max(10).optional(),
  hotelPoiId: z.string().uuid().nullable().optional(),
  defaultTravelMode: z.enum(['driving', 'transit', 'walking', 'cycling']).optional(),
  dayStartTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  dayEndTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
})

export async function PATCH(req: Request, { params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params
  const body = await parseBody(req, patchSchema)
  if (!body.ok) return body.response

  try {
    const trip = await getTrip(tripId)
    if (!trip) return fail('行程不存在', 404)

    // 改酒店/日期/时间窗都会让已算出的路线失效
    const invalidates =
      body.data.hotelPoiId !== undefined ||
      body.data.startDate !== undefined ||
      body.data.endDate !== undefined ||
      body.data.defaultTravelMode !== undefined ||
      body.data.dayStartTime !== undefined ||
      body.data.dayEndTime !== undefined

    const updated = await updateTrip(tripId, body.data)
    if (invalidates) {
      await markStale(tripId)
      return ok(await getTrip(tripId))
    }
    return ok(updated)
  } catch (err) {
    return failFromError(err)
  }
}
