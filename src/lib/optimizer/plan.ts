import { clusterByDay, solveDayRoute } from './tsp'
import { scheduleDay, parseTime, formatTime } from './schedule'
import { estimateDuration, haversine } from '../providers/amap'
import type { MapProvider, TravelMode, LatLng } from '../providers/types'
import type { PoiRow } from '../db/queries'
import type { DayInput, ItemInput } from '../db/trips'

/**
 * 行程求解的编排：聚类分天 → 每天定序 → 排时刻 → 拉折线。
 *
 * LLM 不参与这里的任何计算。它的输入是求解结果（"第2天有4个点、
 * 通勤75分钟、2个点被挤掉了"），输出是主题文案和调整建议。
 * 这样做的好处是行程图永远自洽：时刻表不会出现 14:00 到、13:30 走。
 */

export interface PlanInput {
  pois: {
    poi: PoiRow
    dwellMinutes: number
    pinnedDayIndex: number | null
    priority: number
  }[]
  hotel: PoiRow | null
  days: number
  mode: TravelMode
  dayStartTime: string
  dayEndTime: string
  city: string
  /** 每天的日期，用于写入 trip_days 和判断营业时间是周几 */
  dates?: (string | null)[]
  /** 是否为每一段拉真实折线。点多时很慢，预览可以关掉 */
  withPolylines?: boolean
}

export interface PlanResult {
  days: DayInput[]
  summary: {
    totalDistanceMeters: number
    totalTravelMinutes: number
    unassignedPoiIds: string[]
    solvedAt: string
    solver: string
  }
  /** 给 LLM 看的结构化摘要，用于生成解释文案 */
  digest: {
    dayIndex: number
    date: string | null
    poiNames: string[]
    travelMinutes: number
    distanceMeters: number
    startTime: string
    endTime: string
  }[]
}

/** 星期几（0=周日），用于查营业时间 */
function weekdayOf(dateStr: string | null | undefined): number | null {
  if (!dateStr) return null
  const t = Date.parse(`${dateStr}T00:00:00Z`)
  if (!Number.isFinite(t)) return null
  return new Date(t).getUTCDay()
}

function windowFor(poi: PoiRow, weekday: number | null): { open: number; close: number } | null {
  const weekly = poi.openingHours?.weekly
  if (!weekly || weekday === null) return null
  const slots = weekly[weekday]
  if (!slots || slots.length === 0) return null
  // 多个时段时取最外层的包络，中间的午休交给 agent 在文案里提醒
  const open = Math.min(...slots.map((s) => parseTime(s.open)))
  const close = Math.max(...slots.map((s) => parseTime(s.close)))
  return { open, close }
}

/**
 * 距离矩阵。高德 /distance 一次只能一个 origin 对多个 destination，
 * n 个点就是 n 次调用；缓存命中时是 0 次。失败时退化为直线距离 ——
 * 宁可给个粗略行程，也不要因为一次 API 抖动让用户拿不到结果。
 */
async function buildMatrix(
  map: MapProvider,
  points: LatLng[],
  mode: TravelMode,
  city: string,
): Promise<{ minutes: number[][]; meters: number[][] }> {
  if (points.length === 0) return { minutes: [], meters: [] }

  try {
    const m = await map.distanceMatrix({ origins: points, destinations: points, mode, city })
    return {
      minutes: m.durationSeconds.map((row) => row.map((s) => Math.round(s / 60))),
      meters: m.distanceMeters,
    }
  } catch {
    const meters = points.map((a) => points.map((b) => haversine(a, b)))
    return {
      minutes: meters.map((row) => row.map((d) => Math.round(estimateDuration(d, mode) / 60))),
      meters,
    }
  }
}

export async function planTrip(map: MapProvider, input: PlanInput): Promise<PlanResult> {
  const { pois, hotel, mode, city, dayStartTime, dayEndTime } = input
  const days = Math.max(1, input.days)

  if (pois.length === 0) {
    return {
      days: [],
      summary: {
        totalDistanceMeters: 0,
        totalTravelMinutes: 0,
        unassignedPoiIds: [],
        solvedAt: new Date().toISOString(),
        solver: 'none',
      },
      digest: [],
    }
  }

  // 矩阵里酒店排在最后，下标 = pois.length
  const points: LatLng[] = pois.map((p) => p.poi.location)
  const hotelIndex = hotel ? points.length : -1
  if (hotel) points.push(hotel.location)

  const matrix = await buildMatrix(map, points, mode, city)
  const legOf = (from: number, to: number) => {
    const f = from === -1 ? hotelIndex : from
    const t = to === -1 ? hotelIndex : to
    if (f < 0 || t < 0) return { minutes: 0, meters: 0 }
    return { minutes: matrix.minutes[f]?.[t] ?? 0, meters: matrix.meters[f]?.[t] ?? 0 }
  }

  // ── 分天 ──
  const pinned = new Map<number, number>()
  pois.forEach((p, i) => {
    if (p.pinnedDayIndex !== null && p.pinnedDayIndex >= 0 && p.pinnedDayIndex < days) {
      pinned.set(i, p.pinnedDayIndex)
    }
  })

  const assignment = clusterByDay({
    points: pois.map((p) => p.poi.location),
    days,
    pinned: pinned.size > 0 ? pinned : undefined,
  })

  // ── 每天定序 + 排时刻 ──
  const resultDays: DayInput[] = []
  const digest: PlanResult['digest'] = []
  const unassigned: string[] = []
  let totalDistance = 0
  let totalTravel = 0

  for (let d = 0; d < days; d++) {
    const memberIdx = assignment.map((a, i) => (a === d ? i : -1)).filter((i) => i >= 0)
    const date = input.dates?.[d] ?? null
    const weekday = weekdayOf(date)

    if (memberIdx.length === 0) {
      resultDays.push({ dayIndex: d, date, theme: null, distanceMeters: 0, travelMinutes: 0, items: [] })
      digest.push({
        dayIndex: d,
        date,
        poiNames: [],
        travelMinutes: 0,
        distanceMeters: 0,
        startTime: dayStartTime,
        endTime: dayStartTime,
      })
      continue
    }

    // 子矩阵：当天的点 + 酒店
    const nodes = hotel ? [...memberIdx, hotelIndex] : memberIdx
    const subMatrix = nodes.map((a) => nodes.map((b) => legOf(a, b).minutes))
    const subDepot = hotel ? nodes.length - 1 : -1

    const solved = solveDayRoute({
      matrix: subMatrix,
      depotIndex: subDepot,
      returnToDepot: hotel !== null,
    })

    // 求解结果的下标是子矩阵内的，映射回全局 poi 下标
    const visitOrder = solved.order
      .filter((i) => i !== subDepot)
      .map((i) => nodes[i]!)
      .filter((i) => i !== hotelIndex)

    const dwellByGlobalIdx: number[] = []
    pois.forEach((p, i) => {
      dwellByGlobalIdx[i] = p.dwellMinutes
    })

    const sched = scheduleDay({
      order: visitOrder,
      dwellMinutes: dwellByGlobalIdx,
      leg: legOf,
      startMinutes: parseTime(dayStartTime),
      endMinutes: parseTime(dayEndTime),
      hasHotel: hotel !== null,
      window: (i) => windowFor(pois[i]!.poi, weekday),
    })

    // 时间不够被挤掉的点：优先级高的记下来提示用户，低的静默丢弃
    for (const idx of sched.dropped) unassigned.push(pois[idx]!.poi.id)

    const items: ItemInput[] = []
    let seq = 0

    if (hotel) {
      items.push({
        seq: seq++,
        kind: 'hotel_checkout',
        poiId: hotel.id,
        departAt: dayStartTime,
        note: d === 0 ? '从酒店出发' : '从酒店出发',
      })
    }

    for (const stop of sched.stops) {
      const p = pois[stop.stopIndex]!
      items.push({
        seq: seq++,
        kind: 'visit',
        poiId: p.poi.id,
        arriveAt: formatTime(stop.arriveMinutes),
        departAt: formatTime(stop.departMinutes),
        legMode: mode,
        legDistanceMeters: Math.round(stop.legDistanceMeters),
        legMinutes: stop.legMinutes,
      })
    }

    if (hotel && sched.returnLeg && sched.stops.length > 0) {
      items.push({
        seq: seq++,
        kind: 'hotel_checkin',
        poiId: hotel.id,
        arriveAt: formatTime(sched.endMinutes),
        legMode: mode,
        legDistanceMeters: Math.round(sched.returnLeg.meters),
        legMinutes: sched.returnLeg.minutes,
        note: '返回酒店',
      })
    }

    // 折线单独拉：只对真正排进行程的段调用，且失败不影响时刻表
    if (input.withPolylines) {
      await attachPolylines(map, items, pois, hotel, mode, city)
    }

    totalDistance += sched.totalDistanceMeters
    totalTravel += sched.totalTravelMinutes

    resultDays.push({
      dayIndex: d,
      date,
      theme: null,
      distanceMeters: Math.round(sched.totalDistanceMeters),
      travelMinutes: sched.totalTravelMinutes,
      items,
    })

    digest.push({
      dayIndex: d,
      date,
      poiNames: sched.stops.map((s) => pois[s.stopIndex]!.poi.name),
      travelMinutes: sched.totalTravelMinutes,
      distanceMeters: Math.round(sched.totalDistanceMeters),
      startTime: dayStartTime,
      endTime: formatTime(sched.endMinutes),
    })
  }

  return {
    days: resultDays,
    summary: {
      totalDistanceMeters: Math.round(totalDistance),
      totalTravelMinutes: totalTravel,
      unassignedPoiIds: [...new Set(unassigned)],
      solvedAt: new Date().toISOString(),
      solver: `cluster+2opt(${map.name})`,
    },
    digest,
  }
}

/** 为每个 leg 拉真实折线。串行是为了不把高德 QPS 打爆 */
async function attachPolylines(
  map: MapProvider,
  items: ItemInput[],
  pois: PlanInput['pois'],
  hotel: PoiRow | null,
  mode: TravelMode,
  city: string,
): Promise<void> {
  const locate = (poiId: string | null | undefined): LatLng | null => {
    if (!poiId) return null
    if (hotel && poiId === hotel.id) return hotel.location
    return pois.find((p) => p.poi.id === poiId)?.poi.location ?? null
  }

  for (let i = 1; i < items.length; i++) {
    const from = locate(items[i - 1]!.poiId)
    const to = locate(items[i]!.poiId)
    if (!from || !to) continue
    const r = await map.route({ origin: from, destination: to, mode, city })
    if (r) {
      items[i]!.legPolyline = r.polyline
      // 真实路径比矩阵更准，顺手校正
      items[i]!.legDistanceMeters = r.distanceMeters
      items[i]!.legMinutes = Math.round(r.durationSeconds / 60)
    }
  }
}
