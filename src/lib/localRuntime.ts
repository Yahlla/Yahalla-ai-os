import type { ChatResponse } from './types'

// The Control Center's primary AI path: a local Agent Runtime running on
// this same device (127.0.0.1). No cloud LLM, no tunnel -- Supabase is
// only used elsewhere in this app for auth/optional sync, never for AI
// inference itself.
//
// Three ways this frontend can learn how to reach it, tried in order:
// 1. Running inside the Electron desktop shell: window.yahallaDesktop
//    (exposed by desktop/src/preload.cjs) hands over {baseUrl, authToken}
//    via a secure IPC bridge -- the real path for the packaged desktop app.
// 2. Running as a plain browser page (e.g. the hosted Control Center,
//    https://yahalla-ai.yahalla.de): a stored pairing in localStorage,
//    obtained via pairWithLocalRuntime() below -- a one-click, explicit
//    action that fetches local-runtime's own /pair/token endpoint
//    (server.ts). That endpoint only ever succeeds cross-origin for a
//    request whose Origin is on local-runtime's own CORS allowlist (see
//    local-runtime/src/config.ts's DEFAULT_ALLOWED_ORIGINS), so an
//    arbitrary third-party page cannot silently obtain this device's
//    token just by knowing this code exists -- only a page already
//    running at a known Yahalla origin can. The token itself never
//    passes through Strato or any other server; it goes straight from
//    the local-runtime process to this tab.
// 3. Running during `vite dev` (no Electron, no pairing yet): a dev-only
//    fallback reads VITE_YAHALLA_RUNTIME_TOKEN from the local .env, which
//    a developer copies out of ~/.yahalla/runtime/config.json once. Not a
//    production security boundary -- the Electron bridge and the pairing
//    flow are.
export type RuntimeProcessStatus = { status: 'starting' | 'restarting' | 'failed'; reason?: string }
export type ModelSetupStatus =
  | { phase: 'checking' | 'starting_engine' | 'ready' | 'engine-missing' }
  | { phase: 'downloading'; modelName: string }
  | { phase: 'error'; error: string }

declare global {
  interface Window {
    yahallaDesktop?: {
      getRuntimeInfo: () => Promise<{ baseUrl: string; authToken: string } | null>
      // Both return an unsubscribe function -- Electron-only (main.cjs);
      // absent entirely in a plain browser tab, same as getRuntimeInfo.
      onRuntimeStatus: (callback: (status: RuntimeProcessStatus) => void) => () => void
      onModelStatus: (callback: (status: ModelSetupStatus) => void) => () => void
    }
  }
}

const PAIRING_STORAGE_KEY = 'yahalla_local_runtime_pairing'
export const DEFAULT_LOCAL_RUNTIME_URL = 'http://127.0.0.1:8765'

type StoredPairing = { baseUrl: string; authToken: string }

function readStoredPairing(): StoredPairing | null {
  try {
    const raw = window.localStorage.getItem(PAIRING_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredPairing>
    if (typeof parsed.baseUrl !== 'string' || typeof parsed.authToken !== 'string') return null
    return { baseUrl: parsed.baseUrl, authToken: parsed.authToken }
  } catch {
    return null
  }
}

let cachedInfo: { baseUrl: string; authToken: string } | null | undefined

export async function getRuntimeInfo(): Promise<{ baseUrl: string; authToken: string } | null> {
  // Never permanently cache a missing runtime connection.
  // A plain browser tab may start before the local runtime is ready,
  // or may pair later during the same session.
  if (cachedInfo) return cachedInfo

  if (window.yahallaDesktop) {
    cachedInfo = await window.yahallaDesktop.getRuntimeInfo()
    return cachedInfo
  }

  const stored = readStoredPairing()
  if (stored) {
    cachedInfo = stored
    return cachedInfo
  }

  const devToken = import.meta.env.VITE_YAHALLA_RUNTIME_TOKEN as string | undefined
  const devUrl = (import.meta.env.VITE_YAHALLA_RUNTIME_URL as string | undefined) ?? DEFAULT_LOCAL_RUNTIME_URL

  if (devToken) {
    cachedInfo = { baseUrl: devUrl, authToken: devToken }
    return cachedInfo
  }

  // Important: do NOT cache null.
  // The runtime may become available later and the browser must be
  // able to discover and pair with it without a reload.
  return null
}

// One-click pairing for a plain browser tab (no Electron bridge): fetches
// local-runtime's /pair/token over plain HTTP+CORS (see the module comment
// above for why this is safe) and remembers it in localStorage so future
// visits don't need to re-pair. Only meaningful to call when
// window.yahallaDesktop is absent -- inside Electron, getRuntimeInfo()
// already has a real answer and this is never needed.
export async function pairWithLocalRuntime(baseUrl: string = DEFAULT_LOCAL_RUNTIME_URL): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const response = await fetch(`${baseUrl}/pair/token`, { signal: AbortSignal.timeout(5000) })
    if (!response.ok) return { ok: false, error: `Local Agent Runtime returned HTTP ${response.status}.` }
    const data = (await response.json()) as Partial<StoredPairing>
    if (typeof data.baseUrl !== 'string' || typeof data.authToken !== 'string') {
      return { ok: false, error: 'Local Agent Runtime returned an unexpected pairing response.' }
    }
    const pairing: StoredPairing = { baseUrl: data.baseUrl, authToken: data.authToken }
    window.localStorage.setItem(PAIRING_STORAGE_KEY, JSON.stringify(pairing))
    cachedInfo = pairing

    // The one-time "trust this project folder" step (see server.ts's
    // /project/trust): this pairing action -- an explicit click, from a
    // tab already running at a known Yahalla origin, on the same machine
    // the runtime is on -- is the real consent signal, the same way
    // launching the desktop app pointed at a project is for the Electron
    // path (desktop/src/main.cjs). Without this, every project-scoped
    // tool (get_project_overview, read_project_file, ...) stays
    // permission-denied after pairing with no further way to fix it from
    // this tab. Best-effort: a failure here still leaves pairing itself
    // successful, and the real permission error (if any) surfaces the
    // next time a project tool actually runs.
    try {
      await fetch(`${pairing.baseUrl}/project/trust`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${pairing.authToken}` },
        body: JSON.stringify({ access: 'write' }),
        signal: AbortSignal.timeout(5000),
      })
    } catch {
      // non-fatal -- see comment above
    }

    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not reach a local Agent Runtime on this device.',
    }
  }
}

export function clearStoredPairing(): void {
  window.localStorage.removeItem(PAIRING_STORAGE_KEY)
  if (!window.yahallaDesktop) cachedInfo = undefined
}

// True once this tab actually knows how to authenticate to a local
// runtime (Electron bridge, a completed pairing, or the dev token) --
// distinct from checkRuntimeHealth()'s result, which only proves *a*
// local-runtime process is running and reachable, not that this specific
// tab is allowed to talk to it yet. sendMessage uses both together: health
// without this means "detected, but needs one click to connect."
export async function isPairedWithLocalRuntime(): Promise<boolean> {
  return (await getRuntimeInfo()) !== null
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
  const info = await getRuntimeInfo()
  const configuredUrl =
    (import.meta.env.VITE_YAHALLA_RUNTIME_URL as string | undefined) ??
    DEFAULT_LOCAL_RUNTIME_URL

  // Health is intentionally unauthenticated and must work even before
  // browser pairing. Always probe the known local endpoint directly when
  // this tab has not paired yet.
  const base = info?.baseUrl ?? configuredUrl

  try {
    const response = await fetch(`${base}/health`, {
      signal: AbortSignal.timeout(3000),
      cache: 'no-store',
    })

    if (!response.ok) return null

    return (await response.json()) as RuntimeHealth
  } catch (error) {
    // If a configured URL failed, retry the canonical localhost runtime.
    // This protects the browser from stale Vite/env configuration.
    if (base !== DEFAULT_LOCAL_RUNTIME_URL) {
      try {
        const response = await fetch(`${DEFAULT_LOCAL_RUNTIME_URL}/health`, {
          signal: AbortSignal.timeout(3000),
          cache: 'no-store',
        })

        if (response.ok) {
          return (await response.json()) as RuntimeHealth
        }
      } catch {
        // Fall through to null.
      }
    }

    console.error('[LOCAL RUNTIME HEALTH ERROR]', error)
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
  // Same real fix as api.ts's sendChatMessage: check response.ok and
  // handle a non-JSON body before parsing, rather than letting a
  // malformed/unexpected response surface as an opaque JSON.parse
  // SyntaxError instead of a clear message.
  const text = await response.text()
  let result: LocalChatResult
  try {
    result = text ? (JSON.parse(text) as LocalChatResult) : ({} as LocalChatResult)
  } catch {
    throw new Error(`Local Agent Runtime returned a non-JSON response (HTTP ${response.status}): ${text.slice(0, 200)}`)
  }
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

// Same normalization as sendChatMessage above, but against /chat/stream
// (server.ts): forwards each live content token to onToken as it arrives
// -- the local-runtime tier's equivalent of the browser tier's already-
// streaming browserChatCompletion, so the composer shows live "typing"
// for local-runtime the same way it already does for the browser tier
// instead of a static wait until the whole answer is ready. Native
// EventSource can't POST or send an Authorization header, so this reads
// the SSE body manually, the same pattern subscribeLiveStatus already
// uses above.
export async function sendChatMessageStream(
  params: { message: string; conversation_id?: string },
  onToken: (delta: string) => void,
): Promise<ChatResponse> {
  const info = await getRuntimeInfo()
  if (!info) throw new Error('Local Agent Runtime is not reachable from this window. Is Yahalla AI running?')

  const response = await fetch(`${info.baseUrl}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${info.authToken}` },
    body: JSON.stringify({ message: params.message, conversation_id: params.conversation_id }),
  })
  if (!response.ok || !response.body) {
    throw new Error(`Local Agent Runtime returned HTTP ${response.status}`)
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let result: LocalChatResult | null = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const frames = buffer.split('\n\n')
    buffer = frames.pop() ?? ''
    for (const frame of frames) {
      const dataLine = frame.split('\n').find((l) => l.startsWith('data: '))
      if (!dataLine) continue
      let parsed: { kind: 'token'; delta: string } | ({ kind: 'done' } & LocalChatResult)
      try {
        parsed = JSON.parse(dataLine.slice('data: '.length))
      } catch {
        continue
      }
      if (parsed.kind === 'token') onToken(parsed.delta)
      else result = parsed
    }
  }

  if (!result) throw new Error('Local Agent Runtime closed the stream without a result.')
  if (!result.success && result.status === 'failed') throw new Error(result.error || 'Local Agent Runtime request failed.')

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

// Real, per-device model status -- what actually powers chat on this
// machine, not a static catalog row that was seeded once and never
// touched again. See ModelsSection in App.tsx.
export type LocalModelSummary = {
  key: string
  name: string
  status: 'not_downloaded' | 'downloading' | 'ready' | 'error'
  active: boolean
}

export async function listLocalModels(): Promise<LocalModelSummary[] | null> {
  try {
    const response = await runtimeFetch('/models')
    if (!response.ok) return null
    const data = (await response.json()) as { installed?: { key: string; name: string; status: string; active: number }[] }
    return (data.installed ?? []).map((m) => ({ key: m.key, name: m.name, status: m.status as LocalModelSummary['status'], active: m.active === 1 }))
  } catch {
    return null
  }
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
