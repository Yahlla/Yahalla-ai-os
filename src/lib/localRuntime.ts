import type { ChatResponse } from './types'

// The Control Center's primary AI path: a local Agent Runtime running on
// this same device (127.0.0.1). No cloud LLM, no tunnel -- Supabase is
// only used elsewhere in this app for auth/optional sync, never for AI
// inference itself.
//
// Two ways this frontend can learn how to reach it:
// 1. Running inside the Electron desktop shell: window.yahallaDesktop
//    (exposed by desktop/src/preload.cjs) hands over {baseUrl, authToken}
//    via a secure IPC bridge -- the real path for end users.
// 2. Running as a plain browser page during `vite dev` (no Electron): a
//    dev-only fallback reads VITE_YAHALLA_RUNTIME_TOKEN from the local
//    .env, which a developer copies out of ~/.yahalla/runtime/config.json
//    once. This is a developer convenience, not a production security
//    boundary -- the real boundary is the Electron bridge.
declare global {
  interface Window {
    yahallaDesktop?: {
      getRuntimeInfo: () => Promise<{ baseUrl: string; authToken: string } | null>
    }
  }
}

let cachedInfo: { baseUrl: string; authToken: string } | null | undefined

export async function getRuntimeInfo(): Promise<{ baseUrl: string; authToken: string } | null> {
  if (cachedInfo !== undefined) return cachedInfo

  if (window.yahallaDesktop) {
    cachedInfo = await window.yahallaDesktop.getRuntimeInfo()
    return cachedInfo
  }

  const devToken = import.meta.env.VITE_YAHALLA_RUNTIME_TOKEN as string | undefined
  const devUrl = (import.meta.env.VITE_YAHALLA_RUNTIME_URL as string | undefined) ?? 'http://127.0.0.1:8765'
  cachedInfo = devToken ? { baseUrl: devUrl, authToken: devToken } : null
  return cachedInfo
}

async function runtimeFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const info = await getRuntimeInfo()
  if (!info) {
    throw new Error('Local Agent Runtime is not reachable from this window. Is Yahalla AI running?')
  }
  return fetch(`${info.baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${info.authToken}`, ...init.headers },
  })
}

export type RuntimeHealth = {
  status: string
  runtime: 'local'
  model: { key: string; name: string } | null
  llm_reachable: boolean
}

export async function checkRuntimeHealth(): Promise<RuntimeHealth | null> {
  try {
    const info = await getRuntimeInfo()
    const base = info?.baseUrl ?? ((import.meta.env.VITE_YAHALLA_RUNTIME_URL as string | undefined) ?? 'http://127.0.0.1:8765')
    const response = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) })
    if (!response.ok) return null
    return (await response.json()) as RuntimeHealth
  } catch {
    return null
  }
}

type LocalChatResult = {
  success: boolean
  conversationId: string
  taskId?: string
  status: 'completed' | 'waiting_approval' | 'failed'
  answer?: string
  error?: string
  executedTools?: { tool: string; arguments: Record<string, unknown>; result: Record<string, unknown> }[]
  approvalId?: string
  approvalTool?: string
}

// Normalizes the local runtime's response into the same ChatResponse shape
// the rest of the UI already expects from the old Supabase edge-function
// path, so the calling code in App.tsx does not need to change.
export async function sendChatMessage(params: { message: string; conversation_id?: string }): Promise<ChatResponse> {
  const response = await runtimeFetch('/chat', {
    method: 'POST',
    body: JSON.stringify({ message: params.message, conversation_id: params.conversation_id }),
  })
  const result = (await response.json()) as LocalChatResult
  if (!response.ok) {
    throw new Error(result.error || `Local Agent Runtime returned HTTP ${response.status}`)
  }

  return {
    success: result.success,
    task_id: result.taskId,
    conversation_id: result.conversationId,
    status: result.status,
    answer: result.answer,
    error: result.error,
    agent: { id: 'local', key: 'yahalla-core', name_ar: 'يحalla الأساسي', name_de: 'Yahalla Core', status: 'active' },
    executed_tools: result.executedTools?.map((t, i) => ({ ...t, execution_id: `${result.taskId ?? 'local'}:${i}` })),
    approval_required: result.status === 'waiting_approval',
    tool_execution_id: result.approvalId,
    approval_tool: result.approvalTool,
  }
}

export type LiveUpdate =
  | { kind: 'embodiment'; state: string; summary: string | null; timestamp: string }
  | { kind: 'perception'; event: Record<string, unknown> }

// Native EventSource can't send an Authorization header, and this runtime
// deliberately requires one on every route but /health -- so the live
// stream is consumed with fetch + a manual SSE line reader instead of
// EventSource, keeping the same auth model everywhere rather than leaking
// the token into a URL/query string.
export async function subscribeLiveStatus(onUpdate: (update: LiveUpdate) => void): Promise<() => void> {
  const info = await getRuntimeInfo()
  if (!info) throw new Error('Local Agent Runtime is not reachable from this window.')

  const controller = new AbortController()

  ;(async () => {
    try {
      const response = await fetch(`${info.baseUrl}/live/stream`, {
        headers: { Authorization: `Bearer ${info.authToken}` },
        signal: controller.signal,
      })
      if (!response.ok || !response.body) return
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const dataLine = line.split('\n').find((l) => l.startsWith('data: '))
          if (!dataLine) continue
          try {
            onUpdate(JSON.parse(dataLine.slice('data: '.length)) as LiveUpdate)
          } catch {
            // ignore malformed frame
          }
        }
      }
    } catch {
      // stream ended/aborted -- caller's unsubscribe already handles cleanup
    }
  })()

  return () => controller.abort()
}

// Remote command dispatch (task #78-81): pairs THIS machine's local Agent
// Runtime against a platform-api deployment so a task created from any
// other browser/device can be routed here and run with this machine's own
// real file/git/tool access (see local-runtime/src/taskPoller.ts). This
// call only ever succeeds when made from a browser tab on the same machine
// the runtime is running on -- runtimeFetch throws otherwise, the same way
// every other local-runtime call here does.
export async function pairThisRuntime(platformApiUrl: string, code: string, deviceName: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await runtimeFetch('/device/pair', {
      method: 'POST',
      body: JSON.stringify({ platform_api_url: platformApiUrl, code, device_name: deviceName }),
    })
    const result = (await response.json()) as { success?: boolean; error?: string }
    if (!response.ok || !result.success) return { ok: false, error: result.error ?? `Pairing failed (HTTP ${response.status}).` }
    return { ok: true }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Local Agent Runtime is not reachable from this window.' }
  }
}

export type RuntimeDeviceStatus = { paired: boolean; platformApiUrl: string | null }

export async function getRuntimeDeviceStatus(): Promise<RuntimeDeviceStatus | null> {
  try {
    const response = await runtimeFetch('/device/status')
    if (!response.ok) return null
    const data = (await response.json()) as { paired: boolean; platform_api_url: string | null }
    return { paired: data.paired, platformApiUrl: data.platform_api_url }
  } catch {
    return null
  }
}

export async function unpairThisRuntime(): Promise<void> {
  await runtimeFetch('/device/unpair', { method: 'POST' }).catch(() => {})
}

// Integrations Hub (GitHub): a Personal Access Token entered here, once,
// is what unlocks the github.read/github.write tools already wired into
// agentLoop (see local-runtime/src/github.ts) -- letting Yahalla actually
// read/create GitHub repositories on your command instead of just having
// the capability sit unreachable behind no UI. Device-local by design:
// the token is validated and stored on the machine that runs the tools,
// never sent to or through Strato.
export type GithubIntegrationStatus = { configured: boolean; username: string | null }

export async function getGithubIntegrationStatus(): Promise<GithubIntegrationStatus | null> {
  try {
    const response = await runtimeFetch('/integrations/github/status')
    if (!response.ok) return null
    return (await response.json()) as GithubIntegrationStatus
  } catch {
    return null
  }
}

export async function connectGithub(token: string): Promise<{ ok: true; username: string | null } | { ok: false; error: string }> {
  try {
    const response = await runtimeFetch('/integrations/github', { method: 'POST', body: JSON.stringify({ token }) })
    const result = (await response.json()) as { success?: boolean; username?: string | null; error?: string }
    if (!response.ok || !result.success) return { ok: false, error: result.error ?? `Connecting to GitHub failed (HTTP ${response.status}).` }
    return { ok: true, username: result.username ?? null }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Local Agent Runtime is not reachable from this window.' }
  }
}

export async function disconnectGithub(): Promise<void> {
  await runtimeFetch('/integrations/github', { method: 'DELETE' }).catch(() => {})
}

// Integrations Hub (Databases): each connection unlocks the db_query
// (read-only, enforced by a real Postgres READ ONLY transaction) and
// db_execute (writes/DDL, approval-gated) tools already wired into
// agentLoop -- see local-runtime/src/database.ts. Device-local, same
// reasoning as GitHub: the connection string is validated with a real
// SELECT 1 and stored only on the machine that runs the tools, never sent
// to or through Strato.
export type DatabaseConnectionSummary = { id: string; name: string; createdAt: string }

export async function listDatabaseConnections(): Promise<DatabaseConnectionSummary[]> {
  try {
    const response = await runtimeFetch('/integrations/database')
    if (!response.ok) return []
    const data = (await response.json()) as { connections?: DatabaseConnectionSummary[] }
    return data.connections ?? []
  } catch {
    return []
  }
}

export async function addDatabaseConnection(name: string, connectionString: string): Promise<{ ok: true; connection: DatabaseConnectionSummary } | { ok: false; error: string }> {
  try {
    const response = await runtimeFetch('/integrations/database', {
      method: 'POST',
      body: JSON.stringify({ name, connection_string: connectionString }),
    })
    const result = (await response.json()) as { success?: boolean; connection?: DatabaseConnectionSummary; error?: string }
    if (!response.ok || !result.success || !result.connection) return { ok: false, error: result.error ?? `Connecting failed (HTTP ${response.status}).` }
    return { ok: true, connection: result.connection }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Local Agent Runtime is not reachable from this window.' }
  }
}

export async function removeDatabaseConnection(id: string): Promise<void> {
  await runtimeFetch(`/integrations/database/${id}`, { method: 'DELETE' }).catch(() => {})
}

export async function decideApproval(approvalId: string, decision: 'approve' | 'reject'): Promise<ChatResponse> {
  const response = await runtimeFetch(`/approvals/${approvalId}/decide`, {
    method: 'POST',
    body: JSON.stringify({ decision }),
  })
  const result = (await response.json()) as LocalChatResult
  if (!response.ok) {
    throw new Error(result.error || `Local Agent Runtime returned HTTP ${response.status}`)
  }
  return {
    success: result.success,
    task_id: result.taskId,
    conversation_id: result.conversationId,
    status: result.status,
    answer: result.answer,
    error: result.error,
    executed_tools: result.executedTools?.map((t, i) => ({ ...t, execution_id: `${result.taskId ?? 'local'}:${i}` })),
  }
}
