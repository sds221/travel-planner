'use client'

import { useEffect, useRef, useState } from 'react'
import { publicEnv } from '@/lib/env-public'
import type { ItineraryDay } from '@/types'

/**
 * 行程图。用高德 JS API 而不是 Leaflet/Mapbox：
 * 后端的坐标是 GCJ-02（高德/国内标准），在 WGS-84 底图上会整体偏移
 * 几百米。同一家的底图才对得上，省掉一层坐标转换。
 */

declare global {
  interface Window {
    AMap?: any
    _AMapSecurityConfig?: { securityJsCode: string }
  }
}

/**
 * 每天一个颜色。
 *
 * 排在暖色调主题里,所以从琥珀出发,往陶土红/赭石/橄榄这些"土系"走,
 * 而不是用默认的蓝绿撞色 —— 冷色在暖底图上会显得很跳。
 * 相邻两天的色相拉开足够远,叠在地图上不至于分不清。
 */
const DAY_COLORS = ['#e8873c', '#c8613f', '#d9a13b', '#a8703f', '#7fa650', '#b5544f', '#8a6a4a']

let loaderPromise: Promise<void> | null = null

/** JS API 只能加载一次，多个组件实例共享同一个 promise */
function loadAmap(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve()
  if (window.AMap) return Promise.resolve()
  if (loaderPromise) return loaderPromise

  const key = publicEnv.amapJsKey
  if (!key) return Promise.reject(new Error('NEXT_PUBLIC_AMAP_JS_KEY 未配置'))

  // 2.0 起安全密钥必须在脚本加载前挂到 window 上
  if (publicEnv.amapSecurityCode) {
    window._AMapSecurityConfig = { securityJsCode: publicEnv.amapSecurityCode }
  }

  loaderPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = `https://webapi.amap.com/maps?v=2.0&key=${key}`
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => {
      loaderPromise = null
      reject(new Error('高德地图脚本加载失败，检查 JS key 和安全密钥是否配套'))
    }
    document.head.appendChild(script)
  })
  return loaderPromise
}

export interface RouteMapProps {
  days: ItineraryDay[]
  /** 只显示某一天，null 表示全部 */
  activeDay: number | null
  hotel?: { name: string; location: { lng: number; lat: number } } | null
  className?: string
}

export function RouteMap({ days, activeDay, hotel, className }: RouteMapProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<any>(null)
  const overlaysRef = useRef<any[]>([])
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    loadAmap()
      .then(() => {
        if (cancelled || !containerRef.current) return
        mapRef.current = new window.AMap.Map(containerRef.current, {
          zoom: 12,
          mapStyle: 'amap://styles/dark',
          viewMode: '2D',
        })
        setReady(true)
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message)
      })

    return () => {
      cancelled = true
      mapRef.current?.destroy?.()
      mapRef.current = null
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!ready || !map) return

    // 全量重画：行程条目不多（几十个），diff 的复杂度不值得
    map.remove(overlaysRef.current)
    overlaysRef.current = []

    const visible = activeDay === null ? days : days.filter((d) => d.dayIndex === activeDay)
    const overlays: any[] = []
    const bounds: [number, number][] = []

    for (const day of visible) {
      const color = DAY_COLORS[day.dayIndex % DAY_COLORS.length]!
      let stopNumber = 0

      for (const item of day.items) {
        // 折线：优先用后端存的真实路径，没有就退化为直线
        if (item.legPolyline && item.legPolyline.length > 1) {
          overlays.push(
            new window.AMap.Polyline({
              path: item.legPolyline,
              strokeColor: color,
              strokeWeight: 4,
              strokeOpacity: 0.75,
            }),
          )
          bounds.push(...item.legPolyline)
        }

        if (!item.poi) continue
        const { lng, lat } = item.poi.location
        bounds.push([lng, lat])

        const isHotel = item.kind === 'hotel_checkin' || item.kind === 'hotel_checkout'
        if (isHotel) {
          // 酒店每天出现两次（出发/返回），只画一个标记
          if (stopNumber === 0) {
            overlays.push(
              new window.AMap.Marker({
                position: [lng, lat],
                content: markerHtml('酒', '#f5ece3', '#3a2e25'),
                offset: new window.AMap.Pixel(-13, -13),
                title: item.poi.name,
                zIndex: 120,
              }),
            )
          }
          continue
        }

        stopNumber += 1
        overlays.push(
          new window.AMap.Marker({
            position: [lng, lat],
            content: markerHtml(String(stopNumber), '#ffffff', color),
            offset: new window.AMap.Pixel(-13, -13),
            title: `${item.poi.name}${item.arriveAt ? ` · ${item.arriveAt}` : ''}`,
            zIndex: 100,
          }),
        )
      }
    }

    // 没有行程时至少把酒店标出来
    if (overlays.length === 0 && hotel) {
      overlays.push(
        new window.AMap.Marker({
          position: [hotel.location.lng, hotel.location.lat],
          content: markerHtml('酒', '#f5ece3', '#3a2e25'),
          offset: new window.AMap.Pixel(-13, -13),
          title: hotel.name,
        }),
      )
      bounds.push([hotel.location.lng, hotel.location.lat])
    }

    if (overlays.length > 0) {
      map.add(overlays)
      overlaysRef.current = overlays
    }
    if (bounds.length > 0) {
      map.setFitView(null, false, [40, 40, 40, 40])
    }
  }, [ready, days, activeDay, hotel])

  if (error) {
    return (
      <div
        className={`flex items-center justify-center rounded-xl border border-[var(--border)] bg-[#1b1512] p-6 text-center text-xs text-[var(--muted)] ${className ?? ''}`}
      >
        {error}
        <br />
        行程明细不受影响，仍可正常查看
      </div>
    )
  }

  return <div ref={containerRef} className={className} />
}

function markerHtml(label: string, fg: string, bg: string): string {
  return `<div style="width:26px;height:26px;border-radius:50%;background:${bg};color:${fg};
    display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;
    border:2px solid rgba(255,255,255,.55);box-shadow:0 2px 8px rgba(0,0,0,.5)">${label}</div>`
}
