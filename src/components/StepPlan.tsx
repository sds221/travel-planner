'use client'

import { useState } from 'react'
import { Route, ArrowLeft, AlertTriangle, MapPin, Bed } from 'lucide-react'
import { api } from '@/lib/client'
import { useTripStore } from '@/lib/store'
import { RouteMap } from './RouteMap'
import { AgentPending, ErrorBox, NoteBox, Empty } from './ui'
import { km, duration, MODE_LABEL } from '@/lib/utils'
import type { ItineraryDay } from '@/types'

/**
 * 第三步：行程图。
 *
 * 时刻表来自算法，文案来自 agent。界面上把这两者的来源区分开 ——
 * 用户需要知道"09:30 到外滩"是算出来的（可信），
 * "建议开门就到，人少"是模型建议（参考）。
 */
export function StepPlan() {
  const { detail, refresh, setStep } = useTripStore()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [activeDay, setActiveDay] = useState<number | null>(null)
  const [message, setMessage] = useState('')
  const [result, setResult] = useState<{
    summary: string
    warnings: string[]
    droppedAdvice: { name: string; advice: string }[]
    dropped: string[]
    mode: string
    attempts: number
    degraded: string | null
  } | null>(null)

  if (!detail) return null
  const { trip, pois, hotel, itinerary } = detail
  const stale = trip.status === 'stale'

  async function generate() {
    setLoading(true)
    setError(null)
    try {
      const res = await api.generatePlan(trip.id, message || undefined)
      setResult(res)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '生成失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-5">
      {error && <ErrorBox message={error} onRetry={generate} />}

      <button
        className="flex items-center gap-1.5 text-xs text-[var(--muted)] hover:text-[var(--text)]"
        onClick={() => setStep(1)}
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        回到选酒店
      </button>

      {pois.length === 0 ? (
        <Empty>请先回到第一步选择景点。</Empty>
      ) : (
        <>
          <section className="panel space-y-3 p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Route className="h-4 w-4 text-[var(--accent)]" />
              生成最优路线
            </h3>
            <p className="text-xs leading-relaxed text-[var(--muted)]">
              {pois.length} 个景点 · {detail.days} 天 ·{' '}
              {hotel ? `从「${hotel.name}」出发并返回` : '未选酒店，起终点不固定'} ·
              默认{MODE_LABEL[trip.defaultTravelMode] ?? trip.defaultTravelMode}
            </p>

            <input
              className="input"
              placeholder={`补充要求，比如"第一天想轻松点""尽量用地铁"`}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
            />

            <button className="btn-primary" onClick={generate} disabled={loading}>
              {loading
                ? '正在求解…'
                : itinerary.length > 0
                  ? '重新生成'
                  : '生成行程'}
            </button>

            {stale && itinerary.length > 0 && (
              <div className="rounded-lg border border-amber-900/50 bg-amber-950/20 p-3 text-xs text-amber-200">
                景点或酒店改过了，下面显示的是旧行程。点「重新生成」更新。
              </div>
            )}

            <NoteBox>
              访问顺序和时刻表由算法计算（地理聚类分天 + 2-opt 定序 + 按游览时长和营业时间排时刻），
              同样的输入结果可复现。AI 负责评估这份方案并写说明。
            </NoteBox>
          </section>

          {loading && (
            <AgentPending
              label="正在求解并评估路线"
              hint="AI 会试算多组参数（交通方式、分天方案）比较后定稿，然后拉取真实路径，需要 30-90 秒"
            />
          )}

          {result && (
            <section className="space-y-3">
              <NoteBox>
                {result.summary}
                <p className="mt-1 text-[var(--muted)]">
                  {result.degraded
                    ? `采用${MODE_LABEL[result.mode] ?? result.mode}`
                    : `试算 ${result.attempts} 次 · 采用${MODE_LABEL[result.mode] ?? result.mode}`}
                </p>
              </NoteBox>

              {result.warnings.length > 0 && (
                <div className="space-y-1.5 rounded-lg border border-amber-900/50 bg-amber-950/20 p-3">
                  {result.warnings.map((w, i) => (
                    <p key={i} className="flex items-start gap-2 text-xs text-amber-200">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                      {w}
                    </p>
                  ))}
                </div>
              )}

              {result.dropped.length > 0 && (
                <div className="rounded-lg border border-amber-900/50 bg-amber-950/20 p-3 text-xs">
                  <p className="text-amber-300">
                    时间不够，这些景点没排进去：{result.dropped.join('、')}
                  </p>
                  {result.droppedAdvice.length > 0 && (
                    <ul className="mt-1.5 space-y-0.5 text-amber-200/80">
                      {result.droppedAdvice.map((d) => (
                        <li key={d.name}>
                          {d.name} —— {d.advice}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>
          )}

          {itinerary.length > 0 && (
            <>
              <section className="panel overflow-hidden">
                <div className="flex flex-wrap gap-1.5 border-b border-[var(--border)] p-3">
                  <button
                    onClick={() => setActiveDay(null)}
                    className={`rounded-full px-3 py-1 text-xs ${
                      activeDay === null
                        ? 'bg-[var(--accent)] text-white'
                        : 'border border-[var(--border)] text-[var(--muted)] hover:bg-white/5'
                    }`}
                  >
                    全部
                  </button>
                  {itinerary.map((d) => (
                    <button
                      key={d.dayIndex}
                      onClick={() => setActiveDay(d.dayIndex)}
                      className={`rounded-full px-3 py-1 text-xs ${
                        activeDay === d.dayIndex
                          ? 'bg-[var(--accent)] text-white'
                          : 'border border-[var(--border)] text-[var(--muted)] hover:bg-white/5'
                      }`}
                    >
                      第 {d.dayIndex + 1} 天
                    </button>
                  ))}
                </div>
                <RouteMap
                  days={itinerary}
                  activeDay={activeDay}
                  hotel={hotel ? { name: hotel.name, location: hotel.location } : null}
                  className="h-[380px] w-full"
                />
              </section>

              {trip.routeSummary && (
                <section className="panel grid grid-cols-3 gap-3 p-4 text-center">
                  <Stat label="总里程" value={km(trip.routeSummary.totalDistanceMeters)} />
                  <Stat label="总通勤" value={duration(trip.routeSummary.totalTravelMinutes)} />
                  <Stat label="安排天数" value={`${itinerary.length} 天`} />
                </section>
              )}

              <div className="space-y-4">
                {itinerary
                  .filter((d) => activeDay === null || d.dayIndex === activeDay)
                  .map((day) => (
                    <DayCard key={day.dayIndex} day={day} />
                  ))}
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-[var(--muted)]">{label}</p>
      <p className="mt-0.5 text-sm font-medium">{value}</p>
    </div>
  )
}

function DayCard({ day }: { day: ItineraryDay }) {
  const visits = day.items.filter((i) => i.kind === 'visit')

  return (
    <section className="panel overflow-hidden">
      <header className="border-b border-[var(--border)] bg-[var(--raised)]/40 p-4">
        <div className="flex items-center gap-2.5">
          {/* 天序号做成实心徽章,多天列表滚动时是主要的定位锚点 */}
          <span
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg
              bg-[var(--accent-soft)] text-xs font-semibold text-[var(--accent)]"
          >
            {day.dayIndex + 1}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <h4 className="text-sm font-semibold">第 {day.dayIndex + 1} 天</h4>
              {day.date && <span className="text-xs text-[var(--faint)]">{day.date}</span>}
            </div>
            {day.theme && (
              <p className="mt-0.5 text-xs leading-snug text-[var(--accent)]">{day.theme}</p>
            )}
          </div>
        </div>

        <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[var(--muted)]">
          <span>{visits.length} 个点</span>
          <span className="text-[var(--border-strong)]">·</span>
          <span>通勤 {duration(day.travelMinutes)}</span>
          <span className="text-[var(--border-strong)]">·</span>
          <span>{km(day.distanceMeters)}</span>
        </div>

        {day.tip && (
          <p
            className="mt-2.5 rounded-lg border-l-2 border-[var(--accent)]/50 bg-[var(--accent-soft)]/40
              px-3 py-2 text-xs leading-relaxed text-[var(--muted)]"
          >
            {day.tip}
          </p>
        )}
      </header>
      <div className="p-4">
      {day.items.length === 0 ? (
        <p className="text-xs text-[var(--muted)]">这天空着，可以自由活动。</p>
      ) : (
        <ol className="space-y-0">
          {day.items.map((item, idx) => {
            const isHotel = item.kind === 'hotel_checkin' || item.kind === 'hotel_checkout'
            const visitNumber =
              item.kind === 'visit'
                ? day.items.slice(0, idx + 1).filter((i) => i.kind === 'visit').length
                : null

            return (
              <li key={item.id} className="relative pl-8">
                {/* 竖线连接各站，最后一项不画 */}
                {idx < day.items.length - 1 && (
                  <span className="absolute left-[11px] top-6 h-[calc(100%-12px)] w-px bg-[var(--border)]" />
                )}

                <span
                  className={`absolute left-0 top-1 flex h-[23px] w-[23px] items-center justify-center rounded-full text-[11px] font-semibold ${
                    isHotel
                      ? 'border border-[var(--border-strong)] bg-[var(--raised)] text-[var(--muted)]'
                      : 'bg-[var(--accent)] text-[#231508] shadow-[0_0_0_3px_var(--accent-soft)]'
                  }`}
                >
                  {isHotel ? <Bed className="h-3 w-3" /> : visitNumber}
                </span>

                <div className="pb-4">
                  {item.legMinutes !== null && item.legMinutes > 0 && (
                    <p className="mb-1 text-[11px] text-[var(--muted)]">
                      ↓ {MODE_LABEL[item.legMode ?? ''] ?? '通勤'} {duration(item.legMinutes)} ·{' '}
                      {km(item.legDistanceMeters)}
                    </p>
                  )}

                  <div className="flex items-baseline gap-2">
                    <p className="text-sm">{item.poi?.name ?? '—'}</p>
                    {(item.arriveAt || item.departAt) && (
                      <span className="font-mono text-xs text-[var(--muted)]">
                        {item.arriveAt ?? ''}
                        {item.arriveAt && item.departAt ? ' - ' : ''}
                        {item.departAt ?? ''}
                      </span>
                    )}
                  </div>

                  {item.poi?.address && (
                    <p className="mt-0.5 flex items-start gap-1 text-xs text-[var(--muted)]">
                      <MapPin className="mt-0.5 h-3 w-3 shrink-0" />
                      {item.poi.address}
                    </p>
                  )}

                  {item.note && (
                    <p className="mt-1 text-xs leading-relaxed text-[var(--muted)]">
                      提示：{item.note}
                    </p>
                  )}
                </div>
              </li>
            )
          })}
        </ol>
      )}
      </div>
    </section>
  )
}
