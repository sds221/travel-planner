import { describe, it, expect } from 'vitest'
import { planTrip } from './plan'
import { haversine, estimateDuration } from '../providers/amap'
import type { MapProvider, LatLng } from '../providers/types'
import type { PoiRow } from '../db/queries'

/**
 * 用假 provider 测编排逻辑。真实的高德调用在这里没有意义 ——
 * 要验证的是"子矩阵下标映射对不对""每个点是否恰好出现一次"
 * "酒店在不在首尾"这类结构性质，和外部数据无关。
 */
class FakeMap implements MapProvider {
  readonly name = 'fake'
  matrixCalls = 0
  routeCalls = 0

  async searchPoi() {
    return []
  }
  async geocode() {
    return []
  }

  async distanceMatrix(params: { origins: LatLng[]; destinations: LatLng[]; mode: never }) {
    this.matrixCalls++
    const distanceMeters = params.origins.map((a) => params.destinations.map((b) => haversine(a, b)))
    return {
      distanceMeters,
      durationSeconds: distanceMeters.map((row) =>
        row.map((d) => estimateDuration(d, params.mode ?? 'transit')),
      ),
    }
  }

  async route(params: { origin: LatLng; destination: LatLng }) {
    this.routeCalls++
    const d = haversine(params.origin, params.destination)
    return {
      distanceMeters: d,
      durationSeconds: estimateDuration(d, 'transit'),
      polyline: [
        [params.origin.lng, params.origin.lat],
        [params.destination.lng, params.destination.lat],
      ] as [number, number][],
    }
  }
}

let seq = 0
function poi(name: string, lng: number, lat: number, dwell = 90): PoiRow {
  seq++
  return {
    id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    kind: 'attraction',
    source: 'curated',
    externalId: `fake:${name}`,
    name,
    city: '上海',
    district: null,
    address: null,
    location: { lng, lat },
    dwellMinutes: dwell,
    rating: 4.5,
    tags: [],
    openingHours: null,
    brand: null,
    starRating: null,
    priceMinCents: null,
    priceMaxCents: null,
    priceSource: 'formula',
    priceBasis: null,
    priceCitations: null,
    priceUpdatedAt: null,
  }
}

function entry(p: PoiRow, opts?: { pinnedDayIndex?: number | null; dwell?: number }) {
  return {
    poi: p,
    dwellMinutes: opts?.dwell ?? p.dwellMinutes ?? 90,
    pinnedDayIndex: opts?.pinnedDayIndex ?? null,
    priority: 3,
  }
}

const BASE = {
  city: '上海',
  mode: 'transit' as const,
  dayStartTime: '09:00',
  dayEndTime: '21:00',
}

describe('planTrip', () => {
  it('每个景点最多出现一次，跨天不重复', async () => {
    const pois = [
      entry(poi('外滩', 121.4903, 31.2397)),
      entry(poi('豫园', 121.4921, 31.2272)),
      entry(poi('上海博物馆', 121.4757, 31.2287)),
      entry(poi('迪士尼', 121.6689, 31.1434, 240)),
      entry(poi('东方明珠', 121.4997, 31.2397)),
    ]

    const result = await planTrip(new FakeMap(), { ...BASE, pois, hotel: null, days: 2 })

    const visited = result.days
      .flatMap((d) => d.items)
      .filter((i) => i.kind === 'visit')
      .map((i) => i.poiId)

    expect(new Set(visited).size).toBe(visited.length)
    // 排进去的 + 被挤掉的 = 全部
    const covered = new Set([...visited, ...result.summary.unassignedPoiIds])
    expect(covered.size).toBe(pois.length)
  })

  it('有酒店时每天从酒店出发并返回', async () => {
    const hotel = poi('某酒店', 121.485, 31.233)
    hotel.kind = 'hotel'
    const pois = [
      entry(poi('A', 121.49, 31.24)),
      entry(poi('B', 121.475, 31.229)),
      entry(poi('C', 121.4997, 31.2397)),
    ]

    const result = await planTrip(new FakeMap(), { ...BASE, pois, hotel, days: 1 })
    const items = result.days[0]!.items

    expect(items[0]!.kind).toBe('hotel_checkout')
    expect(items[0]!.poiId).toBe(hotel.id)
    expect(items.at(-1)!.kind).toBe('hotel_checkin')
    expect(items.at(-1)!.poiId).toBe(hotel.id)
    // 中间全是 visit
    expect(items.slice(1, -1).every((i) => i.kind === 'visit')).toBe(true)
  })

  it('没有酒店时不产生酒店条目', async () => {
    const pois = [entry(poi('A', 121.49, 31.24)), entry(poi('B', 121.475, 31.229))]
    const result = await planTrip(new FakeMap(), { ...BASE, pois, hotel: null, days: 1 })
    const kinds = result.days[0]!.items.map((i) => i.kind)
    expect(kinds.every((k) => k === 'visit')).toBe(true)
  })

  it('地理上分开的两簇被分到不同天', async () => {
    // 市区三个点 + 20km 外的迪士尼两个点
    const pois = [
      entry(poi('外滩', 121.4903, 31.2397)),
      entry(poi('豫园', 121.4921, 31.2272)),
      entry(poi('博物馆', 121.4757, 31.2287)),
      entry(poi('迪士尼乐园', 121.6689, 31.1434, 120)),
      entry(poi('迪士尼小镇', 121.6614, 31.1477, 60)),
    ]

    const result = await planTrip(new FakeMap(), { ...BASE, pois, hotel: null, days: 2 })

    const dayOf = new Map<string, number>()
    for (const d of result.days) {
      for (const it of d.items) {
        if (it.kind === 'visit' && it.poiId) dayOf.set(it.poiId, d.dayIndex)
      }
    }

    const disneyDays = pois
      .filter((p) => p.poi.name.startsWith('迪士尼'))
      .map((p) => dayOf.get(p.poi.id))
      .filter((d) => d !== undefined)

    const cityDays = pois
      .filter((p) => !p.poi.name.startsWith('迪士尼'))
      .map((p) => dayOf.get(p.poi.id))
      .filter((d) => d !== undefined)

    // 两簇各自内部同天，且互不同天
    expect(new Set(disneyDays).size).toBe(1)
    expect(new Set(cityDays).size).toBe(1)
    expect(disneyDays[0]).not.toBe(cityDays[0])
  })

  it('锁定某天的景点确实排在那天', async () => {
    const target = poi('必须第二天去', 121.49, 31.24)
    const pois = [
      entry(poi('A', 121.4757, 31.2287)),
      entry(poi('B', 121.4921, 31.2272)),
      entry(target, { pinnedDayIndex: 1 }),
    ]

    const result = await planTrip(new FakeMap(), { ...BASE, pois, hotel: null, days: 2 })
    const day1 = result.days[1]!.items.filter((i) => i.kind === 'visit').map((i) => i.poiId)
    expect(day1).toContain(target.id)
  })

  it('时刻表在每天内部单调递增', async () => {
    const pois = Array.from({ length: 6 }, (_, i) =>
      entry(poi(`P${i}`, 121.47 + i * 0.01, 31.22 + i * 0.005, 60)),
    )
    const result = await planTrip(new FakeMap(), { ...BASE, pois, hotel: null, days: 2 })

    for (const day of result.days) {
      const times = day.items
        .filter((i) => i.kind === 'visit')
        .map((i) => i.arriveAt!)
        .filter(Boolean)
      const sorted = [...times].sort()
      expect(times).toEqual(sorted)
    }
  })

  it('各天的景点数量大致均衡，不会一天塞满其它天空着', async () => {
    // 这是一个真实出现过的 bug：cap 算成 ceil(n/days)+1 时，
    // 5 个点分 3 天变成 3/1/1，用户看到"第一天赶死，后两天没事干"。
    const pois = [
      entry(poi('外滩', 121.4903, 31.2397, 90)),
      entry(poi('东方明珠', 121.4997, 31.2397, 90)),
      entry(poi('豫园', 121.4921, 31.2272, 120)),
      entry(poi('武康路', 121.4356, 31.2117, 75)),
      entry(poi('上海博物馆', 121.4757, 31.2287, 150)),
    ]

    const result = await planTrip(new FakeMap(), { ...BASE, pois, hotel: null, days: 3 })
    const counts = result.days.map((d) => d.items.filter((i) => i.kind === 'visit').length)

    // 5 个点 3 天 → 2/2/1，最多和最少差 1
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1)
    expect(counts.reduce((a, b) => a + b, 0)).toBe(5)
  })

  it('7 个点 3 天时也均衡（3/2/2）', async () => {
    const pois = Array.from({ length: 7 }, (_, i) =>
      entry(poi(`P${i}`, 121.46 + (i % 3) * 0.015, 31.21 + Math.floor(i / 3) * 0.012, 60)),
    )
    const result = await planTrip(new FakeMap(), { ...BASE, pois, hotel: null, days: 3 })
    const counts = result.days.map((d) => d.items.filter((i) => i.kind === 'visit').length)

    expect(Math.max(...counts)).toBeLessThanOrEqual(3)
    expect(Math.min(...counts)).toBeGreaterThanOrEqual(2)
  })

  it('天数多于景点数时空的那天有条目为空的记录', async () => {
    const pois = [entry(poi('唯一一个点', 121.49, 31.24))]
    const result = await planTrip(new FakeMap(), { ...BASE, pois, hotel: null, days: 3 })

    expect(result.days).toHaveLength(3)
    const nonEmpty = result.days.filter((d) => d.items.length > 0)
    expect(nonEmpty).toHaveLength(1)
    // digest 也要覆盖所有天，agent 需要为空的那天写主题
    expect(result.digest).toHaveLength(3)
  })

  it('没有景点时返回空结果而不抛错', async () => {
    const result = await planTrip(new FakeMap(), { ...BASE, pois: [], hotel: null, days: 3 })
    expect(result.days).toEqual([])
    expect(result.summary.totalDistanceMeters).toBe(0)
  })

  it('withPolylines=false 时不调 route，true 时才调', async () => {
    const pois = [entry(poi('A', 121.49, 31.24)), entry(poi('B', 121.475, 31.229))]

    const without = new FakeMap()
    await planTrip(without, { ...BASE, pois, hotel: null, days: 1, withPolylines: false })
    expect(without.routeCalls).toBe(0)

    const withPoly = new FakeMap()
    const result = await planTrip(withPoly, {
      ...BASE,
      pois,
      hotel: null,
      days: 1,
      withPolylines: true,
    })
    expect(withPoly.routeCalls).toBeGreaterThan(0)
    const legs = result.days[0]!.items.filter((i) => i.legPolyline)
    expect(legs.length).toBeGreaterThan(0)
  })

  it('营业时间导致排不下的点进 unassigned', async () => {
    const museum = poi('只开到中午的馆', 121.49, 31.24, 120)
    museum.openingHours = {
      weekly: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [{ open: '09:00', close: '10:00' }]])),
    }
    const pois = [
      entry(poi('先去这里', 121.4757, 31.2287, 180)),
      entry(museum),
    ]

    // 2025-08-15 是周五
    const result = await planTrip(new FakeMap(), {
      ...BASE,
      pois,
      hotel: null,
      days: 1,
      dates: ['2025-08-15'],
    })

    // 逛完第一个点已经过了闭馆时间
    expect(result.summary.unassignedPoiIds).toContain(museum.id)
  })

  it('矩阵只算一次，不按天重复调用', async () => {
    const map = new FakeMap()
    const pois = Array.from({ length: 8 }, (_, i) =>
      entry(poi(`P${i}`, 121.45 + i * 0.02, 31.2 + i * 0.01)),
    )
    await planTrip(map, { ...BASE, pois, hotel: null, days: 3 })
    expect(map.matrixCalls).toBe(1)
  })

  it('距离矩阵失败时降级为直线估算而不是整体失败', async () => {
    class BrokenMap extends FakeMap {
      override async distanceMatrix(): Promise<never> {
        throw new Error('高德 /distance 失败')
      }
    }
    const pois = [entry(poi('A', 121.49, 31.24)), entry(poi('B', 121.6689, 31.1434))]
    const result = await planTrip(new BrokenMap(), { ...BASE, pois, hotel: null, days: 1 })

    const visits = result.days[0]!.items.filter((i) => i.kind === 'visit')
    expect(visits).toHaveLength(2)
    // 直线兜底也要给出非零通勤
    expect(result.summary.totalTravelMinutes).toBeGreaterThan(0)
  })
})
