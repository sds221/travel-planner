'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, MapPin, ChevronRight } from 'lucide-react'
import { api, ApiError } from '@/lib/client'
import { ErrorBox, SetupHint, Spinner, Empty } from '@/components/ui'
import { STATUS_LABEL } from '@/lib/utils'
import type { Trip } from '@/types'

const CITIES = ['上海', '北京', '成都', '杭州', '西安', '广州', '深圳', '重庆', '南京', '厦门']

/** 把异常收敛成 {message, kind}，kind 决定是显示报错还是显示配置引导 */
function toError(err: unknown, fallback: string): { message: string; kind?: string } {
  if (err instanceof ApiError) return { message: err.message, kind: err.kind }
  return { message: err instanceof Error ? err.message : fallback }
}

/** 需要配置引导而不是报错的几类 */
const SETUP_KINDS = new Set(['database', 'migration', 'config'])

export default function HomePage() {
  const router = useRouter()
  const [trips, setTrips] = useState<Trip[] | null>(null)
  const [error, setError] = useState<{ message: string; kind?: string } | null>(null)
  const [creating, setCreating] = useState(false)

  const [city, setCity] = useState('上海')
  const [title, setTitle] = useState('')
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')
  const [partySize, setPartySize] = useState(2)

  const load = useCallback(() => {
    setError(null)
    api
      .listTrips()
      .then(setTrips)
      .catch((err: unknown) => {
        setTrips([])
        setError(toError(err, '加载失败'))
      })
  }, [])

  useEffect(() => {
    load()
  }, [load])

  async function create() {
    setCreating(true)
    setError(null)
    try {
      const trip = await api.createTrip({
        title: title.trim() || `${city}之旅`,
        city,
        startDate: startDate || undefined,
        endDate: endDate || undefined,
        partySize,
      })
      router.push(`/trips/${trip.id}`)
    } catch (err) {
      setError(toError(err, '创建失败'))
      setCreating(false)
    }
  }

  return (
    <main className="mx-auto max-w-3xl px-4 pb-16 pt-12">
      <header className="mb-9">
        <h1 className="text-[2.1rem] font-semibold leading-tight tracking-tight">
          去哪儿,
          <span className="bg-gradient-to-r from-[var(--accent)] to-[var(--terra)] bg-clip-text text-transparent">
            怎么走
          </span>
        </h1>
        <p className="mt-2.5 max-w-lg text-sm leading-relaxed text-[var(--muted)]">
          选景点 → 选酒店 → 生成最优路线。顺序和时刻由算法算,AI 负责挑选和解释。
        </p>
        <div className="mt-4 flex flex-wrap gap-x-4 gap-y-1.5 text-xs text-[var(--faint)]">
          <span>地理聚类分天</span>
          <span className="text-[var(--border-strong)]">·</span>
          <span>2-opt 定序</span>
          <span className="text-[var(--border-strong)]">·</span>
          <span>营业时间感知</span>
          <span className="text-[var(--border-strong)]">·</span>
          <span>真实通勤时间</span>
        </div>
      </header>

      {error && (
        <div className="mb-5">
          {SETUP_KINDS.has(error.kind ?? '') ? (
            <SetupHint kind={error.kind} message={error.message} onRetry={load} />
          ) : (
            <ErrorBox message={error.message} onRetry={load} />
          )}
        </div>
      )}

      <section className="panel relative mb-9 space-y-4 overflow-hidden p-6">
        {/* 卡片顶边一道暖色渐变,给表单一个"入口"的重量 */}
        <div className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-[var(--accent)] to-transparent opacity-60" />

        <h2 className="flex items-center gap-2 text-sm font-semibold">
          <span className="flex h-6 w-6 items-center justify-center rounded-lg bg-[var(--accent-soft)]">
            <Plus className="h-3.5 w-3.5 text-[var(--accent)]" />
          </span>
          新建行程
        </h2>

        <div>
          <span className="label">城市</span>
          <div className="flex flex-wrap gap-1.5">
            {CITIES.map((c) => (
              <button
                key={c}
                onClick={() => setCity(c)}
                className={`rounded-full border px-3 py-1 text-xs transition-all ${
                  city === c
                    ? 'border-[var(--accent)] bg-[var(--accent-soft)] font-medium text-[var(--accent)]'
                    : 'border-[var(--border)] text-[var(--muted)] hover:border-[var(--border-strong)] hover:text-[var(--text)]'
                }`}
              >
                {c}
              </button>
            ))}
          </div>
          <input
            className="input mt-2"
            placeholder="或直接输入其它城市"
            value={CITIES.includes(city) ? '' : city}
            onChange={(e) => setCity(e.target.value || '上海')}
          />
        </div>

        <div>
          <label className="label" htmlFor="title">
            行程名称（可留空）
          </label>
          <input
            id="title"
            className="input"
            placeholder={`${city}之旅`}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>

        <div className="grid gap-3 sm:grid-cols-3">
          <div>
            <label className="label" htmlFor="start">
              出发日期
            </label>
            <input
              id="start"
              className="input"
              type="date"
              value={startDate}
              onChange={(e) => setStartDate(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="end">
              返程日期
            </label>
            <input
              id="end"
              className="input"
              type="date"
              min={startDate || undefined}
              value={endDate}
              onChange={(e) => setEndDate(e.target.value)}
            />
          </div>
          <div>
            <label className="label" htmlFor="party">
              人数
            </label>
            <input
              id="party"
              className="input"
              type="number"
              min={1}
              max={20}
              value={partySize}
              onChange={(e) => setPartySize(Math.max(1, Number(e.target.value) || 1))}
            />
          </div>
        </div>

        <p className="text-xs text-[var(--muted)]">
          不填日期也能规划，系统会按景点数量估算天数（约每天 3 个点）。
        </p>

        <button className="btn-primary" onClick={create} disabled={creating}>
          {creating ? '创建中…' : '开始规划'}
        </button>
      </section>

      <section>
        <h2 className="mb-3 flex items-baseline gap-2 text-sm font-semibold">
          我的行程
          {trips && trips.length > 0 && (
            <span className="text-xs font-normal text-[var(--faint)]">{trips.length}</span>
          )}
        </h2>
        {trips === null ? (
          <div className="flex justify-center py-8">
            <Spinner className="text-[var(--muted)]" />
          </div>
        ) : trips.length === 0 ? (
          // 加载失败时不能说"用上面的表单创建" —— 创建也会失败，
          // 让用户白试一次不如直接说清楚是列表读不出来
          <Empty>{error ? '读不出行程列表，先按上面的提示配置好环境。' : '还没有行程，用上面的表单创建一个。'}</Empty>
        ) : (
          <ul className="space-y-2">
            {trips.map((t) => (
              <li key={t.id}>
                <button
                  onClick={() => router.push(`/trips/${t.id}`)}
                  className="panel group flex w-full items-center gap-3.5 p-3.5 text-left transition-all
                    hover:border-[var(--border-strong)] hover:bg-[var(--raised)]"
                >
                  {/* 城市首字做视觉锚点,列表长了也能快速扫 */}
                  <span
                    className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl
                      border border-[var(--border)] bg-[var(--raised)] text-base font-medium
                      text-[var(--accent)] transition-colors group-hover:border-[var(--accent)]/40"
                  >
                    {t.city.slice(0, 1)}
                  </span>

                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{t.title}</p>
                    <p className="mt-1 flex items-center gap-1 text-xs text-[var(--muted)]">
                      <MapPin className="h-3 w-3 shrink-0" />
                      {t.city}
                      {t.startDate && ` · ${t.startDate}`}
                      {t.endDate && ` 至 ${t.endDate}`}
                    </p>
                  </div>

                  <span
                    className={`chip shrink-0 ${
                      t.status === 'planned' ? 'chip-active' : ''
                    }`}
                  >
                    {STATUS_LABEL[t.status] ?? t.status}
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-[var(--faint)] transition-transform group-hover:translate-x-0.5 group-hover:text-[var(--accent)]" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
