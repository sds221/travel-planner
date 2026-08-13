import { AmapProvider } from './amap'
import { AmapHotelProvider } from './amap-hotel'
import { OfflineMapProvider } from './offline-map'
import { CachedMapProvider, MemoryKV, type KV } from './cache'
import { RedisKV } from './redis-cache'
import { FormulaPriceProvider } from './price-formula'
import { LlmPriceProvider } from './price-llm'
import { ArkSearchPriceProvider } from './price-search'
import { ChainedPriceProvider, CachedPriceProvider } from './price-chain'
import { getModel } from '../agent/model'
import { dbEnv, amapEnv, priceEnv } from '../env'
import type { HotelProvider, MapProvider, PriceProvider } from './types'

/**
 * provider 的装配点。除了测试，其它地方都只通过这里拿实例 ——
 * 换数据源（比如接入真实 OTA 的价格）只需要改这个文件。
 */
const g = globalThis as {
  __travelKv?: KV
  __travelMap?: MapProvider
  __travelHotel?: HotelProvider
  __travelPrice?: PriceProvider
}

async function getKv(): Promise<KV> {
  if (g.__travelKv) return g.__travelKv
  // REDIS_URL 挂在 dbEnv 下：它和数据库一样属于基础设施配置
  const url = dbEnv().REDIS_URL
  const redis = url ? await RedisKV.create(url) : null
  g.__travelKv = redis ?? new MemoryKV()
  return g.__travelKv
}

/**
 * 地图 provider。没配高德 key 时退化为直线估算（见 offline-map.ts）——
 * 行程算法照样能跑，只是通勤时间是估的、地图上没有真实路径。
 *
 * 需要真实 POI 数据的地方（景点搜索、地点解析）会拿到空结果，
 * 由各自的调用方决定怎么提示用户。
 */
export async function getMapProvider(): Promise<MapProvider> {
  if (g.__travelMap) return g.__travelMap
  const kv = await getKv()

  let inner: MapProvider
  try {
    inner = new AmapProvider(amapEnv().AMAP_SERVER_KEY)
  } catch {
    inner = new OfflineMapProvider()
  }

  g.__travelMap = new CachedMapProvider(inner, kv)
  return g.__travelMap
}

/** 当前地图能力是否完整（没配 key 时为 false） */
export async function hasRealMapData(): Promise<boolean> {
  const p = await getMapProvider()
  return !p.name.includes('offline')
}

/**
 * 价格查询链的装配。
 *
 * 默认（PRICE_MODE=auto）：配了 ARK_API_KEY 就 search → llm → formula，
 * 没配就 llm → formula。逐级降级的理由见 price-chain.ts —— 联网查价
 * 会限流会超时，一批里查不到的那几家需要兜底。
 *
 * 想强制某一级用 PRICE_MODE 指定，比如 formula 可以完全离线跑（跑测试
 * 或者不想烧 token 时有用）。
 */
export async function getPriceProvider(): Promise<PriceProvider> {
  if (g.__travelPrice) return g.__travelPrice

  const env = priceEnv()
  const formula = new FormulaPriceProvider()
  const chain: PriceProvider[] = []

  const wantSearch = env.PRICE_MODE === 'auto' || env.PRICE_MODE === 'search'
  if (wantSearch && env.ARK_API_KEY) {
    chain.push(new ArkSearchPriceProvider(env.ARK_API_KEY, env.ARK_MODEL))
  }

  if (env.PRICE_MODE === 'auto' || env.PRICE_MODE === 'llm') {
    // 没配 LLM key 时 getModel() 会抛。auto 模式下这不该是致命错误 ——
    // 少一级降级而已，formula 照样能给出价格。
    try {
      chain.push(new LlmPriceProvider(getModel()))
    } catch (err) {
      if (env.PRICE_MODE === 'llm') throw err
    }
  }

  // formula 永远兜底，除非显式只要它
  chain.push(formula)

  const inner = env.PRICE_MODE === 'formula' ? formula : new ChainedPriceProvider(chain)
  g.__travelPrice = new CachedPriceProvider(inner, await getKv())
  return g.__travelPrice
}

export async function getHotelProvider(): Promise<HotelProvider> {
  if (g.__travelHotel) return g.__travelHotel
  // 酒店搜索走同一个带缓存的 map provider，POI 查询共享缓存
  g.__travelHotel = new AmapHotelProvider(await getMapProvider(), await getPriceProvider())
  return g.__travelHotel
}
