import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import * as schema from './schema'
import { dbEnv } from '../env'

type Db = PostgresJsDatabase<typeof schema>

const g = globalThis as {
  __travelSql?: postgres.Sql
  __travelDb?: Db
}

/**
 * 连接池挂在 globalThis 上：dev 模式的热更新会反复求值模块，
 * 不复用的话几十次改动后就把 Postgres 的 max_connections 打满。
 */
export function getSql(): postgres.Sql {
  if (!g.__travelSql) {
    g.__travelSql = postgres(dbEnv().DATABASE_URL, {
      max: 10,
      // 查询里大量拼动态 SQL 片段（PostGIS 函数），关掉预处理语句更省心
      prepare: false,
    })
  }
  return g.__travelSql
}

export function getDb(): Db {
  if (!g.__travelDb) g.__travelDb = drizzle(getSql(), { schema })
  return g.__travelDb
}

export { schema }
