import { describe, it, expect } from 'vitest'
import { AmapHotelProvider } from './amap-hotel'
import { needsPriceRefresh } from '../agent/tools/hotel'
import type { MapProvider, PriceProvider, PriceInfo, PoiResult } from './types'

/**
 * 酒店 provider 的编排测试：位置来自高德、价格来自 PriceProvider，
 * 两者怎么合并、查不到价怎么处理、贵操作有没有被无谓触发。
 */

function poi(name: string, extra?: Partial<PoiResult>): PoiResult {
  return {
    externalId: `id-${name}`,
    name,
    city: '上海',
    location: { lng: 121.49, lat: 31.24 },
    tags: ['住宿服务'],
    ...extra,
  }
}

class FakeMap implements MapProvider {
  readonly name = 'fake'
  searchCalls: unknown[] = []

  constructor(private readonly pois: PoiResult[]) {}

  async searchPoi(params: unknown) {
    this.searchCalls.push(params)
    return this.pois
  }
  async geocode() {
    return []
  }
  async distanceMatrix() {
    return { distanceMeters: [], durationSeconds: [] }
  }
  async route() {
    return null
  }
}

function priceProvider(
  answers: Record<string, [number, number]>,
  source: PriceInfo['source'] = 'search',
): PriceProvider & { asked: string[][] } {
  const asked: string[][] = []
  return {
    name: 'fake-price',
    source,
    asked,
    async lookup({ hotels }) {
      asked.push(hotels.map((h) => h.name))
      const out = new Map<string, PriceInfo>()
      for (const h of hotels) {
        const hit = answers[h.name]
        if (hit) {
          out.set(h.name, {
            minCents: hit[0],
            maxCents: hit[1],
            source,
            basis: ['测试'],
            citations: source === 'search' ? [{ title: '携程', url: 'https://ctrip.com' }] : undefined,
          })
        }
      }
      return out
    },
  }
}

const CENTER = { lng: 121.49, lat: 31.24 }
const QUERY = { city: '上海', center: CENTER, radiusMeters: 3000 }

describe('AmapHotelProvider', () => {
  it('合并位置与价格，并带上来源', async () => {
    const map = new FakeMap([poi('全季酒店外滩店'), poi('汉庭酒店')])
    const prices = priceProvider({ 全季酒店外滩店: [42000, 56000], 汉庭酒店: [20000, 28000] })

    const hotels = await new AmapHotelProvider(map, prices).searchHotels(QUERY)

    expect(hotels).toHaveLength(2)
    const quanji = hotels.find((h) => h.name === '全季酒店外滩店')!
    expect(quanji.priceMinCents).toBe(42000)
    expect(quanji.priceSource).toBe('search')
    expect(quanji.priceCitations).toEqual([{ title: '携程', url: 'https://ctrip.com' }])
    // 品牌从名字里推出来
    expect(quanji.brand).toBe('全季')
  })

  it('查不到价的酒店仍然返回，标记为无价格', async () => {
    const map = new FakeMap([poi('全季酒店外滩店'), poi('某不知名旅馆')])
    const prices = priceProvider({ 全季酒店外滩店: [42000, 56000] })

    const hotels = await new AmapHotelProvider(map, prices).searchHotels(QUERY)

    // 位置信息本身有价值，不能因为查不到价就整条丢掉
    expect(hotels).toHaveLength(2)
    const unknown = hotels.find((h) => h.name === '某不知名旅馆')!
    expect(unknown.priceMinCents).toBeUndefined()
    expect(unknown.priceSource).toBe('formula')
  })

  it('星级过滤发生在查价之前', async () => {
    const map = new FakeMap([
      poi('如家酒店', { tags: ['住宿服务', '二星级宾馆'] }),
      poi('上海和平饭店', { tags: ['住宿服务', '五星级宾馆'] }),
    ])
    const prices = priceProvider({ 上海和平饭店: [180000, 300000] })

    await new AmapHotelProvider(map, prices).searchHotels({ ...QUERY, minStar: 5 })

    // 查价是贵操作（联网/按次计费），不能为注定被筛掉的店付钱
    expect(prices.asked[0]).toEqual(['上海和平饭店'])
  })

  it('超预算的酒店被排除，但用区间下界判断', async () => {
    const map = new FakeMap([poi('便宜店'), poi('贵店')])
    const prices = priceProvider({
      // 下界在预算内，区间跨过预算 —— 应该保留
      便宜店: [30000, 80000],
      // 下界就超了 —— 排除
      贵店: [90000, 150000],
    })

    const hotels = await new AmapHotelProvider(map, prices).searchHotels({
      ...QUERY,
      maxPriceCents: 50000,
    })

    expect(hotels.map((h) => h.name)).toEqual(['便宜店'])
  })

  it('priceSource 对外声明为底层 provider 的来源', () => {
    const provider = new AmapHotelProvider(new FakeMap([]), priceProvider({}, 'llm'))
    expect(provider.priceSource).toBe('llm')
  })

  it('有品牌偏好时按品牌逐个搜', async () => {
    const map = new FakeMap([poi('全季酒店外滩店')])
    const prices = priceProvider({})

    await new AmapHotelProvider(map, prices).searchHotels({
      ...QUERY,
      brands: ['全季', '亚朵'],
    })

    expect(map.searchCalls).toHaveLength(2)
    expect((map.searchCalls[0] as { keywords: string }).keywords).toBe('全季')
  })

  it('入住日期透传给查价', async () => {
    const map = new FakeMap([poi('全季酒店外滩店')])
    let seenDate: string | undefined
    const prices: PriceProvider = {
      name: 'p',
      source: 'search',
      async lookup({ checkInDate }) {
        seenDate = checkInDate
        return new Map()
      },
    }

    await new AmapHotelProvider(map, prices).searchHotels({
      ...QUERY,
      checkInDate: '2026-10-01',
    })
    expect(seenDate).toBe('2026-10-01')
  })

  it('没有候选酒店时不调查价', async () => {
    const prices = priceProvider({})
    const hotels = await new AmapHotelProvider(new FakeMap([]), prices).searchHotels(QUERY)
    expect(hotels).toEqual([])
    expect(prices.asked).toHaveLength(0)
  })
})

describe('needsPriceRefresh', () => {
  const fresh = new Date('2026-08-12T00:00:00Z')
  const now = new Date('2026-08-12T06:00:00Z').getTime()

  it('库里是 formula 而现在能联网查 → 要刷新', () => {
    const rows = [{ priceSource: 'formula', priceMinCents: 20000, priceUpdatedAt: fresh }]
    expect(needsPriceRefresh(rows, 'search', now)).toBe(true)
  })

  it('库里已是 search 且不旧 → 不刷新', () => {
    const rows = [{ priceSource: 'search', priceMinCents: 42000, priceUpdatedAt: fresh }]
    expect(needsPriceRefresh(rows, 'search', now)).toBe(false)
  })

  it('search 价格超过一天 → 刷新', () => {
    const old = new Date('2026-08-09T00:00:00Z')
    const rows = [{ priceSource: 'search', priceMinCents: 42000, priceUpdatedAt: old }]
    expect(needsPriceRefresh(rows, 'search', now)).toBe(true)
  })

  it('formula 不因为时间过期而刷新', () => {
    // 纯函数算出来的，昨天和今天结果一样，重查纯浪费
    const old = new Date('2025-01-01T00:00:00Z')
    const rows = [{ priceSource: 'formula', priceMinCents: 20000, priceUpdatedAt: old }]
    expect(needsPriceRefresh(rows, 'formula', now)).toBe(false)
  })

  it('完全没有价格 → 刷新', () => {
    const rows = [{ priceSource: 'formula', priceMinCents: null, priceUpdatedAt: null }]
    expect(needsPriceRefresh(rows, 'formula', now)).toBe(true)
  })

  it('只要有一家需要刷新就整批重查', () => {
    const rows = [
      { priceSource: 'search', priceMinCents: 42000, priceUpdatedAt: fresh },
      { priceSource: 'formula', priceMinCents: 20000, priceUpdatedAt: fresh },
    ]
    expect(needsPriceRefresh(rows, 'search', now)).toBe(true)
  })

  it('降级运行时不会因为库里有更好的价格而反复重查', () => {
    // 之前配了 ARK 存了 search 价，现在没配只能 llm —— 不该把好价格覆盖掉
    const rows = [{ priceSource: 'search', priceMinCents: 42000, priceUpdatedAt: fresh }]
    expect(needsPriceRefresh(rows, 'llm', now)).toBe(false)
  })
})
