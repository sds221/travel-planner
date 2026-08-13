import type {
  MapProvider,
  PoiResult,
  LatLng,
  DistanceMatrix,
  TravelMode,
} from './types'

/**
 * 距离矩阵是最贵的调用：n 个点要 n² 次查询，10 个点就是 100 次。
 * 同一个城市的同一批景点会被反复请求（用户改预算、换酒店都要重算路线），
 * 所以缓存是必需的，不是优化。
 *
 * 这里用一个极简的 KV 抽象。Redis 不可用时退化为进程内 Map ——
 * 开发时不想起 Redis 也能跑，代价是重启丢缓存。
 */
export interface KV {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlSeconds: number): Promise<void>
}

export class MemoryKV implements KV {
  private store = new Map<string, { value: string; expiresAt: number }>()

  async get(key: string): Promise<string | null> {
    const hit = this.store.get(key)
    if (!hit) return null
    if (Date.now() > hit.expiresAt) {
      this.store.delete(key)
      return null
    }
    return hit.value
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 })
    // 防止长跑进程无限增长
    if (this.store.size > 5000) {
      const now = Date.now()
      for (const [k, v] of this.store) {
        if (now > v.expiresAt) this.store.delete(k)
      }
    }
  }
}

/** 坐标取 4 位小数(~11m)做 key，避免浮点噪声导致缓存永不命中 */
function coordKey(p: LatLng): string {
  return `${p.lng.toFixed(4)},${p.lat.toFixed(4)}`
}

const TTL = {
  poi: 7 * 24 * 3600, // POI 基本不变
  matrix: 24 * 3600, // 路况会变，一天足够
  route: 12 * 3600,
} as const

/**
 * 给任意 MapProvider 套一层缓存。
 * 装饰器模式：agent 拿到的还是 MapProvider，不知道缓存的存在。
 */
export class CachedMapProvider implements MapProvider {
  readonly name: string

  constructor(
    private readonly inner: MapProvider,
    private readonly kv: KV,
  ) {
    this.name = `cached(${inner.name})`
  }

  private async remember<T>(key: string, ttl: number, fn: () => Promise<T>): Promise<T> {
    try {
      const hit = await this.kv.get(key)
      if (hit) return JSON.parse(hit) as T
    } catch {
      // 缓存读失败不应该让业务失败
    }
    const value = await fn()
    try {
      await this.kv.set(key, JSON.stringify(value), ttl)
    } catch {
      // 同上
    }
    return value
  }

  async searchPoi(params: Parameters<MapProvider['searchPoi']>[0]): Promise<PoiResult[]> {
    const key = [
      'poi',
      params.city,
      params.keywords ?? '',
      params.types ?? '',
      params.around ? `${coordKey(params.around.center)}@${params.around.radiusMeters}` : '',
      params.limit ?? '',
    ].join('|')
    return this.remember(key, TTL.poi, () => this.inner.searchPoi(params))
  }

  async geocode(params: { city: string; address: string }): Promise<PoiResult[]> {
    const key = `geo|${params.city}|${params.address}`
    return this.remember(key, TTL.poi, () => this.inner.geocode(params))
  }

  async distanceMatrix(params: {
    origins: LatLng[]
    destinations: LatLng[]
    mode: TravelMode
    city?: string
  }): Promise<DistanceMatrix> {
    const key = [
      'matrix',
      params.mode,
      params.origins.map(coordKey).join(';'),
      '->',
      params.destinations.map(coordKey).join(';'),
    ].join('|')
    return this.remember(key, TTL.matrix, () => this.inner.distanceMatrix(params))
  }

  async route(params: {
    origin: LatLng
    destination: LatLng
    mode: TravelMode
    city?: string
  }): ReturnType<MapProvider['route']> {
    const key = `route|${params.mode}|${coordKey(params.origin)}->${coordKey(params.destination)}`
    return this.remember(key, TTL.route, () => this.inner.route(params))
  }
}
