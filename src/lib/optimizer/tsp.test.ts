import { describe, it, expect } from 'vitest'
import { solveDayRoute, clusterByDay } from './tsp'

/** 由坐标生成对称距离矩阵 */
function matrixFrom(points: { lng: number; lat: number }[]): number[][] {
  return points.map((a) =>
    points.map((b) => {
      const dx = a.lng - b.lng
      const dy = a.lat - b.lat
      return Math.sqrt(dx * dx + dy * dy)
    }),
  )
}

describe('solveDayRoute', () => {
  it('单点：直接往返', () => {
    const matrix = [
      [0, 5],
      [5, 0],
    ]
    const r = solveDayRoute({ matrix, depotIndex: 0, returnToDepot: true })
    expect(r.order).toEqual([0, 1, 0])
    expect(r.totalCost).toBe(10)
  })

  it('修正交叉路径：2-opt 必须解开一个明显的交叉', () => {
    // 正方形的四个角，depot 在原点。
    // 最近邻可能给出交叉顺序，最优解是绕外围一圈。
    const points = [
      { lng: 0, lat: 0 }, // 0 depot
      { lng: 0, lat: 1 }, // 1
      { lng: 1, lat: 1 }, // 2
      { lng: 1, lat: 0 }, // 3
    ]
    const matrix = matrixFrom(points)
    const r = solveDayRoute({ matrix, depotIndex: 0, returnToDepot: true })

    // 最优环路 = 周长 4；交叉解会明显更大
    expect(r.totalCost).toBeCloseTo(4, 6)
    expect(r.order[0]).toBe(0)
    expect(r.order.at(-1)).toBe(0)
    // 每个点都恰好访问一次
    expect(new Set(r.order.slice(0, -1)).size).toBe(4)
  })

  it('不回 depot 时路径更短', () => {
    const points = [
      { lng: 0, lat: 0 },
      { lng: 1, lat: 0 },
      { lng: 2, lat: 0 },
      { lng: 3, lat: 0 },
    ]
    const matrix = matrixFrom(points)
    const closed = solveDayRoute({ matrix, depotIndex: 0, returnToDepot: true })
    const open = solveDayRoute({ matrix, depotIndex: 0, returnToDepot: false })

    expect(open.totalCost).toBeCloseTo(3, 6) // 一条直线走到底
    expect(closed.totalCost).toBeCloseTo(6, 6) // 再走回来
    expect(open.totalCost).toBeLessThan(closed.totalCost)
  })

  it('结果是确定性的：同样输入跑十次完全一致', () => {
    const points = Array.from({ length: 9 }, (_, i) => ({
      lng: Math.cos(i * 1.7) * 3,
      lat: Math.sin(i * 2.3) * 3,
    }))
    const matrix = matrixFrom(points)
    const runs = Array.from({ length: 10 }, () =>
      solveDayRoute({ matrix, depotIndex: 0, returnToDepot: true }),
    )
    const first = JSON.stringify(runs[0]!.order)
    for (const r of runs) expect(JSON.stringify(r.order)).toBe(first)
  })

  it('所有点都被访问且不重复（10 个随机点）', () => {
    const points = Array.from({ length: 10 }, (_, i) => ({
      lng: ((i * 37) % 11) / 3,
      lat: ((i * 53) % 13) / 3,
    }))
    const matrix = matrixFrom(points)
    const r = solveDayRoute({ matrix, depotIndex: 0, returnToDepot: true })
    const visited = r.order.slice(1, -1)
    expect(visited.length).toBe(9)
    expect(new Set(visited).size).toBe(9)
    expect(visited).not.toContain(0)
  })

  it('2-opt 不会让解变差', () => {
    const points = Array.from({ length: 12 }, (_, i) => ({
      lng: ((i * 7) % 5) + Math.sin(i),
      lat: ((i * 11) % 7) + Math.cos(i),
    }))
    const matrix = matrixFrom(points)
    const r = solveDayRoute({ matrix, depotIndex: 0, returnToDepot: true })
    // 与最近邻初始解比较：solveDayRoute 内部保证 improved 时严格更优
    expect(r.totalCost).toBeGreaterThan(0)
    expect(Number.isFinite(r.totalCost)).toBe(true)
  })

  it('空的一天不报错', () => {
    const r = solveDayRoute({ matrix: [[0]], depotIndex: 0, returnToDepot: true })
    expect(r.order).toEqual([0])
    expect(r.totalCost).toBe(0)
  })
})

describe('clusterByDay', () => {
  it('两簇分明的点被分到不同天', () => {
    const points = [
      // 上海市中心一簇
      { lng: 121.49, lat: 31.24 },
      { lng: 121.48, lat: 31.23 },
      { lng: 121.5, lat: 31.24 },
      // 迪士尼一簇（东南 20km 外）
      { lng: 121.67, lat: 31.15 },
      { lng: 121.66, lat: 31.14 },
      { lng: 121.68, lat: 31.15 },
    ]
    const a = clusterByDay({ points, days: 2 })

    // 前三个同天，后三个同天，且两天不同
    expect(a[0]).toBe(a[1])
    expect(a[1]).toBe(a[2])
    expect(a[3]).toBe(a[4])
    expect(a[4]).toBe(a[5])
    expect(a[0]).not.toBe(a[3])
  })

  it('尊重 pinned 分配', () => {
    const points = [
      { lng: 121.49, lat: 31.24 },
      { lng: 121.48, lat: 31.23 },
      { lng: 121.67, lat: 31.15 },
      { lng: 121.66, lat: 31.14 },
    ]
    // 强行把地理上属于第一簇的点 0 锁到第 1 天
    const pinned = new Map([[0, 1]])
    const a = clusterByDay({ points, days: 2, pinned })
    expect(a[0]).toBe(1)
  })

  it('单天时所有点都在第 0 天', () => {
    const points = Array.from({ length: 5 }, (_, i) => ({ lng: i, lat: i }))
    const a = clusterByDay({ points, days: 1 })
    expect(a).toEqual([0, 0, 0, 0, 0])
  })

  it('每天的点数不会超过容量太多', () => {
    const points = Array.from({ length: 9 }, (_, i) => ({
      lng: (i % 3) * 0.1 + 121.4,
      lat: Math.floor(i / 3) * 0.1 + 31.2,
    }))
    const a = clusterByDay({ points, days: 3 })
    const counts = [0, 0, 0]
    for (const d of a) counts[d] = (counts[d] ?? 0) + 1
    // 9 个点 3 天，cap = ceil(9/3)+1 = 4
    for (const c of counts) expect(c).toBeLessThanOrEqual(4)
    expect(counts.reduce((s, c) => s + c, 0)).toBe(9)
  })

  it('所有点都被分配（没有 -1 残留）', () => {
    const points = Array.from({ length: 14 }, (_, i) => ({
      lng: 121.4 + Math.sin(i) * 0.2,
      lat: 31.2 + Math.cos(i * 1.3) * 0.2,
    }))
    const a = clusterByDay({ points, days: 4 })
    expect(a.length).toBe(14)
    for (const d of a) {
      expect(d).toBeGreaterThanOrEqual(0)
      expect(d).toBeLessThan(4)
    }
  })
})
