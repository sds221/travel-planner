import { describe, it, expect } from 'vitest'
import { cityExamples } from './utils'

/**
 * 输入框里的示例地点必须跟着行程城市走。
 *
 * 对应一个真实 bug：手输框的 placeholder 写成 `在${trip.city}的地点名，
 * 比如"武康路"`——城市名是动态的，但示例地名写死了上海的街道。西安的
 * 行程会显示"在西安的地点名，比如武康路"，用户照着输就搜不到。
 */
describe('cityExamples', () => {
  it('给出所在城市的地点，不串到别的城市', () => {
    expect(cityExamples('西安')).toContain('兵马俑')
    expect(cityExamples('西安')).not.toContain('武康路')
    expect(cityExamples('成都')).toContain('宽窄巷子')
    expect(cityExamples('上海')).toContain('武康路')
  })

  it('没预置的城市给通用词，而不是错城市的地名', () => {
    const ex = cityExamples('景德镇')
    expect(ex.length).toBeGreaterThan(0)
    // 关键：不能漏出任何一个预置城市的具体地名
    for (const leaked of ['武康路', '兵马俑', '宽窄巷子', '鼓浪屿', '洪崖洞']) {
      expect(ex).not.toContain(leaked)
    }
  })

  it('每个预置城市都给够 4 个示例（批量导入框按行展示）', () => {
    for (const city of ['上海', '北京', '成都', '杭州', '西安', '广州', '深圳', '重庆', '南京', '厦门']) {
      expect(cityExamples(city).length, city).toBe(4)
    }
  })
})
