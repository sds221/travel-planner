import {
  pgTable,
  pgEnum,
  uuid,
  text,
  varchar,
  integer,
  smallint,
  real,
  boolean,
  timestamp,
  date,
  jsonb,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'
import { relations, sql } from 'drizzle-orm'

/**
 * 地理列。默认 PostGIS 的 geography(Point,4326)，DB_GEO_MODE=plain 时
 * 退化为 jsonb + 包围盒查询（本地开发不想装 PostGIS 的 131 个依赖时用）。
 * 两种模式的实现和取舍见 geo.ts。
 */
export { geoPoint, geoMode } from './geo'
import { geoPoint, geoMode } from './geo'

// ── 枚举 ──────────────────────────────────────────────────────────────

/**
 * 行程草稿的状态机。三个步骤不是独立功能，而是同一个 trip 对象被逐步填充：
 * 选完酒店会改变每天的起终点，必须让已算出的路线失效并重算。
 */
export const tripStatusEnum = pgEnum('trip_status', [
  'draft_pois', // 第一步：正在选景点
  'draft_hotel', // 第二步：景点已定，正在选酒店
  'routing', // 正在求解路线
  'planned', // 第三步完成，有可用的行程图
  'stale', // 景点或酒店变更，已有路线失效待重算
  'archived',
])

export const poiKindEnum = pgEnum('poi_kind', [
  'attraction',
  'hotel',
  'restaurant',
  'transit', // 机场/火车站，作为首末日的锚点
])

/** 景点是系统推荐的还是用户自己补充的 —— 影响推荐算法的权重和可解释性 */
export const poiSourceEnum = pgEnum('poi_source', [
  'amap', // 高德 POI 搜索
  'curated', // 种子数据/运营维护
  'user', // 用户自定义输入
])

/**
 * 房价的来源，决定 UI 上的可信度标注。
 * 原来是 price_estimated 布尔值，但"公式推的"和"联网查到的"
 * 对用户是完全不同的东西，需要区分。
 */
export const priceSourceEnum = pgEnum('price_source', [
  'formula', // 星级×品牌×城市系数推算
  'llm', // 大模型记忆价格，无来源
  'search', // 大模型联网搜索，带来源链接
  'ota', // 订房平台真实价格（未实现）
])

export const travelModeEnum = pgEnum('travel_mode', [
  'driving',
  'transit',
  'walking',
  'cycling',
])

export const itemKindEnum = pgEnum('item_kind', [
  'visit', // 游览景点
  'meal',
  'hotel_checkin',
  'hotel_checkout',
  'transfer', // 通勤段
])

export const agentRunStatusEnum = pgEnum('agent_run_status', [
  'running',
  'succeeded',
  'failed',
])

// ── 用户 ──────────────────────────────────────────────────────────────

export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    phone: varchar('phone', { length: 20 }).unique(),
    email: varchar('email', { length: 255 }).unique(),
    displayName: text('display_name'),
    /** 长期偏好：常住城市、口味、步行耐受度、偏爱的酒店品牌等 */
    preferences: jsonb('preferences')
      .$type<{
        hotelBrands?: string[]
        maxWalkMinutes?: number
        pace?: 'relaxed' | 'balanced' | 'packed'
        avoidTags?: string[]
      }>()
      .default({})
      .notNull(),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [index('users_phone_idx').on(t.phone)],
)

// ── POI（景点/酒店/餐厅共用一张表）─────────────────────────────────────

export const pois = pgTable(
  'pois',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    kind: poiKindEnum('kind').notNull(),
    source: poiSourceEnum('source').notNull(),
    /** 高德 POI id，用于去重和二次拉详情；用户自定义的为空 */
    externalId: varchar('external_id', { length: 64 }),
    name: text('name').notNull(),
    city: varchar('city', { length: 64 }).notNull(),
    district: varchar('district', { length: 64 }),
    address: text('address'),
    location: geoPoint('location').notNull(),

    // ── 景点相关 ──
    /** 建议游览时长（分钟）。路线求解要用它排时间窗，缺失时按 kind 给默认值 */
    dwellMinutes: integer('dwell_minutes'),
    rating: real('rating'),
    /** 高德标签，如 "风景名胜;公园广场" */
    tags: text('tags').array().default(sql`ARRAY[]::text[]`),
    /**
     * 开放时间。求解器只用 open/close 做粗粒度时间窗校验，
     * 复杂的季节性规则交给 agent 在文案里提示用户。
     */
    openingHours: jsonb('opening_hours').$type<{
      // 0=周日
      weekly?: Record<number, { open: string; close: string }[]>
      note?: string
    }>(),

    // ── 酒店相关 ──
    brand: varchar('brand', { length: 64 }),
    /** 1-5，用于价格估算 */
    starRating: smallint('star_rating'),
    /**
     * 每晚价格区间(分)。准确度取决于 priceSource：
     * search 是联网查到的（带 priceCitations），llm 是模型记忆，
     * formula 是系数推算。任何一种都不是可下单的报价。
     */
    priceMinCents: integer('price_min_cents'),
    priceMaxCents: integer('price_max_cents'),
    priceSource: priceSourceEnum('price_source').default('formula').notNull(),
    /** 定价依据，用于在 UI 上解释"为什么是这个价" */
    priceBasis: text('price_basis').array().default(sql`ARRAY[]::text[]`),
    /** search 来源时的参考链接，让用户能自己核对 */
    priceCitations: jsonb('price_citations').$type<{ title: string; url: string }[]>(),
    priceUpdatedAt: timestamp('price_updated_at', { withTimezone: true }),

    raw: jsonb('raw'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    // 酒店"位置合适"的核心索引。
    // postgis 模式：GiST，ST_DWithin 能用上。
    // plain 模式：对包围盒查询用的两个表达式建 B-tree（GiST 在 jsonb 上没用）。
    ...(geoMode === 'plain'
      ? [
          index('pois_location_lat_idx').on(sql`(${t.location}->>'lat')`),
          index('pois_location_lng_idx').on(sql`(${t.location}->>'lng')`),
        ]
      : [index('pois_location_gist').using('gist', t.location)]),
    index('pois_kind_city_idx').on(t.kind, t.city),
    // 用户输入"外滩"要匹配到"外滩风景区"
    index('pois_name_trgm').using('gin', sql`${t.name} gin_trgm_ops`),
    uniqueIndex('pois_source_external_uniq')
      .on(t.source, t.externalId)
      .where(sql`${t.externalId} IS NOT NULL`),
  ],
)

// ── 行程 ──────────────────────────────────────────────────────────────

export const trips = pgTable(
  'trips',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .references(() => users.id, { onDelete: 'cascade' })
      .notNull(),
    title: text('title').notNull(),
    city: varchar('city', { length: 64 }).notNull(),
    status: tripStatusEnum('status').default('draft_pois').notNull(),

    startDate: date('start_date'),
    endDate: date('end_date'),
    partySize: smallint('party_size').default(2).notNull(),

    // ── 第二步的输入 ──
    /** 住宿总预算(分)。空表示用户还没填 */
    hotelBudgetCents: integer('hotel_budget_cents'),
    budgetPerNight: boolean('budget_per_night').default(true).notNull(),
    preferredBrands: text('preferred_brands').array().default(sql`ARRAY[]::text[]`),

    /** 选定的酒店，作为每天路线的起终点(depot) */
    hotelPoiId: uuid('hotel_poi_id').references(() => pois.id, {
      onDelete: 'set null',
    }),

    // ── 第三步的约束 ──
    defaultTravelMode: travelModeEnum('default_travel_mode')
      .default('transit')
      .notNull(),
    dayStartTime: varchar('day_start_time', { length: 5 })
      .default('09:00')
      .notNull(),
    dayEndTime: varchar('day_end_time', { length: 5 })
      .default('21:00')
      .notNull(),

    /**
     * 求解结果的摘要（总距离/总时长/未能安排的 POI）。
     * 明细在 trip_items，这里存概览避免每次聚合。
     */
    routeSummary: jsonb('route_summary').$type<{
      totalDistanceMeters: number
      totalTravelMinutes: number
      unassignedPoiIds: string[]
      solvedAt: string
      solver: string
    }>(),

    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    index('trips_user_status_idx').on(t.userId, t.status),
  ],
)

/**
 * 用户为这趟行程选中的景点集合（第一步的产出）。
 * 独立于 trip_items：这里是"想去哪些地方"，trip_items 是"哪天几点去"。
 * 求解失败或重算时 trip_items 会被清空重建，但选择不该丢。
 */
export const tripPois = pgTable(
  'trip_pois',
  {
    tripId: uuid('trip_id')
      .references(() => trips.id, { onDelete: 'cascade' })
      .notNull(),
    poiId: uuid('poi_id')
      .references(() => pois.id, { onDelete: 'cascade' })
      .notNull(),
    /** 用户手动排的优先级，求解器在必须丢点时优先保留高优先级 */
    priority: smallint('priority').default(3).notNull(),
    /** 用户是否锁定了某天，锁定的点不参与跨天重分配 */
    pinnedDayIndex: smallint('pinned_day_index'),
    /** 覆盖 poi.dwellMinutes，用户说"我想在这多待2小时" */
    dwellMinutesOverride: integer('dwell_minutes_override'),
    addedBy: poiSourceEnum('added_by').notNull(),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (t) => [
    uniqueIndex('trip_pois_pk').on(t.tripId, t.poiId),
    index('trip_pois_trip_idx').on(t.tripId),
  ],
)

export const tripDays = pgTable(
  'trip_days',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripId: uuid('trip_id')
      .references(() => trips.id, { onDelete: 'cascade' })
      .notNull(),
    dayIndex: smallint('day_index').notNull(), // 0-based
    date: date('date'),
    /** agent 生成的当天主题，如"外滩+老城厢，步行为主" */
    theme: text('theme'),
    /**
     * agent 写的当天实用提醒，如"豫园周末人多，建议开门就到"。
     * 和 trip_items.note 分开：那是"这一站"的说明，这是"这一天"的建议，
     * 挤在同一个字段里会覆盖掉条目自己的备注。
     */
    tip: text('tip'),
    distanceMeters: integer('distance_meters'),
    travelMinutes: integer('travel_minutes'),
  },
  (t) => [uniqueIndex('trip_days_uniq').on(t.tripId, t.dayIndex)],
)

/**
 * 排好序的行程条目（第三步的产出）。
 * seq 在 (tripDayId) 内唯一，就是当天的访问顺序。
 */
export const tripItems = pgTable(
  'trip_items',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripDayId: uuid('trip_day_id')
      .references(() => tripDays.id, { onDelete: 'cascade' })
      .notNull(),
    seq: smallint('seq').notNull(),
    kind: itemKindEnum('kind').notNull(),
    poiId: uuid('poi_id').references(() => pois.id, { onDelete: 'set null' }),

    arriveAt: varchar('arrive_at', { length: 5 }), // "09:30"
    departAt: varchar('depart_at', { length: 5 }),

    /** 从上一个条目到这里的通勤 */
    legMode: travelModeEnum('leg_mode'),
    legDistanceMeters: integer('leg_distance_meters'),
    legMinutes: integer('leg_minutes'),
    /** 折线，前端画路径用；GeoJSON LineString 的坐标数组 */
    legPolyline: jsonb('leg_polyline').$type<[number, number][]>(),

    /** agent 写的这一站的说明 */
    note: text('note'),
  },
  (t) => [
    uniqueIndex('trip_items_seq_uniq').on(t.tripDayId, t.seq),
    index('trip_items_day_idx').on(t.tripDayId),
  ],
)

/**
 * ReAct 执行轨迹。agent 出问题时没有 trace 基本没法查，
 * 也是复现用户投诉("为什么把这两个远的地方排在同一天")的唯一依据。
 */
export const agentRuns = pgTable(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tripId: uuid('trip_id').references(() => trips.id, { onDelete: 'cascade' }),
    userId: uuid('user_id').references(() => users.id, { onDelete: 'set null' }),
    /** 哪个流程：recommend_pois / recommend_hotels / plan_route */
    task: varchar('task', { length: 32 }).notNull(),
    status: agentRunStatusEnum('status').default('running').notNull(),
    model: varchar('model', { length: 64 }),
    userMessage: text('user_message'),
    /** 完整的 step 列表：每步的 tool 调用、入参、返回、文本 */
    steps: jsonb('steps')
      .$type<
        {
          index: number
          type: 'tool' | 'text'
          toolName?: string
          input?: unknown
          output?: unknown
          text?: string
          ms?: number
        }[]
      >()
      .default([])
      .notNull(),
    promptTokens: integer('prompt_tokens'),
    completionTokens: integer('completion_tokens'),
    error: text('error'),
    startedAt: timestamp('started_at', { withTimezone: true })
      .defaultNow()
      .notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true }),
  },
  (t) => [
    index('agent_runs_trip_idx').on(t.tripId),
    index('agent_runs_task_status_idx').on(t.task, t.status),
  ],
)

// ── 关系 ──────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  trips: many(trips),
}))

export const tripsRelations = relations(trips, ({ one, many }) => ({
  user: one(users, { fields: [trips.userId], references: [users.id] }),
  hotel: one(pois, { fields: [trips.hotelPoiId], references: [pois.id] }),
  tripPois: many(tripPois),
  days: many(tripDays),
  agentRuns: many(agentRuns),
}))

export const tripPoisRelations = relations(tripPois, ({ one }) => ({
  trip: one(trips, { fields: [tripPois.tripId], references: [trips.id] }),
  poi: one(pois, { fields: [tripPois.poiId], references: [pois.id] }),
}))

export const tripDaysRelations = relations(tripDays, ({ one, many }) => ({
  trip: one(trips, { fields: [tripDays.tripId], references: [trips.id] }),
  items: many(tripItems),
}))

export const tripItemsRelations = relations(tripItems, ({ one }) => ({
  day: one(tripDays, {
    fields: [tripItems.tripDayId],
    references: [tripDays.id],
  }),
  poi: one(pois, { fields: [tripItems.poiId], references: [pois.id] }),
}))
