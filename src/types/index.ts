/** 前后端共用的视图类型。与 db 层的 Row 类型刻意分开：
 *  API 会附加 alreadySelected / score 这类只对 UI 有意义的字段。 */

export interface LatLng {
  lng: number
  lat: number
}

export type TravelMode = 'driving' | 'transit' | 'walking' | 'cycling'

/** 房价来源，决定 UI 上的可信度标注。见 lib/providers/types.ts */
export type PriceSource = 'formula' | 'llm' | 'search' | 'ota'

export type TripStatus =
  | 'draft_pois'
  | 'draft_hotel'
  | 'routing'
  | 'planned'
  | 'stale'
  | 'archived'

export interface Trip {
  id: string
  title: string
  city: string
  status: TripStatus
  startDate: string | null
  endDate: string | null
  partySize: number
  hotelBudgetCents: number | null
  budgetPerNight: boolean
  preferredBrands: string[] | null
  hotelPoiId: string | null
  defaultTravelMode: TravelMode
  dayStartTime: string
  dayEndTime: string
  routeSummary: {
    totalDistanceMeters: number
    totalTravelMinutes: number
    unassignedPoiIds: string[]
    solvedAt: string
    solver: string
  } | null
}

export interface Poi {
  id: string
  kind: 'attraction' | 'hotel' | 'restaurant' | 'transit'
  source: 'amap' | 'curated' | 'user'
  name: string
  city: string
  district: string | null
  address: string | null
  location: LatLng
  dwellMinutes: number | null
  rating: number | null
  tags: string[] | null
  brand: string | null
  starRating: number | null
  priceMinCents: number | null
  priceMaxCents: number | null
  priceSource: PriceSource
  priceBasis: string[] | null
  priceCitations: { title: string; url: string }[] | null
}

export interface TripPoi {
  poiId: string
  priority: number
  pinnedDayIndex: number | null
  dwellMinutesOverride: number | null
  addedBy: Poi['source']
  note: string | null
  poi: Poi
}

export interface PoiRecommendation {
  poiId: string
  name: string
  reason: string
  suggestedDwellMinutes: number
  priority: number
  district: string | null
  address: string | null
  rating: number | null
  tags: string[]
  location: LatLng
  alreadySelected: boolean
}

export interface HotelRecommendation {
  poiId: string
  name: string
  reason: string
  /** 每晚价格（分）。null 表示没查到价 */
  nightlyCents: number | null
  commuteNote: string
  brand: string | null
  starRating: number | null
  address: string | null
  location: LatLng
  priceMinCents: number | null
  priceMaxCents: number | null
  priceSource: PriceSource
  priceCitations: { title: string; url: string }[] | null
}

export interface ItineraryItem {
  id: string
  seq: number
  kind: 'visit' | 'meal' | 'hotel_checkin' | 'hotel_checkout' | 'transfer'
  poiId: string | null
  arriveAt: string | null
  departAt: string | null
  legMode: TravelMode | null
  legDistanceMeters: number | null
  legMinutes: number | null
  legPolyline: [number, number][] | null
  note: string | null
  poi: Poi | null
}

export interface ItineraryDay {
  dayIndex: number
  date: string | null
  theme: string | null
  /** agent 写的当天提醒，与条目级 note 区分 */
  tip: string | null
  distanceMeters: number | null
  travelMinutes: number | null
  items: ItineraryItem[]
}

export interface TripDetail {
  trip: Trip
  days: number
  pois: TripPoi[]
  hotel: Poi | null
  itinerary: ItineraryDay[]
}

export interface AgentRun {
  id: string
  task: string
  status: 'running' | 'succeeded' | 'failed'
  model: string | null
  userMessage: string | null
  steps: {
    index: number
    type: 'tool' | 'text'
    toolName?: string
    input?: unknown
    output?: unknown
    text?: string
    ms?: number
  }[]
  promptTokens: number | null
  completionTokens: number | null
  error: string | null
  startedAt: string
  finishedAt: string | null
  durationMs: number | null
}
