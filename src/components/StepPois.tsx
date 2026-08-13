'use client'

import { useState } from 'react'
import { Sparkles, Plus, X, Upload, Check } from 'lucide-react'
import { api } from '@/lib/client'
import { useTripStore } from '@/lib/store'
import { AgentPending, ErrorBox, NoteBox, Empty } from './ui'
import type { PoiRecommendation } from '@/types'
import { duration, cityExamples } from '@/lib/utils'

/**
 * 第一步：选景点。
 *
 * 三个入口并列，因为用户的起点不一样：
 *   - 完全没想法 → 让 agent 推荐
 *   - 有个别想去的 → 单个添加
 *   - 手上有一份清单 → 批量导入（自定义模块的入口）
 */
export function StepPois() {
  const { detail, refresh, setStep } = useTripStore()
  const [message, setMessage] = useState('')
  const [recommending, setRecommending] = useState(false)
  const [recs, setRecs] = useState<PoiRecommendation[] | null>(null)
  const [recSummary, setRecSummary] = useState<string>('')
  const [unresolved, setUnresolved] = useState<string[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [error, setError] = useState<string | null>(null)

  const [customName, setCustomName] = useState('')
  const [adding, setAdding] = useState(false)

  const [importText, setImportText] = useState('')
  const [importing, setImporting] = useState(false)
  const [importResult, setImportResult] = useState<{
    imported: number
    resolved: { input: string; matched: string; renamed: boolean }[]
    failed: { name: string; reason: string }[]
    skipped: string[]
  } | null>(null)

  const [showImport, setShowImport] = useState(false)

  if (!detail) return null
  const { trip, pois } = detail

  async function runRecommend() {
    setRecommending(true)
    setError(null)
    try {
      const result = await api.recommendPois(trip.id, message)
      setRecs(result.recommendations)
      setRecSummary(result.summary)
      setUnresolved(result.unresolved)
      setPicked(new Set(result.recommendations.filter((r) => !r.alreadySelected).map((r) => r.poiId)))
    } catch (err) {
      setError(err instanceof Error ? err.message : '推荐失败')
    } finally {
      setRecommending(false)
    }
  }

  async function addPicked() {
    if (picked.size === 0) return
    setError(null)
    try {
      await api.addPois(trip.id, [...picked])
      await refresh()
      setRecs(null)
      setPicked(new Set())
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加失败')
    }
  }

  async function addCustom() {
    const name = customName.trim()
    if (!name) return
    setAdding(true)
    setError(null)
    try {
      await api.addCustomPoi(trip.id, name)
      setCustomName('')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '添加失败')
    } finally {
      setAdding(false)
    }
  }

  async function runImport() {
    const text = importText.trim()
    if (!text) return
    setImporting(true)
    setError(null)
    try {
      const result = await api.importPlaces(trip.id, text)
      setImportResult(result)
      setImportText('')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '导入失败')
    } finally {
      setImporting(false)
    }
  }

  async function remove(poiId: string) {
    try {
      await api.removePoi(trip.id, poiId)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    }
  }

  return (
    <div className="space-y-5">
      {error && <ErrorBox message={error} />}

      {/* ── 已选列表 ── */}
      <section className="panel p-4">
        <header className="mb-3 flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            已选景点
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              {pois.length} 个 · 共 {detail.days} 天
            </span>
          </h3>
          {pois.length > 0 && (
            <button className="btn-primary !py-1.5 !text-xs" onClick={() => setStep(1)}>
              下一步：选酒店
            </button>
          )}
        </header>

        {pois.length === 0 ? (
          <Empty>还没有选景点。用下面任一方式添加。</Empty>
        ) : (
          <ul className="space-y-2">
            {pois.map((tp) => (
              <li
                key={tp.poiId}
                className="flex items-start justify-between gap-3 rounded-lg border border-border px-3 py-2"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm">
                    {tp.poi.name}
                    {tp.addedBy === 'user' && <span className="chip ml-2">自定义</span>}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    {tp.poi.district ?? trip.city} · 建议游览{' '}
                    {duration(tp.dwellMinutesOverride ?? tp.poi.dwellMinutes)}
                    {tp.poi.rating ? ` · ${tp.poi.rating} 分` : ''}
                  </p>
                </div>
                <button
                  onClick={() => remove(tp.poiId)}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:bg-white/5 hover:text-red-400"
                  aria-label={`移除 ${tp.poi.name}`}
                >
                  <X className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {/* ── 入口一：agent 推荐 ── */}
      <section className="panel space-y-3 p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="h-4 w-4 text-foreground" />
          让 AI 推荐
        </h3>
        <textarea
          className="input min-h-[72px] resize-y"
          placeholder={`说说你的偏好，比如"带爸妈，走不了太多路，喜欢历史古迹，不想去人挤人的地方"`}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <button className="btn-primary" onClick={runRecommend} disabled={recommending}>
          {recommending ? '正在推荐…' : '生成推荐'}
        </button>

        {recommending && <AgentPending label="AI 正在搜索并筛选景点" />}

        {recs && (
          <div className="space-y-3">
            {recSummary && <NoteBox>{recSummary}</NoteBox>}
            {unresolved.length > 0 && (
              <NoteBox>
                这些地点没能解析出位置，换个更完整的名字试试：{unresolved.join('、')}
              </NoteBox>
            )}

            {recs.length === 0 ? (
              <Empty>没有可用推荐，换个描述再试。</Empty>
            ) : (
              <>
                <ul className="space-y-2">
                  {recs.map((r) => {
                    const on = picked.has(r.poiId)
                    return (
                      <li key={r.poiId}>
                        <button
                          onClick={() => {
                            const next = new Set(picked)
                            if (on) next.delete(r.poiId)
                            else next.add(r.poiId)
                            setPicked(next)
                          }}
                          disabled={r.alreadySelected}
                          className={`w-full rounded-lg border px-3 py-2 text-left transition-colors ${
                            r.alreadySelected
                              ? 'border-border opacity-50'
                              : on
                                ? 'border-foreground bg-primary/10'
                                : 'border-border hover:bg-white/5'
                          }`}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="text-sm">
                              {r.name}
                              {r.alreadySelected && <span className="chip ml-2">已在列表</span>}
                            </p>
                            {on && !r.alreadySelected && (
                              <Check className="mt-0.5 h-4 w-4 shrink-0 text-foreground" />
                            )}
                          </div>
                          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                            {r.reason}
                          </p>
                          <p className="mt-1 text-xs text-muted-foreground">
                            建议游览 {duration(r.suggestedDwellMinutes)}
                            {r.district ? ` · ${r.district}` : ''}
                            {r.rating ? ` · ${r.rating} 分` : ''}
                          </p>
                        </button>
                      </li>
                    )
                  })}
                </ul>
                <button className="btn-primary" onClick={addPicked} disabled={picked.size === 0}>
                  加入行程（{picked.size}）
                </button>
              </>
            )}
          </div>
        )}
      </section>

      {/* ── 入口二：单个自定义 ── */}
      <section className="panel space-y-3 p-4">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Plus className="h-4 w-4" />
          自己补充一个
        </h3>
        <div className="flex gap-2">
          <input
            className="input"
            placeholder={`在${trip.city}的地点名，比如"${cityExamples(trip.city)[0]}"`}
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') addCustom()
            }}
          />
          <button className="btn-ghost shrink-0" onClick={addCustom} disabled={adding}>
            {adding ? '解析中…' : '添加'}
          </button>
        </div>
      </section>

      {/* ── 入口三：批量导入（自定义模块）── */}
      <section className="panel space-y-3 p-4">
        <button
          className="flex w-full items-center justify-between text-left"
          onClick={() => setShowImport(!showImport)}
        >
          <h3 className="flex items-center gap-2 text-sm font-semibold">
            <Upload className="h-4 w-4" />
            批量导入我的清单
          </h3>
          <span className="text-xs text-muted-foreground">{showImport ? '收起' : '展开'}</span>
        </button>

        {showImport && (
          <>
            <p className="text-xs text-muted-foreground">
              把想去的地方粘进来，一行一个（也支持逗号、顿号分隔）。系统会逐个定位，
              然后你可以直接跳到第三步生成最优路线。
            </p>
            <textarea
              className="input min-h-[110px] resize-y font-mono text-xs"
              placeholder={cityExamples(trip.city).join('\n')}
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
            />
            <button className="btn-ghost" onClick={runImport} disabled={importing}>
              {importing ? '正在定位…' : '导入'}
            </button>

            {importing && (
              <AgentPending
                label="正在逐个定位地点"
                hint="为避免触发地图服务限流，这里是串行请求，地点多时需要十几秒"
              />
            )}

            {importResult && (
              <div className="space-y-2 text-xs">
                <p className="text-muted-foreground">
                  成功导入 {importResult.imported} 个
                  {importResult.skipped.length > 0 &&
                    `，跳过 ${importResult.skipped.length} 个已存在的`}
                </p>
                {importResult.resolved.filter((r) => r.renamed).length > 0 && (
                  <NoteBox>
                    这些地点匹配到了略有不同的名称，确认一下是不是你要的：
                    <ul className="mt-1 space-y-0.5">
                      {importResult.resolved
                        .filter((r) => r.renamed)
                        .map((r) => (
                          <li key={r.input}>
                            {r.input} → {r.matched}
                          </li>
                        ))}
                    </ul>
                  </NoteBox>
                )}
                {importResult.failed.length > 0 && (
                  <div className="rounded-lg border border-amber-900/50 bg-amber-950/20 p-3">
                    <p className="text-amber-300">这些没能定位，需要手动补充：</p>
                    <ul className="mt-1 space-y-0.5 text-amber-200/80">
                      {importResult.failed.map((f) => (
                        <li key={f.name}>
                          {f.name} —— {f.reason}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </section>
    </div>
  )
}
