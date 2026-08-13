import { z } from 'zod'
import { ok, failFromError, parseBody } from '@/lib/api'
import { createTrip, listTrips, ensureDemoUser } from '@/lib/db/trips'
import { normalizeCity } from '@/lib/city'

const createSchema = z.object({
  title: z.string().min(1).max(80),
  // 归一化后入库："成都市" 和 "成都" 必须存成同一个值，
  // 否则和高德返回的 POI 对不上（见 lib/city.ts）
  city: z
    .string()
    .min(1)
    .max(32)
    .transform((v) => normalizeCity(v)),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  partySize: z.number().int().min(1).max(20).optional(),
})

export async function GET() {
  try {
    const userId = await ensureDemoUser()
    return ok(await listTrips(userId))
  } catch (err) {
    return failFromError(err)
  }
}

export async function POST(req: Request) {
  const body = await parseBody(req, createSchema)
  if (!body.ok) return body.response
  try {
    const userId = await ensureDemoUser()
    const trip = await createTrip({ userId, ...body.data })
    return ok(trip, 201)
  } catch (err) {
    return failFromError(err)
  }
}
