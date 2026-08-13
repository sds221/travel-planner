/**
 * 外部数据源的抽象边界。
 *
 * 现在只有高德一家实现，但把接口切出来的实际收益是：
 * HotelProvider 的价格部分目前是估算的，将来接入真实 OTA 时
 * 只需要换一个实现，agent 和求解器都不用动。
 */

export interface LatLng {
  lng: number
  lat: number
}

export interface PoiResult {
  externalId: string
  name: string
  city: string
  district?: string
  address?: string
  location: LatLng
  /** 高德原始 type 字符串拆出的标签 */
  tags: string[]
  rating?: number
  /** 建议游览时长，高德不提供，由 tags 推断 */
  dwellMinutes?: number
  raw?: unknown
}

/**
 * 价格的来源。
 *
 * 原来这里是 priceEstimated: boolean，但"公式推的"和"联网查的"对用户
 * 是完全不同的可信度，一个布尔值表达不了 —— 前者是量级正确的猜测，
 * 后者有可核对的来源链接。所以改成显式的三态。
 */
export type PriceSource =
  /** 星级 × 品牌档位 × 城市系数 推的，离线可用，最不准 */
  | 'formula'
  /** 大模型从训练数据里给的记忆价格。比公式懂品牌调性，但同样无法核实 */
  | 'llm'
  /** 大模型带联网搜索给的，有来源 URL，最接近真实挂牌价 */
  | 'search'
  /** OTA 接口返回的真实可订价格。当前没有实现 */
  | 'ota'

export interface PriceInfo {
  minCents: number
  maxCents: number
  source: PriceSource
  /** 用了哪些信号/查到了什么，用于在 UI 上解释"为什么是这个价" */
  basis: string[]
  /** search 来源时的参考链接，让用户能自己核对 */
  citations?: { title: string; url: string }[]
  /** 数据的时效。search/llm 来源要让用户知道价格是哪天的 */
  asOf?: string
}

export interface HotelResult extends PoiResult {
  brand?: string
  starRating?: number
  /** 每晚价格区间（分） */
  priceMinCents?: number
  priceMaxCents?: number
  priceSource: PriceSource
  priceBasis?: string[]
  priceCitations?: { title: string; url: string }[]
}

/**
 * 房价查询。从 HotelProvider 里拆出来是因为"酒店在哪"和"多少钱"
 * 来自完全不同的数据源：位置来自高德 POI，价格来自大模型/OTA。
 * 拆开后可以独立替换，也能对一批酒店批量查价而不是逐个调。
 */
export interface PriceProvider {
  readonly name: string
  readonly source: PriceSource

  /** 批量查价：一次调用覆盖多家酒店，省 token 也省往返 */
  lookup(params: {
    city: string
    hotels: { name: string; brand?: string; starRating?: number; district?: string }[]
    /** 入住日期，影响旺季/周末价格。缺省表示查平日均价 */
    checkInDate?: string
    nights?: number
  }): Promise<Map<string, PriceInfo>>
}

export type TravelMode = 'driving' | 'transit' | 'walking' | 'cycling'

/** 距离矩阵：cost[i][j] 表示 origins[i] → destinations[j] */
export interface DistanceMatrix {
  distanceMeters: number[][]
  durationSeconds: number[][]
}

export interface MapProvider {
  readonly name: string

  searchPoi(params: {
    city: string
    keywords?: string
    /** 高德的类型编码，如 "风景名胜" */
    types?: string
    /** 围绕某点搜索 */
    around?: { center: LatLng; radiusMeters: number }
    limit?: number
  }): Promise<PoiResult[]>

  /** 用户手输"外滩"这种自由文本，解析成具体 POI */
  geocode(params: { city: string; address: string }): Promise<PoiResult[]>

  distanceMatrix(params: {
    origins: LatLng[]
    destinations: LatLng[]
    mode: TravelMode
    city?: string
  }): Promise<DistanceMatrix>

  /** 两点之间的路径折线，用于前端画线 */
  route(params: {
    origin: LatLng
    destination: LatLng
    mode: TravelMode
    city?: string
  }): Promise<{
    distanceMeters: number
    durationSeconds: number
    polyline: [number, number][]
  } | null>
}

export interface HotelProvider {
  readonly name: string
  /** 价格来自哪里，决定 UI 上怎么标注 */
  readonly priceSource: PriceSource

  searchHotels(params: {
    city: string
    /** 搜索中心，通常是景点集合的地理重心 */
    center: LatLng
    radiusMeters: number
    brands?: string[]
    minStar?: number
    /** 每晚预算上限（分），用于过滤 */
    maxPriceCents?: number
    limit?: number
    /** 入住日期，传给价格查询用于区分平日/周末/旺季 */
    checkInDate?: string
  }): Promise<HotelResult[]>
}
