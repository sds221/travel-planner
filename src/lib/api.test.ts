import { describe, it, expect } from 'vitest'
import { ok, okAs, fail } from './api'

/**
 * 响应包装。
 *
 * 重点是 okAs:它在编译期用 @/types/api 的契约卡住后端返回值。类型检查跑在
 * tsc 里(vitest 看不到),所以这里测的是运行时行为没被 okAs 改变 —— 契约
 * 只该影响编译,不该改变实际发出去的 JSON。
 */
describe('响应包装', () => {
  it('ok 和 okAs 发出的 JSON 完全一样', async () => {
    const payload = { id: 'a', title: 't' }
    const a = await ok(payload).json()
    const b = await okAs<{ id: string; title: string }>(payload).json()
    expect(a).toEqual(b)
    expect(a).toEqual({ ok: true, data: payload })
  })

  it('okAs 保留自定义状态码', async () => {
    const res = okAs<{ id: string }>({ id: 'x' }, 201)
    expect(res.status).toBe(201)
  })

  it('Date 会被序列化成 ISO 字符串（契约里因此声明为 string）', async () => {
    // BeforeJson<T> 存在的原因:数据库给 Date,前端收到的是字符串。
    // 契约按前端视角写 string,okAs 允许路由传 Date。
    const at = new Date('2026-08-13T08:49:39.607Z')
    const body = (await okAs<{ startedAt: string }>({ startedAt: at }).json()) as {
      data: { startedAt: unknown }
    }
    expect(body.data.startedAt).toBe('2026-08-13T08:49:39.607Z')
    expect(typeof body.data.startedAt).toBe('string')
  })

  it('fail 带上 error 和状态码', async () => {
    const res = fail('行程不存在', 404)
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ ok: false, error: '行程不存在' })
  })

  it('fail 的 extra 能透出 kind，UI 靠它区分"没配好"和"出错了"', async () => {
    const res = fail('数据库连不上', 503, { kind: 'database' })
    expect(await res.json()).toMatchObject({ ok: false, kind: 'database' })
  })
})
