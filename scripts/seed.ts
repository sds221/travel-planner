import 'dotenv/config'
import { getSql, getDb, schema } from '../src/lib/db'
import { geoMode } from '../src/lib/db/geo'
import { sql } from 'drizzle-orm'

/**
 * 种子数据：几个城市的核心景点，带营业时间和游览时长。
 *
 * 为什么需要它：冷启动时库里没有任何 POI，"系统推荐"只能实时打高德，
 * 而高德不提供营业时间和建议游览时长 —— 这两个字段直接决定时刻表质量。
 * 这里的数据是人工整理的，比推断准。
 *
 * 数据是 2025 年整理的公开信息，营业时间会变，生产环境应该定期校对。
 */

const DAILY = (open: string, close: string) => ({
  weekly: Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, [{ open, close }]])),
})

/** 周一闭馆（博物馆的常见规则） */
const CLOSED_MONDAY = (open: string, close: string) => ({
  weekly: Object.fromEntries(
    [0, 2, 3, 4, 5, 6].map((d) => [d, [{ open, close }]]),
  ),
  note: '周一闭馆',
})

interface Seed {
  name: string
  city: string
  district: string
  lng: number
  lat: number
  dwellMinutes: number
  rating: number
  tags: string[]
  openingHours?: ReturnType<typeof DAILY>
}

const ATTRACTIONS: Seed[] = [
  // ── 上海 ──
  { name: '外滩', city: '上海', district: '黄浦区', lng: 121.4903, lat: 31.2397, dwellMinutes: 90, rating: 4.7, tags: ['风景名胜', '观景'], openingHours: DAILY('00:00', '23:59') },
  { name: '豫园', city: '上海', district: '黄浦区', lng: 121.4921, lat: 31.2272, dwellMinutes: 120, rating: 4.4, tags: ['风景名胜', '古迹'], openingHours: DAILY('08:45', '16:45') },
  { name: '上海博物馆', city: '上海', district: '黄浦区', lng: 121.4757, lat: 31.2287, dwellMinutes: 150, rating: 4.8, tags: ['博物馆'], openingHours: CLOSED_MONDAY('09:00', '17:00') },
  { name: '田子坊', city: '上海', district: '黄浦区', lng: 121.4677, lat: 31.2094, dwellMinutes: 90, rating: 4.2, tags: ['步行街', '创意园区'], openingHours: DAILY('10:00', '22:00') },
  { name: '上海迪士尼乐园', city: '上海', district: '浦东新区', lng: 121.6689, lat: 31.1434, dwellMinutes: 480, rating: 4.6, tags: ['主题公园'], openingHours: DAILY('08:30', '20:30') },
  { name: '东方明珠', city: '上海', district: '浦东新区', lng: 121.4997, lat: 31.2397, dwellMinutes: 90, rating: 4.5, tags: ['地标', '观景'], openingHours: DAILY('09:00', '21:00') },
  { name: '武康路', city: '上海', district: '徐汇区', lng: 121.4356, lat: 31.2117, dwellMinutes: 75, rating: 4.5, tags: ['步行街', '历史建筑'], openingHours: DAILY('00:00', '23:59') },
  { name: '南京路步行街', city: '上海', district: '黄浦区', lng: 121.4795, lat: 31.2352, dwellMinutes: 90, rating: 4.4, tags: ['步行街'], openingHours: DAILY('00:00', '23:59') },

  // ── 北京 ──
  { name: '故宫博物院', city: '北京', district: '东城区', lng: 116.3972, lat: 39.9175, dwellMinutes: 240, rating: 4.8, tags: ['博物馆', '世界遗产'], openingHours: CLOSED_MONDAY('08:30', '17:00') },
  { name: '天安门广场', city: '北京', district: '东城区', lng: 116.3975, lat: 39.9055, dwellMinutes: 60, rating: 4.7, tags: ['广场'], openingHours: DAILY('05:00', '22:00') },
  { name: '颐和园', city: '北京', district: '海淀区', lng: 116.2755, lat: 39.9998, dwellMinutes: 210, rating: 4.7, tags: ['风景名胜', '世界遗产'], openingHours: DAILY('06:30', '18:00') },
  { name: '八达岭长城', city: '北京', district: '延庆区', lng: 116.0166, lat: 40.3565, dwellMinutes: 240, rating: 4.7, tags: ['世界遗产', '山'], openingHours: DAILY('07:30', '17:30') },
  { name: '天坛公园', city: '北京', district: '东城区', lng: 116.4107, lat: 39.8822, dwellMinutes: 120, rating: 4.6, tags: ['公园', '世界遗产'], openingHours: DAILY('06:00', '21:00') },
  { name: '南锣鼓巷', city: '北京', district: '东城区', lng: 116.4032, lat: 39.9376, dwellMinutes: 90, rating: 4.2, tags: ['步行街'], openingHours: DAILY('00:00', '23:59') },
  { name: '中国国家博物馆', city: '北京', district: '东城区', lng: 116.4023, lat: 39.9036, dwellMinutes: 180, rating: 4.8, tags: ['博物馆'], openingHours: CLOSED_MONDAY('09:00', '17:00') },

  // ── 成都 ──
  { name: '成都大熊猫繁育研究基地', city: '成都', district: '成华区', lng: 104.1465, lat: 30.7336, dwellMinutes: 180, rating: 4.7, tags: ['动物园'], openingHours: DAILY('07:30', '18:00') },
  { name: '宽窄巷子', city: '成都', district: '青羊区', lng: 104.0553, lat: 30.6694, dwellMinutes: 120, rating: 4.4, tags: ['步行街', '古迹'], openingHours: DAILY('00:00', '23:59') },
  { name: '武侯祠', city: '成都', district: '武侯区', lng: 104.0446, lat: 30.6459, dwellMinutes: 120, rating: 4.5, tags: ['古迹', '纪念馆'], openingHours: DAILY('08:00', '20:00') },
  { name: '锦里古街', city: '成都', district: '武侯区', lng: 104.0475, lat: 30.6444, dwellMinutes: 90, rating: 4.4, tags: ['步行街'], openingHours: DAILY('10:00', '22:00') },
  { name: '杜甫草堂', city: '成都', district: '青羊区', lng: 104.0287, lat: 30.6592, dwellMinutes: 120, rating: 4.6, tags: ['古迹', '纪念馆'], openingHours: DAILY('08:00', '18:30') },
  { name: '都江堰景区', city: '成都', district: '都江堰市', lng: 103.6058, lat: 31.0031, dwellMinutes: 210, rating: 4.6, tags: ['风景名胜', '世界遗产'], openingHours: DAILY('08:00', '18:00') },

  // ── 杭州 ──
  { name: '西湖', city: '杭州', district: '西湖区', lng: 120.1478, lat: 30.2489, dwellMinutes: 180, rating: 4.8, tags: ['风景名胜', '湖', '世界遗产'], openingHours: DAILY('00:00', '23:59') },
  { name: '灵隐寺', city: '杭州', district: '西湖区', lng: 120.1006, lat: 30.2415, dwellMinutes: 120, rating: 4.6, tags: ['寺庙'], openingHours: DAILY('07:00', '18:00') },
  { name: '西溪国家湿地公园', city: '杭州', district: '西湖区', lng: 120.0672, lat: 30.2698, dwellMinutes: 180, rating: 4.5, tags: ['公园', '湿地'], openingHours: DAILY('07:30', '17:30') },
  { name: '河坊街', city: '杭州', district: '上城区', lng: 120.1683, lat: 30.2411, dwellMinutes: 90, rating: 4.3, tags: ['步行街'], openingHours: DAILY('00:00', '23:59') },
  { name: '雷峰塔', city: '杭州', district: '西湖区', lng: 120.1489, lat: 30.2318, dwellMinutes: 75, rating: 4.4, tags: ['古迹', '观景'], openingHours: DAILY('08:00', '20:00') },

  // ── 西安 ──
  { name: '秦始皇兵马俑博物馆', city: '西安', district: '临潼区', lng: 109.2783, lat: 34.3853, dwellMinutes: 210, rating: 4.7, tags: ['博物馆', '世界遗产'], openingHours: DAILY('08:30', '17:00') },
  { name: '西安城墙', city: '西安', district: '碑林区', lng: 108.9403, lat: 34.2583, dwellMinutes: 120, rating: 4.6, tags: ['古迹'], openingHours: DAILY('08:00', '19:00') },
  { name: '大雁塔', city: '西安', district: '雁塔区', lng: 108.9647, lat: 34.2189, dwellMinutes: 90, rating: 4.5, tags: ['寺庙', '古迹'], openingHours: DAILY('08:00', '18:30') },
  { name: '回民街', city: '西安', district: '莲湖区', lng: 108.9418, lat: 34.2633, dwellMinutes: 90, rating: 4.3, tags: ['步行街', '美食'], openingHours: DAILY('10:00', '23:30') },
  { name: '陕西历史博物馆', city: '西安', district: '雁塔区', lng: 108.9482, lat: 34.2295, dwellMinutes: 180, rating: 4.8, tags: ['博物馆'], openingHours: CLOSED_MONDAY('08:30', '18:00') },
]

async function main() {
  const db = getDb()

  // 名称模糊搜索需要 pg_trgm，两种地理模式都要
  await db.execute(sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`)

  // PostGIS 只在 postgis 模式下需要。plain 模式（jsonb + 包围盒）
  // 装不装都无所谓，硬建扩展会让本地开发的 seed 直接失败。
  if (geoMode === 'postgis') {
    await db.execute(sql`CREATE EXTENSION IF NOT EXISTS postgis`)
  }
  console.log(`地理模式: ${geoMode}`)

  console.log(`写入 ${ATTRACTIONS.length} 个景点...`)
  let inserted = 0
  for (const a of ATTRACTIONS) {
    await db
      .insert(schema.pois)
      .values({
        kind: 'attraction',
        source: 'curated',
        // curated 数据用名称做 externalId，重跑 seed 时靠唯一索引去重
        externalId: `curated:${a.city}:${a.name}`,
        name: a.name,
        city: a.city,
        district: a.district,
        location: { lng: a.lng, lat: a.lat },
        dwellMinutes: a.dwellMinutes,
        rating: a.rating,
        tags: a.tags,
        openingHours: a.openingHours ?? null,
      })
      .onConflictDoUpdate({
        target: [schema.pois.source, schema.pois.externalId],
        // 部分唯一索引需要重复谓词，见 queries.ts 里的同样处理
        targetWhere: sql`${schema.pois.externalId} IS NOT NULL`,
        set: {
          location: sql`excluded.location`,
          dwellMinutes: sql`excluded.dwell_minutes`,
          rating: sql`excluded.rating`,
          tags: sql`excluded.tags`,
          openingHours: sql`excluded.opening_hours`,
        },
      })
    inserted++
  }

  const cities = [...new Set(ATTRACTIONS.map((a) => a.city))]
  console.log(`完成：${inserted} 个景点，覆盖 ${cities.join('、')}`)
  console.log('酒店数据不预置 —— 第二步会按景点位置实时搜索并缓存。')

  await getSql().end()
}

main().catch((err) => {
  console.error('seed 失败:', err)
  process.exit(1)
})
