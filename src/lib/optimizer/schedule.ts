/**
 * 把"哪些点分到哪天 + 当天的访问顺序"翻译成带时刻的行程条目。
 *
 * 这一层是纯函数：输入距离矩阵和游览时长，输出时刻表。
 * 不碰数据库也不调 API，因此可以完整地单测 —— 时间计算的边界
 * （超时截断、跨天、闭馆）比 TSP 本身更容易出错。
 */

export interface ScheduleStop {
  /** 在传入 stops 数组中的下标 */
  stopIndex: number
  arriveMinutes: number
  departMinutes: number
  /** 从上一站到这里的通勤时间 */
  legMinutes: number
  legDistanceMeters: number
}

export interface ScheduleDayInput {
  /** 当天的访问顺序，元素是 stops 的下标；不含酒店 */
  order: number[]
  /** 每个 stop 的游览时长（分钟），下标与 order 中的值对应 */
  dwellMinutes: number[]
  /** 通勤时间查询：a→b 的分钟数与米数。a/b 为 stop 下标，-1 表示酒店 */
  leg: (from: number, to: number) => { minutes: number; meters: number }
  /** 当天可用时间窗 */
  startMinutes: number
  endMinutes: number
  /** 是否从酒店出发 / 回到酒店 */
  hasHotel: boolean
  /** 每个 stop 的营业时间窗（分钟），缺省表示全天开放 */
  window?: (stopIndex: number) => { open: number; close: number } | null
}

export interface ScheduleDayResult {
  stops: ScheduleStop[]
  /** 时间不够而被挤掉的 stop 下标 */
  dropped: number[]
  totalTravelMinutes: number
  totalDistanceMeters: number
  /** 回酒店那一段 */
  returnLeg: { minutes: number; meters: number } | null
  endMinutes: number
}

export function parseTime(hhmm: string): number {
  const [h, m] = hhmm.split(':')
  const hours = Number(h)
  const mins = Number(m ?? 0)
  if (!Number.isFinite(hours) || !Number.isFinite(mins)) return 0
  return hours * 60 + mins
}

export function formatTime(minutes: number): string {
  // 跨过午夜时继续往上累加而不是回绕，用户看到 25:30 才知道行程排爆了
  const m = Math.max(0, Math.round(minutes))
  const h = Math.floor(m / 60)
  const mm = m % 60
  return `${String(h).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
}

/**
 * 逐站累加时间。超出当天时间窗就停下，剩余的点标记为 dropped
 * 交给上层决定是挪到别天还是提示用户删点。
 *
 * 为什么不硬塞：一天排 12 小时游览听起来很划算，但生成的计划没人能执行，
 * 用户对整个工具的信任会直接归零。宁可少排。
 */
export function scheduleDay(input: ScheduleDayInput): ScheduleDayResult {
  const { order, dwellMinutes, leg, startMinutes, endMinutes, hasHotel, window } = input

  const stops: ScheduleStop[] = []
  const dropped: number[] = []
  let clock = startMinutes
  let totalTravel = 0
  let totalDistance = 0
  let prev = hasHotel ? -1 : null

  for (const stopIndex of order) {
    const l = prev === null ? { minutes: 0, meters: 0 } : leg(prev, stopIndex)
    let arrive = clock + l.minutes

    // 没到营业时间就等，闭馆前来不及看完就跳过这个点
    const w = window?.(stopIndex) ?? null
    if (w) {
      if (arrive < w.open) arrive = w.open
      if (arrive >= w.close) {
        dropped.push(stopIndex)
        continue
      }
    }

    const dwell = dwellMinutes[stopIndex] ?? 90
    let depart = arrive + dwell
    if (w && depart > w.close) depart = w.close

    // 逛完已经超过当天结束时间 → 这个点和后面的都排不下
    if (depart > endMinutes) {
      dropped.push(stopIndex)
      continue
    }

    stops.push({
      stopIndex,
      arriveMinutes: arrive,
      departMinutes: depart,
      legMinutes: l.minutes,
      legDistanceMeters: l.meters,
    })
    totalTravel += l.minutes
    totalDistance += l.meters
    clock = depart
    prev = stopIndex
  }

  let returnLeg: { minutes: number; meters: number } | null = null
  if (hasHotel && prev !== null && prev !== -1) {
    returnLeg = leg(prev, -1)
    totalTravel += returnLeg.minutes
    totalDistance += returnLeg.meters
    clock += returnLeg.minutes
  }

  return {
    stops,
    dropped,
    totalTravelMinutes: totalTravel,
    totalDistanceMeters: totalDistance,
    returnLeg,
    endMinutes: clock,
  }
}

/**
 * 当天能装下多少游览时间。用于分天时判断"这天是不是已经满了"，
 * 比单纯限制点数准确 —— 一个迪士尼(6h)和三个观景台(45m×3)不该算等价。
 */
export function dayCapacityMinutes(startTime: string, endTime: string): number {
  return Math.max(0, parseTime(endTime) - parseTime(startTime))
}
