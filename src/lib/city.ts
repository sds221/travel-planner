/**
 * 城市名归一化。
 *
 * 起因是一个真实 bug：高德返回的 cityname 是"成都市"，而用户在界面上
 * 选的是"成都"。POI 按前者入库、查询按后者过滤，于是
 * `WHERE city = '成都'` 一条都匹配不到 —— 42 家酒店存进去了但全被
 * 滤掉，agent 连试 9 次不同半径都拿到空结果，最后如实告诉用户
 * "搜不到酒店"。数据是对的，只是两边对不上。
 *
 * 所以所有写入和查询都要先过这个函数。规则很简单：去掉行政级别后缀。
 * 四个直辖市和常见的"XX市"都能覆盖。
 *
 * 不做的事：不猜简称（"蓉"→成都）、不处理拼音。那些属于用户输入解析，
 * 应该交给高德的地理编码，不该在这里硬编码一张表。
 */

/** 保留后缀的例外：去掉后会变成另一个地名或过短 */
const KEEP_SUFFIX = new Set([
  '市辖区',
  // 地名本身就带"市"字的（"五家渠市"去掉没问题，但下面这些不行）
  '亳州市', // 亳 单字太生僻，保留全名反而更稳
])

/**
 * 归一化城市名，用于入库和查询。
 * "成都市" → "成都"，"重庆市" → "重庆"，"上海" → "上海"（幂等）
 */
export function normalizeCity(raw: string | null | undefined): string {
  if (!raw) return ''
  const trimmed = raw.trim()
  if (trimmed.length === 0) return ''
  if (KEEP_SUFFIX.has(trimmed)) return trimmed

  // 依次剥掉行政级别后缀。"自治州"这类要在"州"之前匹配，
  // 否则"XX自治州"会先被"州"截断成"XX自治"。
  for (const suffix of ['特别行政区', '自治州', '地区', '盟', '市', '县', '区']) {
    if (trimmed.endsWith(suffix) && trimmed.length > suffix.length + 1) {
      return trimmed.slice(0, -suffix.length)
    }
  }
  return trimmed
}

/**
 * 两个城市名是否指同一个城市。
 * 用于比对用户输入和外部数据，避免"成都" vs "成都市"这种假不匹配。
 */
export function sameCity(a: string | null | undefined, b: string | null | undefined): boolean {
  const na = normalizeCity(a)
  const nb = normalizeCity(b)
  return na.length > 0 && na === nb
}
