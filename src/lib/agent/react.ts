import { generateText, stepCountIs, hasToolCall, tool, type ToolSet, type LanguageModel } from 'ai'
import type { z } from 'zod'
import { getModel, getModelName } from './model'
import { startRun, appendSteps, finishRun, type AgentStep } from '../db/agent-runs'

/**
 * ReAct 循环。
 *
 * 这里没有手写 thought/action/observation 的字符串解析 —— AI SDK 的
 * multi-step tool calling 就是 ReAct：模型推理 → 调工具 → 拿到结果 →
 * 继续推理。自己实现一遍只会多一份容易解析出错的代码。
 *
 * 这一层真正提供的东西是：
 *   1. 每一步落库（agent_runs.steps），出问题能复现；
 *   2. 步数与超时上限，防止工具循环把 token 烧光；
 *   3. 结构化输出：用"提交答案"工具而不是 JSON mode，理由见下。
 */

/**
 * 最终答案通过这个工具提交，不用 experimental_output。
 *
 * 原因是 openai-compatible provider 在设了 output 之后，会给**每一步**都带上
 * response_format: json_object，包括那些要调工具的步骤。DeepSeek 的 JSON 模式
 * 和 function calling 不能同时用，实测会让工具调用失效或返回空 content。
 *
 * 走工具通道就没有这个问题：模型本来就在调工具，提交答案只是最后一次调用。
 * 附带的好处是 schema 校验和重试由 SDK 的工具入参机制负责，
 * 而且这次调用会原样出现在 agent_runs.steps 里，轨迹更完整。
 */
const SUBMIT_TOOL = 'submitResult'

export interface RunAgentOptions<TOOLS extends ToolSet, OUT> {
  task: string
  system: string
  prompt: string
  tools: TOOLS
  /** 覆盖默认模型。生产代码不传，测试用它注入 mock */
  model?: LanguageModel
  /** 覆盖轨迹存储。默认写数据库，测试注入内存实现 */
  tracer?: Tracer
  /**
   * 最终产物的 schema。
   * 第三个类型参数写 any 是必要的：带 .default() 的字段让 zod 的输入类型
   * 和输出类型不一致，写成 z.ZodType<OUT> 会把 OUT 推成输入类型，
   * 于是有默认值的字段在调用方变成可选，白丢一层类型保障。
   */
  schema: z.ZodType<OUT, z.ZodTypeDef, any>
  maxSteps?: number
  timeoutMs?: number
  tripId?: string | null
  userId?: string | null
  /** 记轨迹用的原始用户输入 */
  userMessage?: string
}

/**
 * 轨迹存储。抽出接口是为了让 ReAct 循环本身可以脱离数据库测试 ——
 * 这个循环的逻辑（何时终止、拿哪次提交、没提交怎么办）比存储更容易出错，
 * 值得单独覆盖。
 */
export interface Tracer {
  start(input: {
    tripId?: string | null
    userId?: string | null
    task: string
    model?: string
    userMessage?: string
  }): Promise<string>
  append(runId: string, steps: AgentStep[]): Promise<void>
  finish(
    runId: string,
    result: {
      status: 'succeeded' | 'failed'
      error?: string
      promptTokens?: number
      completionTokens?: number
    },
  ): Promise<void>
}

const dbTracer: Tracer = {
  start: startRun,
  append: appendSteps,
  finish: finishRun,
}

export interface RunAgentResult<T> {
  runId: string
  output: T
  text: string
  steps: number
  usage: { promptTokens?: number; completionTokens?: number }
}

/** 工具入参/返回值可能很大（POI 列表），截断后再落库，避免 trace 表爆炸 */
function truncate(value: unknown, maxChars = 4000): unknown {
  const json = JSON.stringify(value)
  if (json === undefined) return null
  if (json.length <= maxChars) return JSON.parse(json)
  return { _truncated: true, preview: json.slice(0, maxChars) }
}

/** 只取轨迹需要的字段，避免和 StepResult<TOOLS> 的泛型协变较劲 */
interface StepLike {
  text: string
  toolCalls: readonly { toolCallId: string; toolName: string; input: unknown }[]
  toolResults: readonly { toolCallId: string; output?: unknown }[]
}

function toAgentSteps(step: StepLike, offset: number): AgentStep[] {
  const out: AgentStep[] = []
  let i = offset

  if (step.text.trim().length > 0) {
    out.push({ index: i++, type: 'text', text: step.text })
  }
  for (const call of step.toolCalls) {
    const result = step.toolResults.find((r) => r.toolCallId === call.toolCallId)
    out.push({
      index: i++,
      type: 'tool',
      toolName: call.toolName,
      input: truncate(call.input),
      output: result ? truncate(result.output) : undefined,
    })
  }
  return out
}

export async function runAgent<TOOLS extends ToolSet, OUT>(
  opts: RunAgentOptions<TOOLS, OUT>,
): Promise<RunAgentResult<OUT>> {
  const tracer = opts.tracer ?? dbTracer
  const runId = await tracer.start({
    tripId: opts.tripId,
    userId: opts.userId,
    task: opts.task,
    model: getModelName(),
    userMessage: opts.userMessage,
  })

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 90_000)
  let stepOffset = 0

  // 没有 execute：这是纯粹的输出通道，不需要副作用，
  // 由 stopWhen(hasToolCall) 在模型调用它之后立刻结束循环。
  const submit = tool({
    description:
      '提交最终结果。收集到足够信息后必须调用这个工具，这是唯一的输出方式；' +
      '不要用普通文本回答。',
    inputSchema: opts.schema,
  })

  const tools = { ...opts.tools, [SUBMIT_TOOL]: submit } as TOOLS & { [SUBMIT_TOOL]: typeof submit }

  try {
    const result = await generateText({
      model: opts.model ?? getModel(),
      system: `${opts.system}\n\n完成分析后，调用 ${SUBMIT_TOOL} 工具提交结果。这是唯一被接受的输出方式。`,
      prompt: opts.prompt,
      tools,
      // 两个终止条件：提交了答案，或者步数用尽（防止工具循环打转）
      stopWhen: [stepCountIs(opts.maxSteps ?? 8), hasToolCall(SUBMIT_TOOL)],
      abortSignal: controller.signal,
      onStepFinish: async (step) => {
        // 边跑边写：agent 卡死或超时后，已完成的步骤仍然可查
        const steps = toAgentSteps(step, stepOffset)
        stepOffset += steps.length
        try {
          await tracer.append(runId, steps)
        } catch {
          // 轨迹写失败不该中断规划
        }
      },
    })

    // 取最后一次提交（模型偶尔会调两次，后一次是修正）
    const submissions = result.steps
      .flatMap((s) => s.toolCalls)
      .filter((c) => c.toolName === SUBMIT_TOOL)

    const last = submissions.at(-1)
    if (!last) {
      throw new Error(
        `模型在 ${result.steps.length} 步内没有提交结果（可能是工具调用出错或步数不足），请重试`,
      )
    }

    // SDK 已按 inputSchema 校验过，这里再 parse 一次是为了拿到应用了
    // .default() 之后的值 —— 模型省略的可选字段要补上默认值。
    const output = opts.schema.parse(last.input)

    await tracer.finish(runId, {
      status: 'succeeded',
      promptTokens: result.totalUsage.inputTokens,
      completionTokens: result.totalUsage.outputTokens,
    })

    return {
      runId,
      output,
      text: result.text,
      steps: result.steps.length,
      usage: {
        promptTokens: result.totalUsage.inputTokens,
        completionTokens: result.totalUsage.outputTokens,
      },
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await tracer.finish(runId, {
      status: 'failed',
      error: controller.signal.aborted ? `超时或被中断: ${message}` : message,
    })
    throw err
  } finally {
    clearTimeout(timeout)
  }
}
