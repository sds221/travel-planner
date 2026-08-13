import { describe, it, expect } from 'vitest'
import { normalizeCity, sameCity } from './city'

/**
 * 城市名归一化。
 *
 * 这些断言对应一个真实 bug：高德返回 cityname="成都市"，用户界面选的是
 * "成都"，POI 按前者入库、查询按后者过滤，于是 42 家酒店存进去了但
 * `WHERE city = '成都'` 一条都匹配不到。agent 连试 9 次不同半径都拿到
 * 空结果，最后如实告诉用户"搜不到酒店"——数据全是对的，只是两边对不上。
 */

describe('normalizeCity', () => {
  it('去掉"市"后缀', () => {
    expect(normalizeCity('成都市')).toBe('成都')
    expect(normalizeCity('上海市')).toBe('上海')
    expect(normalizeCity('哈尔滨市')).toBe('哈尔滨')
  })

  it('幂等：已经归一化过的不变', () => {
    expect(normalizeCity('成都')).toBe('成都')
    expect(normalizeCity(normalizeCity('成都市'))).toBe('成都')
  })

  it('自治州要在"州"之前匹配，否则会截断成"XX自治"', () => {
    expect(normalizeCity('西双版纳自治州')).toBe('西双版纳')
    expect(normalizeCity('延边自治州')).toBe('延边')
  })

  it('处理地区和特别行政区', () => {
    expect(normalizeCity('阿里地区')).toBe('阿里')
    expect(normalizeCity('香港特别行政区')).toBe('香港')
  })

  it('去掉后过短的不动，避免把地名弄坏', () => {
    // 只剩一个字的话保留原名更安全
    expect(normalizeCity('市')).toBe('市')
    expect(normalizeCity('区')).toBe('区')
  })

  it('空值和空白安全', () => {
    expect(normalizeCity(null)).toBe('')
    expect(normalizeCity(undefined)).toBe('')
    expect(normalizeCity('')).toBe('')
    expect(normalizeCity('  成都市  ')).toBe('成都')
  })

  it('不带后缀的直接返回', () => {
    expect(normalizeCity('北京')).toBe('北京')
    expect(normalizeCity('西安')).toBe('西安')
  })
})

describe('sameCity', () => {
  it('归一化后相同就算同一个城市', () => {
    // 这是 bug 的核心场景
    expect(sameCity('成都', '成都市')).toBe(true)
    expect(sameCity('成都市', '成都')).toBe(true)
  })

  it('不同城市返回 false', () => {
    expect(sameCity('成都', '重庆')).toBe(false)
    expect(sameCity('成都市', '重庆市')).toBe(false)
  })

  it('空值不算匹配', () => {
    expect(sameCity('', '')).toBe(false)
    expect(sameCity(null, null)).toBe(false)
    expect(sameCity('成都', null)).toBe(false)
  })
})
