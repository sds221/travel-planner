'use client'

import { Loader2, AlertCircle, Info } from 'lucide-react'
import { cn } from '@/lib/utils'

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('h-4 w-4 animate-spin', className)} />
}

/**
 * agent 调用要等 20-60 秒。空转的 spinner 会让人以为卡住了，
 * 所以显示当前在做什么，并说明大概要等多久。
 */
export function AgentPending({ label, hint }: { label: string; hint?: string }) {
  return (
    <div className="panel flex items-start gap-3 p-4">
      <Spinner className="mt-0.5 text-foreground" />
      <div className="space-y-1">
        <p className="text-sm">{label}</p>
        <p className="text-xs text-muted-foreground">
          {hint ?? '模型正在调用地图数据并推理，通常需要 20-60 秒'}
        </p>
      </div>
    </div>
  )
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-red-900/50 bg-red-950/30 p-4">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-400" />
      <div className="min-w-0 flex-1 space-y-2">
        <p className="break-words text-sm text-red-200">{message}</p>
        {onRetry && (
          <button onClick={onRetry} className="text-xs text-red-300 underline hover:text-red-200">
            重试
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * 环境没配好时的引导。
 *
 * 和 ErrorBox 分开：缺配置不是"出错了"，是"还没准备好"。用红色报错框
 * 显示"连不上数据库"会让人以为程序坏了，而实际上照着提示跑两条命令就行。
 */
export function SetupHint({
  kind,
  message,
  onRetry,
}: {
  kind?: string
  message: string
  onRetry?: () => void
}) {
  const steps = SETUP_STEPS[kind ?? ''] ?? null

  return (
    <div className="rounded-xl border border-amber-900/50 bg-amber-950/20 p-4">
      <div className="flex items-start gap-3">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
        <div className="min-w-0 flex-1 space-y-3">
          <p className="break-words text-sm text-amber-100">{message}</p>

          {steps && (
            <div className="space-y-1.5">
              <p className="text-xs text-amber-200/70">照这几步操作：</p>
              <ol className="space-y-1">
                {steps.map((s, i) => (
                  <li key={i} className="text-xs text-amber-200/90">
                    {i + 1}.{' '}
                    {s.cmd ? (
                      <code className="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[11px]">
                        {s.cmd}
                      </code>
                    ) : null}{' '}
                    {s.text}
                  </li>
                ))}
              </ol>
            </div>
          )}

          {onRetry && (
            <button
              onClick={onRetry}
              className="text-xs text-amber-300 underline hover:text-amber-200"
            >
              配置好了，重新加载
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

const SETUP_STEPS: Record<string, { cmd?: string; text: string }[]> = {
  database: [
    { cmd: 'pnpm db:up', text: '启动 Postgres 和 Redis（需要 Docker）' },
    { cmd: 'pnpm db:migrate', text: '建表' },
    { cmd: 'pnpm db:seed', text: '写入种子景点（可选，但没有它"系统推荐"是空的）' },
  ],
  migration: [
    { cmd: 'pnpm db:migrate', text: '建表' },
    { cmd: 'pnpm db:seed', text: '写入种子景点' },
  ],
  config: [
    { text: '复制 .env.example 为 .env' },
    { text: '填上 LLM_API_KEY（DeepSeek）和 AMAP_SERVER_KEY（高德 Web 服务）' },
    { text: '重启开发服务器' },
  ],
}

export function NoteBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-2 rounded-lg border border-border bg-white/[0.02] p-3">
      <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <div className="text-xs leading-relaxed text-muted-foreground">{children}</div>
    </div>
  )
}

export function Empty({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
      {children}
    </p>
  )
}

/**
 * 价格来源标注。
 *
 * 三种来源的可信度差别很大，用同一个"预估价"标签会误导：联网查到的
 * 价格用户可以点开来源核对，公式推的只是量级正确。颜色也分开 ——
 * 绿色表示有据可查，琥珀色表示估算。
 */
const PRICE_SOURCE_STYLE: Record<string, { label: string; className: string; title: string }> = {
  search: {
    label: '联网查价',
    className: 'bg-emerald-950/40 text-emerald-300',
    title: '来自订房平台的展示价格，可点击来源核对。实际房费随日期和房型浮动',
  },
  ota: {
    label: '平台报价',
    className: 'bg-emerald-950/40 text-emerald-300',
    title: '来自订房平台接口的可订价格',
  },
  llm: {
    label: '行情估价',
    className: 'bg-amber-950/40 text-amber-300',
    title: '模型根据市场行情判断的价位，没有实时来源，仅供比较档位',
  },
  formula: {
    label: '粗估价',
    className: 'bg-amber-950/40 text-amber-300',
    title: '按星级、品牌、城市水平推算，误差较大，仅供比较档位',
  },
}

export function PriceSourceBadge({ source }: { source: string }) {
  const style = PRICE_SOURCE_STYLE[source] ?? PRICE_SOURCE_STYLE.formula!
  return (
    <span
      title={style.title}
      className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${style.className}`}
    >
      {style.label}
    </span>
  )
}

/** 联网查到的价格附上来源链接，让用户能自己核对 */
export function PriceCitations({ citations }: { citations: { title: string; url: string }[] }) {
  if (citations.length === 0) return null
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      {citations.slice(0, 3).map((c) => (
        <a
          key={c.url}
          href={c.url}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[10px] text-foreground underline decoration-dotted hover:no-underline"
          title={c.title}
        >
          来源
        </a>
      ))}
    </span>
  )
}
