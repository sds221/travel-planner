import { describe, it, expect } from 'vitest'
import { tool, type LanguageModel } from 'ai'
import { z } from 'zod'
import { runAgent, type Tracer } from './react'
import type { AgentStep } from '../db/agent-runs'

/**
 * 自己写 mock 而不用 ai/test 的 MockLanguageModelV2：后者会 import msw，
 * 为了一个假模型多装一整套 HTTP 拦截依赖不值得。这里只实现 doGenerate，
 * 因为 generateText 用不到 doStream。
 */
type GenerateArgs = Parameters<LanguageModelV2['doGenerate']>[0]
type GenerateResult = Awaited<ReturnType<LanguageModelV2['doGenerate']>>
type LanguageModelV2 = Extract<LanguageModel, { specificationVersion: 'v2' }>

class MockModel {
  readonly specificationVersion = 'v2' as const
  readonly provider = 'mock'
  readonly modelId = 'mock-model'
  readonly supportedUrls = {}
  readonly calls: GenerateArgs[] = []

  private queue: GenerateResult[]
  private handler?: () => Promise<GenerateResult>

  constructor(steps: GenerateResult[] | (() => Promise<GenerateResult>)) {
    if (typeof steps === 'function') {
      this.queue = []
      this.handler = steps
    } else {
      this.queue = [...steps]
    }
  }

  doGenerate = async (args: GenerateArgs): Promise<GenerateResult> => {
    this.calls.push(args)
    if (this.handler) return this.handler()
    const next = this.queue.shift()
    if (!next) throw new Error('mock 模型的返回队列已空：说明循环比预期多跑了一步')
    return next
  }

  doStream = async (): Promise<never> => {
    throw new Error('测试不该用到 doStream')
  }
}

/** 把 MockModel 交给 generateText —— 结构上满足 LanguageModelV2 */
function asModel(m: MockModel): LanguageModel {
  return m as unknown as LanguageModel
}

/**
 * ReAct 循环本身的测试。模型和轨迹存储都注入 mock，不碰 LLM 和数据库。
 *
 * 覆盖的是这一层真正容易出错的地方：何时终止、多次提交取哪一次、
 * 模型不提交结果时怎么办、失败时轨迹有没有正确收尾。
 */

function memoryTracer() {
  const runs = new Map<
    string,
    { steps: AgentStep[]; status: string; error?: string; finished: boolean }
  >()
  let n = 0

  const tracer: Tracer = {
    async start() {
      const id = `run-${++n}`
      runs.set(id, { steps: [], status: 'running', finished: false })
      return id
    },
    async append(runId, steps) {
      runs.get(runId)!.steps.push(...steps)
    },
    async finish(runId, result) {
      const run = runs.get(runId)!
      run.status = result.status
      run.error = result.error
      run.finished = true
    },
  }
  return { tracer, runs }
}

const OUT_SCHEMA = z.object({
  answer: z.string(),
  score: z.number().default(5),
  notes: z.array(z.string()).default([]),
})

const USAGE = { inputTokens: 10, outputTokens: 20, totalTokens: 30 }

/** 一次 doGenerate 的返回：调用某个工具 */
function toolCallStep(toolName: string, input: unknown, id = 'c1') {
  return {
    content: [{ type: 'tool-call' as const, toolCallId: id, toolName, input: JSON.stringify(input) }],
    finishReason: 'tool-calls' as const,
    usage: USAGE,
    warnings: [],
  }
}

function textStep(text: string) {
  return {
    content: [{ type: 'text' as const, text }],
    finishReason: 'stop' as const,
    usage: USAGE,
    warnings: [],
  }
}

const NOOP_TOOLS = {
  lookup: tool({
    description: '查点东西',
    inputSchema: z.object({ q: z.string() }),
    execute: async ({ q }) => ({ found: `结果:${q}` }),
  }),
}

function base(model: MockModel, tracer: Tracer) {
  return {
    task: 'test',
    system: '你是测试助手',
    prompt: '干活',
    tools: NOOP_TOOLS,
    schema: OUT_SCHEMA,
    model: asModel(model),
    tracer,
  }
}

describe('runAgent', () => {
  it('模型调用提交工具后返回结构化结果', async () => {
    const { tracer, runs } = memoryTracer()
    const model = new MockModel([
      toolCallStep('submitResult', { answer: '好了', score: 9, notes: ['a'] }),
    ])

    const r = await runAgent(base(model, tracer))

    expect(r.output).toEqual({ answer: '好了', score: 9, notes: ['a'] })
    expect(r.usage.promptTokens).toBe(10)
    expect(runs.get(r.runId)!.status).toBe('succeeded')
    expect(runs.get(r.runId)!.finished).toBe(true)
  })

  it('省略的可选字段被补上 zod 默认值', async () => {
    const { tracer } = memoryTracer()
    const model = new MockModel([toolCallStep('submitResult', { answer: '只给了必填' })])

    const r = await runAgent(base(model, tracer))
    // SDK 的校验不会应用 default，所以 runAgent 里补了一次 parse
    expect(r.output.score).toBe(5)
    expect(r.output.notes).toEqual([])
  })

  it('先调业务工具再提交：多步 ReAct 走得通', async () => {
    const { tracer, runs } = memoryTracer()
    const model = new MockModel([
        toolCallStep('lookup', { q: '外滩' }, 'c1'),
        toolCallStep('submitResult', { answer: '用到了工具结果' }, 'c2'),
      ])

    const r = await runAgent(base(model, tracer))

    expect(r.steps).toBe(2)
    expect(r.output.answer).toBe('用到了工具结果')

    // 轨迹里两次工具调用都在，且记下了返回值
    const steps = runs.get(r.runId)!.steps
    const names = steps.filter((s) => s.type === 'tool').map((s) => s.toolName)
    expect(names).toEqual(['lookup', 'submitResult'])
    expect(JSON.stringify(steps[0]!.output)).toContain('结果:外滩')
  })

  it('提交后立刻停止，不再多调模型', async () => {
    const { tracer } = memoryTracer()
    const model = new MockModel([
        toolCallStep('submitResult', { answer: '第一次' }, 'c1'),
        // 如果没在提交后终止，这一步会被消费掉
        toolCallStep('submitResult', { answer: '不该被调用' }, 'c2'),
      ])

    const r = await runAgent(base(model, tracer))
    expect(model.calls).toHaveLength(1)
    expect(r.output.answer).toBe('第一次')
  })

  it('步数耗尽仍未提交时报错，并把轨迹标记为失败', async () => {
    const { tracer, runs } = memoryTracer()
    const model = new MockModel(async () => toolCallStep('lookup', { q: '一直查' }))

    await expect(runAgent({ ...base(model, tracer), maxSteps: 3 })).rejects.toThrow(/没有提交结果/)

    // 循环确实被步数上限挡住了，没有无限打转
    expect(model.calls).toHaveLength(3)
    const run = [...runs.values()][0]!
    expect(run.status).toBe('failed')
    expect(run.finished).toBe(true)
  })

  it('模型只回文本不调工具时也报错，而不是返回空结果', async () => {
    const { tracer } = memoryTracer()
    const model = new MockModel([textStep('我觉得应该去外滩')])

    await expect(runAgent(base(model, tracer))).rejects.toThrow(/没有提交结果/)
  })

  it('模型抛错时轨迹收尾为 failed 并带上原因', async () => {
    const { tracer, runs } = memoryTracer()
    const model = new MockModel(async () => {
      throw new Error('上游 502')
    })

    await expect(runAgent(base(model, tracer))).rejects.toThrow(/502/)
    const run = [...runs.values()][0]!
    expect(run.status).toBe('failed')
    expect(run.error).toMatch(/502/)
  })

  it('轨迹写入失败不影响主流程', async () => {
    const { tracer } = memoryTracer()
    const flaky: Tracer = {
      ...tracer,
      append: async () => {
        throw new Error('数据库连接断了')
      },
    }
    const model = new MockModel([toolCallStep('submitResult', { answer: '照样返回' })])

    const r = await runAgent({ ...base(model, tracer), tracer: flaky })
    expect(r.output.answer).toBe('照样返回')
  })

  it('提交工具的 schema 传给了模型，且提示词要求必须调用它', async () => {
    const { tracer } = memoryTracer()
    const model = new MockModel([toolCallStep('submitResult', { answer: 'x' })])

    await runAgent(base(model, tracer))
    const call = model.calls[0]!

    const names = (call.tools ?? []).map((t) => ('name' in t ? t.name : ''))
    expect(names).toContain('submitResult')
    expect(names).toContain('lookup')

    // 关键：不能设 json response format，否则 DeepSeek 的工具调用会失效
    expect(call.responseFormat?.type).not.toBe('json')

    const system = call.prompt.find((m) => m.role === 'system')
    expect(JSON.stringify(system)).toContain('submitResult')
  })

  it('大的工具返回被截断后再落库', async () => {
    const { tracer, runs } = memoryTracer()
    const bigTools = {
      dump: tool({
        description: '返回一大堆数据',
        inputSchema: z.object({}),
        execute: async () => ({ blob: 'x'.repeat(20_000) }),
      }),
    }
    const model = new MockModel([
        toolCallStep('dump', {}, 'c1'),
        toolCallStep('submitResult', { answer: 'done' }, 'c2'),
      ])

    const r = await runAgent({
      task: 'test',
      system: 's',
      prompt: 'p',
      tools: bigTools,
      schema: OUT_SCHEMA,
      model: asModel(model),
      tracer,
    })

    const dumpStep = runs.get(r.runId)!.steps.find((s) => s.toolName === 'dump')!
    expect(JSON.stringify(dumpStep.output).length).toBeLessThan(6000)
    expect(dumpStep.output).toMatchObject({ _truncated: true })
  })
})
