import { z } from 'zod'
import { runAgent } from '../react'
import { makeRouteTools, type SolveContext } from '../tools/route'
import type { PoiRow } from '../../db/queries'
import type { TravelMode } from '../../providers/types'
import type { PlanResult } from '../../optimizer/plan'

/**
 * 第三步：生成最佳线路计划。
 *
 * 分工是这一步的核心设计：
 *   算法负责"顺序和时刻"（可复现、最优、自洽）；
 *   LLM 负责"评价和解释"（这天是不是太赶、被挤掉的点怎么处理、每天叫什么主题）。
 *
 * 所以 agent 允许多次调 solveRoute 比较不同参数，但最终写库的是
 * 算法的输出，不是 LLM 编的时刻表。
 */

const outputSchema = z.object({
  dayThemes: z
    .array(
      z.object({
        dayIndex: z.number().int().min(0),
        theme: z.string().describe('这天的一句话主题，如"外滩+老城厢，步行为主"'),
        tip: z.string().describe('这天的实用提醒，如"豫园周末人多，建议开门就到"'),
      }),
    )
    .describe('每天一条，dayIndex 必须和 solveRoute 返回的对应'),
  /** 最终采用的参数，上层据此重算并落库 */
  chosenMode: z.enum(['driving', 'transit', 'walking', 'cycling']),
  chosenDays: z.number().int().min(1).max(14),
  droppedAdvice: z
    .array(z.object({ name: z.string(), advice: z.string() }))
    .default([])
    .describe('被挤掉的景点，给用户处理建议：删掉/加一天/缩短别的'),
  warnings: z.array(z.string()).default([]).describe('如"第2天通勤3小时，偏赶"'),
  summary: z.string().describe('3-4 句总结这份行程的思路'),
})

export type PlanRouteOutput = z.infer<typeof outputSchema>

const SYSTEM = `你是行程规划助手，负责第三步：确认并解释最优路线。

顺序和时刻表由算法计算（solveRoute 工具），不要自己排。你的任务是评估和解释。

工作方式：
1. 先调一次 solveRoute 看基线结果。
2. 结果不理想时换参数重试，最多 3 次。判断标准：
   - 某天通勤超过 150 分钟 → 试试换交通方式，或说明这天注定要奔波
   - 有景点被挤掉 → 试试加一天；天数固定就给 droppedAdvice
   - 某天空着而别天很满 → 用 checkLeg 看看是不是有个点特别远
3. 定稿后为每天写 theme 和 tip。

硬性要求：
- chosenMode 和 chosenDays 必须是你最后一次 solveRoute 用的参数，上层会照这个重算。
- dayThemes 要覆盖所有天，包括空着的那天（写"预留自由活动"之类）。
- 不要编造时刻。用户看到的时刻表来自算法，你说的话必须和它一致。
- warnings 只写真实存在的问题，没有就留空数组。`

export async function planRoute(params: {
  city: string
  pois: { poi: PoiRow; dwellMinutes: number; pinnedDayIndex: number | null; priority: number }[]
  hotel: PoiRow | null
  days: number
  dates: (string | null)[]
  dayStartTime: string
  dayEndTime: string
  defaultMode: TravelMode
  userMessage?: string
  tripId?: string
  userId?: string
}): Promise<{
  runId: string
  output: PlanRouteOutput
  /** agent 最后一次求解的结果。上层用 chosenMode/chosenDays 重算带折线的版本 */
  lastSolve: PlanResult | null
  attempts: number
}> {
  const ctx: SolveContext = { last: null, attempts: 0 }
  const tools = makeRouteTools({
    city: params.city,
    pois: params.pois,
    hotel: params.hotel,
    days: params.days,
    dates: params.dates,
    dayStartTime: params.dayStartTime,
    dayEndTime: params.dayEndTime,
    defaultMode: params.defaultMode,
    ctx,
  })

  const prompt = [
    `城市：${params.city}`,
    `天数：${params.days} 天`,
    `每天活动时间：${params.dayStartTime} - ${params.dayEndTime}`,
    `默认交通方式：${params.defaultMode}`,
    params.hotel
      ? `酒店：${params.hotel.name}（每天从这里出发并返回）`
      : '酒店：未选，路线不固定起终点',
    '',
    `待安排景点（共 ${params.pois.length} 个）：`,
    ...params.pois.map(
      (p) =>
        `- ${p.poi.name}（建议游览 ${p.dwellMinutes} 分钟${
          p.pinnedDayIndex !== null ? `，用户锁定在第 ${p.pinnedDayIndex + 1} 天` : ''
        }）`,
    ),
    params.userMessage ? `\n用户补充：${params.userMessage}` : null,
  ]
    .filter((x) => x !== null)
    .join('\n')

  const result = await runAgent({
    task: 'plan_route',
    system: SYSTEM,
    prompt,
    tools,
    schema: outputSchema,
    maxSteps: 10,
    timeoutMs: 120_000,
    tripId: params.tripId,
    userId: params.userId,
    userMessage: params.userMessage,
  })

  return {
    runId: result.runId,
    output: result.output,
    lastSolve: ctx.last,
    attempts: ctx.attempts,
  }
}
