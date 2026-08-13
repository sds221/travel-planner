'use client'

import { create } from 'zustand'
import { api, ApiError } from './client'
import type { TripDetail } from '@/types'

/**
 * 行程状态。三个步骤共享同一份 TripDetail，任何一步的修改都要
 * 重新拉全量 —— 因为它们互相影响（改景点会让路线失效），
 * 局部更新很容易让界面显示出一份自相矛盾的状态。
 */

interface TripStore {
  detail: TripDetail | null
  loading: boolean
  error: string | null
  /** 错误类别（database/migration/config），决定显示报错还是配置引导 */
  errorKind: string | undefined
  /** 当前在第几步（0/1/2），用户可以回退 */
  step: number

  load: (tripId: string) => Promise<void>
  refresh: () => Promise<void>
  setStep: (step: number) => void
  setError: (error: string | null) => void
}

export const useTripStore = create<TripStore>((set, get) => ({
  detail: null,
  loading: false,
  error: null,
  errorKind: undefined,
  step: 0,

  load: async (tripId) => {
    set({ loading: true, error: null, errorKind: undefined })
    try {
      const detail = await api.getTrip(tripId)
      // 打开已有行程时跳到它该在的步骤，不让用户从头点一遍
      const step =
        detail.trip.status === 'planned' || detail.trip.status === 'stale'
          ? 2
          : detail.trip.status === 'draft_hotel'
            ? 1
            : 0
      set({ detail, loading: false, step })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : '加载失败',
        errorKind: err instanceof ApiError ? err.kind : undefined,
        loading: false,
      })
    }
  },

  refresh: async () => {
    const id = get().detail?.trip.id
    if (!id) return
    try {
      set({ detail: await api.getTrip(id) })
    } catch (err) {
      set({
        error: err instanceof Error ? err.message : '刷新失败',
        errorKind: err instanceof ApiError ? err.kind : undefined,
      })
    }
  },

  setStep: (step) => set({ step }),
  setError: (error) => set({ error, errorKind: undefined }),
}))
