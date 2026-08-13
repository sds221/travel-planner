import { API_ROUTES } from '@/types/api'
import type {
  ApiEnvelope,
  CreateTripBody,
  ListTripsData,
  CreateTripData,
  GetTripData,
  UpdateTripData,
  UpdateTripBody,
  RecommendPoisData,
  AddPoisData,
  AddCustomPoiData,
  ImportPlacesData,
  UpdatePoiBody,
  UpdatePoiData,
  RemovePoiData,
  RecommendHotelsBody,
  RecommendHotelsData,
  GeneratePlanData,
  GetRunsData,
} from '@/types/api'

/**
 * 前端唯一的请求出口。
 *
 * 请求/响应的类型都来自 @/types/api（前后端共用的契约），这个文件只负责
 * 发请求和拆包装。后期后端接入时,改动集中在两处:
 *   1. 路径变了 → 改 API_ROUTES(在 types/api.ts)
 *   2. 要带鉴权/统一头 → 改下面的 buildHeaders
 * 业务组件不用动。
 *
 * agent 相关的请求会跑几十秒（LLM + 多次工具调用），所以错误信息必须
 * 原样传给用户 —— 等了 40 秒只看到"失败"是最糟的体验。
 */

/**
 * 带上后端给的 kind，让 UI 能区分"程序出错"和"环境还没配好"。
 * 后者需要的是操作步骤，不是一个红色报错框。
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind?: string,
    /** HTTP 状态码,鉴权接入后 UI 需要靠它区分 401 和其它错误 */
    readonly status?: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * 统一请求头的注入点。
 *
 * 现在没有鉴权,所以只有 content-type。接后端时如果要带 token,只改这里
 * 一个函数,13 个接口自动都带上。
 */
function buildHeaders(init?: RequestInit): HeadersInit {
  return { 'content-type': 'application/json', ...init?.headers }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, headers: buildHeaders(init) })

  let body: ApiEnvelope<T>
  try {
    body = (await res.json()) as ApiEnvelope<T>
  } catch {
    throw new ApiError(`服务返回了非 JSON 响应（HTTP ${res.status}）`, undefined, res.status)
  }

  if (!body.ok) throw new ApiError(body.error, body.kind, res.status)
  return body.data
}

/** GET 之外的方法都是 JSON body,收敛掉重复的 method/stringify */
function post<T>(url: string, body?: unknown): Promise<T> {
  return request<T>(url, { method: 'POST', body: JSON.stringify(body ?? {}) })
}

function patch<T>(url: string, body: unknown): Promise<T> {
  return request<T>(url, { method: 'PATCH', body: JSON.stringify(body) })
}

export const api = {
  listTrips: () => request<ListTripsData>(API_ROUTES.trips()),

  createTrip: (input: CreateTripBody) => post<CreateTripData>(API_ROUTES.trips(), input),

  getTrip: (tripId: string) => request<GetTripData>(API_ROUTES.trip(tripId)),

  updateTrip: (tripId: string, body: UpdateTripBody) =>
    patch<UpdateTripData>(API_ROUTES.trip(tripId), body),

  // ── 第一步 ──
  recommendPois: (tripId: string, message: string) =>
    post<RecommendPoisData>(API_ROUTES.recommendPois(tripId), { message }),

  addPois: (tripId: string, poiIds: string[]) =>
    post<AddPoisData>(API_ROUTES.pois(tripId), { mode: 'existing', poiIds }),

  addCustomPoi: (tripId: string, name: string) =>
    post<AddCustomPoiData>(API_ROUTES.pois(tripId), { mode: 'custom', name }),

  importPlaces: (tripId: string, text: string) =>
    post<ImportPlacesData>(API_ROUTES.import(tripId), { text }),

  removePoi: (tripId: string, poiId: string) =>
    request<RemovePoiData>(
      `${API_ROUTES.pois(tripId)}?poiId=${encodeURIComponent(poiId)}`,
      { method: 'DELETE' },
    ),

  updatePoi: (tripId: string, poiId: string, body: Omit<UpdatePoiBody, 'poiId'>) =>
    patch<UpdatePoiData>(API_ROUTES.pois(tripId), { poiId, ...body }),

  // ── 第二步 ──
  recommendHotels: (tripId: string, input: RecommendHotelsBody) =>
    post<RecommendHotelsData>(API_ROUTES.recommendHotels(tripId), input),

  // ── 第三步 ──
  generatePlan: (tripId: string, message?: string) =>
    post<GeneratePlanData>(API_ROUTES.plan(tripId), { message }),

  getRuns: (tripId: string) => request<GetRunsData>(API_ROUTES.runs(tripId)),
}
