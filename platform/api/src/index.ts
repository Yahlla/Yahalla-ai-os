#!/usr/bin/env node
import { loadCloudTierConfig } from './cloudTier.js'
import { createPlatformServer } from './server.js'

const port = Number(process.env.PORT ?? 8080)
const supabaseJwtSecret = process.env.SUPABASE_JWT_SECRET || undefined
const supabaseUrl = process.env.SUPABASE_URL || undefined
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const cloudTier = loadCloudTierConfig(process.env)
const githubRepo = process.env.GITHUB_REPO || 'Yahlla/Yahalla-ai-os'
const githubWebhookSecret = process.env.GITHUB_WEBHOOK_SECRET || undefined

// Supabase projects sign tokens with HS256 (needs SUPABASE_JWT_SECRET) or
// ES256 (needs SUPABASE_URL, to fetch the project's public JWKS) -- see
// jwt.ts. At least one path must be configured or no login can ever
// verify; both may be set so the same deployment tolerates either.
if (!supabaseJwtSecret && !supabaseUrl) {
  console.error('[platform-api] Set SUPABASE_JWT_SECRET (HS256 / "Legacy JWT Secret") or SUPABASE_URL (ES256, verified via JWKS) -- at least one is required.')
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
if (githubWebhookSecret) {
  console.log('[platform-api] GitHub push webhook enabled: POST /webhooks/github')
} else {
  console.log('[platform-api] GitHub push webhook disabled (GITHUB_WEBHOOK_SECRET not set) -- "Ship latest main" still works manually')
}

const server = createPlatformServer({ port, supabaseJwtSecret, supabaseUrl, allowedOrigins, cloudTier, githubRepo, githubWebhookSecret })

server.listen(port, () => {
  console.log(`[platform-api] listening on :${port}`)
})

const shutdown = () => {
  console.log('\n[platform-api] shutting down...')
  server.close(() => process.exit(0))
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
