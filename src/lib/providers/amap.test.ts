import { describe, it, expect } from 'vitest'
import { AmapProvider, decodePolyline, haversine, estimateDuration } from './amap'

/**
 * 用假 fetch 测高德适配层。
 *
 * 重点是请求参数的形状：/distance 是"多 origins 对单 destination"，
 * 写反了高德不报错，只会静默返回第一个目的地的结果 —— 于是距离矩阵
 * 每一列都相同，行程看起来能生成但顺序完全是错的。这类 bug 靠肉眼
 * 审查很难发现，必须断言 query string。
 */

interface Call {
  path: string
  params: URLSearchParams
}

function mockFetch(handler: (call: Call) => unknown) {
  const calls: Call[] = []
  const impl = (async (url: string | URL) => {
    const u = new URL(String(url))
    const call = { path: u.pathname, params: u.searchParams }
    calls.push(call)
    return {
      ok: true,
      json: async () => ({ status: '1', ...(handler(call) as object) }),
    } as Response
  }) as unknown as typeof fetch
  return { impl, calls }
}

describe('AmapProvider 构造', () => {
  it('没有 key 时立刻报错，而不是等到第一次请求', () => {
    expect(() => new AmapProvider('')).toThrow(/AMAP_SERVER_KEY/)
  })
})

describe('业务状态码', () => {
  it('HTTP 200 但 status!=1 视为失败', async () => {
    const impl = (async () =>
      ({
        ok: true,
        json: async () => ({ status: '0', info: 'INVALID_USER_KEY', infocode: '10001' }),
      }) as Response) as unknown as typeof fetch

    const p = new AmapProvider('k', impl)
    await expect(p.searchPoi({ city: '上海' })).rejects.toThrow(/INVALID_USER_KEY/)
  })

  it('HTTP 非 2xx 带上状态码', async () => {
    const impl = (async () => ({ ok: false, status: 503 }) as Response) as unknown as typeof fetch
    const p = new AmapProvider('k', impl)
    await expect(p.searchPoi({ city: '上海' })).rejects.toThrow(/503/)
  })
})

describe('searchPoi', () => {
  it('有 around 时走周边搜索并带上 location/radius', async () => {
    const { impl, calls } = mockFetch(() => ({ pois: [] }))
    const p = new AmapProvider('k', impl)
    await p.searchPoi({
      city: '上海',
      types: '住宿服务',
      around: { center: { lng: 121.49, lat: 31.24 }, radiusMeters: 3000 },
    })

    expect(calls[0]!.path).toBe('/v3/place/around')
    expect(calls[0]!.params.get('location')).toBe('121.490000,31.240000')
    expect(calls[0]!.params.get('radius')).toBe('3000')
  })

  it('没有 around 时走关键字搜索', async () => {
    const { impl, calls } = mockFetch(() => ({ pois: [] }))
    const p = new AmapProvider('k', impl)
    await p.searchPoi({ city: '上海', keywords: '外滩' })

    expect(calls[0]!.path).toBe('/v3/place/text')
    expect(calls[0]!.params.get('keywords')).toBe('外滩')
    // citylimit 防止搜到外地同名景点
    expect(calls[0]!.params.get('citylimit')).toBe('true')
  })

  it('高德返回的 cityname 带后缀时归一化后再入库', async () => {
    // 真实 bug：高德给 "成都市"，界面上选的是 "成都"，
    // 不归一化会让 WHERE city = '成都' 一条都匹配不到。
    const { impl } = mockFetch(() => ({
      pois: [
        {
          id: 'B001',
          name: '锦兰酒店',
          location: '104.044600,30.645900',
          cityname: '成都市',
          adname: '武侯区',
          type: '住宿服务;宾馆酒店',
        },
      ],
    }))
    const p = new AmapProvider('k', impl)
    const [poi] = await p.searchPoi({ city: '成都' })

    expect(poi!.city).toBe('成都')
    // district 保持原样：区名本来就带"区"，那是它的一部分
    expect(poi!.district).toBe('武侯区')
  })

  it('cityname 缺失时用传入的城市，也要归一化', async () => {
    const { impl } = mockFetch(() => ({
      pois: [{ id: 'B002', name: '某酒店', location: '104.04,30.64', type: '住宿服务' }],
    }))
    const p = new AmapProvider('k', impl)
    const [poi] = await p.searchPoi({ city: '成都市' })
    expect(poi!.city).toBe('成都')
  })

  it('limit 收敛到高德单页上限 25', async () => {
    const { impl, calls } = mockFetch(() => ({ pois: [] }))
    const p = new AmapProvider('k', impl)
    await p.searchPoi({ city: '上海', limit: 100 })
    expect(calls[0]!.params.get('offset')).toBe('25')
  })

  it('空字段返回 [] 时归一成 undefined 而不是字符串 "[]"', async () => {
    const { impl } = mockFetch(() => ({
      pois: [
        {
          id: 'B1',
          name: '外滩',
          type: '风景名胜;风景名胜相关',
          address: [], // 高德对空值返回空数组
          location: '121.490000,31.240000',
          biz_ext: { rating: [] },
        },
      ],
    }))

    const p = new AmapProvider('k', impl)
    const [poi] = await p.searchPoi({ city: '上海', keywords: '外滩' })

    expect(poi!.address).toBeUndefined()
    expect(poi!.rating).toBeUndefined()
    expect(poi!.tags).toEqual(['风景名胜', '风景名胜相关'])
  })

  it('坐标无法解析的 POI 被丢弃而不是产出 NaN', async () => {
    const { impl } = mockFetch(() => ({
      pois: [
        { id: 'ok', name: 'A', location: '121.49,31.24' },
        { id: 'bad', name: 'B', location: '' },
      ],
    }))
    const p = new AmapProvider('k', impl)
    const pois = await p.searchPoi({ city: '上海' })
    expect(pois.map((x) => x.externalId)).toEqual(['ok'])
  })

  it('按类型推断游览时长', async () => {
    const { impl } = mockFetch(() => ({
      pois: [
        { id: '1', name: '迪士尼', type: '风景名胜;主题公园', location: '121.66,31.14' },
        { id: '2', name: '上博', type: '科教文化服务;博物馆', location: '121.47,31.22' },
      ],
    }))
    const p = new AmapProvider('k', impl)
    const pois = await p.searchPoi({ city: '上海' })
    // 主题公园远长于博物馆，否则一天会塞太多点
    expect(pois[0]!.dwellMinutes).toBeGreaterThan(pois[1]!.dwellMinutes!)
  })
})

describe('distanceMatrix', () => {
  it('origins 用竖线分隔、destination 是单点', async () => {
    const { impl, calls } = mockFetch(({ params }) => {
      const n = params.get('origins')!.split('|').length
      return {
        results: Array.from({ length: n }, (_, i) => ({
          origin_id: String(i + 1),
          dest_id: '1',
          distance: String(1000 * (i + 1)),
          duration: String(600 * (i + 1)),
        })),
      }
    })

    const p = new AmapProvider('k', impl)
    const origins = [
      { lng: 121.47, lat: 31.22 },
      { lng: 121.49, lat: 31.24 },
    ]
    const destinations = [
      { lng: 121.5, lat: 31.23 },
      { lng: 121.66, lat: 31.14 },
    ]

    const m = await p.distanceMatrix({ origins, destinations, mode: 'driving' })

    // 每个 destination 一次调用，origins 一次全传
    expect(calls).toHaveLength(2)
    expect(calls[0]!.params.get('origins')!.split('|')).toHaveLength(2)
    expect(calls[0]!.params.get('destination')).not.toContain('|')

    // 矩阵形状：origins × destinations
    expect(m.distanceMeters).toHaveLength(2)
    expect(m.distanceMeters[0]).toHaveLength(2)
    // 列不应该全相同 —— 写反参数时的典型症状
    expect(m.distanceMeters[0]![0]).not.toBe(m.distanceMeters[1]![0])
  })

  it('按 origin_id 对齐，乱序返回也不会错位', async () => {
    const { impl } = mockFetch(() => ({
      results: [
        { origin_id: '2', dest_id: '1', distance: '2000', duration: '1200' },
        { origin_id: '1', dest_id: '1', distance: '1000', duration: '600' },
      ],
    }))

    const p = new AmapProvider('k', impl)
    const m = await p.distanceMatrix({
      origins: [
        { lng: 121.47, lat: 31.22 },
        { lng: 121.49, lat: 31.24 },
      ],
      destinations: [{ lng: 121.5, lat: 31.23 }],
      mode: 'driving',
    })

    expect(m.distanceMeters[0]![0]).toBe(1000)
    expect(m.distanceMeters[1]![0]).toBe(2000)
  })

  it('结果缺失时用直线距离兜底而不是留 0', async () => {
    const { impl } = mockFetch(() => ({ results: [] }))
    const p = new AmapProvider('k', impl)
    const m = await p.distanceMatrix({
      origins: [{ lng: 121.47, lat: 31.22 }],
      destinations: [{ lng: 121.66, lat: 31.14 }],
      mode: 'driving',
    })
    expect(m.distanceMeters[0]![0]).toBeGreaterThan(1000)
    expect(m.durationSeconds[0]![0]).toBeGreaterThan(0)
  })

  it('transit 用步行距离换算公交时长', async () => {
    const { impl, calls } = mockFetch(() => ({
      results: [{ origin_id: '1', dest_id: '1', distance: '5000', duration: '3600' }],
    }))
    const p = new AmapProvider('k', impl)
    const m = await p.distanceMatrix({
      origins: [{ lng: 121.47, lat: 31.22 }],
      destinations: [{ lng: 121.5, lat: 31.23 }],
      mode: 'transit',
    })

    // 走步行接口（type=3）拿路网距离
    expect(calls[0]!.params.get('type')).toBe('3')
    expect(m.distanceMeters[0]![0]).toBe(5000)
    // 步行的 3600 秒被换算成公交时长，不是原样返回
    expect(m.durationSeconds[0]![0]).toBe(estimateDuration(5000, 'transit'))
  })

  it('origins 超过 100 个时分批', async () => {
    const { impl, calls } = mockFetch(({ params }) => {
      const n = params.get('origins')!.split('|').length
      return {
        results: Array.from({ length: n }, (_, i) => ({
          origin_id: String(i + 1),
          dest_id: '1',
          distance: '1000',
          duration: '600',
        })),
      }
    })

    const p = new AmapProvider('k', impl)
    const origins = Array.from({ length: 150 }, (_, i) => ({ lng: 121 + i * 0.001, lat: 31 }))
    const m = await p.distanceMatrix({
      origins,
      destinations: [{ lng: 121.5, lat: 31.23 }],
      mode: 'driving',
    })

    expect(calls).toHaveLength(2)
    expect(calls[0]!.params.get('origins')!.split('|')).toHaveLength(100)
    expect(calls[1]!.params.get('origins')!.split('|')).toHaveLength(50)
    expect(m.distanceMeters).toHaveLength(150)
  })
})

describe('route', () => {
  it('公交模式拼接步行段和公交段的折线', async () => {
    const { impl, calls } = mockFetch(() => ({
      route: {
        transits: [
          {
            distance: '8000',
            duration: '2400',
            segments: [
              { walking: { polyline: '121.47,31.22;121.475,31.222' } },
              { bus: { buslines: [{ polyline: '121.475,31.222;121.49,31.24' }] } },
            ],
          },
        ],
      },
    }))

    const p = new AmapProvider('k', impl)
    const r = await p.route({
      origin: { lng: 121.47, lat: 31.22 },
      destination: { lng: 121.49, lat: 31.24 },
      mode: 'transit',
      city: '上海',
    })

    expect(calls[0]!.path).toBe('/v3/direction/transit/integrated')
    expect(r!.distanceMeters).toBe(8000)
    expect(r!.polyline).toHaveLength(4)
  })

  it('单段失败返回 null，不让整个行程生成挂掉', async () => {
    const impl = (async () =>
      ({ ok: true, json: async () => ({ status: '0', info: 'NO_RESULT' }) }) as Response) as unknown as typeof fetch
    const p = new AmapProvider('k', impl)
    const r = await p.route({
      origin: { lng: 121.47, lat: 31.22 },
      destination: { lng: 121.49, lat: 31.24 },
      mode: 'driving',
    })
    expect(r).toBeNull()
  })

  it('各交通方式打到对应的接口', async () => {
    const cases: [('driving' | 'walking' | 'cycling'), string][] = [
      ['driving', '/v3/direction/driving'],
      ['walking', '/v3/direction/walking'],
      ['cycling', '/v3/direction/bicycling'],
    ]
    for (const [mode, path] of cases) {
      const { impl, calls } = mockFetch(() => ({
        route: { paths: [{ distance: '100', duration: '60', steps: [] }] },
      }))
      const p = new AmapProvider('k', impl)
      await p.route({
        origin: { lng: 121.47, lat: 31.22 },
        destination: { lng: 121.49, lat: 31.24 },
        mode,
      })
      expect(calls[0]!.path).toBe(path)
    }
  })
})

describe('geocode', () => {
  it('先试 POI 搜索，命中就不再打地理编码', async () => {
    const { impl, calls } = mockFetch(() => ({
      pois: [{ id: 'B1', name: '外滩风景区', location: '121.49,31.24' }],
    }))
    const p = new AmapProvider('k', impl)
    const r = await p.geocode({ city: '上海', address: '外滩' })

    expect(calls).toHaveLength(1)
    expect(calls[0]!.path).toBe('/v3/place/text')
    expect(r[0]!.name).toBe('外滩风景区')
  })

  it('POI 搜索空时退回地理编码，externalId 标记为 geo:', async () => {
    const { impl, calls } = mockFetch(({ path }) =>
      path.includes('place/text')
        ? { pois: [] }
        : {
            geocodes: [
              { formatted_address: '上海市黄浦区某路', location: '121.49,31.24', district: '黄浦区' },
            ],
          },
    )
    const p = new AmapProvider('k', impl)
    const r = await p.geocode({ city: '上海', address: '某个小地方' })

    expect(calls).toHaveLength(2)
    expect(calls[1]!.path).toBe('/v3/geocode/geo')
    // geo: 前缀是上层判断"要不要存成用户自定义 POI"的依据
    expect(r[0]!.externalId).toMatch(/^geo:/)
  })
})

describe('decodePolyline', () => {
  it('解析高德的明文 lng,lat 串', () => {
    expect(decodePolyline('121.47,31.22;121.49,31.24')).toEqual([
      [121.47, 31.22],
      [121.49, 31.24],
    ])
  })

  it('跳过畸形片段', () => {
    expect(decodePolyline('121.47,31.22;;abc,def;121.49,31.24')).toEqual([
      [121.47, 31.22],
      [121.49, 31.24],
    ])
  })
})

describe('haversine', () => {
  it('同点距离为 0', () => {
    expect(haversine({ lng: 121.49, lat: 31.24 }, { lng: 121.49, lat: 31.24 })).toBe(0)
  })

  it('外滩到迪士尼约 20km 量级', () => {
    const d = haversine({ lng: 121.4903, lat: 31.2397 }, { lng: 121.6689, lat: 31.1434 })
    expect(d).toBeGreaterThan(18000)
    expect(d).toBeLessThan(24000)
  })
})

describe('estimateDuration', () => {
  it('公交带固定的等车换乘开销', () => {
    // 距离趋于 0 时步行也趋于 0，公交仍有 10 分钟起步
    expect(estimateDuration(0, 'transit')).toBe(600)
    expect(estimateDuration(0, 'walking')).toBe(0)
  })

  it('同距离下驾车快于步行', () => {
    expect(estimateDuration(5000, 'driving')).toBeLessThan(estimateDuration(5000, 'walking'))
  })
})
