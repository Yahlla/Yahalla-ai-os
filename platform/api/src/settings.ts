import type pg from 'pg'
import { withServiceRole, withUserSession } from './db.js'

// Admin-editable settings stored in Postgres (platform_settings, RLS-gated
// to is_admin() -- see the 20260815000000_platform_settings.sql migration)
// instead of an env file, so the Control Center's Settings page can
// configure them with no terminal/SSH step. Starts with just the cloud
// smart tier's key/url/model; the table itself is a plain key/value store
// so future settings reuse this same mechanism.

const CLOUD_TIER_KEYS = {
  apiKey: 'cloud_tier_api_key',
  url: 'cloud_tier_url',
  model: 'cloud_tier_model',
  provider: 'cloud_tier_provider',
} as const

async function readSetting(client: pg.PoolClient, key: string): Promise<string | null> {
  const result = await client.query('SELECT value FROM platform_settings WHERE key = $1', [key])
  return (result.rows[0]?.value as string | undefined) ?? null
}

async function writeSetting(client: pg.PoolClient, key: string, value: string, updatedBy: string): Promise<void> {
  await client.query(
    `INSERT INTO platform_settings (key, value, updated_by, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_by = $3, updated_at = now()`,
    [key, value, updatedBy],
  )
}

// Both of these run as the caller's own session (withUserSession), so the
// platform_settings RLS policy (is_admin()) does the actual enforcement:
// a non-admin's write throws (surfaced by the route as 403), and a
// non-admin's read silently sees no rows -- reported as "not configured"
// rather than leaking whether it's actually set.

export async function saveCloudTierSettings(
  userId: string,
  settings: { apiKey: string; url?: string; model?: string; provider?: 'openai' | 'anthropic' },
): Promise<void> {
  await withUserSession(userId, async (client) => {
    await writeSetting(client, CLOUD_TIER_KEYS.apiKey, settings.apiKey, userId)
    if (settings.url) await writeSetting(client, CLOUD_TIER_KEYS.url, settings.url, userId)
    if (settings.model) await writeSetting(client, CLOUD_TIER_KEYS.model, settings.model, userId)
    if (settings.provider) await writeSetting(client, CLOUD_TIER_KEYS.provider, settings.provider, userId)
  })
}

export async function getCloudTierStatus(
  userId: string,
): Promise<{ configured: boolean; model: string | null; url: string | null; provider: string | null }> {
  return withUserSession(userId, async (client) => {
    const apiKey = await readSetting(client, CLOUD_TIER_KEYS.apiKey)
    const model = await readSetting(client, CLOUD_TIER_KEYS.model)
    const url = await readSetting(client, CLOUD_TIER_KEYS.url)
    const provider = await readSetting(client, CLOUD_TIER_KEYS.provider)
    return { configured: Boolean(apiKey), model, url, provider }
  })
}

// Used internally by the /smart-tier/chat handler, which needs the actual
// secret value regardless of which user is chatting -- the key is a
// platform-wide setting, not the requester's own data, so this
// deliberately bypasses RLS via withServiceRole (see db.ts) instead of
// requiring every chatting user to also be an admin.
export async function readCloudTierSecret(): Promise<
  { apiKey: string; url: string | null; model: string | null; provider: 'openai' | 'anthropic' | null } | null
> {
  return withServiceRole(async (client) => {
    const apiKey = await readSetting(client, CLOUD_TIER_KEYS.apiKey)
    if (!apiKey) return null
    const url = await readSetting(client, CLOUD_TIER_KEYS.url)
    const model = await readSetting(client, CLOUD_TIER_KEYS.model)
    const provider = await readSetting(client, CLOUD_TIER_KEYS.provider)
    return { apiKey, url, model, provider: provider === 'anthropic' ? 'anthropic' : provider === 'openai' ? 'openai' : null }
  })
}
