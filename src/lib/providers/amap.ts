import type {
  MapProvider,
  PoiResult,
  LatLng,
  DistanceMatrix,
  TravelMode,
} from './types'
import { normalizeCity } from '../city'

const BASE = 'https://restapi.amap.com/v3'

/** 高德坐标是 "lng,lat" 字符串，且精度最多 6 位 */
function fmt(p: LatLng): string {
  return `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`
}

function parseLocation(s: string): LatLng | null {
  const [lngStr, latStr] = s.split(',')
  const lng = Number(lngStr)
  const lat = Number(latStr)
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null
  return { lng, lat }
}

/**
 * 高德不返回"建议游览时长"，按 POI 类型给经验默认值。
 * 求解器需要这个值来排时间窗，缺失会导致一天塞太多点。
 */
function inferDwellMinutes(tags: string[]): number {
  const joined = tags.join(' ')
  if (/主题公园|游乐场|度假区/.test(joined)) return 360
  if (/博物馆|美术馆|展览馆|科技馆/.test(joined)) return 120
  if (/风景名胜|世界遗产|山|湖/.test(joined)) return 150
  if (/寺庙|教堂|古迹|纪念馆/.test(joined)) return 75
  if (/公园|广场|步行街/.test(joined)) return 60
  if (/观景|观光|地标/.test(joined)) return 45
  return 90
}

interface AmapPoi {
  id: string
  name: string
  type?: string
  address?: string | string[]
  location: string
  cityname?: string
  adname?: string
  biz_ext?: { rating?: string | string[]; cost?: string | string[] }
}

/** 高德对空字段返回 `[]` 而不是 null，取值时要归一 */
function scalar(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined
  if (Array.isArray(v)) return v.length > 0 ? v[0] : undefined
  return v === '' ? undefined : v
}

function toPoiResult(p: AmapPoi, fallbackCity: string): PoiResult | null {
  const location = parseLocation(p.location)
  if (!location) return null
  const tags = (p.type ?? '').split(';').filter(Boolean)
  const ratingStr = scalar(p.biz_ext?.rating)
  const rating = ratingStr ? Number(ratingStr) : undefined

  return {
    externalId: p.id,
    name: p.name,
    // 归一化："成都市" → "成都"。高德带行政级别后缀，界面上选的不带，
    // 不统一会让 WHERE city = ? 一条都匹配不到（见 city.ts）
    city: normalizeCity(p.cityname) || normalizeCity(fallbackCity),
    district: p.adname,
    address: scalar(p.address),
    location,
    tags,
    rating: Number.isFinite(rating) ? rating : undefined,
    dwellMinutes: inferDwellMinutes(tags),
    raw: p,
  }
}

export class AmapProvider implements MapProvider {
  readonly name = 'amap'

  constructor(
    private readonly key: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!key) throw new Error('AMAP_SERVER_KEY 未配置')
  }

  private async call<T>(path: string, params: Record<string, string | number | undefined>): Promise<T> {
    const qs = new URLSearchParams({ key: this.key })
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined) qs.set(k, String(v))
    }
    const url = `${BASE}${path}?${qs}`
    const res = await this.fetchImpl(url)
    if (!res.ok) {
      throw new Error(`高德 ${path} HTTP ${res.status}`)
    }
    const body = (await res.json()) as { status: string; info?: string; infocode?: string } & T
    // 高德用 status="1" 表示成功，HTTP 200 也可能是业务失败
    if (body.status !== '1') {
      throw new Error(`高德 ${path} 失败: ${body.info ?? 'unknown'} (${body.infocode ?? '-'})`)
    }
    return body
  }

  async searchPoi(params: {
    city: string
    keywords?: string
    types?: string
    around?: { center: LatLng; radiusMeters: number }
    limit?: number
  }): Promise<PoiResult[]> {
    const limit = Math.min(params.limit ?? 20, 25) // 高德单页上限 25

    // 有 around 用周边搜索，否则用关键字搜索
    const path = params.around ? '/place/around' : '/place/text'
    const body = await this.call<{ pois?: AmapPoi[] }>(path, {
      city: params.city,
      citylimit: 'true',
      keywords: params.keywords,
      types: params.types,
      location: params.around ? fmt(params.around.center) : undefined,
      radius: params.around?.radiusMeters,
      offset: limit,
      page: 1,
      extensions: 'all',
    })

    return (body.pois ?? [])
      .map((p) => toPoiResult(p, params.city))
      .filter((p): p is PoiResult => p !== null)
  }

  async geocode(params: { city: string; address: string }): Promise<PoiResult[]> {
    // 地理编码接口对景点名的召回不如 POI 搜索，先走 POI 搜索
    const pois = await this.searchPoi({
      city: params.city,
      keywords: params.address,
      limit: 5,
    })
    if (pois.length > 0) return pois

    const body = await this.call<{
      geocodes?: { formatted_address: string; location: string; city?: string; district?: string }[]
    }>('/geocode/geo', { address: params.address, city: params.city })

    return (body.geocodes ?? [])
      .map((g, i): PoiResult | null => {
        const location = parseLocation(g.location)
        if (!location) return null
        return {
          externalId: `geo:${params.address}:${i}`,
          name: params.address,
          city: normalizeCity(g.city) || normalizeCity(params.city),
          district: g.district,
          address: g.formatted_address,
          location,
          tags: [],
          dwellMinutes: 90,
          raw: g,
        }
      })
      .filter((p): p is PoiResult => p !== null)
  }

  async distanceMatrix(params: {
    origins: LatLng[]
    destinations: LatLng[]
    mode: TravelMode
    city?: string
  }): Promise<DistanceMatrix> {
    const { origins, destinations, mode } = params

    // /distance 的形状是"多个 origins 对一个 destination"：origins 用 | 分隔、
    // 上限 100，destination 只能是单点。所以外层循环必须是 destinations，
    // 一次调用拿到矩阵的一整列。反过来写（一个 origin 对多个 destination）
    // 参数不合法，高德只会认第一个目的地。
    //
    // type: 1=驾车 3=步行。transit 没有矩阵接口，先用步行距离拿到路网距离，
    // 再按经验系数折算成公交时长 —— 对"分天聚类"够用，精确通勤时间在生成
    // 最终行程时对每一段单独调 route()。
    const apiType = mode === 'driving' ? 1 : 3
    const distanceMeters = origins.map(() => new Array<number>(destinations.length).fill(0))
    const durationSeconds = origins.map(() => new Array<number>(destinations.length).fill(0))

    for (let j = 0; j < destinations.length; j++) {
      const destination = destinations[j]!

      for (let start = 0; start < origins.length; start += 100) {
        const batch = origins.slice(start, start + 100)
        const body = await this.call<{
          results?: { origin_id: string; dest_id: string; distance: string; duration: string }[]
        }>('/distance', {
          origins: batch.map(fmt).join('|'),
          destination: fmt(destination),
          type: apiType,
        })

        // origin_id 是 1-based 的下标。高德偶尔乱序返回，优先按 id 定位，
        // 缺失时才退回数组顺序。
        const results = body.results ?? []
        for (let k = 0; k < batch.length; k++) {
          const origin = batch[k]!
          const byId = results.find((r) => Number(r.origin_id) === k + 1)
          const r = byId ?? results[k]

          const straight = haversine(origin, destination)
          const dist = r ? Number(r.distance) : NaN
          const dur = r ? Number(r.duration) : NaN

          const i = start + k
          distanceMeters[i]![j] = Number.isFinite(dist) ? dist : straight
          durationSeconds[i]![j] = Number.isFinite(dur) ? dur : estimateDuration(straight, mode)
        }
      }
    }

    // 公交模式：步行时长换算成公交的经验值
    if (mode === 'transit') {
      for (let i = 0; i < durationSeconds.length; i++) {
        for (let j = 0; j < durationSeconds[i]!.length; j++) {
          durationSeconds[i]![j] = estimateDuration(distanceMeters[i]![j]!, 'transit')
        }
      }
    }

    return { distanceMeters, durationSeconds }
  }

  async route(params: {
    origin: LatLng
    destination: LatLng
    mode: TravelMode
    city?: string
  }): Promise<{ distanceMeters: number; durationSeconds: number; polyline: [number, number][] } | null> {
    const { origin, destination, mode, city } = params

    const path =
      mode === 'driving'
        ? '/direction/driving'
        : mode === 'walking'
          ? '/direction/walking'
          : mode === 'cycling'
            ? '/direction/bicycling'
            : '/direction/transit/integrated'

    try {
      const body = await this.call<{
        route?: {
          paths?: { distance: string; duration: string; steps?: { polyline?: string }[] }[]
          transits?: {
            distance: string
            duration: string
            segments?: { bus?: { buslines?: { polyline?: string }[] }; walking?: { polyline?: string } }[]
          }[]
        }
      }>(path, {
        origin: fmt(origin),
        destination: fmt(destination),
        city,
        cityd: city,
        extensions: 'all',
      })

      if (mode === 'transit') {
        const t = body.route?.transits?.[0]
        if (!t) return null
        const polyline: [number, number][] = []
        for (const seg of t.segments ?? []) {
          const walk = seg.walking?.polyline
          if (walk) polyline.push(...decodePolyline(walk))
          for (const line of seg.bus?.buslines ?? []) {
            if (line.polyline) polyline.push(...decodePolyline(line.polyline))
          }
        }
        return {
          distanceMeters: Number(t.distance) || 0,
          durationSeconds: Number(t.duration) || 0,
          polyline,
        }
      }

      const p = body.route?.paths?.[0]
      if (!p) return null
      const polyline: [number, number][] = []
      for (const step of p.steps ?? []) {
        if (step.polyline) polyline.push(...decodePolyline(step.polyline))
      }
      return {
        distanceMeters: Number(p.distance) || 0,
        durationSeconds: Number(p.duration) || 0,
        polyline,
      }
    } catch {
      // 单段路径失败不该让整个行程生成失败，降级为直线估算
      return null
    }
  }
}

/** 高德 polyline 是 "lng,lat;lng,lat" 明文，不是 Google 的编码格式 */
export function decodePolyline(s: string): [number, number][] {
  const out: [number, number][] = []
  for (const pair of s.split(';')) {
    const [lngStr, latStr] = pair.split(',')
    const lng = Number(lngStr)
    const lat = Number(latStr)
    if (Number.isFinite(lng) && Number.isFinite(lat)) out.push([lng, lat])
  }
  return out
}

export function haversine(a: LatLng, b: LatLng): number {
  const R = 6371000
  const toRad = (d: number) => (d * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLng = toRad(b.lng - a.lng)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)))
}

/** 各交通方式的经验速度，用于 API 失败时兜底 */
export function estimateDuration(meters: number, mode: TravelMode): number {
  const kmh = mode === 'driving' ? 25 : mode === 'transit' ? 18 : mode === 'cycling' ? 12 : 4.5
  const base = (meters / 1000 / kmh) * 3600
  // 公交有固定的等车+换乘开销
  return Math.round(mode === 'transit' ? base + 600 : base)
}
