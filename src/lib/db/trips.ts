import { and, eq, asc, sql, inArray } from 'drizzle-orm'
import { getDb, schema } from './index'
import { getPoisByIds, type PoiRow } from './queries'
import type { LatLng } from '../providers/types'

export type TripStatus = (typeof schema.tripStatusEnum.enumValues)[number]
export type TravelMode = (typeof schema.travelModeEnum.enumValues)[number]

export interface TripRow {
  id: string
  userId: string
  title: string
  city: string
  status: TripStatus
  startDate: string | null
  endDate: string | null
  partySize: number
  hotelBudgetCents: number | null
  budgetPerNight: boolean
  preferredBrands: string[] | null
  hotelPoiId: string | null
  defaultTravelMode: TravelMode
  dayStartTime: string
  dayEndTime: string
  routeSummary: {
    totalDistanceMeters: number
    totalTravelMinutes: number
    unassignedPoiIds: string[]
    solvedAt: string
    solver: string
  } | null
}

export async function createTrip(input: {
  userId: string
  title: string
  city: string
  startDate?: string
  endDate?: string
  partySize?: number
}): Promise<TripRow> {
  const rows = await getDb()
    .insert(schema.trips)
    .values({
      userId: input.userId,
      title: input.title,
      city: input.city,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      partySize: input.partySize ?? 2,
    })
    .returning()
  return rows[0] as TripRow
}

export async function getTrip(tripId: string): Promise<TripRow | null> {
  const rows = await getDb().select().from(schema.trips).where(eq(schema.trips.id, tripId)).limit(1)
  return (rows[0] as TripRow | undefined) ?? null
}

export async function listTrips(userId: string): Promise<TripRow[]> {
  return (await getDb()
    .select()
    .from(schema.trips)
    .where(eq(schema.trips.userId, userId))
    .orderBy(sql`${schema.trips.updatedAt} DESC`)
    .limit(50)) as TripRow[]
}

/** 行程天数。没填日期时按已选景点数兜底（约每天 3 个点） */
export function tripDayCount(trip: TripRow, poiCount = 0): number {
  if (trip.startDate && trip.endDate) {
    const start = Date.parse(`${trip.startDate}T00:00:00Z`)
    const end = Date.parse(`${trip.endDate}T00:00:00Z`)
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      return Math.floor((end - start) / 86400000) + 1
    }
  }
  return Math.max(1, Math.ceil(poiCount / 3))
}

// ── 状态机 ────────────────────────────────────────────────────────────

/**
 * 三个步骤耦合在同一个 trip 上：改景点会让酒店推荐失去依据，
 * 改酒店会让每天的起终点变化。所以任何上游变更都要把已算出的
 * 路线标记为 stale，而不是留着一份和输入不一致的行程图。
 */
export async function markStale(tripId: string): Promise<void> {
  await getDb()
    .update(schema.trips)
    .set({ status: 'stale', updatedAt: new Date() })
    .where(and(eq(schema.trips.id, tripId), inArray(schema.trips.status, ['planned', 'routing'])))
}

export async function updateTripStatus(tripId: string, status: TripStatus): Promise<void> {
  await getDb()
    .update(schema.trips)
    .set({ status, updatedAt: new Date() })
    .where(eq(schema.trips.id, tripId))
}

export async function updateTrip(
  tripId: string,
  patch: Partial<{
    title: string
    startDate: string | null
    endDate: string | null
    partySize: number
    hotelBudgetCents: number | null
    budgetPerNight: boolean
    preferredBrands: string[]
    hotelPoiId: string | null
    defaultTravelMode: TravelMode
    dayStartTime: string
    dayEndTime: string
    status: TripStatus
  }>,
): Promise<TripRow | null> {
  const rows = await getDb()
    .update(schema.trips)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.trips.id, tripId))
    .returning()
  return (rows[0] as TripRow | undefined) ?? null
}

// ── 第一步：选景点 ────────────────────────────────────────────────────

export interface TripPoiRow {
  poiId: string
  priority: number
  pinnedDayIndex: number | null
  dwellMinutesOverride: number | null
  addedBy: PoiRow['source']
  note: string | null
  poi: PoiRow
}

export async function listTripPois(tripId: string): Promise<TripPoiRow[]> {
  const links = await getDb()
    .select()
    .from(schema.tripPois)
    .where(eq(schema.tripPois.tripId, tripId))
    .orderBy(asc(schema.tripPois.createdAt))

  if (links.length === 0) return []
  const pois = await getPoisByIds(links.map((l) => l.poiId))
  const byId = new Map(pois.map((p) => [p.id, p]))

  return links
    .map((l) => {
      const poi = byId.get(l.poiId)
      if (!poi) return null
      return {
        poiId: l.poiId,
        priority: l.priority,
        pinnedDayIndex: l.pinnedDayIndex,
        dwellMinutesOverride: l.dwellMinutesOverride,
        addedBy: l.addedBy,
        note: l.note,
        poi,
      }
    })
    .filter((x): x is TripPoiRow => x !== null)
}

export async function addTripPois(
  tripId: string,
  items: { poiId: string; addedBy: PoiRow['source']; priority?: number; note?: string }[],
): Promise<void> {
  if (items.length === 0) return
  await getDb()
    .insert(schema.tripPois)
    .values(
      items.map((i) => ({
        tripId,
        poiId: i.poiId,
        addedBy: i.addedBy,
        priority: i.priority ?? 3,
        note: i.note ?? null,
      })),
    )
    .onConflictDoNothing({ target: [schema.tripPois.tripId, schema.tripPois.poiId] })
  await markStale(tripId)
}

export async function removeTripPoi(tripId: string, poiId: string): Promise<void> {
  await getDb()
    .delete(schema.tripPois)
    .where(and(eq(schema.tripPois.tripId, tripId), eq(schema.tripPois.poiId, poiId)))
  await markStale(tripId)
}

export async function updateTripPoi(
  tripId: string,
  poiId: string,
  patch: Partial<{ priority: number; pinnedDayIndex: number | null; dwellMinutesOverride: number | null; note: string }>,
): Promise<void> {
  await getDb()
    .update(schema.tripPois)
    .set(patch)
    .where(and(eq(schema.tripPois.tripId, tripId), eq(schema.tripPois.poiId, poiId)))
  await markStale(tripId)
}

/** 已选景点的地理重心 —— 第二步酒店搜索的中心点 */
export function centroidOf(points: LatLng[]): LatLng | null {
  if (points.length === 0) return null
  const lng = points.reduce((s, p) => s + p.lng, 0) / points.length
  const lat = points.reduce((s, p) => s + p.lat, 0) / points.length
  return { lng, lat }
}

// ── 第三步：行程明细 ──────────────────────────────────────────────────

export interface ItemInput {
  seq: number
  kind: (typeof schema.itemKindEnum.enumValues)[number]
  poiId?: string | null
  arriveAt?: string | null
  departAt?: string | null
  legMode?: TravelMode | null
  legDistanceMeters?: number | null
  legMinutes?: number | null
  legPolyline?: [number, number][] | null
  note?: string | null
}

export interface DayInput {
  dayIndex: number
  date?: string | null
  theme?: string | null
  tip?: string | null
  distanceMeters?: number | null
  travelMinutes?: number | null
  items: ItemInput[]
}

/**
 * 整体替换行程明细。用事务是因为中途失败会留下"有天没条目"的半成品，
 * 前端拿到这种数据画出来的图是错的，比没有图更糟。
 */
export async function replaceItinerary(
  tripId: string,
  days: DayInput[],
  summary: TripRow['routeSummary'],
): Promise<void> {
  const db = getDb()
  await db.transaction(async (tx) => {
    // trip_items 通过 trip_day_id 级联删除
    await tx.delete(schema.tripDays).where(eq(schema.tripDays.tripId, tripId))

    for (const day of days) {
      const inserted = await tx
        .insert(schema.tripDays)
        .values({
          tripId,
          dayIndex: day.dayIndex,
          date: day.date ?? null,
          theme: day.theme ?? null,
          tip: day.tip ?? null,
          distanceMeters: day.distanceMeters ?? null,
          travelMinutes: day.travelMinutes ?? null,
        })
        .returning({ id: schema.tripDays.id })

      const dayId = inserted[0]!.id
      if (day.items.length > 0) {
        await tx.insert(schema.tripItems).values(
          day.items.map((it) => ({
            tripDayId: dayId,
            seq: it.seq,
            kind: it.kind,
            poiId: it.poiId ?? null,
            arriveAt: it.arriveAt ?? null,
            departAt: it.departAt ?? null,
            legMode: it.legMode ?? null,
            legDistanceMeters: it.legDistanceMeters ?? null,
            legMinutes: it.legMinutes ?? null,
            legPolyline: it.legPolyline ?? null,
            note: it.note ?? null,
          })),
        )
      }
    }

    await tx
      .update(schema.trips)
      .set({ status: 'planned', routeSummary: summary, updatedAt: new Date() })
      .where(eq(schema.trips.id, tripId))
  })
}

/**
 * 从库里读出来的一天。
 *
 * 注意 items 不能写成 `ItemInput & {...}` —— `ItemInput` 是**写入**用的类型,
 * 那些 `poiId?` 的可选是为了让调用方少写几个 null。读出来的行每一列都在,
 * 是 `string | null` 而不是 `undefined`。
 * 混用这两者会让 JSON 契约对不上:`undefined` 的键会被 JSON.stringify 整个
 * 省掉,前端读到 undefined;而契约(@/types/api → ItineraryItem)声明的是 null。
 * 所以这里显式列出读取形状,与前端契约保持一致。
 */
export interface ItineraryDay {
  dayIndex: number
  date: string | null
  theme: string | null
  tip: string | null
  distanceMeters: number | null
  travelMinutes: number | null
  items: {
    id: string
    seq: number
    kind: (typeof schema.itemKindEnum.enumValues)[number]
    poiId: string | null
    arriveAt: string | null
    departAt: string | null
    legMode: TravelMode | null
    legDistanceMeters: number | null
    legMinutes: number | null
    legPolyline: [number, number][] | null
    note: string | null
    poi: PoiRow | null
  }[]
}

export async function getItinerary(tripId: string): Promise<ItineraryDay[]> {
  const db = getDb()
  const days = await db
    .select()
    .from(schema.tripDays)
    .where(eq(schema.tripDays.tripId, tripId))
    .orderBy(asc(schema.tripDays.dayIndex))

  if (days.length === 0) return []

  const items = await db
    .select()
    .from(schema.tripItems)
    .where(
      inArray(
        schema.tripItems.tripDayId,
        days.map((d) => d.id),
      ),
    )
    .orderBy(asc(schema.tripItems.tripDayId), asc(schema.tripItems.seq))

  const poiIds = [...new Set(items.map((i) => i.poiId).filter((x): x is string => !!x))]
  const pois = await getPoisByIds(poiIds)
  const byId = new Map(pois.map((p) => [p.id, p]))

  return days.map((d) => ({
    dayIndex: d.dayIndex,
    date: d.date,
    theme: d.theme,
    tip: d.tip,
    distanceMeters: d.distanceMeters,
    travelMinutes: d.travelMinutes,
    items: items
      .filter((i) => i.tripDayId === d.id)
      .map((i) => ({
        id: i.id,
        seq: i.seq,
        kind: i.kind,
        poiId: i.poiId,
        arriveAt: i.arriveAt,
        departAt: i.departAt,
        legMode: i.legMode,
        legDistanceMeters: i.legDistanceMeters,
        legMinutes: i.legMinutes,
        legPolyline: i.legPolyline,
        note: i.note,
        poi: i.poiId ? byId.get(i.poiId) ?? null : null,
      })),
  }))
}

// ── 用户 ──────────────────────────────────────────────────────────────

/**
 * 项目没做登录。为了让"存用户数据"这件事成立，用一个固定的演示账号
 * 承载所有行程；接入真实鉴权时把 currentUserId() 换成 session 读取即可。
 */
const DEMO_PHONE = '00000000000'

export async function ensureDemoUser(): Promise<string> {
  const db = getDb()
  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.phone, DEMO_PHONE))
    .limit(1)
  if (existing[0]) return existing[0].id

  const rows = await db
    .insert(schema.users)
    .values({ phone: DEMO_PHONE, displayName: '演示用户' })
    .onConflictDoNothing({ target: schema.users.phone })
    .returning({ id: schema.users.id })

  if (rows[0]) return rows[0].id

  // 并发插入时上面会 DoNothing 返回空，重查一次
  const again = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.phone, DEMO_PHONE))
    .limit(1)
  return again[0]!.id
}
