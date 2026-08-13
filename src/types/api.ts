/**
 * 前后端接口契约。
 *
 * 这个文件是前端和后端之间唯一的约定:每个接口的路径、方法、请求体、
 * 响应体都在这里声明一次,两边都 import 它。
 *
 * 为什么单独放一个文件,而不是内联在 client.ts 的泛型里:
 * 内联的话响应结构只有前端知道,后端同学得读 client.ts 反推。抽出来之后
 * 改接口会同时让前后端两侧编译报错,不会出现"前端以为返回 A、后端返回 B"
 * 这种只能在运行时发现的问题。
 *
 * 约定:
 * - 所有响应统一包一层 `{ ok, data }` / `{ ok, error }`(见 ApiEnvelope)
 * - 实体类型(Trip/Poi/...)在 ./index.ts,这里只放接口的入参和出参
 * - 路径统一由 API_ROUTES 生成,不在业务代码里拼字符串
 */

import type {
  Trip,
  TripDetail,
  Poi,
  TripPoi,
  PoiRecommendation,
  HotelRecommendation,
  ItineraryDay,
  AgentRun,
  LatLng,
} from './index'

// ── 统一响应包装 ────────────────────────────────────────────────────

export interface ApiOk<T> {
  ok: true
  data: T
}

export interface ApiErr {
  /**
   * kind 让 UI 能区分"程序出错"和"环境还没配好"——后者需要的是操作
   * 步骤,不是一个红色报错框。新增 kind 时记得同步 SETUP_KINDS。
   */
  ok: false
  error: string
  kind?: 'database' | 'migration' | 'config' | (string & {})
  note?: string
}

export type ApiEnvelope<T> = ApiOk<T> | ApiErr

// ── 路径 ───────────────────────────────────────────────────────────

/**
 * 所有接口路径的唯一来源。
 *
 * 之前 13 个路径散在 client.ts 各处,改前缀要挨个找。集中在这里之后,
 * 后端换挂载点只改这一个对象。
 */
export const API_ROUTES = {
  trips: () => '/api/trips',
  trip: (tripId: string) => `/api/trips/${tripId}`,
  pois: (tripId: string) => `/api/trips/${tripId}/pois`,
  recommendPois: (tripId: string) => `/api/trips/${tripId}/recommend-pois`,
  recommendHotels: (tripId: string) => `/api/trips/${tripId}/recommend-hotels`,
  import: (tripId: string) => `/api/trips/${tripId}/import`,
  plan: (tripId: string) => `/api/trips/${tripId}/plan`,
  runs: (tripId: string) => `/api/trips/${tripId}/runs`,
} as const

// ── 行程 ───────────────────────────────────────────────────────────

/** POST /api/trips */
export interface CreateTripBody {
  title: string
  city: string
  startDate?: string
  endDate?: string
  partySize?: number
}

/** GET /api/trips */
export type ListTripsData = Trip[]
/** POST /api/trips */
export type CreateTripData = Trip
/** GET /api/trips/:id */
export type GetTripData = TripDetail
/** PATCH /api/trips/:id */
export type UpdateTripData = Trip
export type UpdateTripBody = Partial<Trip>

// ── 第一步:景点 ────────────────────────────────────────────────────

/** POST /api/trips/:id/recommend-pois */
export interface RecommendPoisBody {
  message: string
}

export interface RecommendPoisData {
  runId: string
  summary: string
  /** agent 没能定位的地名,原样回显给用户,不静默丢弃 */
  unresolved: string[]
  recommendations: PoiRecommendation[]
  note?: string
}

/**
 * POST /api/trips/:id/pois
 *
 * 两种模式共用一个端点:existing 是从推荐结果里勾选,custom 是用户手输
 * 一个名字由后端去搜。判别字段是 mode。
 */
export type AddPoisBody =
  | { mode: 'existing'; poiIds: string[] }
  | { mode: 'custom'; name: string }

/**
 * custom 模式下如果搜到多个同名地点,除了加进去的那个,还会把其它候选
 * 一起返回,让用户确认是不是加错了。
 *
 * 注意 `added` 是 Poi(刚落库的地点本身),不是 TripPoi(行程与地点的关联)
 * —— 这一步只保证地点入库了,关联信息前端靠 refresh() 重新拉。
 *
 * TODO: otherCandidates 目前后端在发、前端没读 —— "选错了可以改"这个交互
 * 还没做。要么把它做出来,要么后端别再算这段。
 */
export interface AddCustomPoiAmbiguous {
  added: Poi
  otherCandidates: { name: string; address: string | null; district: string | null }[]
}

export type AddPoisData = TripPoi[]
export type AddCustomPoiData = TripPoi[] | AddCustomPoiAmbiguous

/** PATCH /api/trips/:id/pois */
export interface UpdatePoiBody {
  poiId: string
  priority?: number
  /** 钉死在某一天;null 表示解除钉死 */
  pinnedDayIndex?: number | null
  /** 覆盖默认游览时长(分钟);null 表示恢复默认 */
  dwellMinutesOverride?: number | null
}

export type UpdatePoiData = TripPoi[]
/** DELETE /api/trips/:id/pois?poiId= */
export type RemovePoiData = TripPoi[]

/** POST /api/trips/:id/import */
export interface ImportPlacesBody {
  /** 一行一个地名的纯文本 */
  text: string
}

export interface ImportPlacesData {
  imported: number
  /** renamed 表示搜到的正式名跟用户输入不一致,需要在 UI 上提示 */
  resolved: { input: string; matched: string; renamed: boolean }[]
  failed: { name: string; reason: string }[]
  /** 已经在行程里的,不重复添加 */
  skipped: string[]
  pois: TripPoi[]
}

// ── 第二步:酒店 ────────────────────────────────────────────────────

/** POST /api/trips/:id/recommend-hotels */
export interface RecommendHotelsBody {
  budgetCents?: number | null
  /** true=预算是每晚,false=预算是总价 */
  budgetPerNight?: boolean
  brands?: string[]
  message?: string
}

export interface RecommendHotelsData {
  runId: string
  summary: string
  /** 预算够不够,UI 据此决定要不要提醒用户放宽 */
  budgetVerdict: 'comfortable' | 'tight' | 'insufficient'
  /** 景点的几何中心,酒店按到它的通勤时间排序 */
  center: LatLng
  nights: number
  recommendations: HotelRecommendation[]
}

// ── 第三步:路线 ────────────────────────────────────────────────────

/** POST /api/trips/:id/plan */
export interface GeneratePlanBody {
  message?: string
}

export interface GeneratePlanData {
  /** 降级为纯算法输出时没有 agent run,为 null */
  runId: string | null
  attempts: number
  summary: string
  warnings: string[]
  /** 放不进行程的点,以及为什么放不进去 */
  droppedAdvice: { name: string; advice: string }[]
  dropped: string[]
  mode: string
  days: number
  /** 非 null 表示没有 AI 文案,值是降级原因 */
  degraded: string | null
  routeSummary: TripDetail['trip']['routeSummary']
  itinerary: ItineraryDay[]
}

// ── agent 轨迹 ─────────────────────────────────────────────────────

/**
 * GET /api/trips/:id/plan
 *
 * TODO: 前端没有调用方 —— 同样的数据已经在 `GET /api/trips/:id` 里返回了。
 * 保留是因为它对调试有用(单独看算法输出),但如果确认不需要就该删掉,
 * 少一个要维护的端点。
 */
export interface GetPlanData {
  trip: Trip
  itinerary: ItineraryDay[]
}

/** GET /api/trips/:id/runs */
export type GetRunsData = AgentRun[]
