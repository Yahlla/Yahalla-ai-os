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
  }
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
