import { NextResponse } from 'next/server'
import { z } from 'zod'

/**
 * 路由层的统一约定。
 *
 * agent 调用会因为外部服务（LLM/高德）失败，这类错误必须带上可读信息
 * 传到前端 —— "生成失败"对用户毫无用处，"高德 key 未配置"能让他自己解决。
 * 同时不能把堆栈或 key 泄出去，所以只透出 message。
 */

export function ok<T>(data: T, init?: number) {
  return NextResponse.json({ ok: true as const, data }, { status: init ?? 200 })
}

/**
 * 序列化之前的形状。
 *
 * 契约(@/types/api)描述的是**前端收到的 JSON**,而路由手里拿的是序列化
 * 之前的值 —— 差别主要在 Date:数据库返回 `Date`,`JSON.stringify` 会把它
 * 变成 ISO 字符串,所以契约里写的是 `string`。
 *
 * 如果直接拿契约类型去卡路由的返回值,`Date` vs `string` 会报一堆假错,
 * 逼着人在路由里到处写 `.toISOString()`(纯样板)或者干脆放弃类型检查。
 * 这个类型把"JSON 化"这层语义补上:契约要 string 的位置,路由给 Date
 * 或 string 都算对。
 *
 * 只放宽 Date,不放宽别的 —— 漏字段、类型写错这些真问题照样拦住。
 */
type BeforeJson<T> = T extends string
  ? T | Date
  : T extends (infer E)[]
    ? BeforeJson<E>[]
    : T extends object
      ? { [K in keyof T]: BeforeJson<T[K]> }
      : T

/**
 * 按契约返回,让后端也受 @/types/api 约束。
 *
 * `ok()` 的泛型是自由推导的,后端返回什么结构都不会报错 —— 契约只拦住了
 * 前端。用 `okAs<GetTripData>(...)` 写的话,后端漏字段/类型写错会当场编译
 * 失败,而不是等前端运行时拿到 undefined。
 *
 * 实测:后端漏返回 city 时报
 *   Type '{...}' is missing the following properties from type 'Trip': city, status, ...
 */
export function okAs<T>(data: BeforeJson<T>, init?: number) {
  return ok(data, init)
}

export function fail(message: string, status = 400, extra?: Record<string, unknown>) {
  return NextResponse.json({ ok: false as const, error: message, ...extra }, { status })
}

/**
 * 收集 error.cause 链上的所有消息。
 *
 * postgres.js 把连接错误包在 "Failed query: select ..." 里，真正的原因
 * （ECONNREFUSED / 数据库不存在 / 表不存在）在 cause 上。只看最外层
 * message 会把"没起 Postgres"显示成一句看不懂的 SQL。
 */
function messageChain(err: unknown): string {
  const parts: string[] = []
  let current: unknown = err
  for (let depth = 0; current && depth < 5; depth++) {
    if (current instanceof Error) {
      parts.push(current.message)
      // postgres.js 的错误把 PG 错误码放在 code 上
      const code = (current as { code?: string }).code
      if (code) parts.push(code)
      current = current.cause
    } else {
      parts.push(String(current))
      break
    }
  }
  return parts.join(' | ')
}

/** 把抛出的异常翻译成响应。配置类错误保留原文，便于用户自查 */
export function failFromError(err: unknown) {
  const message = messageChain(err)

  // 缺配置是 503 而不是 500：服务本身没坏，是还没配好。
  // 消息里带了"需要配置 X，请在 .env 里填上"，直接透给用户最有用。
  if (/请在 \.env 里填上|未配置/.test(message)) return fail(message, 503, { kind: 'config' })

  // 连不上数据库：本机开发时最常见的原因是没起 Postgres
  if (/ECONNREFUSED|ENOTFOUND|connect ECONN|Connection terminated|CONNECTION_/i.test(message)) {
    return fail('连不上数据库。先启动 Postgres（pnpm db:up），并检查 .env 的 DATABASE_URL', 503, {
      kind: 'database',
    })
  }
  // 数据库/角色不存在：连上了服务但目标库没建
  if (/database ".*" does not exist|3D000/i.test(message)) {
    return fail('数据库不存在。先创建库并运行 pnpm db:migrate', 503, { kind: 'database' })
  }
  if (/role ".*" does not exist|28000|password authentication failed/i.test(message)) {
    return fail('数据库账号或密码不对，检查 .env 的 DATABASE_URL', 503, { kind: 'database' })
  }
  // 库在但表没建
  if (/relation ".*" does not exist|42P01/i.test(message)) {
    return fail('数据库表还没创建，先运行 pnpm db:migrate', 503, { kind: 'migration' })
  }

  if (/高德/.test(message)) return fail(`地图服务调用失败：${message}`, 502)
  if (/超时|aborted|timeout/i.test(message)) return fail('模型响应超时，请重试', 504)
  return fail(message, 500)
}

export async function parseBody<T>(req: Request, schema: z.ZodType<T, z.ZodTypeDef, any>): Promise<
  { ok: true; data: T } | { ok: false; response: NextResponse }
> {
  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return { ok: false, response: fail('请求体不是合法 JSON') }
  }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join('.') || 'body'}: ${i.message}`)
      .join('; ')
    return { ok: false, response: fail(`参数校验失败 —— ${detail}`) }
  }
  return { ok: true, data: parsed.data }
}
