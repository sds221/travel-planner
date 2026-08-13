'use client'

import { useEffect, use } from 'react'
import Link from 'next/link'
import { ChevronLeft } from 'lucide-react'
import { useTripStore } from '@/lib/store'
import { StepPois } from '@/components/StepPois'
import { StepHotel } from '@/components/StepHotel'
import { StepPlan } from '@/components/StepPlan'
import { AgentTrace } from '@/components/AgentTrace'
import { Spinner, ErrorBox, SetupHint } from '@/components/ui'
import { STATUS_LABEL } from '@/lib/utils'

const STEPS = [
  { label: '选景点', hint: '推荐或自己导入' },
  { label: '选酒店', hint: '按预算和位置' },
  { label: '生成路线', hint: '最优顺序和时刻' },
]

export default function TripPage({ params }: { params: Promise<{ tripId: string }> }) {
  const { tripId } = use(params)
  const { detail, loading, error, errorKind, step, load, setStep } = useTripStore()

  useEffect(() => {
    load(tripId)
  }, [tripId, load])

  if (loading && !detail) {
    return (
      <main className="flex min-h-screen items-center justify-center">
        <Spinner className="text-[var(--muted)]" />
      </main>
    )
  }

  if (error && !detail) {
    const isSetup = errorKind === 'database' || errorKind === 'migration' || errorKind === 'config'
    return (
      <main className="mx-auto max-w-3xl px-4 py-10">
        {isSetup ? (
          <SetupHint kind={errorKind} message={error} onRetry={() => load(tripId)} />
        ) : (
          <ErrorBox message={error} onRetry={() => load(tripId)} />
        )}
        <Link href="/" className="mt-4 inline-block text-xs text-[var(--accent)] underline">
          返回首页
        </Link>
      </main>
    )
  }

  if (!detail) return null
  const { trip, pois } = detail

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-6">
        <Link
          href="/"
          className="mb-3 inline-flex items-center gap-1 text-xs text-[var(--muted)] hover:text-[var(--text)]"
        >
          <ChevronLeft className="h-3.5 w-3.5" />
          全部行程
        </Link>
        <div className="flex flex-wrap items-baseline gap-2">
          <h1 className="text-xl font-semibold">{trip.title}</h1>
          <span className="chip">{trip.city}</span>
          <span className="chip">{STATUS_LABEL[trip.status] ?? trip.status}</span>
        </div>
        <p className="mt-1 text-xs text-[var(--muted)]">
          {trip.startDate ? `${trip.startDate} 起 · ` : ''}
          {detail.days} 天 · {trip.partySize} 人 · 已选 {pois.length} 个景点
        </p>
      </header>

      {/* 步骤条：允许自由跳转，因为用户经常需要回去改景点 */}
      <nav className="mb-6 grid grid-cols-3 gap-2">
        {STEPS.map((s, i) => {
          const active = step === i
          // 第二、三步在没选景点前点了也没用，置灰但不禁用（提示比拦截友好）
          const usable = i === 0 || pois.length > 0
          // 走过的步骤标成完成态,给一点推进感
          const done = i < step && usable
          return (
            <button
              key={s.label}
              onClick={() => setStep(i)}
              className={`group relative overflow-hidden rounded-xl border px-3.5 py-2.5 text-left transition-all ${
                active
                  ? 'border-[var(--accent)] bg-[var(--accent-soft)]'
                  : 'border-[var(--border)] hover:border-[var(--border-strong)] hover:bg-[var(--raised)]'
              } ${!usable && !active ? 'opacity-45' : ''}`}
            >
              <div className="flex items-center gap-1.5">
                <span
                  className={`flex h-4 w-4 items-center justify-center rounded-full text-[10px] font-medium ${
                    active
                      ? 'bg-[var(--accent)] text-[#231508]'
                      : done
                        ? 'bg-[var(--success)]/25 text-[var(--success)]'
                        : 'bg-[var(--raised)] text-[var(--faint)]'
                  }`}
                >
                  {done ? '✓' : i + 1}
                </span>
                <p
                  className={`text-sm font-medium ${active ? 'text-[var(--accent)]' : ''}`}
                >
                  {s.label}
                </p>
              </div>
              <p className="mt-1 hidden text-[11px] leading-snug text-[var(--muted)] sm:block">
                {s.hint}
              </p>
            </button>
          )
        })}
      </nav>

      {step === 0 && <StepPois />}
      {step === 1 && <StepHotel />}
      {step === 2 && <StepPlan />}

      <div className="mt-8">
        <AgentTrace tripId={tripId} />
      </div>
    </main>
  )
}
