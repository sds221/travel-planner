import { describe, it, expect } from 'vitest'
import {
  estimateNightlyPrice,
  budgetFitScore,
  inferBrand,
  inferStarRating,
} from './hotel-pricing'

describe('inferBrand', () => {
  it('从酒店全名里认出品牌', () => {
    expect(inferBrand('全季酒店(上海外滩店)')).toBe('全季')
    expect(inferBrand('上海浦东丽思卡尔顿酒店')).toBe('丽思卡尔顿')
    expect(inferBrand('汉庭酒店(南京路店)')).toBe('汉庭')
  })

  it('无品牌返回 undefined', () => {
    expect(inferBrand('老王家庭旅馆')).toBeUndefined()
  })
})

describe('inferStarRating', () => {
  it('优先用名称/标签里的星级', () => {
    expect(inferStarRating('某某大酒店', ['五星级宾馆'])).toBe(5)
    expect(inferStarRating('某某宾馆', ['三星级宾馆'])).toBe(3)
  })

  it('没有星级时用品牌反推', () => {
    expect(inferStarRating('全季酒店', [])).toBe(3)
    expect(inferStarRating('如家快捷酒店', [])).toBe(2)
    expect(inferStarRating('柏悦酒店', [])).toBe(5)
  })
})

describe('estimateNightlyPrice', () => {
  it('档位顺序正确：经济 < 中端 < 高端 < 奢华', () => {
    const cheap = estimateNightlyPrice({ name: '如家酒店', city: '成都' })
    const mid = estimateNightlyPrice({ name: '全季酒店', city: '成都' })
    const high = estimateNightlyPrice({ name: '希尔顿酒店', city: '成都' })
    const luxe = estimateNightlyPrice({ name: '四季酒店', city: '成都' })

    const midOf = (e: { minCents: number; maxCents: number }) =>
      (e.minCents + e.maxCents) / 2

    expect(midOf(cheap)).toBeLessThan(midOf(mid))
    expect(midOf(mid)).toBeLessThan(midOf(high))
    expect(midOf(high)).toBeLessThan(midOf(luxe))
  })

  it('城市系数生效：上海同品牌贵于成都', () => {
    const sh = estimateNightlyPrice({ name: '全季酒店', city: '上海' })
    const cd = estimateNightlyPrice({ name: '全季酒店', city: '成都' })
    expect(sh.minCents).toBeGreaterThan(cd.minCents)
  })

  it('始终标记为估算值', () => {
    const e = estimateNightlyPrice({ name: '任意酒店', city: '北京' })
    expect(e.estimated).toBe(true)
    expect(e.basis.length).toBeGreaterThan(0)
  })

  it('区间有效且为正', () => {
    const e = estimateNightlyPrice({ name: '亚朵酒店', city: '杭州' })
    expect(e.minCents).toBeGreaterThan(0)
    expect(e.maxCents).toBeGreaterThan(e.minCents)
  })

  it('未知城市不报错，退回基准价', () => {
    const e = estimateNightlyPrice({ name: '全季酒店', city: '某不存在市' })
    expect(e.minCents).toBeGreaterThan(0)
    expect(e.basis).not.toContain('城市系数')
  })
})

describe('budgetFitScore', () => {
  const est = { minCents: 40000, maxCents: 60000 } // 400-600 元

  it('预算落在区间内得满分', () => {
    expect(budgetFitScore(est, 50000)).toBe(1)
    expect(budgetFitScore(est, 40000)).toBe(1)
  })

  it('超预算越多分越低', () => {
    const slightlyOver = budgetFitScore(est, 45000) // 区间内
    const wayUnder = budgetFitScore(est, 20000) // 预算 200，酒店均价 500
    expect(wayUnder).toBeLessThan(slightlyOver)
  })

  it('预算远超酒店档位会扣分（用户有品质期待）', () => {
    const exact = budgetFitScore(est, 50000)
    const overkill = budgetFitScore(est, 200000) // 预算 2000 住 500 的店
    expect(overkill).toBeLessThan(exact)
    expect(overkill).toBeGreaterThanOrEqual(0.3)
  })

  it('分数始终在 0-1 之间', () => {
    for (const budget of [1000, 30000, 50000, 100000, 999999]) {
      const s = budgetFitScore(est, budget)
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThanOrEqual(1)
    }
  })

  it('预算为 0 时返回中性分', () => {
    expect(budgetFitScore(est, 0)).toBe(0.5)
  })
})
