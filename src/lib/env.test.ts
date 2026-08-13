import { describe, it, expect, beforeEach, afterEach } from 'vitest'

/**
 * 环境变量按能力分组校验的测试。
 *
 * 起因是一个真实的 bug：原来是一个大 schema 全量校验，结果只想看行程列表
 * （只需要 DATABASE_URL）也会因为没配 LLM_API_KEY 而 500，报错还指向
 * 一个跟当前操作无关的字段。这几条断言防止它回来。
 *
 * env.ts 内部有缓存，所以每个用例都要 resetModules 重新 import。
 */

const ORIGINAL = { ...process.env }

beforeEach(() => {
  // 清掉所有相关变量，避免本机 .env 干扰断言
  for (const k of [
    'DATABASE_URL',
    'REDIS_URL',
    'LLM_BASE_URL',
    'LLM_API_KEY',
    'LLM_MODEL',
    'AMAP_SERVER_KEY',
    'ARK_API_KEY',
    'ARK_MODEL',
    'PRICE_MODE',
  ]) {
    delete process.env[k]
  }
})

afterEach(() => {
  process.env = { ...ORIGINAL }
})

/** 每次拿到一份没有缓存的 env 模块 */
async function freshEnv() {
  const { resetModules } = await import('vitest').then((m) => m.vi)
  resetModules()
  return import('./env')
}

describe('分组校验', () => {
  it('只配数据库时 dbEnv 可用，不会因为缺 LLM key 而失败', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db'
    const env = await freshEnv()

    // 这就是那个 bug：浏览行程只需要数据库
    expect(env.dbEnv().DATABASE_URL).toBe('postgresql://u:p@localhost:5432/db')
    expect(() => env.llmEnv()).toThrow()
  })

  it('缺 DATABASE_URL 时 dbEnv 报错并说明影响的功能', async () => {
    const env = await freshEnv()
    expect(() => env.dbEnv()).toThrow(/数据库连接需要配置 DATABASE_URL/)
    // 报错要告诉用户去哪儿改
    expect(() => env.dbEnv()).toThrow(/\.env/)
  })

  it('缺 LLM key 的报错说明是 AI 功能不可用', async () => {
    const env = await freshEnv()
    expect(() => env.llmEnv()).toThrow(/AI 功能.*LLM_API_KEY/)
  })

  it('缺高德 key 的报错说明是地图功能不可用', async () => {
    const env = await freshEnv()
    expect(() => env.amapEnv()).toThrow(/地图功能.*AMAP_SERVER_KEY/)
  })

  it('查价配置全可选，什么都不配也能读出默认值', async () => {
    const env = await freshEnv()
    const price = env.priceEnv()
    expect(price.PRICE_MODE).toBe('auto')
    expect(price.ARK_API_KEY).toBeUndefined()
    expect(price.ARK_MODEL).toBeTruthy()
  })
})

describe('空字符串等同于没配', () => {
  it('REDIS_URL 留空时是 undefined，不当成合法值', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db'
    process.env.REDIS_URL = ''
    const env = await freshEnv()

    // .env 里写 REDIS_URL= 是常见写法，不该让缓存层拿空串去连
    expect(env.dbEnv().REDIS_URL).toBeUndefined()
  })

  it('ARK_API_KEY 留空时不会被当成配了', async () => {
    process.env.ARK_API_KEY = ''
    const env = await freshEnv()
    // 空串如果被当成"配了"，会走联网查价然后每次都 401
    expect(env.priceEnv().ARK_API_KEY).toBeUndefined()
  })
})

describe('默认值', () => {
  it('LLM 的 base URL 和模型有默认值，只需配 key', async () => {
    process.env.LLM_API_KEY = 'sk-test'
    const env = await freshEnv()
    const llm = env.llmEnv()
    expect(llm.LLM_BASE_URL).toBe('https://api.deepseek.com/v1')
    expect(llm.LLM_MODEL).toBe('deepseek-chat')
  })

  it('非法的 PRICE_MODE 被拒绝而不是静默忽略', async () => {
    process.env.PRICE_MODE = 'magic'
    const env = await freshEnv()
    expect(() => env.priceEnv()).toThrow(/PRICE_MODE/)
  })

  it('非法的 LLM_BASE_URL 被拒绝', async () => {
    process.env.LLM_API_KEY = 'sk-test'
    process.env.LLM_BASE_URL = '不是url'
    const env = await freshEnv()
    expect(() => env.llmEnv()).toThrow(/LLM_BASE_URL/)
  })
})

describe('envStatus', () => {
  it('汇总哪些能力可用、缺什么', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db'
    const env = await freshEnv()
    const status = env.envStatus()

    expect(status.db).toBe(true)
    expect(status.llm).toBe(false)
    expect(status.amap).toBe(false)
    expect(status.arkSearch).toBe(false)
    expect(status.missing).toContain('LLM_API_KEY')
    expect(status.missing).toContain('AMAP_SERVER_KEY')
    expect(status.missing).not.toContain('DATABASE_URL')
  })

  it('全配齐时 arkSearch 也报 true', async () => {
    process.env.DATABASE_URL = 'postgresql://u:p@localhost:5432/db'
    process.env.LLM_API_KEY = 'sk-test'
    process.env.AMAP_SERVER_KEY = 'amap-key'
    process.env.ARK_API_KEY = 'ark-key'
    const env = await freshEnv()
    const status = env.envStatus()

    expect(status).toMatchObject({ db: true, llm: true, amap: true, arkSearch: true })
    expect(status.missing).toEqual([])
  })
})
