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

import Anthropic from '@anthropic-ai/sdk'
import { readCloudTierSecret } from './settings.js'

// Two providers share this one tier: the original OpenAI-compatible path
// (Groq by default) and a real Anthropic Claude path, added so a deployment
// with no local-runtime and no browser WebGPU (e.g. iOS, or an admin who
// wants every user on Claude regardless of their device) still gets a real,
// working AI instead of "Cloud smart tier is not reachable". Both are
// reached through this same opt-in, server-side tier -- see the module
// comment above for why this lives here and not in local-runtime.
export type CloudTierProvider = 'openai' | 'anthropic'

export type CloudTierConfig = {
  provider: CloudTierProvider
  url: string
  model: string
  apiKey: string
}

// An env-var default, kept for operators who still prefer setting this in
// platform/.env (e.g. before ever signing in to configure it from the
// Settings page). The database (platform_settings, edited from the
// Control Center -- see resolveCloudTierConfig below) always takes
// precedence when both are set. ANTHROPIC_API_KEY takes precedence over
// CLOUD_TIER_API_KEY when both are set in the environment, since a real
// Anthropic key is a stronger, more specific signal than the generic
// OpenAI-compatible one.
export function loadCloudTierConfig(env: NodeJS.ProcessEnv): CloudTierConfig | null {
  const anthropicKey = env.ANTHROPIC_API_KEY
  if (anthropicKey) {
    return {
      provider: 'anthropic',
      url: env.CLOUD_TIER_URL || env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
      model: env.CLOUD_TIER_MODEL || env.ANTHROPIC_MODEL || 'claude-opus-5',
      apiKey: anthropicKey,
    }
  }
  const apiKey = env.CLOUD_TIER_API_KEY
  if (!apiKey) return null
  return {
    provider: 'openai',
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
    const provider = stored.provider ?? fallback?.provider ?? 'openai'
    const defaults = provider === 'anthropic'
      ? { url: 'https://api.anthropic.com', model: 'claude-opus-5' }
      : { url: 'https://api.groq.com/openai/v1', model: 'llama-3.3-70b-versatile' }
    return {
      provider,
      apiKey: stored.apiKey,
      url: stored.url || fallback?.url || defaults.url,
      model: stored.model || fallback?.model || defaults.model,
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
  return config.provider === 'anthropic'
    ? callAnthropic(config, messages, timeoutMs)
    : callOpenAiCompatible(config, messages, timeoutMs)
}

async function callOpenAiCompatible(config: CloudTierConfig, messages: CloudTierMessage[], timeoutMs: number): Promise<CloudTierResult> {
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

// Real Claude, via the official Anthropic SDK -- not an OpenAI-shaped proxy.
// The Messages API needs `system` pulled out of the message list (Claude has
// no system-role message, only a top-level `system` string) and every other
// turn must be user/assistant -- both handled below. `baseURL: config.url`
// is what lets tests point this at a fake server the same way the Groq path
// already does (see server.test.ts's withFakeGithub-style pattern).
async function callAnthropic(config: CloudTierConfig, messages: CloudTierMessage[], timeoutMs: number): Promise<CloudTierResult> {
  const client = new Anthropic({ apiKey: config.apiKey, baseURL: config.url })
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')
  const turns = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

  try {
    const response = await client.messages.create(
      {
        model: config.model,
        // Generous by design -- the user asked for fully detailed, rich
        // answers, not clipped ones. Non-streaming stays safely under the
        // SDK's HTTP-timeout risk zone (~16K) documented for this endpoint.
        max_tokens: 8192,
        system: system || undefined,
        messages: turns,
      },
      { timeout: timeoutMs },
    )

    if (response.stop_reason === 'refusal') {
      return { ok: false, status: 422, error: 'Claude declined to answer this request (safety classifier).' }
    }

    const content = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
    if (!content) {
      return { ok: false, status: 502, error: 'Claude returned no text content.' }
    }
    return { ok: true, content }
  } catch (error) {
    if (error instanceof Anthropic.AuthenticationError) {
      return { ok: false, status: 502, error: `Claude rejected the API key: ${error.message}` }
    }
    if (error instanceof Anthropic.RateLimitError) {
      return { ok: false, status: 429, error: `Claude rate limit: ${error.message}` }
    }
    if (error instanceof Anthropic.APIConnectionTimeoutError) {
      return { ok: false, status: 504, error: `Claude request timed out after ${timeoutMs}ms.` }
    }
    if (error instanceof Anthropic.APIConnectionError) {
      return { ok: false, status: 502, error: `Could not reach Claude: ${error.message}` }
    }
    if (error instanceof Anthropic.APIError) {
      return { ok: false, status: 502, error: `Claude upstream error (${error.status}): ${error.message}` }
    }
    return { ok: false, status: 502, error: error instanceof Error ? error.message : 'Claude request failed.' }
  }
}
