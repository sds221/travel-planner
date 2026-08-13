import { describe, it, expect, beforeAll } from 'vitest'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { and, eq, sql, asc, desc } from 'drizzle-orm'
import * as schema from './schema'

/**
 * 校验 PostGIS 查询生成的 SQL 形状。
 *
 * 为什么值得单独测：这些查询的错误只在运行时暴露，而且症状具有误导性 ——
 * 忘记 ST_AsGeoJSON 会让 customType.fromDriver 收到 WKB 十六进制串，
 * 报的是 "Unexpected token in JSON"，看不出跟地理列有关。
 *
 * postgres.js 是惰性连接的，.toSQL() 不会真的连库，所以这个测试
 * 不需要 Postgres 实例。真实的 ST_DWithin 行为要靠集成测试覆盖。
 */

let db: ReturnType<typeof drizzle<typeof schema>>

beforeAll(() => {
  // 不会建立连接：只用来构造查询
  db = drizzle(postgres('postgresql://noop:noop@127.0.0.1:1/noop', { max: 1 }), { schema })
})

const geoJson = sql<string>`ST_AsGeoJSON(${schema.pois.location})`

describe('地理列的读取', () => {
  it('location 一定包在 ST_AsGeoJSON 里', () => {
    const { sql: text } = db.select({ location: geoJson }).from(schema.pois).toSQL()
    expect(text).toContain('ST_AsGeoJSON')
  })
})

describe('findHotelsNear 的 SQL', () => {
  function build(center: { lng: number; lat: number }, radius: number) {
    const point = sql`ST_SetSRID(ST_MakePoint(${center.lng}, ${center.lat}), 4326)::geography`
    return db
      .select({
        id: schema.pois.id,
        location: geoJson,
        distanceMeters: sql<number>`ST_Distance(${schema.pois.location}, ${point})`,
      })
      .from(schema.pois)
      .where(
        and(
          eq(schema.pois.kind, 'hotel'),
          eq(schema.pois.city, '上海'),
          sql`ST_DWithin(${schema.pois.location}, ${point}, ${radius})`,
        ),
      )
      .orderBy(asc(sql`ST_Distance(${schema.pois.location}, ${point})`))
      .toSQL()
  }

  it('用 ST_DWithin 过滤，能走 GiST 索引', () => {
    const { sql: text } = build({ lng: 121.49, lat: 31.24 }, 4000)
    // ST_Distance(...) < r 无法用索引，必须是 ST_DWithin
    expect(text).toContain('ST_DWithin')
    expect(text).not.toMatch(/ST_Distance\([^)]*\)\s*<\s*/)
  })

  it('坐标和半径走参数绑定，不拼进 SQL 文本', () => {
    const { sql: text, params } = build({ lng: 121.49, lat: 31.24 }, 4000)
    expect(text).not.toContain('121.49')
    expect(params).toContain(121.49)
    expect(params).toContain(31.24)
    expect(params).toContain(4000)
  })

  it('SRID 固定 4326，与 geography 列一致', () => {
    const { sql: text } = build({ lng: 121.49, lat: 31.24 }, 4000)
    expect(text).toContain('ST_SetSRID')
    expect(text).toContain('4326')
    expect(text).toContain('::geography')
  })

  it('按实际球面距离排序而不是按经纬度', () => {
    const { sql: text } = build({ lng: 121.49, lat: 31.24 }, 4000)
    expect(text).toMatch(/order by\s+ST_Distance/i)
  })
})

describe('名称模糊搜索的 SQL', () => {
  function build(query: string) {
    return db
      .select({ id: schema.pois.id })
      .from(schema.pois)
      .where(and(eq(schema.pois.city, '上海'), sql`${schema.pois.name} % ${query}`))
      .orderBy(desc(sql`similarity(${schema.pois.name}, ${query})`))
      .toSQL()
  }

  it('用 % 操作符命中 gin_trgm_ops 索引', () => {
    const { sql: text, params } = build('外滩')
    // LIKE '%x%' 用不了 trgm 索引，必须是 % 相似度操作符
    expect(text).toMatch(/"name"\s*%\s*\$\d/)
    expect(text).toContain('similarity')
    expect(params).toContain('外滩')
  })

  it('用户输入不进 SQL 文本，注入无从下手', () => {
    const { sql: text, params } = build("'; DROP TABLE pois; --")
    expect(text).not.toContain('DROP TABLE')
    expect(params).toContain("'; DROP TABLE pois; --")
  })
})

describe('POI upsert 的 ON CONFLICT', () => {
  function build() {
    return db
      .insert(schema.pois)
      .values({
        kind: 'attraction',
        source: 'amap',
        externalId: 'B000A7BM4H',
        name: '外滩',
        city: '上海',
        location: { lng: 121.4903, lat: 31.2397 },
      })
      .onConflictDoUpdate({
        target: [schema.pois.source, schema.pois.externalId],
        targetWhere: sql`${schema.pois.externalId} IS NOT NULL`,
        set: { name: sql`excluded.name` },
      })
      .toSQL()
  }

  it('带上部分索引的谓词', () => {
    // pois_source_external_uniq 是 WHERE external_id IS NOT NULL 的部分索引。
    // 少了这个 where，Postgres 会拒绝：no unique or exclusion constraint
    // matching the ON CONFLICT specification —— 而且只在真正写库时才报。
    const { sql: text } = build()
    expect(text).toMatch(/on conflict\s+\("source","external_id"\)\s+where/i)
    expect(text).toContain('IS NOT NULL')
  })

  it('冲突时更新而不是静默跳过', () => {
    expect(build().sql).toContain('do update set')
  })
})

describe('geoPoint customType', () => {
  it('写入时序列化成带 SRID 的 WKT', () => {
    const { params } = db
      .insert(schema.pois)
      .values({
        kind: 'attraction',
        source: 'user',
        name: 'X',
        city: '上海',
        location: { lng: 121.4903, lat: 31.2397 },
      })
      .toSQL()

    expect(params).toContain('SRID=4326;POINT(121.4903 31.2397)')
  })

  it('读取时把 GeoJSON 解析回 lng/lat', () => {
    // 用建好的列而不是 geoPoint()：后者返回的是 builder，没有 map 方法
    const parsed = schema.pois.location.mapFromDriverValue(
      '{"type":"Point","coordinates":[121.4903,31.2397]}',
    )
    expect(parsed).toEqual({ lng: 121.4903, lat: 31.2397 })
  })

  it('声明的列类型是 geography(Point,4326)', () => {
    expect(schema.pois.location.getSQLType()).toBe('geography(Point,4326)')
  })
})
