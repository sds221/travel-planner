/**
 * ⚠️ 公式估价 —— 价格链上最不准的一档，纯离线兜底。
 *
 * 高德 POI 能给出真实的酒店位置、品牌、星级，但不给房价。这个模块用
 * 星级 × 品牌档位 × 城市系数 推断一个区间，产出标记为 priceSource='formula'。
 *
 * 优先级：ota > search(联网查价) > llm(模型行情) > formula(这里)。
 * 保留它的理由是前面几档都会失败 —— 没配 key、限流、超时 ——
 * 而酒店列表不该因为查不到价就整个空掉。见 price-chain.ts 的降级逻辑。
 *
 * 系数来自 2024-2025 年国内酒店市场的公开均价区间，属于量级正确、
 * 单店不准的水平。不要用它做任何涉及支付的判断。
 */

/** 品牌 → 档位。档位决定价格倍率 */
const BRAND_TIERS: Record<string, number> = {
  // 经济型
  如家: 1,
  汉庭: 1,
  '7天': 1,
  锦江之星: 1,
  格林豪泰: 1,
  宜必思: 1,
  // 中端
  全季: 2,
  桔子: 2,
  亚朵: 2,
  维也纳: 2,
  希尔顿欢朋: 2,
  智选假日: 2,
  万枫: 2,
  // 高端
  希尔顿: 3,
  万豪: 3,
  喜来登: 3,
  皇冠假日: 3,
  凯悦: 3,
  索菲特: 3,
  洲际: 3,
  康莱德: 3,
  // 奢华
  丽思卡尔顿: 4,
  柏悦: 4,
  华尔道夫: 4,
  安缦: 4,
  四季: 4,
  宝格丽: 4,
  瑞吉: 4,
}

/** 一线/新一线城市房价显著高于均值 */
const CITY_MULTIPLIER: Record<string, number> = {
  北京: 1.35,
  上海: 1.4,
  深圳: 1.25,
  广州: 1.15,
  杭州: 1.2,
  三亚: 1.45,
  成都: 1.0,
  重庆: 0.95,
  西安: 0.95,
  南京: 1.05,
  苏州: 1.05,
  武汉: 0.95,
  厦门: 1.1,
  青岛: 1.0,
  丽江: 0.9,
  大理: 0.9,
}

/** 每晚基准价（分），按档位。区间的中值 */
const TIER_BASE_CENTS: Record<number, number> = {
  1: 22000, // 220 元
  2: 45000, // 450 元
  3: 90000, // 900 元
  4: 220000, // 2200 元
}

/** 星级在缺品牌信息时作为档位的替代信号 */
function tierFromStar(star: number): number {
  if (star >= 5) return 4
  if (star === 4) return 3
  if (star === 3) return 2
  return 1
}

export function inferBrand(name: string): string | undefined {
  for (const brand of Object.keys(BRAND_TIERS)) {
    if (name.includes(brand)) return brand
  }
  return undefined
}

/** 高德 POI 的 type 里可能带 "四星级宾馆" 这类信息 */
export function inferStarRating(name: string, tags: string[]): number | undefined {
  const text = `${name} ${tags.join(' ')}`
  if (/五星级|5星/.test(text)) return 5
  if (/四星级|4星/.test(text)) return 4
  if (/三星级|3星/.test(text)) return 3
  if (/二星级|2星/.test(text)) return 2
  const brand = inferBrand(name)
  if (brand) {
    const tier = BRAND_TIERS[brand]!
    return tier === 4 ? 5 : tier === 3 ? 4 : tier === 2 ? 3 : 2
  }
  return undefined
}

export interface PriceEstimate {
  minCents: number
  maxCents: number
  estimated: true
  /** 用了哪些信号，便于在 UI 上解释"为什么是这个价" */
  basis: string[]
}

export function estimateNightlyPrice(params: {
  name: string
  city: string
  brand?: string
  starRating?: number
  /** 高德 biz_ext.cost，偶尔有值，是人均消费不是房价，但比纯推断强 */
  reportedCost?: number
}): PriceEstimate {
  const basis: string[] = []

  const brand = params.brand ?? inferBrand(params.name)
  const star = params.starRating ?? inferStarRating(params.name, [])

  let tier: number
  if (brand && BRAND_TIERS[brand] !== undefined) {
    tier = BRAND_TIERS[brand]!
    basis.push(`品牌:${brand}`)
  } else if (star !== undefined) {
    tier = tierFromStar(star)
    basis.push(`星级:${star}`)
  } else {
    tier = 2
    basis.push('默认中端档位')
  }

  let center = TIER_BASE_CENTS[tier]!

  const cityMult = CITY_MULTIPLIER[params.city]
  if (cityMult !== undefined) {
    center *= cityMult
    basis.push(`城市系数:${params.city} ×${cityMult}`)
  }

  // 高德给了人均消费时，向它靠拢一点（房价通常是人均餐饮消费的数倍，
  // 这里只用它做同档位内的微调，权重压到 25%）
  if (params.reportedCost && params.reportedCost > 0) {
    const hinted = params.reportedCost * 100 * 2.2
    center = center * 0.75 + hinted * 0.25
    basis.push('高德消费参考')
  }

  // 区间宽度：档位越高波动越大
  const spread = tier >= 3 ? 0.45 : 0.3

  return {
    minCents: Math.round((center * (1 - spread)) / 1000) * 1000,
    maxCents: Math.round((center * (1 + spread)) / 1000) * 1000,
    estimated: true,
    basis,
  }
}

/** 预算匹配度：0-1，用于酒店推荐排序 */
export function budgetFitScore(
  estimate: { minCents: number; maxCents: number },
  budgetPerNightCents: number,
): number {
  const mid = (estimate.minCents + estimate.maxCents) / 2
  if (budgetPerNightCents <= 0) return 0.5

  // 落在区间内得满分
  if (budgetPerNightCents >= estimate.minCents && budgetPerNightCents <= estimate.maxCents) {
    return 1
  }
  // 超预算惩罚比省预算更重：贵 30% 基本不可接受
  if (mid > budgetPerNightCents) {
    const over = (mid - budgetPerNightCents) / budgetPerNightCents
    return Math.max(0, 1 - over * 2.5)
  }
  // 便宜很多也扣分，用户给了预算说明有品质期待
  const under = (budgetPerNightCents - mid) / budgetPerNightCents
  return Math.max(0.3, 1 - under * 0.6)
}
