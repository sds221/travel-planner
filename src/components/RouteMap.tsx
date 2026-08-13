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
 * 每天一条线的颜色。
 *
 * 地图配色不跟 UI 主题走 —— 换主题色就改地图会让线路时而看不清。这里用导航
 * 软件常见的那套高饱和色相环(蓝/橙/绿/紫/红/青/棕):
 *
 * - 高德底图是浅灰白配米色道路,深一档的饱和色压在上面才看得清
 * - 相邻两天必须换色相而不是换明度 —— 折线只有 4px 宽,靠明暗区分在
 *   彩色底图上根本认不出来
 * - 蓝色排第一:单天行程最常见,而蓝色是地图上默认的"路线"语义
 *
 * 超过 7 天会回到第一个颜色,实际行程很少超过。
 */
const DAY_COLORS = ['#1a73e8', '#f9a825', '#0f9d58', '#7b1fa2', '#d93025', '#00838f', '#6d4c41']

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
              strokeWeight: 5,
              // 0.75 会让线和底图道路混在一起，0.9 才像导航软件里那条"主路线"
              strokeOpacity: 0.9,
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
                content: markerHtml('酒', '#ffffff', '#37474f'),
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
          content: markerHtml('酒', '#ffffff', '#37474f'),
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
        className={`flex items-center justify-center rounded-xl border border-border bg-muted p-6 text-center text-xs text-muted-foreground ${className ?? ''}`}
      >
        {error}
        <br />
        行程明细不受影响，仍可正常查看
      </div>
    )
  }

  return <div ref={containerRef} className={className} />
}

/**
 * 标记点。
 *
 * 白描边和阴影都是为了在彩色底图上"浮起来":
 * 之前描边是半透明白(.55)、阴影是 rgba(0,0,0,.5) —— 那套是给深色底调的,
 * 压在高德的浅色底图上会发灰、糊成一团。现在描边给实心白,阴影压到 .25。
 */
function markerHtml(label: string, fg: string, bg: string): string {
  return `<div style="width:26px;height:26px;border-radius:50%;background:${bg};color:${fg};
    display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;
    border:2px solid #fff;box-shadow:0 1px 4px rgba(0,0,0,.25)">${label}</div>`
}
