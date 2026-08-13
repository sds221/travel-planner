import type {
  Trip,
  TripDetail,
  TripPoi,
  PoiRecommendation,
  HotelRecommendation,
  ItineraryDay,
  AgentRun,
  LatLng,
} from '@/types'

/**
 * 前端唯一的请求出口。
 *
 * agent 相关的请求会跑几十秒（LLM + 多次工具调用），所以错误信息必须
 * 原样传给用户 —— 等了 40 秒只看到"失败"是最糟的体验。
 */

interface ApiOk<T> {
  ok: true
  data: T
}
interface ApiErr {
  ok: false
  error: string
  /** 'database' | 'migration' | 'config' 之类，UI 据此显示对应的引导步骤 */
  kind?: string
  note?: string
}

/**
 * 带上后端给的 kind，让 UI 能区分"程序出错"和"环境还没配好"。
 * 后者需要的是操作步骤，不是一个红色报错框。
 */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly kind?: string,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...init?.headers },
  })

  let body: ApiOk<T> | ApiErr
  try {
    body = (await res.json()) as ApiOk<T> | ApiErr
  } catch {
    throw new ApiError(`服务返回了非 JSON 响应（HTTP ${res.status}）`)
  }

  if (!body.ok) throw new ApiError(body.error, body.kind)
  return body.data
}

export const api = {
  listTrips: () => request<Trip[]>('/api/trips'),

  createTrip: (input: {
    title: string
    city: string
    startDate?: string
    endDate?: string
    partySize?: number
  }) => request<Trip>('/api/trips', { method: 'POST', body: JSON.stringify(input) }),

  getTrip: (tripId: string) => request<TripDetail>(`/api/trips/${tripId}`),

  updateTrip: (tripId: string, patch: Partial<Trip>) =>
    request<Trip>(`/api/trips/${tripId}`, { method: 'PATCH', body: JSON.stringify(patch) }),

  // ── 第一步 ──
  recommendPois: (tripId: string, message: string) =>
    request<{
      runId: string
      summary: string
      unresolved: string[]
      recommendations: PoiRecommendation[]
      note?: string
    }>(`/api/trips/${tripId}/recommend-pois`, {
      method: 'POST',
      body: JSON.stringify({ message }),
    }),

  addPois: (tripId: string, poiIds: string[]) =>
    request<TripPoi[]>(`/api/trips/${tripId}/pois`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'existing', poiIds }),
    }),

  addCustomPoi: (tripId: string, name: string) =>
    request<
      | TripPoi[]
      | { added: unknown; otherCandidates: { name: string; address: string | null }[] }
    >(`/api/trips/${tripId}/pois`, {
      method: 'POST',
      body: JSON.stringify({ mode: 'custom', name }),
    }),

  importPlaces: (tripId: string, text: string) =>
    request<{
      imported: number
      resolved: { input: string; matched: string; renamed: boolean }[]
      failed: { name: string; reason: string }[]
      skipped: string[]
      pois: TripPoi[]
    }>(`/api/trips/${tripId}/import`, { method: 'POST', body: JSON.stringify({ text }) }),

  removePoi: (tripId: string, poiId: string) =>
    request<TripPoi[]>(`/api/trips/${tripId}/pois?poiId=${encodeURIComponent(poiId)}`, {
      method: 'DELETE',
    }),

  updatePoi: (
    tripId: string,
    poiId: string,
    patch: { priority?: number; pinnedDayIndex?: number | null; dwellMinutesOverride?: number | null },
  ) =>
    request<TripPoi[]>(`/api/trips/${tripId}/pois`, {
      method: 'PATCH',
      body: JSON.stringify({ poiId, ...patch }),
    }),

  // ── 第二步 ──
  recommendHotels: (
    tripId: string,
    input: { budgetCents?: number | null; budgetPerNight?: boolean; brands?: string[]; message?: string },
  ) =>
    request<{
      runId: string
      summary: string
      budgetVerdict: 'comfortable' | 'tight' | 'insufficient'
      center: LatLng
      nights: number
      recommendations: HotelRecommendation[]
    }>(`/api/trips/${tripId}/recommend-hotels`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  // ── 第三步 ──
  generatePlan: (tripId: string, message?: string) =>
    request<{
      runId: string | null
      attempts: number
      summary: string
      warnings: string[]
      droppedAdvice: { name: string; advice: string }[]
      dropped: string[]
      mode: string
      days: number
      /** 非 null 表示没有 AI 文案，值是原因 */
      degraded: string | null
      routeSummary: TripDetail['trip']['routeSummary']
      itinerary: ItineraryDay[]
    }>(`/api/trips/${tripId}/plan`, { method: 'POST', body: JSON.stringify({ message }) }),

  getRuns: (tripId: string) => request<AgentRun[]>(`/api/trips/${tripId}/runs`),
}
