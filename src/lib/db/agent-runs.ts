import { eq, desc, sql } from 'drizzle-orm'
import { getDb, schema } from './index'

export type AgentStep = NonNullable<typeof schema.agentRuns.$inferSelect['steps']>[number]

/**
 * agent 轨迹的写入。刻意做成"开始时插一行，结束时补齐"而不是跑完一次性写：
 * agent 挂在中途（LLM 超时、工具抛错）时，已经执行的步骤才是排查的关键，
 * 一次性写会把这部分丢掉。
 */
export async function startRun(input: {
  tripId?: string | null
  userId?: string | null
  task: string
  model?: string
  userMessage?: string
}): Promise<string> {
  const rows = await getDb()
    .insert(schema.agentRuns)
    .values({
      tripId: input.tripId ?? null,
      userId: input.userId ?? null,
      task: input.task,
      model: input.model ?? null,
      userMessage: input.userMessage ?? null,
    })
    .returning({ id: schema.agentRuns.id })
  return rows[0]!.id
}

export async function appendSteps(runId: string, steps: AgentStep[]): Promise<void> {
  if (steps.length === 0) return
  // jsonb 数组拼接在 SQL 侧做，避免读改写的竞态
  await getDb()
    .update(schema.agentRuns)
    .set({
      steps: sql`COALESCE(${schema.agentRuns.steps}, '[]'::jsonb) || ${JSON.stringify(steps)}::jsonb`,
    })
    .where(eq(schema.agentRuns.id, runId))
}

export async function finishRun(
  runId: string,
  result: {
    status: 'succeeded' | 'failed'
    error?: string
    promptTokens?: number
    completionTokens?: number
  },
): Promise<void> {
  await getDb()
    .update(schema.agentRuns)
    .set({
      status: result.status,
      error: result.error ?? null,
      promptTokens: result.promptTokens ?? null,
      completionTokens: result.completionTokens ?? null,
      finishedAt: new Date(),
    })
    .where(eq(schema.agentRuns.id, runId))
}

export async function listRuns(tripId: string) {
  return getDb()
    .select()
    .from(schema.agentRuns)
    .where(eq(schema.agentRuns.tripId, tripId))
    .orderBy(desc(schema.agentRuns.startedAt))
    .limit(20)
}
