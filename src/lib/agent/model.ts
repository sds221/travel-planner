import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import type { LanguageModel } from 'ai'
import { llmEnv } from '../env'

/**
 * DeepSeek 走 OpenAI 兼容协议，所以用 openai-compatible 而不是专用 provider ——
 * 换成通义/月之暗面/本地 vLLM 只需要改 .env 里的 base URL 和 model 名。
 */
let cached: LanguageModel | undefined

export function getModel(): LanguageModel {
  if (!cached) {
    const env = llmEnv()
    const provider = createOpenAICompatible({
      name: 'llm',
      baseURL: env.LLM_BASE_URL,
      apiKey: env.LLM_API_KEY,
    })
    cached = provider.chatModel(env.LLM_MODEL)
  }
  return cached
}

/**
 * 只用于记轨迹，所以不强制校验环境变量 —— 注入了 mock 模型的测试路径
 * 不该因为没配 LLM_API_KEY 就挂掉。
 */
export function getModelName(): string {
  return process.env.LLM_MODEL ?? 'unknown'
}
