import { and, eq, sql, inArray, notInArray, desc, asc } from 'drizzle-orm'
import { getDb, schema } from './index'
import { geoSelect, withinRadius, distanceMeters, parseGeo } from './geo'
import type { LatLng, PoiResult, HotelResult } from '../providers/types'

/**
 * 地理列的读取统一走 geoSelect()。
 *
 * postgis 模式下它会包一层 ST_AsGeoJSON —— 少了这层，customType.fromDriver
 * 会收到 WKB 十六进制串然后 JSON.parse 炸掉，报的错跟地理列毫无关系。
 * 这个约束容易在新查询里被忘掉，所以集中在这里。
 */
const geoJson = geoSelect(schema.pois.location)

/** select 时用的字段集合，避免每处重复写一遍 geoJson 包装 */
const poiColumns = {
  id: schema.pois.id,
  kind: schema.pois.kind,
  source: schema.pois.source,
  externalId: schema.pois.externalId,
  name: schema.pois.name,
  city: schema.pois.city,
  district: schema.pois.district,
  address: schema.pois.address,
  location: geoJson,
  dwellMinutes: schema.pois.dwellMinutes,
  rating: schema.pois.rating,
  tags: schema.pois.tags,
  openingHours: schema.pois.openingHours,
  brand: schema.pois.brand,
  starRating: schema.pois.starRating,
  priceMinCents: schema.pois.priceMinCents,
  priceMaxCents: schema.pois.priceMaxCents,
  priceSource: schema.pois.priceSource,
  priceBasis: schema.pois.priceBasis,
  priceCitations: schema.pois.priceCitations,
  priceUpdatedAt: schema.pois.priceUpdatedAt,
} as const

export interface PoiRow {
  id: string
  kind: (typeof schema.poiKindEnum.enumValues)[number]
  source: (typeof schema.poiSourceEnum.enumValues)[number]
  externalId: string | null
  name: string
  city: string
  district: string | null
  address: string | null
  location: LatLng
  dwellMinutes: number | null
  rating: number | null
  tags: string[] | null
  openingHours: { weekly?: Record<number, { open: string; close: string }[]>; note?: string } | null
  brand: string | null
  starRating: number | null
  priceMinCents: number | null
  priceMaxCents: number | null
  priceSource: (typeof schema.priceSourceEnum.enumValues)[number]
  priceBasis: string[] | null
  priceCitations: { title: string; url: string }[] | null
  priceUpdatedAt: Date | null
}

function toPoiRow(r: Record<string, unknown>): PoiRow {
  return { ...r, location: parseGeo(r.location) } as PoiRow
}

// ── POI 写入 ──────────────────────────────────────────────────────────

/**
 * 把 provider 返回的 POI 落库。同一个高德 id 反复出现是常态
 * （不同用户搜同一个景点），靠 (source, external_id) 唯一索引做 upsert。
 */
export async function upsertPois(
  results: (PoiResult | HotelResult)[],
  opts: { kind: PoiRow['kind']; source: PoiRow['source'] },
): Promise<PoiRow[]> {
  if (results.length === 0) return []
  const db = getDb()

  const values = results.map((r) => {
    const hotel = r as HotelResult
    return {
      kind: opts.kind,
      source: opts.source,
      externalId: r.externalId,
      name: r.name,
      city: r.city,
      district: r.district ?? null,
      address: r.address ?? null,
      location: r.location,
      dwellMinutes: r.dwellMinutes ?? null,
      rating: r.rating ?? null,
      tags: r.tags,
      brand: hotel.brand ?? null,
      starRating: hotel.starRating ?? null,
      priceMinCents: hotel.priceMinCents ?? null,
      priceMaxCents: hotel.priceMaxCents ?? null,
      priceSource: hotel.priceSource ?? 'formula',
      priceBasis: hotel.priceBasis ?? [],
      priceCitations: hotel.priceCitations ?? null,
      priceUpdatedAt: hotel.priceMinCents !== undefined ? new Date() : null,
      raw: r.raw ?? null,
    }
  })

  const rows = await db
    .insert(schema.pois)
    .values(values)
    .onConflictDoUpdate({
      target: [schema.pois.source, schema.pois.externalId],
      // pois_source_external_uniq 是带 WHERE 的部分索引，ON CONFLICT 必须
      // 重复它的谓词才能被 Postgres 推断出来，否则报
      // "no unique or exclusion constraint matching the ON CONFLICT specification"
      targetWhere: sql`${schema.pois.externalId} IS NOT NULL`,
      set: {
        name: sql`excluded.name`,
        address: sql`excluded.address`,
        location: sql`excluded.location`,
        rating: sql`excluded.rating`,
        tags: sql`excluded.tags`,
        brand: sql`excluded.brand`,
        starRating: sql`excluded.star_rating`,
        // 价格字段只在新值确实查到了价的时候覆盖 —— 联网查价失败时
        // 传进来的是 NULL，不能让一次限流把之前查到的好价格擦掉。
        priceMinCents: sql`COALESCE(excluded.price_min_cents, ${schema.pois.priceMinCents})`,
        priceMaxCents: sql`COALESCE(excluded.price_max_cents, ${schema.pois.priceMaxCents})`,
        priceSource: sql`CASE WHEN excluded.price_min_cents IS NULL
          THEN ${schema.pois.priceSource} ELSE excluded.price_source END`,
        priceBasis: sql`CASE WHEN excluded.price_min_cents IS NULL
          THEN ${schema.pois.priceBasis} ELSE excluded.price_basis END`,
        priceCitations: sql`CASE WHEN excluded.price_min_cents IS NULL
          THEN ${schema.pois.priceCitations} ELSE excluded.price_citations END`,
        priceUpdatedAt: sql`COALESCE(excluded.price_updated_at, ${schema.pois.priceUpdatedAt})`,
        raw: sql`excluded.raw`,
      },
    })
    .returning({ ...poiColumns })

  return rows.map((r) => toPoiRow(r as Record<string, unknown>))
}

/** 用户自定义输入的地点：没有 externalId，靠 (city, name) 去重 */
export async function upsertUserPoi(input: {
  name: string
  city: string
  location: LatLng
  address?: string
  dwellMinutes?: number
  tags?: string[]
}): Promise<PoiRow> {
  const db = getDb()
  const existing = await db
    .select({ ...poiColumns })
    .from(schema.pois)
    .where(
      and(
        eq(schema.pois.city, input.city),
        eq(schema.pois.name, input.name),
        eq(schema.pois.source, 'user'),
      ),
    )
    .limit(1)

  if (existing[0]) return toPoiRow(existing[0] as Record<string, unknown>)

  const inserted = await db
    .insert(schema.pois)
    .values({
      kind: 'attraction',
      source: 'user',
      name: input.name,
      city: input.city,
      address: input.address ?? null,
      location: input.location,
      dwellMinutes: input.dwellMinutes ?? 90,
      tags: input.tags ?? [],
    })
    .returning({ ...poiColumns })

  return toPoiRow(inserted[0] as Record<string, unknown>)
}

// ── POI 读取 ──────────────────────────────────────────────────────────

export async function getPoisByIds(ids: string[]): Promise<PoiRow[]> {
  if (ids.length === 0) return []
  const rows = await getDb()
    .select({ ...poiColumns })
    .from(schema.pois)
    .where(inArray(schema.pois.id, ids))
  return rows.map((r) => toPoiRow(r as Record<string, unknown>))
}

/**
 * 名称模糊搜索，走 pg_trgm 索引。
 * 用户输入"外滩"应该先命中库里已有的"外滩风景区"，避免每次都打高德。
 */
export async function searchPoisByName(params: {
  city: string
  query: string
  kind?: PoiRow['kind']
  limit?: number
}): Promise<PoiRow[]> {
  const { city, query, kind, limit = 10 } = params
  const rows = await getDb()
    .select({ ...poiColumns, score: sql<number>`similarity(${schema.pois.name}, ${query})` })
    .from(schema.pois)
    .where(
      and(
        eq(schema.pois.city, city),
        kind ? eq(schema.pois.kind, kind) : undefined,
        sql`${schema.pois.name} % ${query}`,
      ),
    )
    .orderBy(desc(sql`similarity(${schema.pois.name}, ${query})`))
    .limit(limit)
  return rows.map((r) => toPoiRow(r as Record<string, unknown>))
}

/** 城市热门景点：评分优先，用于"系统推荐"的冷启动 */
export async function listCuratedAttractions(params: {
  city: string
  limit?: number
  excludeIds?: string[]
}): Promise<PoiRow[]> {
  const { city, limit = 20, excludeIds } = params
  const rows = await getDb()
    .select({ ...poiColumns })
    .from(schema.pois)
    .where(
      and(
        eq(schema.pois.city, city),
        eq(schema.pois.kind, 'attraction'),
        excludeIds && excludeIds.length > 0
          ? notInArray(schema.pois.id, excludeIds)
          : undefined,
      ),
    )
    .orderBy(desc(sql`COALESCE(${schema.pois.rating}, 0)`), asc(schema.pois.name))
    .limit(limit)
  return rows.map((r) => toPoiRow(r as Record<string, unknown>))
}

/**
 * 酒店的"位置合适"查询 —— 这是把 PostGIS 引进来的唯一理由。
 * 给定景点集合的重心，找半径内的酒店，并按到重心的实际球面距离排序。
 * ST_DWithin 在 geography 上走 GiST 索引，不会全表扫。
 */
export async function findHotelsNear(params: {
  city: string
  center: LatLng
  radiusMeters: number
  maxPriceCents?: number
  brands?: string[]
  minStar?: number
  limit?: number
}): Promise<(PoiRow & { distanceMeters: number })[]> {
  const { city, center, radiusMeters, maxPriceCents, brands, minStar, limit = 20 } = params
  const dist = distanceMeters(schema.pois.location, center)

  const rows = await getDb()
    .select({ ...poiColumns, distanceMeters: dist })
    .from(schema.pois)
    .where(
      and(
        eq(schema.pois.kind, 'hotel'),
        eq(schema.pois.city, city),
        withinRadius(schema.pois.location, center, radiusMeters),
        maxPriceCents !== undefined
          ? sql`COALESCE(${schema.pois.priceMinCents}, 0) <= ${maxPriceCents}`
          : undefined,
        brands && brands.length > 0 ? inArray(schema.pois.brand, brands) : undefined,
        minStar !== undefined ? sql`COALESCE(${schema.pois.starRating}, 0) >= ${minStar}` : undefined,
      ),
    )
    // 按精确距离排序：plain 模式的包围盒会多召回角落里的点，
    // 排序 + limit 之后它们自然被挤掉
    .orderBy(asc(dist))
    .limit(limit)

  return rows.map((r) => ({
    ...toPoiRow(r as Record<string, unknown>),
    distanceMeters: Number((r as { distanceMeters: number }).distanceMeters),
  }))
}
