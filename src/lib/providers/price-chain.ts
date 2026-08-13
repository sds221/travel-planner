import type { PriceProvider, PriceInfo, PriceSource } from './types'
import type { KV } from './cache'

/**
 * 价格查询的降级链：search → llm → formula。
 *
 * 为什么要链式而不是只用最好的那个：联网查价慢（每批十几秒）、会限流、
 * 要花钱。一批 20 家酒店里查到 15 家是常态，剩下 5 家如果直接空着，
 * UI 上就是"部分酒店没有价格"，比给个粗估更难用。
 *
 * 每家酒店独立降级 —— 查到的用真实价，没查到的退回下一级，
 * 结果里 source 逐条标注，UI 据此区分显示。
 */
export class ChainedPriceProvider implements PriceProvider {
  readonly name: string
  /** 链上最好的那一级，用于 HotelProvider 对外声明 */
  readonly source: PriceSource

  constructor(private readonly chain: PriceProvider[]) {
    if (chain.length === 0) throw new Error('价格查询链不能为空')
    this.name = `chain(${chain.map((p) => p.name).join('→')})`
    this.source = chain[0]!.source
  }

  async lookup(params: {
    city: string
    hotels: { name: string; brand?: string; starRating?: number; district?: string }[]
    checkInDate?: string
    nights?: number
  }): Promise<Map<string, PriceInfo>> {
    const found = new Map<string, PriceInfo>()
    let pending = params.hotels

    for (const provider of this.chain) {
      if (pending.length === 0) break
      try {
        const result = await provider.lookup({ ...params, hotels: pending })
        for (const [name, info] of result) {
          if (!found.has(name)) found.set(name, info)
        }
      } catch {
        // 整个 provider 挂掉（没配 key、服务不可用）就跳到下一级
      }
      pending = pending.filter((h) => !found.has(h.name))
    }

    return found
  }
}

/**
 * 给价格查询套缓存。
 *
 * 房价查询是整条链上最贵的操作：联网搜索一批要十几秒，还按次计费。
 * 同一个用户改预算、换品牌筛选会反复触发同一批酒店的查询，
 * 不缓存的话体验和成本都不能接受。
 *
 * TTL 比 POI 短得多 —— 房价是会变的，缓存太久就失去了"实时"的意义。
 */
export class CachedPriceProvider implements PriceProvider {
  readonly name: string
  readonly source: PriceSource

  constructor(
    private readonly inner: PriceProvider,
    private readonly kv: KV,
    /** 默认 6 小时：足够覆盖一次规划会话，又不会让价格过期太久 */
    private readonly ttlSeconds = 6 * 3600,
  ) {
    this.name = `cached(${inner.name})`
    this.source = inner.source
  }

  async lookup(params: {
    city: string
    hotels: { name: string; brand?: string; starRating?: number; district?: string }[]
    checkInDate?: string
    nights?: number
  }): Promise<Map<string, PriceInfo>> {
    const out = new Map<string, PriceInfo>()
    const misses: typeof params.hotels = []

    // 逐家查缓存：命中的直接用，没命中的收集起来一次性问
    await Promise.all(
      params.hotels.map(async (h) => {
        const hit = await this.read(this.keyOf(params, h.name))
        if (hit) out.set(h.name, hit)
        else misses.push(h)
      }),
    )

    if (misses.length === 0) return out

    const fresh = await this.inner.lookup({ ...params, hotels: misses })
    await Promise.all(
      [...fresh].map(async ([name, info]) => {
        out.set(name, info)
        await this.write(this.keyOf(params, name), info)
      }),
    )

    return out
  }

  /** 日期进 key：平日价和节假日价不能互相复用 */
  private keyOf(params: { city: string; checkInDate?: string }, name: string): string {
    return `price|${this.inner.source}|${params.city}|${params.checkInDate ?? 'anyday'}|${name}`
  }

  private async read(key: string): Promise<PriceInfo | null> {
    try {
      const raw = await this.kv.get(key)
      return raw ? (JSON.parse(raw) as PriceInfo) : null
    } catch {
      return null
    }
  }

  private async write(key: string, info: PriceInfo): Promise<void> {
    try {
      await this.kv.set(key, JSON.stringify(info), this.ttlSeconds)
    } catch {
      // 缓存写失败不影响返回
    }
  }
}
