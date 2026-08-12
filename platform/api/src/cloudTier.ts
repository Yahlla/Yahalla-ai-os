// Opt-in "cloud smart tier": an additional, clearly-separate escalation
// path that forwards a chat request to a free-tier OpenAI-compatible API
// (e.g. Groq) for heavier reasoning than the local/browser models can do.
//
// This is deliberately NOT part of local-runtime's chatCompletion (see
// local-runtime/src/llm.ts) -- that function has a hard, on-purpose
// invariant that it never leaves 127.0.0.1. Adding remote-model calling
// there would silently undo that safety boundary. Instead this lives here,
// server-side on the self-hosted platform-api, so:
//   - the upstream API key never reaches the browser bundle or any
//     client-side code (the "vault" principle: secrets never leave the
//     server that holds them) -- the browser only ever calls this
//     platform-api route with its own Supabase session token, never the
//     upstream key directly.
//   - it is entirely opt-in and off by default: if CLOUD_TIER_API_KEY
//     isn't set, this tier simply doesn't exist for any caller.
//   - it is portable by construction: CLOUD_TIER_URL/MODEL/API_KEY are
//     the only thing that changes to point this at a future self-hosted,
//     OpenAI-compatible server instead of a free-tier provider -- no code
//     change needed.

import { readCloudTierSecret } from './settings.js'

export type CloudTierConfig = {
  url: string
  model: string
  apiKey: string
}

// An env-var default, kept for operators who still prefer setting this in
// platform/.env (e.g. before ever signing in to configure it from the
// Settings page). The database (platform_settings, edited from the
// Control Center -- see resolveCloudTierConfig below) always takes
// precedence when both are set.
export function loadCloudTierConfig(env: NodeJS.ProcessEnv): CloudTierConfig | null {
  const apiKey = env.CLOUD_TIER_API_KEY
  if (!apiKey) return null
  return {
    url: env.CLOUD_TIER_URL || 'https://api.groq.com/openai/v1',
    model: env.CLOUD_TIER_MODEL || 'llama-3.3-70b-versatile',
    apiKey,
  }
}

// Called per-request (not cached) so saving a new key from the Settings
// page takes effect on the very next chat message -- no restart, no
// redeploy. A DB lookup per request is negligible cost at this scale and
// keeps this honestly correct rather than eventually-consistent.
export async function resolveCloudTierConfig(fallback: CloudTierConfig | null): Promise<CloudTierConfig | null> {
  const stored = await readCloudTierSecret()
  if (stored) {
    return {
      apiKey: stored.apiKey,
      url: stored.url || fallback?.url || 'https://api.groq.com/openai/v1',
      model: stored.model || fallback?.model || 'llama-3.3-70b-versatile',
    }
  }
  return fallback
}

export type CloudTierMessage = { role: string; content: string }

export type CloudTierResult = { ok: true; content: string } | { ok: false; status: number; error: string }

export async function callCloudTier(
  config: CloudTierConfig,
  messages: CloudTierMessage[],
  timeoutMs = 30_000,
): Promise<CloudTierResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${config.url}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      // A moderate temperature -- the provider's own default tends toward
      // looser, more "creative" sampling that measurably increases
      // random-language-word intrusions in otherwise-Arabic text (seen
      // live: a stray Cyrillic/Chinese word inside an Arabic sentence).
      // This doesn't change what the model knows, just how deterministically
      // it picks among its own top candidate tokens.
      body: JSON.stringify({ model: config.model, messages, temperature: 0.6 }),
      signal: controller.signal,
    })
    const text = await response.text()
    if (!response.ok) {
      return { ok: false, status: 502, error: `Cloud tier upstream returned HTTP ${response.status}: ${text.slice(0, 500)}` }
    }
    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      return { ok: false, status: 502, error: 'Cloud tier upstream returned a non-JSON response.' }
    }
    const content = data?.choices?.[0]?.message?.content
    if (typeof content !== 'string') {
      return { ok: false, status: 502, error: 'Cloud tier upstream response had no message content.' }
    }
    return { ok: true, content }
  } catch (error) {
    const isAbort = error instanceof DOMException && error.name === 'AbortError'
    return {
      ok: false,
      status: 504,
      error: isAbort ? `Cloud tier request timed out after ${timeoutMs}ms.` : error instanceof Error ? error.message : 'Cloud tier request failed.',
    }
  } finally {
    clearTimeout(timeout)
  }
}
