/**
 * 浏览器侧可见的配置，单独一个文件。
 *
 * 和 env.ts 分开是有意的：env.ts 里有服务端 schema（含 LLM_API_KEY、
 * AMAP_SERVER_KEY 的字段名），被 'use client' 组件 import 会把整个模块
 * 拖进客户端 bundle。值不会泄漏（Next 只内联 NEXT_PUBLIC_*），
 * 但没必要把服务端配置的形状暴露出去。
 */
export const publicEnv = {
  amapJsKey: process.env.NEXT_PUBLIC_AMAP_JS_KEY ?? '',
  amapSecurityCode: process.env.NEXT_PUBLIC_AMAP_JS_SECURITY_CODE ?? '',
}
