'use client'

import { useState } from 'react'
import { Terminal, ChevronDown, ChevronRight } from 'lucide-react'
import { api } from '@/lib/client'
import { Spinner, ErrorBox, Empty } from './ui'
import type { AgentRun } from '@/types'

const TASK_LABEL: Record<string, string> = {
  recommend_pois: '推荐景点',
  recommend_hotels: '推荐酒店',
  plan_route: '规划路线',
}

/**
 * ReAct 轨迹查看器。
 *
 * 这个面板不是给终端用户看的花活 —— 它是"为什么把这两个远的地方排在
 * 同一天"这类问题的唯一答案来源。agent 调了哪些工具、拿到什么数据、
 * 试算了几次，都在这里。默认折叠，需要时展开。
 */
export function AgentTrace({ tripId }: { tripId: string }) {
  const [open, setOpen] = useState(false)
  const [runs, setRuns] = useState<AgentRun[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  async function toggle() {
    const next = !open
    setOpen(next)
    if (next && runs === null) {
      try {
        setRuns(await api.getRuns(tripId))
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载失败')
      }
    }
  }

  return (
    <section className="panel">
      <button
        className="flex w-full items-center justify-between p-4 text-left"
        onClick={toggle}
      >
        <span className="flex items-center gap-2 text-sm font-semibold">
          <Terminal className="h-4 w-4 text-[var(--muted)]" />
          AI 推理过程
        </span>
        <span className="flex items-center gap-2 text-xs text-[var(--muted)]">
          {open ? '收起' : '展开'}
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-[var(--border)] p-4">
          {error && <ErrorBox message={error} />}
          {runs === null && !error && (
            <div className="flex justify-center py-4">
              <Spinner className="text-[var(--muted)]" />
            </div>
          )}
          {runs?.length === 0 && <Empty>还没有 AI 调用记录。</Empty>}

          {runs?.map((run) => {
            const isOpen = expanded.has(run.id)
            return (
              <div key={run.id} className="rounded-lg border border-[var(--border)]">
                <button
                  className="flex w-full items-start justify-between gap-3 p-3 text-left"
                  onClick={() => {
                    const next = new Set(expanded)
                    if (isOpen) next.delete(run.id)
                    else next.add(run.id)
                    setExpanded(next)
                  }}
                >
                  <div className="min-w-0">
                    <p className="text-xs">
                      {TASK_LABEL[run.task] ?? run.task}
                      <span
                        className={`ml-2 ${
                          run.status === 'failed'
                            ? 'text-red-400'
                            : run.status === 'running'
                              ? 'text-amber-400'
                              : 'text-green-400'
                        }`}
                      >
                        {run.status === 'succeeded' ? '成功' : run.status === 'failed' ? '失败' : '进行中'}
                      </span>
                    </p>
                    <p className="mt-0.5 text-[11px] text-[var(--muted)]">
                      {run.steps.length} 步
                      {run.durationMs !== null && ` · ${(run.durationMs / 1000).toFixed(1)}s`}
                      {run.model && ` · ${run.model}`}
                      {run.promptTokens !== null &&
                        ` · ${run.promptTokens}+${run.completionTokens ?? 0} tokens`}
                    </p>
                    {run.error && (
                      <p className="mt-1 break-words text-[11px] text-red-300">{run.error}</p>
                    )}
                  </div>
                  {isOpen ? (
                    <ChevronDown className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--muted)]" />
                  ) : (
                    <ChevronRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[var(--muted)]" />
                  )}
                </button>

                {isOpen && (
                  <div className="space-y-2 border-t border-[var(--border)] p-3">
                    {run.userMessage && (
                      <p className="text-[11px] text-[var(--muted)]">
                        用户输入：{run.userMessage}
                      </p>
                    )}
                    {run.steps.length === 0 && (
                      <p className="text-[11px] text-[var(--muted)]">没有记录到步骤。</p>
                    )}
                    {run.steps.map((step) => (
                      <div key={step.index} className="rounded border border-[var(--border)] p-2">
                        {step.type === 'text' ? (
                          <p className="whitespace-pre-wrap text-[11px] leading-relaxed">
                            {step.text}
                          </p>
                        ) : (
                          <>
                            <p className="font-mono text-[11px] text-[var(--accent)]">
                              {step.toolName}()
                            </p>
                            <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all text-[10px] text-[var(--muted)]">
                              入参 {JSON.stringify(step.input)}
                            </pre>
                            <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[10px] text-[var(--muted)]">
                              返回 {JSON.stringify(step.output)}
                            </pre>
                          </>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
