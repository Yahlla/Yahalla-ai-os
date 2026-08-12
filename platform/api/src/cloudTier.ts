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

export type CloudTierConfig = {
  url: string
  model: string
  apiKey: string
}

export function loadCloudTierConfig(env: NodeJS.ProcessEnv): CloudTierConfig | null {
  const apiKey = env.CLOUD_TIER_API_KEY
  if (!apiKey) return null
  return {
    url: env.CLOUD_TIER_URL || 'https://api.groq.com/openai/v1',
    model: env.CLOUD_TIER_MODEL || 'llama-3.3-70b-versatile',
    apiKey,
  }
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
      body: JSON.stringify({ model: config.model, messages }),
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
