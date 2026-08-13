import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: '行程规划',
  description: '选景点 → 选酒店 → 生成最优路线',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  )
}
