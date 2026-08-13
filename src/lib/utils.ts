import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** 分 → 元。价格全程用分存，避免浮点误差 */
export function yuan(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return '—'
  return `¥${Math.round(cents / 100).toLocaleString('zh-CN')}`
}

export function priceRange(min: number | null, max: number | null): string {
  if (min === null && max === null) return '价格未知'
  if (min === null) return `≤ ${yuan(max)}`
  if (max === null) return `≥ ${yuan(min)}`
  return `${yuan(min)} - ${yuan(max)}`
}

export function km(meters: number | null | undefined): string {
  if (meters === null || meters === undefined) return '—'
  if (meters < 1000) return `${Math.round(meters)} m`
  return `${(meters / 1000).toFixed(1)} km`
}

export function duration(minutes: number | null | undefined): string {
  if (minutes === null || minutes === undefined) return '—'
  if (minutes < 60) return `${Math.round(minutes)} 分钟`
  const h = Math.floor(minutes / 60)
  const m = Math.round(minutes % 60)
  return m === 0 ? `${h} 小时` : `${h} 小时 ${m} 分`
}

export const MODE_LABEL: Record<string, string> = {
  driving: '驾车',
  transit: '公交地铁',
  walking: '步行',
  cycling: '骑行',
}

export const STATUS_LABEL: Record<string, string> = {
  draft_pois: '选择景点',
  draft_hotel: '选择酒店',
  routing: '正在求解',
  planned: '已生成',
  stale: '需重新生成',
  archived: '已归档',
}

/** 手输/批量导入框里的示例地点。写死上海的例子会让其它城市的用户困惑。 */
const CITY_EXAMPLES: Record<string, string[]> = {
  上海: ['外滩', '豫园', '武康路', '上海博物馆'],
  北京: ['故宫', '颐和园', '南锣鼓巷', '国家博物馆'],
  成都: ['宽窄巷子', '武侯祠', '杜甫草堂', '锦里'],
  杭州: ['西湖', '灵隐寺', '河坊街', '西溪湿地'],
  西安: ['兵马俑', '大雁塔', '回民街', '陕西历史博物馆'],
  广州: ['沙面岛', '陈家祠', '越秀公园', '广州塔'],
  深圳: ['世界之窗', '莲花山公园', '大鹏所城', '深圳博物馆'],
  重庆: ['洪崖洞', '磁器口', '解放碑', '长江索道'],
  南京: ['夫子庙', '中山陵', '总统府', '南京博物院'],
  厦门: ['鼓浪屿', '南普陀寺', '曾厝垵', '厦门大学'],
}

/** 没预置的城市给一组通用词,总比给错城市的地名好。 */
export function cityExamples(city: string): string[] {
  return CITY_EXAMPLES[city] ?? ['市博物馆', '老城区', '中心公园', '步行街']
}
