#!/usr/bin/env node
import { loadCloudTierConfig } from './cloudTier.js'
import { createPlatformServer } from './server.js'

const port = Number(process.env.PORT ?? 8080)
const supabaseJwtSecret = process.env.SUPABASE_JWT_SECRET
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const cloudTier = loadCloudTierConfig(process.env)

if (!supabaseJwtSecret) {
  console.error('[platform-api] SUPABASE_JWT_SECRET is required (Supabase project -> Settings -> API -> JWT Secret).')
  process.exit(1)
}
if (!process.env.DATABASE_URL) {
  console.error('[platform-api] DATABASE_URL is required.')
  process.exit(1)
}
if (cloudTier) {
  console.log(`[platform-api] cloud smart tier enabled: ${cloudTier.url} (${cloudTier.model})`)
} else {
  console.log('[platform-api] cloud smart tier disabled (CLOUD_TIER_API_KEY not set)')
}

const server = createPlatformServer({ port, supabaseJwtSecret, allowedOrigins, cloudTier })

server.listen(port, () => {
  console.log(`[platform-api] listening on :${port}`)
})

const shutdown = () => {
  console.log('\n[platform-api] shutting down...')
  server.close(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
