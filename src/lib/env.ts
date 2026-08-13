import { z } from 'zod'

/**
 * 环境变量按"能力"分组校验，而不是一次全校验。
 *
 * 一开始是一个大 schema 全量校验，结果只想看看行程列表（只需要数据库）
 * 也会因为没配 LLM_API_KEY 而 500 —— 报的错还指向一个跟当前操作
 * 毫无关系的字段。现在每个能力只检查自己需要的那几项：
 * 浏览行程不需要模型，画地图不需要方舟。
 *
 * 浏览器侧的配置在 env-public.ts，客户端组件不要从这个文件 import。
 */

const dbSchema = z.object({
  DATABASE_URL: z.string().min(1),
  // 空字符串等同于没配 —— .env 里留空是常见写法，不该当成合法 URL
  REDIS_URL: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
})

const llmSchema = z.object({
  LLM_BASE_URL: z.string().url().default('https://api.deepseek.com/v1'),
  LLM_API_KEY: z.string().min(1),
  LLM_MODEL: z.string().default('deepseek-chat'),
})

const amapSchema = z.object({
  AMAP_SERVER_KEY: z.string().min(1),
})

/**
 * 火山方舟(豆包)的凭据，只用于联网查房价。
 *
 * 单独配一份而不是复用 LLM_* 是因为这是两个不同的能力：主模型负责
 * 推理和文案（DeepSeek 够用且便宜），查房价需要 web_search，
 * 而只有方舟的 Responses API 有这个内置工具。
 * 不配就退回模型行情估价，功能不受影响但价格标注会不同。
 */
const priceSchema = z.object({
  ARK_API_KEY: z
    .string()
    .optional()
    .transform((v) => (v && v.length > 0 ? v : undefined)),
  ARK_MODEL: z.string().default('doubao-seed-1-6-250615'),
  /** 价格查询策略。auto = 配了 ARK 就联网查，否则用模型行情估价 */
  PRICE_MODE: z.enum(['auto', 'search', 'llm', 'formula']).default('auto'),
})

export type DbEnv = z.infer<typeof dbSchema>
export type LlmEnv = z.infer<typeof llmSchema>
export type AmapEnv = z.infer<typeof amapSchema>
export type PriceEnv = z.infer<typeof priceSchema>

const cache = new Map<string, unknown>()

/** 报错要说清楚缺什么、以及这会影响什么功能，而不是只报字段名 */
function read<T>(key: string, schema: z.ZodType<T, z.ZodTypeDef, any>, feature: string): T {
  const hit = cache.get(key)
  if (hit !== undefined) return hit as T

  const parsed = schema.safeParse(process.env)
  if (!parsed.success) {
    const bad = parsed.error.issues.map((i) => i.path.join('.')).join(', ')
    throw new Error(`${feature}需要配置 ${bad}，请在 .env 里填上（参考 .env.example）`)
  }
  cache.set(key, parsed.data)
  return parsed.data
}

export function dbEnv(): DbEnv {
  return read('db', dbSchema, '数据库连接')
}

export function llmEnv(): LlmEnv {
  return read('llm', llmSchema, 'AI 功能（景点/酒店推荐、行程生成）')
}

export function amapEnv(): AmapEnv {
  return read('amap', amapSchema, '地图功能（景点搜索、路径规划）')
}

export function priceEnv(): PriceEnv {
  return read('price', priceSchema, '房价查询')
}

/** 供 UI 提示"哪些功能还不能用" */
export function envStatus(): {
  db: boolean
  llm: boolean
  amap: boolean
  arkSearch: boolean
  missing: string[]
} {
  const missing: string[] = []
  const check = (fn: () => unknown, label: string): boolean => {
    try {
      fn()
      return true
    } catch {
      missing.push(label)
      return false
    }
  }

  const status = {
    db: check(dbEnv, 'DATABASE_URL'),
    llm: check(llmEnv, 'LLM_API_KEY'),
    amap: check(amapEnv, 'AMAP_SERVER_KEY'),
    arkSearch: false,
    missing,
  }

  try {
    status.arkSearch = priceEnv().ARK_API_KEY !== undefined
  } catch {
    // 查价配置全是可选的，理论上不会走到这里
  }

  return status
}

export { publicEnv } from './env-public'
