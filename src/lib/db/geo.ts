import { sql, type SQL } from 'drizzle-orm'
import { customType, type AnyPgColumn } from 'drizzle-orm/pg-core'

/**
 * 地理列的两种存储模式。
 *
 * PostGIS 是这个项目的首选 —— `ST_DWithin` 走 GiST 索引，酒店"位置合适"
 * 的查询在几万条 POI 上仍然是毫秒级。但 PostGIS 在 Homebrew 上要拉 131 个
 * 依赖（llvm、boost、aws-sdk-cpp，好几 GB），只为本地跑一下界面装它不值得。
 *
 * 所以留了 plain 模式：坐标存 jsonb，半径过滤用经纬度包围盒（能用 B-tree
 * 索引），精确距离用 SQL 里手写的 haversine。
 *
 * 两种模式的差别与代价：
 *   - plain 的距离是球面直线距离，和 PostGIS 的椭球距离在城市尺度上
 *     相差 0.3% 以内，对"挑离景点近的酒店"没有实际影响；
 *   - plain 的包围盒过滤会多召回一点（角落里的点），但后面按精确距离
 *     排序会把它们排到后面，limit 之后看不出来；
 *   - plain 没有 GiST 索引，几十万条 POI 时会明显变慢。生产环境用 PostGIS。
 *
 * 由 DB_GEO_MODE 切换，默认 postgis。切换模式必须重建表（列类型不同），
 * 不要在有数据的库上改。
 */
export type GeoMode = 'postgis' | 'plain'

export const geoMode: GeoMode = process.env.DB_GEO_MODE === 'plain' ? 'plain' : 'postgis'

export interface LatLng {
  lng: number
  lat: number
}

/**
 * PostGIS 模式：geography(Point,4326)，读写走 WKT/GeoJSON。
 * plain 模式：jsonb {lng, lat}。
 *
 * 两种模式共用一个 TS 类型，上层代码不需要知道差别。
 */
export const geoPoint = customType<{ data: LatLng; driverData: string }>({
  dataType: () => (geoMode === 'plain' ? 'jsonb' : 'geography(Point,4326)'),

  toDriver: (v) =>
    geoMode === 'plain'
      ? JSON.stringify({ lng: v.lng, lat: v.lat })
      : `SRID=4326;POINT(${v.lng} ${v.lat})`,

  fromDriver: (v) => parseGeo(v),
})

/**
 * 把驱动返回的值解析成 {lng, lat}。
 *
 * postgis 模式下查询必须用 geoSelect() 包一层 ST_AsGeoJSON，否则这里会
 * 收到 WKB 十六进制串然后 JSON.parse 失败 —— 报的错跟地理列毫无关系，
 * 很难查。plain 模式下直接就是 jsonb。
 */
export function parseGeo(raw: unknown): LatLng {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw

  // GeoJSON: {type:'Point', coordinates:[lng, lat]}
  const coords = (parsed as { coordinates?: [number, number] }).coordinates
  if (Array.isArray(coords)) return { lng: coords[0], lat: coords[1] }

  // plain 模式存的就是 {lng, lat}
  const obj = parsed as LatLng
  return { lng: obj.lng, lat: obj.lat }
}

/** select 地理列时用这个，两种模式各自返回可被 parseGeo 解析的形式 */
export function geoSelect(column: AnyPgColumn): SQL<string> {
  return geoMode === 'plain'
    ? sql<string>`${column}`
    : sql<string>`ST_AsGeoJSON(${column})`
}

/** 纬度一度约 111km；经度一度随纬度收缩 */
const METERS_PER_DEG_LAT = 111_320

function degLngAt(lat: number): number {
  return METERS_PER_DEG_LAT * Math.max(0.01, Math.cos((lat * Math.PI) / 180))
}

/**
 * 半径过滤。
 *
 * postgis: ST_DWithin，走 GiST 索引。
 * plain:   经纬度包围盒。这是能用索引的形式 —— 写成 haversine(...) < r
 *          会让每一行都算一次三角函数且用不上索引。多召回的角落点由
 *          后续的精确距离排序处理。
 */
export function withinRadius(column: AnyPgColumn, center: LatLng, meters: number): SQL {
  if (geoMode === 'plain') {
    const dLat = meters / METERS_PER_DEG_LAT
    const dLng = meters / degLngAt(center.lat)
    return sql`(${column}->>'lat')::float8 BETWEEN ${center.lat - dLat} AND ${center.lat + dLat}
      AND (${column}->>'lng')::float8 BETWEEN ${center.lng - dLng} AND ${center.lng + dLng}`
  }
  return sql`ST_DWithin(${column}, ${geogOf(center)}, ${meters})`
}

/**
 * 到某点的距离（米），可用于 ORDER BY。
 *
 * plain 模式在 SQL 里手写 haversine。写在 SQL 而不是取回 JS 里算，
 * 是为了让 ORDER BY ... LIMIT 只返回需要的那几行，而不是把半径内
 * 所有酒店都传输回来。
 */
export function distanceMeters(column: AnyPgColumn, center: LatLng): SQL<number> {
  if (geoMode === 'plain') {
    const lat1 = sql`radians((${column}->>'lat')::float8)`
    const lng1 = sql`radians((${column}->>'lng')::float8)`
    const lat2 = sql`radians(${center.lat}::float8)`
    const lng2 = sql`radians(${center.lng}::float8)`
    return sql<number>`(6371000 * 2 * asin(least(1, sqrt(
      power(sin((${lat2} - ${lat1}) / 2), 2)
      + cos(${lat1}) * cos(${lat2}) * power(sin((${lng2} - ${lng1}) / 2), 2)
    ))))`
  }
  return sql<number>`ST_Distance(${column}, ${geogOf(center)})`
}

function geogOf(center: LatLng): SQL {
  return sql`ST_SetSRID(ST_MakePoint(${center.lng}, ${center.lat}), 4326)::geography`
}

/**
 * 地理索引。postgis 用 GiST，plain 对包围盒查询用的两个表达式建 B-tree。
 * 返回 null 表示这个模式下不建索引（交给 drizzle 的调用方跳过）。
 */
export function geoIndexKind(): 'gist' | 'btree' {
  return geoMode === 'plain' ? 'btree' : 'gist'
}
