import { z } from 'zod'
import { okAs, fail, failFromError, parseBody } from '@/lib/api'
import type { ImportPlacesData } from '@/types/api'
import { getTrip, addTripPois, listTripPois, updateTrip } from '@/lib/db/trips'
import { upsertPois, upsertUserPoi, searchPoisByName } from '@/lib/db/queries'
import { getMapProvider } from '@/lib/providers'

/**
 * 自定义模块：批量导入"我要去的地方"。
 *
 * 用户手上常常已经有一份清单（小红书收藏、朋友推荐），逐个搜索加入太慢。
 * 这个接口接受一整段文本，逐行解析成坐标后一次性加入行程，
 * 接着就可以直接生成最优路线。
 *
 * 解析失败的行必须单独回给用户 —— 静默丢掉会让他以为都导进去了，
 * 直到看行程图才发现少了几个地方。
 */

const schema = z.object({
  /** 一行一个地点，或用逗号/顿号分隔 */
  text: z.string().min(1).max(2000),
  /** 导入后是否立刻推进到第二步 */
  advanceStep: z.boolean().default(true),
})

/** 拆行：兼容换行、中英文逗号、顿号、分号，顺手去掉序号前缀 */
function splitPlaces(text: string): string[] {
  return text
    .split(/[\n\r,，、;；]+/)
    .map((s) => s.trim().replace(/^\d+[.、)）]\s*/, ''))
    .filter((s) => s.length > 0 && s.length <= 40)
    .slice(0, 40)
}

export async function POST(req: Request, { params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params
  const body = await parseBody(req, schema)
  if (!body.ok) return body.response

  try {
    const trip = await getTrip(tripId)
    if (!trip) return fail('行程不存在', 404)

    const names = splitPlaces(body.data.text)
    if (names.length === 0) return fail('没解析出任何地点，一行写一个地名试试')

    const existing = await listTripPois(tripId)
    const existingNames = new Set(existing.map((e) => e.poi.name))

    const map = await getMapProvider()
    const resolved: { name: string; poiId: string; matchedName: string; source: string }[] = []
    const failed: { name: string; reason: string }[] = []
    const skipped: string[] = []

    // 串行解析：40 个地名并发打高德会触发限流，用户等 10 秒可以接受
    for (const name of names) {
      if (existingNames.has(name)) {
        skipped.push(name)
        continue
      }

      try {
        // 本地库优先，省一次外部调用
        const local = await searchPoisByName({ city: trip.city, query: name, limit: 1 })
        if (local[0]) {
          resolved.push({
            name,
            poiId: local[0].id,
            matchedName: local[0].name,
            source: local[0].source,
          })
          continue
        }

        const candidates = await map.geocode({ city: trip.city, address: name })
        if (candidates.length === 0) {
          failed.push({ name, reason: '没找到匹配的地点' })
          continue
        }

        const first = candidates[0]!
        const saved = first.externalId.startsWith('geo:')
          ? await upsertUserPoi({
              name,
              city: trip.city,
              location: first.location,
              address: first.address,
              dwellMinutes: first.dwellMinutes,
            })
          : (await upsertPois([first], { kind: 'attraction', source: 'amap' }))[0]!

        resolved.push({ name, poiId: saved.id, matchedName: saved.name, source: saved.source })
      } catch (err) {
        failed.push({ name, reason: err instanceof Error ? err.message : '解析失败' })
      }
    }

    if (resolved.length > 0) {
      await addTripPois(
        tripId,
        resolved.map((r) => ({
          poiId: r.poiId,
          addedBy: r.source === 'user' ? ('user' as const) : ('amap' as const),
        })),
      )
      if (body.data.advanceStep && trip.status === 'draft_pois') {
        await updateTrip(tripId, { status: 'draft_hotel' })
      }
    }

    return okAs<ImportPlacesData>({
      imported: resolved.length,
      // 匹配到的名字和用户写的不一样时要显式告知，"迪士尼"可能匹配成"迪士尼小镇"
      resolved: resolved.map((r) => ({
        input: r.name,
        matched: r.matchedName,
        renamed: r.matchedName !== r.name,
      })),
      failed,
      skipped,
      pois: await listTripPois(tripId),
    })
  } catch (err) {
    return failFromError(err)
  }
}
