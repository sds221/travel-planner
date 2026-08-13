import { describe, it, expect } from 'vitest'
import { FormulaPriceProvider } from './price-formula'
import { ArkSearchPriceProvider, extractJson, flattenArkOutput } from './price-search'
import { ChainedPriceProvider, CachedPriceProvider } from './price-chain'
import { toCents, describeHotel, matchName } from './price-llm'
import { MemoryKV } from './cache'
import type { PriceProvider, PriceInfo } from './types'

const HOTELS = [
  { name: '全季酒店上海外滩店', brand: '全季', starRating: 3, district: '黄浦区' },
  { name: '上海和平饭店', starRating: 5, district: '黄浦区' },
]

/** 可编排的假 provider：指定哪些酒店查得到、是否整体抛错 */
function fakeProvider(opts: {
  name: string
  source: PriceInfo['source']
  answers?: Record<string, [number, number]>
  throws?: boolean
}): PriceProvider & { calls: string[][] } {
  const calls: string[][] = []
  return {
    name: opts.name,
    source: opts.source,
    calls,
    async lookup({ hotels }) {
      calls.push(hotels.map((h) => h.name))
      if (opts.throws) throw new Error(`${opts.name} 挂了`)
      const out = new Map<string, PriceInfo>()
      for (const h of hotels) {
        const hit = opts.answers?.[h.name]
        if (hit) {
          out.set(h.name, {
            minCents: hit[0],
            maxCents: hit[1],
            source: opts.source,
            basis: [opts.name],
          })
        }
      }
      return out
    },
  }
}

describe('toCents', () => {
  it('元转分', () => {
    expect(toCents(458)).toBe(45800)
  })

  it('挡掉单位写错的值', () => {
    // 模型偶尔把分当元填，或者给出离谱的数字
    expect(toCents(5)).toBeNull()
    expect(toCents(999_999)).toBeNull()
    expect(toCents(0)).toBeNull()
    expect(toCents(NaN)).toBeNull()
    expect(toCents(-100)).toBeNull()
  })
})

describe('describeHotel', () => {
  it('拼上品牌星级区域帮模型定位', () => {
    expect(describeHotel(HOTELS[0]!)).toBe('全季酒店上海外滩店（品牌:全季 / 3星 / 黄浦区）')
  })

  it('没有额外属性时只给名字', () => {
    expect(describeHotel({ name: '某酒店' })).toBe('某酒店')
  })
})

describe('matchName', () => {
  it('精确匹配优先', () => {
    expect(matchName('上海和平饭店', HOTELS)).toBe('上海和平饭店')
  })

  it('模型简写酒店名时也能对回去', () => {
    // 模型常把"全季酒店上海外滩店"简写成"全季外滩店"之外的形式，
    // 这里覆盖它只返回子串的情况
    expect(matchName('和平饭店', HOTELS)).toBe('上海和平饭店')
  })

  it('完全对不上返回 null，不硬塞', () => {
    expect(matchName('北京饭店', HOTELS)).toBeNull()
  })
})

describe('FormulaPriceProvider', () => {
  it('离线给出所有酒店的粗估价', async () => {
    const p = new FormulaPriceProvider()
    const r = await p.lookup({ city: '上海', hotels: HOTELS })

    expect(r.size).toBe(2)
    // 五星的和平饭店应该明显贵于三星全季
    const quanji = r.get('全季酒店上海外滩店')!
    const peace = r.get('上海和平饭店')!
    expect(peace.minCents).toBeGreaterThan(quanji.maxCents)
    expect(quanji.source).toBe('formula')
    expect(quanji.basis.length).toBeGreaterThan(0)
  })
})

describe('extractJson', () => {
  it('从裸 JSON 里解析', () => {
    expect(extractJson('{"a":1}')).toEqual({ a: 1 })
  })

  it('剥掉 markdown 代码块和前后废话', () => {
    const text = '好的，我查到了：\n```json\n{"hotels":[{"name":"X"}]}\n```\n以上。'
    expect(extractJson(text)).toEqual({ hotels: [{ name: 'X' }] })
  })

  it('没有 JSON 时返回 null 而不是抛错', () => {
    expect(extractJson('抱歉我没查到')).toBeNull()
    expect(extractJson('{坏掉的 json')).toBeNull()
  })
})

describe('flattenArkOutput', () => {
  it('拼接多段文本并去重收集引用', () => {
    const r = flattenArkOutput({
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: '{"hotels":',
              annotations: [{ type: 'url_citation', url: 'https://a.com', title: '携程' }],
            },
            {
              type: 'output_text',
              text: '[]}',
              // 同一个 URL 出现两次只保留一条
              annotations: [
                { type: 'url_citation', url: 'https://a.com', title: '携程' },
                { type: 'url_citation', url: 'https://b.com', title: '美团' },
              ],
            },
          ],
        },
      ],
    })

    expect(r.text).toBe('{"hotels":[]}')
    expect(r.citations).toEqual([
      { title: '携程', url: 'https://a.com' },
      { title: '美团', url: 'https://b.com' },
    ])
  })

  it('空响应不报错', () => {
    expect(flattenArkOutput({})).toEqual({ text: '', citations: [] })
  })
})

describe('ArkSearchPriceProvider', () => {
  function mockArk(handler: (body: any) => unknown) {
    const bodies: any[] = []
    const impl = (async (_url: string, init?: RequestInit) => {
      const parsed = JSON.parse(String(init?.body))
      bodies.push(parsed)
      // provider 读 text() 再自己 JSON.parse（为了在解析前匹配永久性错误）
      const payload = JSON.stringify(handler(parsed))
      return { ok: true, text: async () => payload } as Response
    }) as unknown as typeof fetch
    return { impl, bodies }
  }

  function arkReply(hotels: unknown[], citations: { url: string; title: string }[] = []) {
    return {
      output: [
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: JSON.stringify({ hotels }),
              annotations: citations.map((c) => ({ type: 'url_citation', ...c })),
            },
          ],
        },
      ],
    }
  }

  it('没有 key 时构造就失败', () => {
    expect(() => new ArkSearchPriceProvider('', 'doubao')).toThrow(/ARK_API_KEY/)
  })

  it('请求里带上 web_search 工具', async () => {
    const { impl, bodies } = mockArk(() => arkReply([]))
    const p = new ArkSearchPriceProvider('k', 'doubao-seed', impl)
    await p.lookup({ city: '上海', hotels: HOTELS })

    // 这是整个 provider 存在的意义：不带这个工具就只是普通推理
    expect(bodies[0].tools).toEqual([{ type: 'web_search' }])
    expect(bodies[0].model).toBe('doubao-seed')
    expect(bodies[0].stream).toBe(false)
  })

  it('解析价格并带上来源链接', async () => {
    const { impl } = mockArk(() =>
      arkReply(
        [
          {
            name: '全季酒店上海外滩店',
            minYuan: 420,
            maxYuan: 560,
            confidence: 'high',
            reasoning: '携程显示的近期价格',
            sourceUrl: 'https://ctrip.com/hotel/123',
          },
        ],
        [{ url: 'https://ctrip.com', title: '携程' }],
      ),
    )

    const p = new ArkSearchPriceProvider('k', 'doubao', impl)
    const r = await p.lookup({ city: '上海', hotels: HOTELS })
    const hit = r.get('全季酒店上海外滩店')!

    expect(hit.minCents).toBe(42000)
    expect(hit.maxCents).toBe(56000)
    expect(hit.source).toBe('search')
    // 有来源链接才是这个 provider 相对 llm 的核心价值
    expect(hit.citations).toEqual([{ title: '价格来源', url: 'https://ctrip.com/hotel/123' }])
    expect(hit.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('没给单条来源时退回整批的搜索引用', async () => {
    const { impl } = mockArk(() =>
      arkReply(
        [{ name: '上海和平饭店', minYuan: 1800, maxYuan: 3000, confidence: 'medium', reasoning: 'x' }],
        [{ url: 'https://booking.com', title: 'Booking' }],
      ),
    )
    const p = new ArkSearchPriceProvider('k', 'doubao', impl)
    const r = await p.lookup({ city: '上海', hotels: HOTELS })
    expect(r.get('上海和平饭店')!.citations).toEqual([
      { title: 'Booking', url: 'https://booking.com' },
    ])
  })

  it('min/max 写反时自动纠正', async () => {
    const { impl } = mockArk(() =>
      arkReply([{ name: '上海和平饭店', minYuan: 3000, maxYuan: 1800, confidence: 'low', reasoning: 'x' }]),
    )
    const p = new ArkSearchPriceProvider('k', 'doubao', impl)
    const r = await p.lookup({ city: '上海', hotels: HOTELS })
    const hit = r.get('上海和平饭店')!
    expect(hit.minCents).toBeLessThan(hit.maxCents)
  })

  it('HTTP 失败时整批返回空，不抛到调用方', async () => {
    const impl = (async () =>
      ({ ok: false, status: 429, text: async () => 'rate limited' }) as Response) as unknown as typeof fetch
    const p = new ArkSearchPriceProvider('k', 'doubao', impl)
    // lookup 内部吞掉批次错误，由 chain 去降级
    await expect(p.lookup({ city: '上海', hotels: HOTELS })).resolves.toEqual(new Map())
  })

  it('返回的业务错误也被吞掉', async () => {
    const impl = (async () =>
      ({ ok: true, text: async () => JSON.stringify({ error: { message: '额度不足' } }) }) as Response) as unknown as typeof fetch
    const p = new ArkSearchPriceProvider('k', 'doubao', impl)
    await expect(p.lookup({ city: '上海', hotels: HOTELS })).resolves.toEqual(new Map())
  })

  it('账号没开通联网搜索时立刻停用，不逐批重试', async () => {
    // 真实遇到的响应：联网搜索在方舟是要单独开通的付费插件。
    // 每批要等几十秒，不识别出来就是几分钟的白等。
    let calls = 0
    const impl = (async () => {
      calls++
      return {
        ok: false,
        status: 404,
        text: async () =>
          JSON.stringify({
            error: { code: 'ToolNotOpen', message: 'Your account has not activated web search.' },
          }),
      } as Response
    }) as unknown as typeof fetch

    const p = new ArkSearchPriceProvider('k', 'doubao', impl, 2)
    const many = Array.from({ length: 10 }, (_, i) => ({ name: `酒店${i}` }))
    await p.lookup({ city: '上海', hotels: many })

    // 10 家 / 每批 2 = 5 批，但第一批就该停下
    expect(calls).toBe(1)
    expect(p.unavailableReason).toMatch(/未开通联网搜索/)
  })

  it('限流这类临时错误不会停用整个 provider', async () => {
    let calls = 0
    const impl = (async () => {
      calls++
      return { ok: false, status: 429, text: async () => 'rate limited' } as Response
    }) as unknown as typeof fetch

    const p = new ArkSearchPriceProvider('k', 'doubao', impl, 2)
    await p.lookup({ city: '上海', hotels: Array.from({ length: 4 }, (_, i) => ({ name: `H${i}` })) })

    // 限流是暂时的，后面的批次照样试
    expect(calls).toBe(2)
    expect(p.unavailableReason).toBeNull()
  })

  it('只取 message 的文本，忽略 reasoning 条目', async () => {
    // 豆包的 reasoning 模型会额外返回思考过程，
    // 拼进来会污染要解析的 JSON
    const impl = (async () =>
      ({
        ok: true,
        text: async () =>
          JSON.stringify({
            output: [
              {
                type: 'reasoning',
                content: [{ type: 'text', text: '让我想想这家酒店{"hotels":[伪造的]}' }],
              },
              {
                type: 'message',
                content: [
                  {
                    type: 'output_text',
                    text: JSON.stringify({
                      hotels: [
                        {
                          name: '上海和平饭店',
                          minYuan: 1800,
                          maxYuan: 3000,
                          confidence: 'high',
                          reasoning: 'x',
                        },
                      ],
                    }),
                  },
                ],
              },
            ],
          }),
      }) as Response) as unknown as typeof fetch

    const p = new ArkSearchPriceProvider('k', 'doubao', impl)
    const r = await p.lookup({ city: '上海', hotels: HOTELS })
    expect(r.get('上海和平饭店')!.minCents).toBe(180000)
  })

  it('酒店多于批次大小时分批请求', async () => {
    const { impl, bodies } = mockArk(() => arkReply([]))
    const p = new ArkSearchPriceProvider('k', 'doubao', impl, 2)
    const many = Array.from({ length: 5 }, (_, i) => ({ name: `酒店${i}` }))
    await p.lookup({ city: '上海', hotels: many })
    expect(bodies).toHaveLength(3)
  })

  it('入住日期传进 prompt', async () => {
    const { impl, bodies } = mockArk(() => arkReply([]))
    const p = new ArkSearchPriceProvider('k', 'doubao', impl)
    await p.lookup({ city: '上海', hotels: HOTELS, checkInDate: '2026-10-01', nights: 3 })
    expect(bodies[0].input).toContain('2026-10-01')
  })
})

describe('ChainedPriceProvider', () => {
  it('逐家降级：上一级查不到的才问下一级', async () => {
    const search = fakeProvider({
      name: 'search',
      source: 'search',
      answers: { '全季酒店上海外滩店': [42000, 56000] },
    })
    const formula = fakeProvider({
      name: 'formula',
      source: 'formula',
      answers: { '上海和平饭店': [100000, 200000] },
    })

    const chain = new ChainedPriceProvider([search, formula])
    const r = await chain.lookup({ city: '上海', hotels: HOTELS })

    expect(r.get('全季酒店上海外滩店')!.source).toBe('search')
    expect(r.get('上海和平饭店')!.source).toBe('formula')
    // 关键：第二级只被问了第一级没查到的那家，不重复付费
    expect(formula.calls[0]).toEqual(['上海和平饭店'])
  })

  it('第一级整体挂掉时完全落到下一级', async () => {
    const broken = fakeProvider({ name: 'search', source: 'search', throws: true })
    const formula = fakeProvider({
      name: 'formula',
      source: 'formula',
      answers: {
        '全季酒店上海外滩店': [20000, 30000],
        '上海和平饭店': [100000, 200000],
      },
    })

    const r = await new ChainedPriceProvider([broken, formula]).lookup({
      city: '上海',
      hotels: HOTELS,
    })
    expect(r.size).toBe(2)
    expect([...r.values()].every((v) => v.source === 'formula')).toBe(true)
  })

  it('全部查到时不再调后续级别', async () => {
    const search = fakeProvider({
      name: 'search',
      source: 'search',
      answers: {
        '全季酒店上海外滩店': [42000, 56000],
        '上海和平饭店': [180000, 300000],
      },
    })
    const formula = fakeProvider({ name: 'formula', source: 'formula' })

    await new ChainedPriceProvider([search, formula]).lookup({ city: '上海', hotels: HOTELS })
    expect(formula.calls).toHaveLength(0)
  })

  it('source 报告链上最好的那一级', () => {
    const chain = new ChainedPriceProvider([
      fakeProvider({ name: 'search', source: 'search' }),
      fakeProvider({ name: 'formula', source: 'formula' }),
    ])
    expect(chain.source).toBe('search')
  })

  it('空链拒绝构造', () => {
    expect(() => new ChainedPriceProvider([])).toThrow(/不能为空/)
  })
})

describe('CachedPriceProvider', () => {
  it('第二次查询命中缓存，不再调底层', async () => {
    const inner = fakeProvider({
      name: 'search',
      source: 'search',
      answers: { '全季酒店上海外滩店': [42000, 56000] },
    })
    const cached = new CachedPriceProvider(inner, new MemoryKV())

    const first = await cached.lookup({ city: '上海', hotels: [HOTELS[0]!] })
    const second = await cached.lookup({ city: '上海', hotels: [HOTELS[0]!] })

    expect(first.get('全季酒店上海外滩店')!.minCents).toBe(42000)
    expect(second.get('全季酒店上海外滩店')!.minCents).toBe(42000)
    // 联网查价按次计费，重复查同一家必须命中缓存
    expect(inner.calls).toHaveLength(1)
  })

  it('只把没命中的那些传给底层', async () => {
    const inner = fakeProvider({
      name: 'search',
      source: 'search',
      answers: {
        '全季酒店上海外滩店': [42000, 56000],
        '上海和平饭店': [180000, 300000],
      },
    })
    const cached = new CachedPriceProvider(inner, new MemoryKV())

    await cached.lookup({ city: '上海', hotels: [HOTELS[0]!] })
    await cached.lookup({ city: '上海', hotels: HOTELS })

    expect(inner.calls[1]).toEqual(['上海和平饭店'])
  })

  it('不同入住日期不共用缓存', async () => {
    const inner = fakeProvider({
      name: 'search',
      source: 'search',
      answers: { '全季酒店上海外滩店': [42000, 56000] },
    })
    const cached = new CachedPriceProvider(inner, new MemoryKV())

    await cached.lookup({ city: '上海', hotels: [HOTELS[0]!], checkInDate: '2026-10-01' })
    await cached.lookup({ city: '上海', hotels: [HOTELS[0]!], checkInDate: '2026-11-15' })

    // 国庆价和平日价不能互相复用
    expect(inner.calls).toHaveLength(2)
  })

  it('缓存读写失败时退化为直接查询', async () => {
    const brokenKv = {
      get: async () => {
        throw new Error('redis 挂了')
      },
      set: async () => {
        throw new Error('redis 挂了')
      },
    }
    const inner = fakeProvider({
      name: 'search',
      source: 'search',
      answers: { '全季酒店上海外滩店': [42000, 56000] },
    })

    const r = await new CachedPriceProvider(inner, brokenKv).lookup({
      city: '上海',
      hotels: [HOTELS[0]!],
    })
    expect(r.get('全季酒店上海外滩店')!.minCents).toBe(42000)
  })
})
