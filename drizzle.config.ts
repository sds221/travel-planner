import 'dotenv/config'
import { defineConfig } from 'drizzle-kit'

export default defineConfig({
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: { url: process.env.DATABASE_URL! },
  // geography 列由 drizzle 的 customType 声明，push 时不要因为无法内省而丢弃
  verbose: true,
  strict: true,
})
