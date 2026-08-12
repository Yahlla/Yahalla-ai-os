import type { Device, DeploymentProposal } from './types'
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

// Needed by localRuntime.pairThisRuntime -- the local Agent Runtime's own
// /device/pair endpoint has to be told which platform-api deployment to
// register itself against, and that's this same URL the rest of this file
// already talks to.
export function getPlatformApiUrl(): string | null {
  return PLATFORM_API_URL ?? null
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
export type CloudTierStatus = { configured: boolean; model: string | null; url: string | null; provider: 'openai' | 'anthropic' | null }

export async function getCloudTierStatus(): Promise<CloudTierStatus> {
  const res = await platformFetch('/settings/cloud-tier')
  if (!res?.ok) return { configured: false, model: null, url: null, provider: null }
  return (await res.json()) as CloudTierStatus
}

export async function saveCloudTierSettings(settings: {
  apiKey: string
  url?: string
  model?: string
  provider?: 'openai' | 'anthropic'
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await platformFetch('/settings/cloud-tier', {
    method: 'POST',
    body: JSON.stringify({ api_key: settings.apiKey, url: settings.url, model: settings.model, provider: settings.provider }),
  })
  if (!res) return { ok: false, error: 'Platform server is not configured.' }
  const data = (await res.json()) as { success?: boolean; error?: string }
  if (!res.ok || !data.success) return { ok: false, error: data.error ?? `Save failed (HTTP ${res.status}).` }
  return { ok: true }
}

// Real command dispatch to a paired device's own local Agent Runtime (task
// #78-81): a human on ANY browser/device can ask for a task to run with the
// full file/git/GitHub tool access that only a real machine has, by routing
// it through platform-api's task queue to a device that's already paired
// and polling (see local-runtime/src/taskPoller.ts).

export async function requestDevicePairingCode(deviceName?: string): Promise<{ ok: true; code: string; expiresAt: string } | { ok: false; error: string }> {
  const res = await platformFetch('/pair_device', { method: 'POST', body: JSON.stringify({ device_name: deviceName }) })
  if (!res) return { ok: false, error: 'Platform server is not configured.' }
  const data = (await res.json()) as { success?: boolean; pairing_code?: string; expires_at?: string; error?: string }
  if (!res.ok || !data.success || !data.pairing_code || !data.expires_at) {
    return { ok: false, error: data.error ?? `Failed to create a pairing code (HTTP ${res.status}).` }
  }
  return { ok: true, code: data.pairing_code, expiresAt: data.expires_at }
}

export async function listPlatformDevices(): Promise<Device[]> {
  const res = await platformFetch('/devices')
  if (!res?.ok) return []
  const data = (await res.json()) as { devices?: Device[] }
  return data.devices ?? []
}

export type PlatformTask = {
  id: string
  title: string
  status: 'queued' | 'running' | 'completed' | 'failed' | string
  output: { answer?: string; executedTools?: { tool: string; arguments: Record<string, unknown>; result: Record<string, unknown> }[] } | null
  error: string | null
}

export async function createDeviceTask(title: string, deviceId?: string): Promise<{ ok: true; task: PlatformTask } | { ok: false; error: string }> {
  const res = await platformFetch('/tasks', { method: 'POST', body: JSON.stringify({ title, device_id: deviceId }) })
  if (!res) return { ok: false, error: 'Platform server is not configured.' }
  const data = (await res.json()) as { success?: boolean; task?: PlatformTask; error?: string }
  if (!res.ok || !data.success || !data.task) return { ok: false, error: data.error ?? `Failed to create task (HTTP ${res.status}).` }
  return { ok: true, task: data.task }
}

export async function getTask(taskId: string): Promise<PlatformTask | null> {
  const res = await platformFetch(`/tasks/${taskId}`)
  if (!res?.ok) return null
  const data = (await res.json()) as { success?: boolean; task?: PlatformTask }
  return data.task ?? null
}

// Zero-local-agent coding path (platform/api/src/codingAgent.ts +
// githubCommit.ts): a platform-level GitHub token, held server-side, lets
// this server itself read real repo files and commit a real branch/PR
// directly via the GitHub API -- no device pairing, no local-runtime,
// no local git clone, anywhere in the path.

export type GithubConnectionStatus = { configured: boolean; username: string | null; defaultRepo: string | null; oauthAvailable: boolean }

export async function getGithubConnectionStatus(): Promise<GithubConnectionStatus> {
  const res = await platformFetch('/settings/github')
  if (!res?.ok) return { configured: false, username: null, defaultRepo: null, oauthAvailable: false }
  return (await res.json()) as GithubConnectionStatus
}

// "Sign in with GitHub": mints a real github.com authorize URL for the
// signed-in human and hands it back so the caller can do
// window.location.href = url itself (a real top-level navigation, not a
// fetch redirect) -- see platform/api/src/githubOAuth.ts. Only available
// when the deployment owner has registered a GitHub OAuth App
// (oauthAvailable above); otherwise the manual Personal Access Token form
// stays the only way to connect.
export async function startGithubOAuth(): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const res = await platformFetch('/auth/github/start', { method: 'POST' })
  if (!res) return { ok: false, error: 'Platform server is not configured.' }
  const data = (await res.json()) as { success?: boolean; url?: string; error?: string }
  if (!res.ok || !data.success || !data.url) return { ok: false, error: data.error ?? `Could not start GitHub sign-in (HTTP ${res.status}).` }
  return { ok: true, url: data.url }
}

export async function connectPlatformGithub(token: string, defaultRepo?: string): Promise<{ ok: true; username: string | null } | { ok: false; error: string }> {
  const res = await platformFetch('/settings/github', { method: 'POST', body: JSON.stringify({ token, default_repo: defaultRepo }) })
  if (!res) return { ok: false, error: 'Platform server is not configured.' }
  const data = (await res.json()) as { success?: boolean; username?: string | null; error?: string }
  if (!res.ok || !data.success) return { ok: false, error: data.error ?? `Connect failed (HTTP ${res.status}).` }
  return { ok: true, username: data.username ?? null }
}

export async function disconnectPlatformGithub(): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await platformFetch('/settings/github', { method: 'DELETE' })
  if (!res) return { ok: false, error: 'Platform server is not configured.' }
  const data = (await res.json()) as { success?: boolean; error?: string }
  if (!res.ok || !data.success) return { ok: false, error: data.error ?? `Disconnect failed (HTTP ${res.status}).` }
  return { ok: true }
}

export type CodeChangePullRequest = { number: number; html_url: string; title: string; state: string; head: string; base: string }

export type CodeRequestResult = { ok: true; summary: string; pullRequest: CodeChangePullRequest | null } | { ok: false; error: string }

export async function requestCodeChange(instruction: string, repo?: string, base?: string): Promise<CodeRequestResult> {
  const res = await platformFetch('/code/request', { method: 'POST', body: JSON.stringify({ instruction, repo, base }) })
  if (!res) return { ok: false, error: 'Platform server is not configured.' }
  const data = (await res.json()) as { success?: boolean; summary?: string; pull_request?: CodeChangePullRequest | null; error?: string }
  if (!res.ok || !data.success) return { ok: false, error: data.error ?? `Code request failed (HTTP ${res.status}).` }
  return { ok: true, summary: data.summary ?? 'Done.', pullRequest: data.pull_request ?? null }
}

// Deployments (self-evolving agent path + the zero-terminal "ship the
// latest code" button): these read/write platform-api's own self-hosted
// deployment_proposals table -- the exact one deploy-agent's worker polls
// for approved rows before running `git pull && docker compose up -d
// --build` on the VPS. Deliberately NOT the Supabase-backed functions in
// api.ts, which write to a different database deploy-agent never looks at.
export async function listDeployments(): Promise<DeploymentProposal[]> {
  const res = await platformFetch('/deployments')
  if (!res?.ok) return []
  const data = (await res.json()) as { deployments?: DeploymentProposal[] }
  return data.deployments ?? []
}

export async function proposeLatestDeployment(): Promise<
  { ok: true; upToDate: true } | { ok: true; upToDate: false; deployment: DeploymentProposal } | { ok: false; error: string }
> {
  const res = await platformFetch('/deployments/propose_latest', { method: 'POST' })
  if (!res) return { ok: false, error: 'Platform server is not configured.' }
  const data = (await res.json()) as { success?: boolean; up_to_date?: boolean; message?: string; deployment?: DeploymentProposal; error?: string }
  if (!res.ok || !data.success) return { ok: false, error: data.error ?? `Failed (HTTP ${res.status}).` }
  if (data.up_to_date) return { ok: true, upToDate: true }
  if (!data.deployment) return { ok: false, error: 'Server did not return a deployment proposal.' }
  return { ok: true, upToDate: false, deployment: data.deployment }
}

export async function decideDeployment(id: string, decision: 'approve' | 'reject'): Promise<{ ok: true } | { ok: false; error: string }> {
  const res = await platformFetch(`/deployments/${id}/decide`, { method: 'POST', body: JSON.stringify({ decision }) })
  if (!res) return { ok: false, error: 'Platform server is not configured.' }
  const data = (await res.json()) as { success?: boolean; error?: string }
  if (!res.ok) return { ok: false, error: data.error ?? `Failed (HTTP ${res.status}).` }
  return { ok: true }
}
