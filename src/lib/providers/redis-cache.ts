import type { KV } from './cache'

/**
 * Redis 版 KV。ioredis 是可选依赖式接入：REDIS_URL 没配就退回 MemoryKV，
 * 这样本地开发不必起 Redis 容器。
 *
 * 连接失败不抛错，只把自己标记为不可用 —— 缓存挂了应该降级到直连高德，
 * 而不是让整个行程规划 500。
 */
export class RedisKV implements KV {
  private client: import('ioredis').Redis | null = null
  private healthy = true

  private constructor(client: import('ioredis').Redis) {
    this.client = client
  }

  static async create(url: string): Promise<RedisKV | null> {
    try {
      const { default: Redis } = await import('ioredis')
      const client = new Redis(url, {
        maxRetriesPerRequest: 2,
        lazyConnect: true,
        // 连不上时快速失败，别让请求挂在这里
        connectTimeout: 2000,
      })
      client.on('error', () => {
        // ioredis 的 error 事件不处理会变成 unhandled rejection
      })
      await client.connect()
      return new RedisKV(client)
    } catch {
      return null
    }
  }

  async get(key: string): Promise<string | null> {
    if (!this.healthy || !this.client) return null
    try {
      return await this.client.get(key)
    } catch {
      this.healthy = false
      return null
    }
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    if (!this.healthy || !this.client) return
    try {
      await this.client.set(key, value, 'EX', ttlSeconds)
    } catch {
      this.healthy = false
    }
  }
}
