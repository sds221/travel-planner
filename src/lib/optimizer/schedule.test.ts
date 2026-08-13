import { describe, it, expect } from 'vitest'
import { scheduleDay, parseTime, formatTime, dayCapacityMinutes } from './schedule'

/** 固定通勤成本的 leg 函数，让断言只关注时间累加逻辑 */
function flatLeg(minutes: number, meters = 1000) {
  return () => ({ minutes, meters })
}

describe('parseTime / formatTime', () => {
  it('往返一致', () => {
    for (const t of ['00:00', '09:30', '13:05', '23:59']) {
      expect(formatTime(parseTime(t))).toBe(t)
    }
  })

  it('跨午夜继续累加而不回绕', () => {
    // 行程排爆时用户要能看出来超过了当天
    expect(formatTime(25 * 60 + 30)).toBe('25:30')
  })

  it('非法输入按 0 处理而不是 NaN', () => {
    expect(parseTime('abc')).toBe(0)
    expect(formatTime(-10)).toBe('00:00')
  })
})

describe('scheduleDay', () => {
  it('按顺序累加通勤和游览时间', () => {
    const r = scheduleDay({
      order: [0, 1, 2],
      dwellMinutes: [60, 90, 30],
      leg: flatLeg(20),
      startMinutes: parseTime('09:00'),
      endMinutes: parseTime('21:00'),
      hasHotel: true,
    })

    expect(r.stops).toHaveLength(3)
    // 9:00 出发 + 20 通勤 = 9:20 到，逛 60 分钟 → 10:20 走
    expect(formatTime(r.stops[0]!.arriveMinutes)).toBe('09:20')
    expect(formatTime(r.stops[0]!.departMinutes)).toBe('10:20')
    // 10:20 + 20 = 10:40 到，逛 90 → 12:10
    expect(formatTime(r.stops[1]!.arriveMinutes)).toBe('10:40')
    expect(formatTime(r.stops[1]!.departMinutes)).toBe('12:10')
    // 12:10 + 20 = 12:30 到，逛 30 → 13:00
    expect(formatTime(r.stops[2]!.departMinutes)).toBe('13:00')

    // 通勤 4 段（含回酒店）
    expect(r.totalTravelMinutes).toBe(80)
    expect(r.returnLeg).toEqual({ minutes: 20, meters: 1000 })
    expect(formatTime(r.endMinutes)).toBe('13:20')
    expect(r.dropped).toEqual([])
  })

  it('没有酒店时不计首段通勤也不返程', () => {
    const r = scheduleDay({
      order: [0, 1],
      dwellMinutes: [60, 60],
      leg: flatLeg(30),
      startMinutes: parseTime('09:00'),
      endMinutes: parseTime('21:00'),
      hasHotel: false,
    })

    expect(formatTime(r.stops[0]!.arriveMinutes)).toBe('09:00')
    expect(r.stops[0]!.legMinutes).toBe(0)
    expect(r.returnLeg).toBeNull()
    // 只有 0→1 这一段
    expect(r.totalTravelMinutes).toBe(30)
  })

  it('装不下的点进 dropped，不硬塞', () => {
    // 每天 4 小时，每个点 90 分钟 + 30 通勤 = 120 分钟，只能装 2 个
    const r = scheduleDay({
      order: [0, 1, 2, 3],
      dwellMinutes: [90, 90, 90, 90],
      leg: flatLeg(30),
      startMinutes: parseTime('09:00'),
      endMinutes: parseTime('13:00'),
      hasHotel: true,
    })

    expect(r.stops).toHaveLength(2)
    expect(r.dropped).toEqual([2, 3])
    // 排进去的都在时间窗内
    for (const s of r.stops) expect(s.departMinutes).toBeLessThanOrEqual(parseTime('13:00'))
  })

  it('早到会等到开门', () => {
    const r = scheduleDay({
      order: [0],
      dwellMinutes: [60],
      leg: flatLeg(10),
      startMinutes: parseTime('08:00'),
      endMinutes: parseTime('20:00'),
      hasHotel: true,
      window: () => ({ open: parseTime('09:00'), close: parseTime('17:00') }),
    })

    // 8:10 就到了，但要等到 9:00
    expect(formatTime(r.stops[0]!.arriveMinutes)).toBe('09:00')
    expect(formatTime(r.stops[0]!.departMinutes)).toBe('10:00')
  })

  it('闭馆后到达则跳过该点', () => {
    const r = scheduleDay({
      order: [0, 1],
      dwellMinutes: [60, 60],
      leg: flatLeg(10),
      startMinutes: parseTime('16:30'),
      endMinutes: parseTime('22:00'),
      hasHotel: true,
      // 第 0 个点 17:00 关门，16:40 到还赶得上；第 1 个点已经关了
      window: (i) =>
        i === 0
          ? { open: parseTime('09:00'), close: parseTime('17:00') }
          : { open: parseTime('09:00'), close: parseTime('17:00') },
    })

    expect(r.stops.map((s) => s.stopIndex)).toEqual([0])
    expect(r.dropped).toEqual([1])
    // 17:00 闭馆，游览被截断
    expect(formatTime(r.stops[0]!.departMinutes)).toBe('17:00')
  })

  it('空的一天返回零值而不报错', () => {
    const r = scheduleDay({
      order: [],
      dwellMinutes: [],
      leg: flatLeg(10),
      startMinutes: parseTime('09:00'),
      endMinutes: parseTime('21:00'),
      hasHotel: true,
    })
    expect(r.stops).toEqual([])
    expect(r.totalTravelMinutes).toBe(0)
    expect(r.returnLeg).toBeNull()
    expect(formatTime(r.endMinutes)).toBe('09:00')
  })

  it('时刻表自洽：到达时间严格递增，出发不早于到达', () => {
    const r = scheduleDay({
      order: [0, 1, 2, 3],
      dwellMinutes: [45, 120, 60, 90],
      leg: (from, to) => ({ minutes: 10 + Math.abs(to - from) * 5, meters: 800 }),
      startMinutes: parseTime('08:30'),
      endMinutes: parseTime('22:00'),
      hasHotel: true,
    })

    for (let i = 0; i < r.stops.length; i++) {
      const s = r.stops[i]!
      expect(s.departMinutes).toBeGreaterThanOrEqual(s.arriveMinutes)
      if (i > 0) {
        expect(s.arriveMinutes).toBeGreaterThanOrEqual(r.stops[i - 1]!.departMinutes)
      }
    }
  })

  it('缺失游览时长时用 90 分钟兜底', () => {
    const r = scheduleDay({
      order: [0],
      dwellMinutes: [], // 故意留空
      leg: flatLeg(0),
      startMinutes: parseTime('09:00'),
      endMinutes: parseTime('21:00'),
      hasHotel: false,
    })
    expect(r.stops[0]!.departMinutes - r.stops[0]!.arriveMinutes).toBe(90)
  })
})

describe('dayCapacityMinutes', () => {
  it('算出可用分钟数', () => {
    expect(dayCapacityMinutes('09:00', '21:00')).toBe(720)
  })
  it('结束早于开始时返回 0 而不是负数', () => {
    expect(dayCapacityMinutes('21:00', '09:00')).toBe(0)
  })
})
