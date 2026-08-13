import { okAs, failFromError } from '@/lib/api'
import { listRuns } from '@/lib/db/agent-runs'
import type { GetRunsData } from '@/types/api'

/** ReAct 轨迹查询。UI 上的"查看推理过程"和排查问题都用这个。 */
export async function GET(_req: Request, { params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = await params
  try {
    const runs = await listRuns(tripId)
    return okAs<GetRunsData>(
      runs.map((r) => ({
        id: r.id,
        task: r.task,
        status: r.status,
        model: r.model,
        userMessage: r.userMessage,
        steps: r.steps,
        promptTokens: r.promptTokens,
        completionTokens: r.completionTokens,
        error: r.error,
        startedAt: r.startedAt,
        finishedAt: r.finishedAt,
        durationMs:
          r.finishedAt && r.startedAt
            ? new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()
            : null,
      })),
    )
  } catch (err) {
    return failFromError(err)
  }
}
