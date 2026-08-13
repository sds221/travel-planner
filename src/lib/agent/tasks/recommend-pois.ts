import { z } from 'zod'
import { runAgent } from '../react'
import { makePoiTools } from '../tools/poi'

/**
 * 第一步：景点推荐。
 *
 * agent 在这里做的事是"理解意图并选点"：用户说"带老人、不想太累、
 * 喜欢历史"，它要把这个翻译成搜索词、筛掉爬山的、控制总量。
 * 纯搜索做不到这一点，这是 LLM 在本项目里的第一个真实用途。
 */

const outputSchema = z.object({
  recommendations: z
    .array(
      z.object({
        poiId: z.string().describe('必须是工具返回的 id，不能自己编'),
        name: z.string(),
        reason: z.string().describe('一句话说明为什么推荐给这位用户'),
        suggestedDwellMinutes: z.number().int().min(15).max(600),
        priority: z.number().int().min(1).max(5).describe('5 最高，用于时间不够时决定保留谁'),
      }),
    )
    .max(20),
  /** 用户提到但没能解析成坐标的地点，需要前端反问 */
  unresolved: z.array(z.string()).default([]),
  summary: z.string().describe('给用户看的整体说明，2-3 句'),
})

export type RecommendPoisOutput = z.infer<typeof outputSchema>

const SYSTEM = `你是行程规划助手，负责第一步：帮用户确定要去哪些景点。

工作方式：
1. 先用 listPopular 或 searchAttractions 了解这个城市有什么。
2. 用户明确点名的地点，用 resolvePlace 逐个解析成坐标。解析不出来的放进 unresolved，不要猜。
3. 根据用户的偏好（同行人、体力、兴趣、天数）筛选，不要把搜到的都塞进去。

硬性要求：
- poiId 必须来自工具返回结果，绝对不能自己编造 UUID。
- 推荐数量匹配天数：一天 3-4 个点是舒适节奏，超过 5 个会很赶。
- suggestedDwellMinutes 要贴合实际：迪士尼半天以上，观景台 1 小时够了。
- reason 写给用户看，说清楚"为什么适合你"，不要复述景点简介。
- 不要在这一步谈酒店或具体路线，那是后面的步骤。`

export async function recommendPois(params: {
  city: string
  days: number
  partySize: number
  userMessage: string
  /** 用户已经选过的，避免重复推荐 */
  existingNames?: string[]
  tripId?: string
  userId?: string
}) {
  const tools = makePoiTools(params.city)

  const prompt = [
    `城市：${params.city}`,
    `天数：${params.days} 天`,
    `人数：${params.partySize} 人`,
    params.existingNames && params.existingNames.length > 0
      ? `已选景点（不要重复推荐）：${params.existingNames.join('、')}`
      : null,
    '',
    `用户需求：${params.userMessage || '没有特别说明，按热门程度推荐'}`,
  ]
    .filter((x) => x !== null)
    .join('\n')

  return runAgent({
    task: 'recommend_pois',
    system: SYSTEM,
    prompt,
    tools,
    schema: outputSchema,
    maxSteps: 8,
    tripId: params.tripId,
    userId: params.userId,
    userMessage: params.userMessage,
  })
}
