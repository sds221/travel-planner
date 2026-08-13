import { z } from 'zod'
import { runAgent } from '../react'
import { makeHotelTools } from '../tools/hotel'
import type { LatLng } from '../../providers/types'

/**
 * 第二步：酒店推荐。
 *
 * 这一步依赖第一步的产出：搜索中心是已选景点的重心，评分里"位置"
 * 这一项就是到这些景点的平均通勤。所以流程是耦合的 ——
 * 换景点必须重新推荐酒店。
 */

const outputSchema = z.object({
  recommendations: z
    .array(
      z.object({
        poiId: z.string().describe('必须是 searchHotels 返回的 id'),
        name: z.string(),
        reason: z.string().describe('为什么推荐：位置/价位/品牌，一句话'),
        /**
         * 每晚价格（分），取工具返回区间的中值。
         * 工具没给价格时填 null —— 不要自己编一个数字。
         */
        nightlyCents: z.number().int().nullable(),
        commuteNote: z.string().describe('到主要景点的通勤概况，如"到外滩地铁20分钟"'),
      }),
    )
    .max(6),
  budgetVerdict: z
    .enum(['comfortable', 'tight', 'insufficient'])
    .describe('用户预算在这个城市这个位置是否够用'),
  summary: z.string().describe('2-3 句给用户的建议'),
})

export type RecommendHotelsOutput = z.infer<typeof outputSchema>

const SYSTEM = `你是行程规划助手，负责第二步：根据已选景点和预算推荐酒店。

工作方式：
1. 用 searchHotels 搜索。景点分散时（重心到各点距离差很大）要放大 radiusMeters 重搜。
2. 对排名靠前的 1-2 家用 checkCommute 验证真实通勤时间，直线距离在有江河阻隔的城市会骗人。
3. 挑 3-5 家，覆盖不同价位档次，不要全推最贵的。

关于价格 —— 严格按工具返回的 priceSource 区分口径：
- priceSource=search 或 ota：价格查过订房平台，可以具体说"大约 480 元一晚"，
  但要提醒实际房费随日期和房型浮动。
- priceSource=llm：只是行情判断，说"这个档位通常 400-600 元"，不要给单一数字。
- priceSource=formula：粗估，只能用于比较档次，不要在文案里报具体价格。
- 价格为 null 表示没查到。如实说"未获取到价格"，绝对不要编一个数字填上。
- 用户预算明显不够时，如实说 insufficient，并建议放宽位置或降低档次，不要硬凑。

工具返回的 priceNote 字段会说明这批结果的价格来源，按它的口径写文案。

其它要求：
- poiId 必须来自工具返回，不能编造。
- 用户指定了品牌就优先在这些品牌里选；一家都搜不到时说明情况并给替代。
- 不要在这一步排具体路线。`

export async function recommendHotels(params: {
  city: string
  center: LatLng
  poiPoints: { id: string; name: string; location: LatLng }[]
  nights: number
  budgetCents: number | null
  budgetPerNight: boolean
  preferredBrands: string[]
  checkInDate?: string
  userMessage?: string
  tripId?: string
  userId?: string
}) {
  const tools = makeHotelTools({
    city: params.city,
    poiPoints: params.poiPoints,
    center: params.center,
    checkInDate: params.checkInDate,
  })

  const perNight =
    params.budgetCents === null
      ? null
      : params.budgetPerNight
        ? params.budgetCents
        : Math.round(params.budgetCents / Math.max(1, params.nights))

  const prompt = [
    `城市：${params.city}`,
    `住宿晚数：${params.nights} 晚`,
    perNight !== null
      ? `每晚预算：约 ${(perNight / 100).toFixed(0)} 元（${
          params.budgetPerNight ? '用户按每晚填写' : `总预算 ${(params.budgetCents! / 100).toFixed(0)} 元均摊`
        }）`
      : '预算：用户未填，按中端档位推荐并说明',
    params.preferredBrands.length > 0
      ? `偏好品牌：${params.preferredBrands.join('、')}`
      : '偏好品牌：无',
    params.checkInDate ? `入住日期：${params.checkInDate}` : null,
    '',
    `已选景点（共 ${params.poiPoints.length} 个）：${params.poiPoints.map((p) => p.name).join('、')}`,
    `景点重心坐标：${params.center.lng.toFixed(4)},${params.center.lat.toFixed(4)}`,
    params.userMessage ? `\n用户补充：${params.userMessage}` : null,
  ]
    .filter((x) => x !== null)
    .join('\n')

  return runAgent({
    task: 'recommend_hotels',
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
