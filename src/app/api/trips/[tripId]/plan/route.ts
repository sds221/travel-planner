import { z } from 'zod'
import { ok, fail, failFromError, parseBody } from '@/lib/api'
import {
  getTrip,
  listTripPois,
  tripDayCount,
  replaceItinerary,
  getItinerary,
  updateTripStatus,
  type TripStatus,
} from '@/lib/db/trips'
import { getPoisByIds } from '@/lib/db/queries'
import { planRoute } from '@/lib/agent/tasks/plan-route'
import { planTrip } from '@/lib/optimizer/plan'
import { getMapProvider } from '@/lib/providers'

/**
 * 第三步：生成行程图。
 *
 * 流程刻意分成两段：
 *   1. agent 用 solveRoute 试算若干次，挑出最好的参数并写出每天的主题；
 *   2. 用它选定的参数重算一遍，这次带上折线，然后落库。
 *
 * 为什么要重算：agent 试算时不拉折线（太慢，且它可能推翻这次结果）。
 * 定稿后再补折线，只为最终方案付一次代价。参数一致时距离矩阵全部命中
 * 缓存，重算的开销只有折线请求。
 */

const schema = z.object({
  message: z.string().max(500).optional(),
})

/** 日期序列：有起始日期就按天递增，没有就全 null */
function datesOf(startDate: string | null, days: number): (string | null)[] {
  if (!startDate) return Array.from({ length: days }, () => null)
  const base = Date.parse(`${startDate}T00:00:00Z`)
  if (!Number.isFinite(base)) return Array.from({ length: days }, () => null)
  return Array.from({ length: days }, (_, i) =>
    new Date(base + i * 86400000).toISOString().slice(0, 10),
  )
}

export async function POST(req: Request, { params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params
  const body = await parseBody(req, schema)
  if (!body.ok) return body.response

  // 失败时要还原，所以在改成 routing 之前记下来
  let previousStatus: TripStatus | undefined

  try {
    const trip = await getTrip(tripId)
    if (!trip) return fail('行程不存在', 404)
    previousStatus = trip.status

    const tripPois = await listTripPois(tripId)
    if (tripPois.length === 0) {
      return fail('请先在第一步选择景点', 409)
    }

    const hotel = trip.hotelPoiId ? (await getPoisByIds([trip.hotelPoiId]))[0] ?? null : null
    const days = tripDayCount(trip, tripPois.length)

    const solverPois = tripPois.map((p) => ({
      poi: p.poi,
      dwellMinutes: p.dwellMinutesOverride ?? p.poi.dwellMinutes ?? 90,
      pinnedDayIndex: p.pinnedDayIndex,
      priority: p.priority,
    }))

    await updateTripStatus(tripId, 'routing')

    /**
     * 没配 LLM key 时仍然出行程。
     *
     * 顺序和时刻表本来就全是算法算的（聚类分天 + 2-opt + 排时刻），
     * agent 的作用是评估方案和写每天的主题文案。没有它，行程图照样
     * 完整可用，只是少了说明文字 —— 这种情况下直接 503 是不必要的：
     * 用户明明能拿到核心产出。
     */
    let agentResult: Awaited<ReturnType<typeof planRoute>> | null = null
    let agentError: string | null = null
    try {
      agentResult = await planRoute({
        city: trip.city,
        pois: solverPois,
        hotel,
        days,
        dates: datesOf(trip.startDate, days),
        dayStartTime: trip.dayStartTime,
        dayEndTime: trip.dayEndTime,
        defaultMode: trip.defaultTravelMode,
        userMessage: body.data.message,
        tripId,
        userId: trip.userId,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // 只有"没配 key"这种可预期的情况才降级。模型真的调用失败
      // （超时、返回垃圾）应该照常报错，否则会掩盖真实问题。
      if (!/请在 \.env 里填上|未配置/.test(message)) throw err
      agentError = message
    }

    const chosenMode = agentResult?.output.chosenMode ?? trip.defaultTravelMode
    const finalDays = Math.min(Math.max(1, agentResult?.output.chosenDays ?? days), 14)

    // 用 agent 定的参数重算，这次带折线
    const map = await getMapProvider()
    const finalPlan = await planTrip(map, {
      pois: solverPois,
      hotel,
      days: finalDays,
      mode: chosenMode,
      dayStartTime: trip.dayStartTime,
      dayEndTime: trip.dayEndTime,
      city: trip.city,
      dates: datesOf(trip.startDate, finalDays),
      withPolylines: true,
    })

    // agent 写的主题和提醒贴回对应的那一天。
    // 存在 day 上而不是塞进首个 item 的 note —— 后者会覆盖条目自己的备注。
    const themeByDay = new Map(
      (agentResult?.output.dayThemes ?? []).map((t) => [t.dayIndex, t]),
    )
    const daysWithThemes = finalPlan.days.map((d) => {
      const t = themeByDay.get(d.dayIndex)
      return { ...d, theme: t?.theme ?? null, tip: t?.tip ?? null }
    })

    await replaceItinerary(tripId, daysWithThemes, finalPlan.summary)

    const droppedNames = finalPlan.summary.unassignedPoiIds
      .map((id) => tripPois.find((p) => p.poiId === id)?.poi.name)
      .filter((n): n is string => !!n)

    return ok({
      runId: agentResult?.runId ?? null,
      attempts: agentResult?.attempts ?? 0,
      summary:
        agentResult?.output.summary ??
        '行程已按地理位置分天并优化了访问顺序。配置 LLM_API_KEY 后可以让 AI 评估方案、写出每天的主题和提醒。',
      warnings: agentResult?.output.warnings ?? [],
      droppedAdvice: agentResult?.output.droppedAdvice ?? [],
      dropped: droppedNames,
      mode: chosenMode,
      days: finalDays,
      /** 没有 AI 文案时告诉前端原因，界面上给个提示而不是静默少一块 */
      degraded: agentError,
      routeSummary: finalPlan.summary,
      itinerary: await getItinerary(tripId),
    })
  } catch (err) {
    // 求解失败要把状态退回去，否则前端一直卡在"正在求解"。
    // 退回进来时的状态而不是一律标 stale —— stale 的含义是"曾经有可用行程、
    // 现在失效了"，对从没生成过的行程来说是误导。
    await updateTripStatus(tripId, previousStatus ?? 'draft_hotel').catch(() => {})
    return failFromError(err)
  }
}

/** 只读已生成的行程 */
export async function GET(_req: Request, { params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params
  try {
    const trip = await getTrip(tripId)
    if (!trip) return fail('行程不存在', 404)
    return ok({ trip, itinerary: await getItinerary(tripId) })
  } catch (err) {
    return failFromError(err)
  }
}
