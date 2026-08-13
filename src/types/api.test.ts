import { describe, it, expect } from 'vitest'
import { API_ROUTES } from './api'

/**
 * 路径拼接。
 *
 * 这些断言的意义不在于"验证字符串模板能用",而在于锁住路径形状:后端
 * 以后改挂载点(比如加 /v1 前缀)时,改 API_ROUTES 一处,这里会立刻告诉
 * 你哪些路径变了、变成什么样,而不是等前端 404。
 */
describe('API_ROUTES', () => {
  const tripId = '2cdad20e-ef2d-4a23-bcd8-7a3c90796095'

  it('行程相关路径', () => {
    expect(API_ROUTES.trips()).toBe('/api/trips')
    expect(API_ROUTES.trip(tripId)).toBe(`/api/trips/${tripId}`)
  })

  it('三步流程各自的路径', () => {
    expect(API_ROUTES.recommendPois(tripId)).toBe(`/api/trips/${tripId}/recommend-pois`)
    expect(API_ROUTES.recommendHotels(tripId)).toBe(`/api/trips/${tripId}/recommend-hotels`)
    expect(API_ROUTES.plan(tripId)).toBe(`/api/trips/${tripId}/plan`)
  })

  it('景点增删改共用一个路径', () => {
    // 三个操作(POST/PATCH/DELETE)复用同一路径,靠方法和 body 区分
    expect(API_ROUTES.pois(tripId)).toBe(`/api/trips/${tripId}/pois`)
  })

  it('所有路径都挂在 /api 下,没有漏写斜杠', () => {
    const all = [
      API_ROUTES.trips(),
      API_ROUTES.trip(tripId),
      API_ROUTES.pois(tripId),
      API_ROUTES.recommendPois(tripId),
      API_ROUTES.recommendHotels(tripId),
      API_ROUTES.import(tripId),
      API_ROUTES.plan(tripId),
      API_ROUTES.runs(tripId),
    ]
    for (const p of all) {
      expect(p.startsWith('/api/'), p).toBe(true)
      expect(p, p).not.toContain('//')
    }
  })

  it('tripId 原样出现在路径里(调用方负责传合法 id)', () => {
    // 这里不做 encodeURIComponent —— tripId 是后端生成的 uuid,
    // 如果哪天换成用户可控的 slug,得回来加转义
    expect(API_ROUTES.trip('abc-123')).toContain('abc-123')
  })
})
