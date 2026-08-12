import { supabase } from './supabase'

// Optional: the self-hosted Strato control plane (platform/api). Chat
// keeps working with purely local state when this isn't configured --
// every function here degrades to a no-op rather than throwing, so a
// deployment without a Strato server yet (or one where it's briefly
// unreachable) never breaks the chat itself, only the "remembers across
// reloads" part of it.
const PLATFORM_API_URL = import.meta.env.VITE_PLATFORM_API_URL as string | undefined

export function isPlatformApiConfigured(): boolean {
  return Boolean(PLATFORM_API_URL)
}

async function authHeader(): Promise<Record<string, string> | null> {
  const {
    data: { session },
  } = await supabase.auth.getSession()
  if (!session?.access_token) return null
  return { Authorization: `Bearer ${session.access_token}` }
}

async function platformFetch(path: string, init: RequestInit = {}): Promise<Response | null> {
  if (!PLATFORM_API_URL) return null
  try {
    const headers = await authHeader()
    if (!headers) return null
    return await fetch(`${PLATFORM_API_URL}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...headers, ...init.headers },
    })
  } catch {
    return null
  }
}

export type PersistedConversation = { id: string; title: string; updated_at: string }
export type PersistedMessage = {
  id: string
  conversation_id: string
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  tool_activity: { tool: string; result: Record<string, unknown> }[]
  metadata: Record<string, unknown>
  created_at: string
}

export async function listConversations(): Promise<PersistedConversation[]> {
  const res = await platformFetch('/conversations')
  if (!res?.ok) return []
  const data = (await res.json()) as { conversations?: PersistedConversation[] }
  return data.conversations ?? []
}

export async function createConversation(title?: string): Promise<PersistedConversation | null> {
  const res = await platformFetch('/conversations', { method: 'POST', body: JSON.stringify({ title }) })
  if (!res?.ok) return null
  const data = (await res.json()) as { conversation?: PersistedConversation }
  return data.conversation ?? null
}

export async function getConversationMessages(conversationId: string): Promise<PersistedMessage[]> {
  const res = await platformFetch(`/conversations/${conversationId}/messages`)
  if (!res?.ok) return []
  const data = (await res.json()) as { messages?: PersistedMessage[] }
  return data.messages ?? []
}

// Fire-and-forget by design at the call site: persistence should never
// make the chat itself feel slower or fail a send that otherwise
// succeeded locally.
export async function appendMessage(
  conversationId: string,
  message: { role: 'user' | 'assistant'; content: string; tool_activity?: { tool: string; result: Record<string, unknown> }[]; metadata?: Record<string, unknown> },
): Promise<void> {
  await platformFetch(`/conversations/${conversationId}/messages`, { method: 'POST', body: JSON.stringify(message) })
}

// Opt-in cloud smart tier (server-side proxy to a free-tier 70B-class
// model, see platform/api/src/cloudTier.ts). Same fail-soft shape as the
// rest of this file: no platform-api configured, or the deployment hasn't
// set a CLOUD_TIER_API_KEY, both just mean "not available" -- never a
// thrown error the chat has to handle specially.
export type CloudTierChatResult = { ok: true; content: string; model: string } | { ok: false; error: string }

export async function cloudTierChat(messages: { role: string; content: string }[]): Promise<CloudTierChatResult> {
  const res = await platformFetch('/smart-tier/chat', { method: 'POST', body: JSON.stringify({ messages }) })
  if (!res) return { ok: false, error: 'Cloud smart tier is not reachable (platform server not configured).' }
  const data = (await res.json()) as { success?: boolean; content?: string; model?: string; error?: string }
  if (!res.ok || !data.success || typeof data.content !== 'string') {
    return { ok: false, error: data.error ?? `Cloud smart tier request failed (HTTP ${res.status}).` }
  }
  return { ok: true, content: data.content, model: data.model ?? 'cloud' }
}

// Admin-only, zero-terminal configuration for the cloud smart tier: saved
// to the database (platform_settings, RLS-gated to admins) from the
// Control Center's Settings page instead of editing platform/.env by
// hand. Takes effect on the very next chat message, no redeploy.
export type CloudTierStatus = { configured: boolean; model: string | null; url: string | null }

export async function getCloudTierStatus(): Promise<CloudTierStatus> {
  const res = await platformFetch('/settings/cloud-tier')
  if (!res?.ok) return { configured: false, model: null, url: null }
  return (await res.json()) as CloudTierStatus
}

export async function saveCloudTierSettings(settings: { apiKey: string; url?: string; model?: string }): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await platformFetch('/settings/cloud-tier', {
    method: 'POST',
    body: JSON.stringify({ api_key: settings.apiKey, url: settings.url, model: settings.model }),
  })
  if (!res) return { ok: false, error: 'Platform server is not configured.' }
  const data = (await res.json()) as { success?: boolean; error?: string }
  if (!res.ok || !data.success) return { ok: false, error: data.error ?? `Save failed (HTTP ${res.status}).` }
  return { ok: true }
}
