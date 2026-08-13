import { tool } from 'ai'
import { z } from 'zod'
import { getMapProvider } from '../../providers'
import { searchPoisByName, upsertPois, upsertUserPoi, listCuratedAttractions } from '../../db/queries'

/**
 * 第一步（选景点）的工具集。
 *
 * 设计上的一个关键取舍：工具返回的是已经落库的 POI（带 UUID），
 * 不是高德的原始结果。这样 agent 推荐的东西可以被直接引用到
 * trip_pois，不需要再做一次"名字对回 id"的模糊匹配。
 */

const poiOut = z.object({
  id: z.string(),
  name: z.string(),
  district: z.string().nullable(),
  address: z.string().nullable(),
  lng: z.number(),
  lat: z.number(),
  rating: z.number().nullable(),
  dwellMinutes: z.number().nullable(),
  tags: z.array(z.string()),
})

export function makePoiTools(city: string) {
  return {
    searchAttractions: tool({
      description:
        '按关键词或类型搜索城市里的景点。先查本地库，命中不足时再打高德。' +
        '返回的 id 可以直接用于把景点加入行程。',
      inputSchema: z.object({
        keywords: z
          .string()
          .optional()
          .describe('关键词，如"外滩""博物馆"。留空则按类型搜索热门景点'),
        types: z
          .string()
          .optional()
          .describe('高德类型词，如"风景名胜""博物馆""公园广场"'),
        limit: z.number().int().min(1).max(25).default(10),
      }),
      execute: async ({ keywords, types, limit }) => {
        // 本地库优先：省一次外部调用，也让重复搜索的结果稳定
        if (keywords) {
          const local = await searchPoisByName({ city, query: keywords, kind: 'attraction', limit })
          if (local.length >= Math.min(3, limit)) {
            return { source: 'local', pois: local.map(toOut) }
          }
        }

        const map = await getMapProvider()
        const found = await map.searchPoi({ city, keywords, types, limit })
        const saved = await upsertPois(found, { kind: 'attraction', source: 'amap' })
        return { source: 'amap', pois: saved.map(toOut) }
      },
    }),

    /**
     * 用户自定义输入的入口。"我还想去田子坊"这种自由文本必须先变成坐标，
     * 否则进不了距离矩阵。解析失败要明确告诉 agent，让它反问用户而不是瞎猜。
     */
    resolvePlace: tool({
      description:
        '把用户手写的地点名解析成具体坐标（用户自定义补充的景点走这里）。' +
        '返回多个候选时应向用户确认是哪一个。',
      inputSchema: z.object({
        name: z.string().describe('用户写的地点名'),
      }),
      execute: async ({ name }) => {
        const local = await searchPoisByName({ city, query: name, limit: 3 })
        if (local.length > 0) {
          return { resolved: true, source: 'local', candidates: local.map(toOut) }
        }

        const map = await getMapProvider()
        const found = await map.geocode({ city, address: name })
        if (found.length === 0) {
          return {
            resolved: false,
            candidates: [],
            hint: `在${city}没找到"${name}"，需要向用户确认更完整的名称或所在区域`,
          }
        }

        // 高德 POI 搜索命中的存为 amap 来源，纯地理编码结果存为用户自定义
        const isGeocode = found[0]!.externalId.startsWith('geo:')
        if (isGeocode) {
          const first = found[0]!
          const saved = await upsertUserPoi({
            name: first.name,
            city: first.city,
            location: first.location,
            address: first.address,
            dwellMinutes: first.dwellMinutes,
          })
          return { resolved: true, source: 'user', candidates: [toOut(saved)] }
        }

        const saved = await upsertPois(found, { kind: 'attraction', source: 'amap' })
        return { resolved: true, source: 'amap', candidates: saved.map(toOut) }
      },
    }),

    listPopular: tool({
      description: '列出本地库里该城市评分最高的景点，用于给用户一个起始推荐列表。',
      inputSchema: z.object({ limit: z.number().int().min(1).max(30).default(15) }),
      execute: async ({ limit }) => {
        const rows = await listCuratedAttractions({ city, limit })
        return { pois: rows.map(toOut) }
      },
    }),
  }
}

type Row = Awaited<ReturnType<typeof listCuratedAttractions>>[number]

function toOut(p: Row): z.infer<typeof poiOut> {
  return {
    id: p.id,
    name: p.name,
    district: p.district,
    address: p.address,
    lng: p.location.lng,
    lat: p.location.lat,
    rating: p.rating,
    dwellMinutes: p.dwellMinutes,
    tags: p.tags ?? [],
  }
}
