/**
 * 单日访问顺序求解：最近邻构造初始解 + 2-opt 局部改进。
 *
 * 为什么不交给 LLM：TSP 是组合优化问题，LLM 给出的顺序看起来合理但通常次优，
 * 且同样输入多次调用结果不一致，无法复现。这里用确定性算法，LLM 只负责
 * 决定"哪些点分到哪天"和"怎么向用户解释"。
 *
 * 规模假设：单天 3-15 个点。这个量级下 2-opt 几毫秒收敛，
 * 不需要 OR-Tools。若将来要支持带时间窗的多车辆场景，再换求解器。
 */

/** 起终点固定为酒店(depot)的开放/闭合路径 */
export interface SolveOptions {
  /** 距离矩阵，matrix[i][j] = i→j 的成本（秒或米，保持一致即可） */
  matrix: number[][]
  /** depot 在矩阵中的下标。有酒店时为酒店，没有时用 -1 表示自由起点 */
  depotIndex: number
  /** 是否必须回到 depot（当天住同一酒店 → true） */
  returnToDepot: boolean
  /** 必须固定在某个位置的点：poiIndex → 顺序位置(0-based，不含 depot) */
  pinned?: Map<number, number>
  maxIterations?: number
}

export interface SolveResult {
  /** 访问顺序（矩阵下标），含首尾 depot（若有） */
  order: number[]
  totalCost: number
  iterations: number
  improved: boolean
}

function pathCost(order: number[], matrix: number[][]): number {
  let sum = 0
  for (let i = 0; i < order.length - 1; i++) {
    const from = order[i]!
    const to = order[i + 1]!
    sum += matrix[from]![to]!
  }
  return sum
}

/** 最近邻：从 depot 出发每次走到最近的未访问点 */
function nearestNeighbor(
  nodes: number[],
  matrix: number[][],
  start: number,
): number[] {
  const unvisited = new Set(nodes)
  const order: number[] = [start]
  unvisited.delete(start)
  let current = start

  while (unvisited.size > 0) {
    let best = -1
    let bestCost = Infinity
    for (const cand of unvisited) {
      const cost = matrix[current]![cand]!
      if (cost < bestCost) {
        bestCost = cost
        best = cand
      }
    }
    order.push(best)
    unvisited.delete(best)
    current = best
  }
  return order
}

/**
 * 2-opt：反复反转路径中的一段，只要能降低总成本就接受。
 * 首尾若是 depot 则固定不动。
 */
function twoOpt(
  order: number[],
  matrix: number[][],
  fixedHead: boolean,
  fixedTail: boolean,
  maxIterations: number,
): { order: number[]; iterations: number } {
  const route = [...order]
  const lo = fixedHead ? 1 : 0
  const hi = fixedTail ? route.length - 2 : route.length - 1

  let iterations = 0
  let improved = true

  while (improved && iterations < maxIterations) {
    improved = false
    for (let i = lo; i < hi; i++) {
      for (let k = i + 1; k <= hi; k++) {
        const a = route[i - 1]
        const b = route[i]!
        const c = route[k]!
        const d = route[k + 1]

        // 边界：没有前驱/后继时该侧成本不变
        const before =
          (a !== undefined ? matrix[a]![b]! : 0) +
          (d !== undefined ? matrix[c]![d]! : 0)
        const after =
          (a !== undefined ? matrix[a]![c]! : 0) +
          (d !== undefined ? matrix[b]![d]! : 0)

        if (after < before - 1e-9) {
          // 反转 [i, k]
          let x = i
          let y = k
          while (x < y) {
            const tmp = route[x]!
            route[x] = route[y]!
            route[y] = tmp
            x++
            y--
          }
          improved = true
        }
      }
      iterations++
      if (iterations >= maxIterations) break
    }
  }

  return { order: route, iterations }
}

export function solveDayRoute(opts: SolveOptions): SolveResult {
  const { matrix, depotIndex, returnToDepot, maxIterations = 2000 } = opts

  const n = matrix.length
  const all = Array.from({ length: n }, (_, i) => i)
  const stops = all.filter((i) => i !== depotIndex)

  if (stops.length === 0) {
    return { order: depotIndex >= 0 ? [depotIndex] : [], totalCost: 0, iterations: 0, improved: false }
  }

  // 1-2 个点无需优化
  if (stops.length <= 2) {
    const order =
      depotIndex >= 0
        ? returnToDepot
          ? [depotIndex, ...stops, depotIndex]
          : [depotIndex, ...stops]
        : stops
    return { order, totalCost: pathCost(order, matrix), iterations: 0, improved: false }
  }

  const start = depotIndex >= 0 ? depotIndex : stops[0]!
  let initial = nearestNeighbor(depotIndex >= 0 ? [start, ...stops] : stops, matrix, start)

  if (depotIndex >= 0 && returnToDepot) initial = [...initial, depotIndex]

  const initialCost = pathCost(initial, matrix)

  const { order, iterations } = twoOpt(
    initial,
    matrix,
    depotIndex >= 0,
    depotIndex >= 0 && returnToDepot,
    maxIterations,
  )

  const totalCost = pathCost(order, matrix)

  return {
    order,
    totalCost,
    iterations,
    improved: totalCost < initialCost - 1e-9,
  }
}

/**
 * 多天分配：先按地理位置做 k-means 聚类，再逐天求解顺序。
 *
 * 这样做的理由是"同一天的点应该地理上接近"，聚类正好表达这个目标。
 * agent 可以覆盖聚类结果（比如它知道某两个景点是套票、该同一天去），
 * 所以 pinned 分配优先级高于聚类。
 */
export interface ClusterOptions {
  points: { lng: number; lat: number }[]
  days: number
  /** 每天最多几个点，防止一天塞满而另一天空着 */
  maxPerDay?: number
  /** 已锁定的分配：pointIndex → dayIndex */
  pinned?: Map<number, number>
  seed?: number
}

/** 等角投影下的平面距离，城市尺度(<100km)误差可忽略 */
function planarDist(
  a: { lng: number; lat: number },
  b: { lng: number; lat: number },
): number {
  const latRad = ((a.lat + b.lat) / 2) * (Math.PI / 180)
  const dx = (a.lng - b.lng) * Math.cos(latRad)
  const dy = a.lat - b.lat
  return Math.sqrt(dx * dx + dy * dy)
}

export function clusterByDay(opts: ClusterOptions): number[] {
  const { points, days, pinned, maxPerDay } = opts
  const n = points.length
  const assignment = new Array<number>(n).fill(-1)

  if (days <= 1 || n === 0) return new Array<number>(n).fill(0)

  // 锁定的点直接落位
  if (pinned) {
    for (const [pointIdx, dayIdx] of pinned) {
      if (pointIdx >= 0 && pointIdx < n && dayIdx >= 0 && dayIdx < days) {
        assignment[pointIdx] = dayIdx
      }
    }
  }

  const free = Array.from({ length: n }, (_, i) => i).filter(
    (i) => assignment[i] === -1,
  )
  if (free.length === 0) return assignment

  // k-means++ 风格的确定性初始化：取彼此最远的 days 个点做初始中心
  const centers: { lng: number; lat: number }[] = []
  const firstIdx = free[0]!
  centers.push({ ...points[firstIdx]! })
  while (centers.length < Math.min(days, free.length)) {
    let bestIdx = -1
    let bestMinDist = -1
    for (const i of free) {
      const minDist = Math.min(...centers.map((c) => planarDist(points[i]!, c)))
      if (minDist > bestMinDist) {
        bestMinDist = minDist
        bestIdx = i
      }
    }
    centers.push({ ...points[bestIdx]! })
  }

  /**
   * 每天的容量上限。
   *
   * 原来是 ceil(n/days) + 1，那个 +1 会让均衡失效：5 个点分 3 天时
   * cap=3，于是第一天塞 3 个、后两天各 1 个 —— 用户看到的就是
   * "第一天赶死，后两天没事干"。去掉 +1 后 cap=2，得到 2/2/1。
   *
   * 纯地理聚类不会自己均衡数量：它只管"同一天的点要近"，而最优的
   * 地理划分经常就是不均衡的。数量均衡是额外的业务约束，只能靠
   * 容量上限来表达。
   *
   * 仍然保留"全满了放到最空的那天"的兜底，所以极端的地理分布
   * （比如所有点挤在一处）不会因为容量而丢点。
   */
  const cap = maxPerDay ?? Math.max(1, Math.ceil(n / days))

  for (let iter = 0; iter < 50; iter++) {
    const counts = new Array<number>(days).fill(0)
    for (let i = 0; i < n; i++) {
      const a = assignment[i]!
      if (a >= 0 && (!pinned || !pinned.has(i))) counts[a] = (counts[a] ?? 0) + 1
    }
    // 锁定点也占容量
    if (pinned) for (const [, d] of pinned) counts[d] = (counts[d] ?? 0) + 1

    const nextCounts = new Array<number>(days).fill(0)
    if (pinned) for (const [, d] of pinned) nextCounts[d] = (nextCounts[d] ?? 0) + 1

    let changed = false
    // 按到最近中心的距离排序，近的先占位，避免容量被远点抢走
    const ordered = [...free].sort((x, y) => {
      const dx = Math.min(...centers.map((c) => planarDist(points[x]!, c)))
      const dy = Math.min(...centers.map((c) => planarDist(points[y]!, c)))
      return dx - dy
    })

    for (const i of ordered) {
      let best = -1
      let bestDist = Infinity
      for (let d = 0; d < centers.length; d++) {
        if ((nextCounts[d] ?? 0) >= cap) continue
        const dist = planarDist(points[i]!, centers[d]!)
        if (dist < bestDist) {
          bestDist = dist
          best = d
        }
      }
      // 全满了就放到最空的那天
      if (best === -1) {
        best = nextCounts.indexOf(Math.min(...nextCounts.slice(0, centers.length)))
      }
      if (assignment[i] !== best) changed = true
      assignment[i] = best
      nextCounts[best] = (nextCounts[best] ?? 0) + 1
    }

    // 重算中心
    for (let d = 0; d < centers.length; d++) {
      const members = assignment
        .map((a, i) => (a === d ? i : -1))
        .filter((i) => i >= 0)
      if (members.length === 0) continue
      centers[d] = {
        lng: members.reduce((s, i) => s + points[i]!.lng, 0) / members.length,
        lat: members.reduce((s, i) => s + points[i]!.lat, 0) / members.length,
      }
    }

    if (!changed && iter > 0) break
  }

  return rebalance(assignment, points, days, cap, pinned)
}

/**
 * 均衡各天的点数。
 *
 * 光靠容量上限不够：cap 只挡住"某天超额"，挡不住"某天太空"。
 * 7 个点 3 天时 cap=3，聚类完全可以给出 3/3/1 —— 有一天只有一个点，
 * 而另两天满载。用户的感受是"这天白瞎了"。
 *
 * 做法：把点数最多的那天里"离目标天中心最近"的那个点挪过去，
 * 重复到最大最小差 ≤1。挑最近的点是为了尽量不破坏地理紧凑性 ——
 * 均衡和"同一天的点要近"本来就是冲突的目标，这里让均衡优先，
 * 但在满足均衡的前提下选代价最小的移动。
 *
 * 锁定的点不参与移动：用户/agent 明确指定了哪天，不能被均衡覆盖。
 */
function rebalance(
  assignment: number[],
  points: { lng: number; lat: number }[],
  days: number,
  cap: number,
  pinned?: Map<number, number>,
): number[] {
  const result = [...assignment]
  const membersOf = (d: number) =>
    result
      .map((a, i) => (a === d ? i : -1))
      .filter((i) => i >= 0 && !(pinned && pinned.has(i)))

  // 最多挪 n 次，避免任何意外的来回摆动
  for (let guard = 0; guard < points.length * 2; guard++) {
    const counts = new Array<number>(days).fill(0)
    for (const a of result) if (a >= 0 && a < days) counts[a]!++

    const maxDay = counts.indexOf(Math.max(...counts))
    const minDay = counts.indexOf(Math.min(...counts))
    if (counts[maxDay]! - counts[minDay]! <= 1) break
    // 目标天已经到容量上限就没法再收（cap 通常不会挡，兜底而已）
    if (counts[minDay]! >= cap) break

    const movable = membersOf(maxDay)
    if (movable.length === 0) break

    // 目标天的中心；那天为空时用它自己的成员算不出来，
    // 退化为"离 maxDay 中心最远的点"——把最不合群的挪走
    const minMembers = result.map((a, i) => (a === minDay ? i : -1)).filter((i) => i >= 0)
    let pick: number
    if (minMembers.length > 0) {
      const center = {
        lng: minMembers.reduce((s, i) => s + points[i]!.lng, 0) / minMembers.length,
        lat: minMembers.reduce((s, i) => s + points[i]!.lat, 0) / minMembers.length,
      }
      pick = movable.reduce((best, i) =>
        planarDist(points[i]!, center) < planarDist(points[best]!, center) ? i : best,
      )
    } else {
      const maxMembers = result.map((a, i) => (a === maxDay ? i : -1)).filter((i) => i >= 0)
      const center = {
        lng: maxMembers.reduce((s, i) => s + points[i]!.lng, 0) / maxMembers.length,
        lat: maxMembers.reduce((s, i) => s + points[i]!.lat, 0) / maxMembers.length,
      }
      pick = movable.reduce((best, i) =>
        planarDist(points[i]!, center) > planarDist(points[best]!, center) ? i : best,
      )
    }

    result[pick] = minDay
  }

  return result
}
