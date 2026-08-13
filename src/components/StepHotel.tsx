'use client'

import { useState } from 'react'
import { Hotel, Check, ArrowLeft } from 'lucide-react'
import { api } from '@/lib/client'
import { useTripStore } from '@/lib/store'
import { AgentPending, ErrorBox, NoteBox, Empty, PriceSourceBadge, PriceCitations } from './ui'
import { yuan, priceRange } from '@/lib/utils'
import type { HotelRecommendation } from '@/types'

/** 常见品牌，按档位分组给用户点选 —— 手打品牌名容易拼错导致搜不到 */
const BRAND_GROUPS: { tier: string; brands: string[] }[] = [
  { tier: '经济型', brands: ['如家', '汉庭', '7天', '锦江之星', '格林豪泰'] },
  { tier: '中端', brands: ['全季', '桔子', '亚朵', '维也纳', '希尔顿欢朋'] },
  { tier: '高端', brands: ['希尔顿', '万豪', '喜来登', '皇冠假日', '洲际'] },
  { tier: '奢华', brands: ['丽思卡尔顿', '柏悦', '华尔道夫', '四季'] },
]

const VERDICT_TEXT: Record<string, string> = {
  comfortable: '预算充裕，位置和品质都有得选',
  tight: '预算偏紧，位置和品质需要取舍',
  insufficient: '预算不够，建议放宽位置或降低档次',
}

/**
 * 第二步：选酒店。
 *
 * 依赖第一步的景点位置 —— 推荐里的"位置分"就是到这些景点的平均通勤。
 * 所以这里显示景点数量，让用户明白推荐是基于什么算出来的。
 */
export function StepHotel() {
  const { detail, refresh, setStep } = useTripStore()
  const [budgetYuan, setBudgetYuan] = useState('')
  const [perNight, setPerNight] = useState(true)
  const [brands, setBrands] = useState<Set<string>>(new Set())
  const [message, setMessage] = useState('')

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<{
    summary: string
    budgetVerdict: string
    nights: number
    recommendations: HotelRecommendation[]
  } | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  if (!detail) return null
  const { trip, pois, hotel } = detail

  async function run() {
    setLoading(true)
    setError(null)
    try {
      const parsed = Number(budgetYuan)
      const res = await api.recommendHotels(trip.id, {
        budgetCents: budgetYuan && Number.isFinite(parsed) ? Math.round(parsed * 100) : null,
        budgetPerNight: perNight,
        brands: [...brands],
        message: message || undefined,
      })
      setResult(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : '推荐失败')
    } finally {
      setLoading(false)
    }
  }

  async function choose(poiId: string) {
    setSaving(poiId)
    setError(null)
    try {
      await api.updateTrip(trip.id, { hotelPoiId: poiId })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '选择失败')
    } finally {
      setSaving(null)
    }
  }

  return (
    <div className="space-y-5">
      {error && <ErrorBox message={error} />}

      <button
        className="flex items-center gap-1.5 text-xs text-[var(--muted)] hover:text-[var(--text)]"
        onClick={() => setStep(0)}
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        回到选景点
      </button>

      {pois.length === 0 ? (
        <Empty>请先回到第一步选择景点 —— 酒店推荐要根据景点位置来判断。</Empty>
      ) : (
        <>
          {hotel && (
            <section className="panel p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs text-[var(--muted)]">已选酒店</p>
                  <p className="mt-1 text-sm font-medium">{hotel.name}</p>
                  <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-[var(--muted)]">
                    <span>{hotel.address ?? hotel.district ?? ''}</span>
                    {hotel.priceMinCents !== null && (
                      <>
                        <span>· {priceRange(hotel.priceMinCents, hotel.priceMaxCents)}/晚</span>
                        <PriceSourceBadge source={hotel.priceSource} />
                        {hotel.priceCitations && (
                          <PriceCitations citations={hotel.priceCitations} />
                        )}
                      </>
                    )}
                  </p>
                </div>
                <button className="btn-primary !py-1.5 !text-xs shrink-0" onClick={() => setStep(2)}>
                  下一步：生成路线
                </button>
              </div>
            </section>
          )}

          <section className="panel space-y-4 p-4">
            <h3 className="flex items-center gap-2 text-sm font-semibold">
              <Hotel className="h-4 w-4 text-[var(--accent)]" />
              按预算和偏好推荐
              <span className="text-xs font-normal text-[var(--muted)]">
                基于已选的 {pois.length} 个景点
              </span>
            </h3>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="label" htmlFor="budget">
                  住宿预算（元）
                </label>
                <input
                  id="budget"
                  className="input"
                  type="number"
                  min={0}
                  placeholder="比如 600"
                  value={budgetYuan}
                  onChange={(e) => setBudgetYuan(e.target.value)}
                />
              </div>
              <div>
                <span className="label">预算口径</span>
                <div className="flex gap-2">
                  <button
                    className={`btn flex-1 border ${perNight ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border)]'}`}
                    onClick={() => setPerNight(true)}
                  >
                    每晚
                  </button>
                  <button
                    className={`btn flex-1 border ${!perNight ? 'border-[var(--accent)] bg-[var(--accent)]/10' : 'border-[var(--border)]'}`}
                    onClick={() => setPerNight(false)}
                  >
                    总价
                  </button>
                </div>
              </div>
            </div>

            <div>
              <span className="label">偏好品牌（可多选，留空表示不限）</span>
              <div className="space-y-2">
                {BRAND_GROUPS.map((group) => (
                  <div key={group.tier} className="flex flex-wrap items-center gap-1.5">
                    <span className="w-14 shrink-0 text-xs text-[var(--muted)]">{group.tier}</span>
                    {group.brands.map((b) => {
                      const on = brands.has(b)
                      return (
                        <button
                          key={b}
                          onClick={() => {
                            const next = new Set(brands)
                            if (on) next.delete(b)
                            else next.add(b)
                            setBrands(next)
                          }}
                          className={`rounded-full border px-2.5 py-1 text-xs transition-colors ${
                            on
                              ? 'border-[var(--accent)] bg-[var(--accent)]/15 text-[var(--text)]'
                              : 'border-[var(--border)] text-[var(--muted)] hover:bg-white/5'
                          }`}
                        >
                          {b}
                        </button>
                      )
                    })}
                  </div>
                ))}
              </div>
            </div>

            <div>
              <label className="label" htmlFor="hotel-note">
                其它要求（可选）
              </label>
              <input
                id="hotel-note"
                className="input"
                placeholder={`比如"要有早餐""离地铁站近""带小孩需要浴缸"`}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
              />
            </div>

            <button className="btn-primary" onClick={run} disabled={loading}>
              {loading ? '正在推荐…' : '推荐酒店'}
            </button>

            <NoteBox>
              房价按可获取的最好来源展示，每条结果上会标明是「联网查价」「行情估价」
              还是「粗估价」。任何一种都不是可下单的报价，实际房费取决于日期和房型，
              下单前请到订房平台核实。
            </NoteBox>
          </section>

          {loading && (
            <AgentPending
              label="AI 正在按位置和预算筛选酒店"
              hint="需要联网查询各家的当前房价，首次查询较慢，通常 30-90 秒"
            />
          )}

          {result && (
            <section className="space-y-3">
              <NoteBox>
                {result.summary}
                <p className="mt-1">
                  住 {result.nights} 晚 · 预算判断：
                  {VERDICT_TEXT[result.budgetVerdict] ?? result.budgetVerdict}
                </p>
              </NoteBox>

              {result.recommendations.length === 0 ? (
                <Empty>这个条件下没找到合适的酒店，试试放宽预算或取消品牌限制。</Empty>
              ) : (
                <ul className="space-y-2">
                  {result.recommendations.map((h) => {
                    const chosen = trip.hotelPoiId === h.poiId
                    return (
                      <li
                        key={h.poiId}
                        className={`panel p-3 ${chosen ? 'border-[var(--accent)]' : ''}`}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 space-y-1">
                            <p className="text-sm font-medium">
                              {h.name}
                              {h.starRating && <span className="chip ml-2">{h.starRating} 星</span>}
                              {h.brand && <span className="chip ml-1">{h.brand}</span>}
                            </p>
                            <p className="text-xs leading-relaxed text-[var(--muted)]">{h.reason}</p>
                            <p className="text-xs text-[var(--muted)]">{h.commuteNote}</p>
                            <p className="flex flex-wrap items-center gap-1.5 text-xs">
                              {h.nightlyCents !== null ? (
                                <span className="text-[var(--text)]">
                                  {/* 联网查到的价格说"约"是恰当的谨慎，
                                      粗估的说"约"反而显得比实际更确定 */}
                                  {h.priceSource === 'search' || h.priceSource === 'ota'
                                    ? `${yuan(h.nightlyCents)}/晚`
                                    : `约 ${yuan(h.nightlyCents)}/晚`}
                                </span>
                              ) : (
                                <span className="text-[var(--muted)]">未获取到价格</span>
                              )}
                              <PriceSourceBadge source={h.priceSource} />
                              {h.priceCitations && <PriceCitations citations={h.priceCitations} />}
                              {h.priceMinCents !== null && (
                                <span className="text-[var(--muted)]">
                                  区间 {priceRange(h.priceMinCents, h.priceMaxCents)}
                                </span>
                              )}
                            </p>
                            {h.address && (
                              <p className="truncate text-xs text-[var(--muted)]">{h.address}</p>
                            )}
                          </div>
                          <button
                            className={`shrink-0 ${chosen ? 'btn-ghost' : 'btn-primary'} !py-1.5 !text-xs`}
                            onClick={() => choose(h.poiId)}
                            disabled={saving === h.poiId || chosen}
                          >
                            {chosen ? (
                              <>
                                <Check className="h-3.5 w-3.5" /> 已选
                              </>
                            ) : saving === h.poiId ? (
                              '保存中…'
                            ) : (
                              '选这家'
                            )}
                          </button>
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          )}

          <section className="panel p-4">
            <p className="text-xs text-[var(--muted)]">
              不想住酒店或已有住处？可以
              <button className="mx-1 text-[var(--accent)] underline" onClick={() => setStep(2)}>
                跳过这步
              </button>
              直接生成路线，届时行程不会固定起终点。
            </p>
          </section>
        </>
      )}
    </div>
  )
}
