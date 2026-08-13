import { tool } from 'ai'
import { z } from 'zod'
import { getMapProvider } from '../../providers'
import { planTrip, type PlanResult } from '../../optimizer/plan'
import type { PoiRow } from '../../db/queries'
import type { TravelMode } from '../../providers/types'

/**
 * 第三步（生成路线）的工具集。
 *
 * solveRoute 是整个 agent 里唯一"有副作用但不落库"的工具：它跑完整的
 * 聚类+TSP+排时刻，把结果暂存在闭包里，由调用方在 agent 结束后写库。
 * 这样 agent 可以试算多次（改交通方式、改天数）而不产生垃圾数据。
 */

export interface SolveContext {
  /** 最近一次求解结果，供上层落库 */
  last: PlanResult | null
  attempts: number
}

export function makeRouteTools(params: {
  city: string
  pois: { poi: PoiRow; dwellMinutes: number; pinnedDayIndex: number | null; priority: number }[]
  hotel: PoiRow | null
  days: number
  dates: (string | null)[]
  dayStartTime: string
  dayEndTime: string
  defaultMode: TravelMode
  ctx: SolveContext
}) {
  const { city, pois, hotel, days, dates, dayStartTime, dayEndTime, defaultMode, ctx } = params

  return {
    solveRoute: tool({
      description:
        '用确定性算法求解行程：按地理位置分天、每天用 2-opt 排访问顺序、' +
        '按游览时长和营业时间排出时刻表。返回每天的点、通勤时长，以及' +
        '因时间不够被挤掉的点。可以改参数多次调用比较结果。',
      inputSchema: z.object({
        mode: z
          .enum(['driving', 'transit', 'walking', 'cycling'])
          .optional()
          .describe('交通方式，默认用行程设置'),
        days: z.number().int().min(1).max(14).optional().describe('分成几天，默认按日期算'),
        dayStartTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
        dayEndTime: z.string().regex(/^\d{2}:\d{2}$/).optional(),
      }),
      execute: async (args) => {
        const map = await getMapProvider()
        const result = await planTrip(map, {
          pois,
          hotel,
          days: args.days ?? days,
          mode: args.mode ?? defaultMode,
          dayStartTime: args.dayStartTime ?? dayStartTime,
          dayEndTime: args.dayEndTime ?? dayEndTime,
          city,
          dates,
          // 折线在 agent 试算阶段不拉，确认方案后由上层补
          withPolylines: false,
        })

        ctx.last = result
        ctx.attempts += 1

        const nameById = new Map(pois.map((p) => [p.poi.id, p.poi.name]))

        return {
          days: result.digest,
          totalTravelMinutes: result.summary.totalTravelMinutes,
          totalDistanceKm: Number((result.summary.totalDistanceMeters / 1000).toFixed(1)),
          droppedPois: result.summary.unassignedPoiIds.map((id) => nameById.get(id) ?? id),
          solver: result.summary.solver,
        }
      },
    }),

    /** 给 agent 一个"这两个点到底多远"的探针，用于判断是否该拆天 */
    checkLeg: tool({
      description: '查两个已选景点之间的通勤时间，用于判断它们是否适合安排在同一天。',
      inputSchema: z.object({
        fromName: z.string(),
        toName: z.string(),
        mode: z.enum(['driving', 'transit', 'walking', 'cycling']).optional(),
      }),
      execute: async ({ fromName, toName, mode }) => {
        const from = pois.find((p) => p.poi.name.includes(fromName))
        const to = pois.find((p) => p.poi.name.includes(toName))
        if (!from || !to) {
          return { error: '景点名没匹配到已选列表中的点', available: pois.map((p) => p.poi.name) }
        }
        const map = await getMapProvider()
        const r = await map.route({
          origin: from.poi.location,
          destination: to.poi.location,
          mode: mode ?? defaultMode,
          city,
        })
        if (!r) return { error: '路径查询失败' }
        return {
          from: from.poi.name,
          to: to.poi.name,
          minutes: Math.round(r.durationSeconds / 60),
          km: Number((r.distanceMeters / 1000).toFixed(1)),
        }
      },
    }),
  }
}
