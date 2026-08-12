import type { ChatResult, RuntimeContext } from './agentLoop.js'
import { runChat } from './agentLoop.js'
import type { RuntimeConfig } from './config.js'
import { sendHeartbeat } from './devicePairing.js'

const DEFAULT_POLL_INTERVAL_MS = 5000
const DEFAULT_HEARTBEAT_INTERVAL_MS = 60_000

type PendingApproval = { remoteTaskId: string; approvalId: string; tool?: string }

export type TaskPollerOptions = {
  // Overridable so tests don't need to wait out the real 5s/60s cadence.
  pollIntervalMs?: number
  heartbeatIntervalMs?: number
}

// Starts (or, if the device isn't paired, no-ops) a poll loop against
// platform-api's device task queue. Returns a stop function. Safe to call
// again after config changes -- callers should stop the previous poller
// first (see index.ts's restartPoller).
export function startTaskPoller(ctx: RuntimeContext, config: RuntimeConfig, options: TaskPollerOptions = {}): () => void {
  if (!config.platformApiUrl || !config.deviceToken) {
    return () => {}
  }
  const platformApiUrl = trimTrailingSlash(config.platformApiUrl)
  const deviceToken = config.deviceToken
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS

  let stopped = false
  let busy = false
  const pendingApprovals: PendingApproval[] = []

  async function reportResult(remoteTaskId: string, result: ChatResult): Promise<void> {
    const status = result.status === 'completed' && result.success ? 'completed' : 'failed'
    await fetch(`${platformApiUrl}/tasks/${remoteTaskId}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${deviceToken}` },
      body: JSON.stringify({
        status,
        output: { answer: result.answer ?? null, executedTools: result.executedTools ?? [] },
        error: result.error ?? null,
      }),
    }).catch(() => {})
  }

  // A task that hit an approval gate isn't done -- it stays "running" on
  // platform-api until the device owner decides via this machine's own
  // /approvals list (the same approval UI used for local chats). We just
  // watch the local approvals table for a decision instead of blocking.
  async function checkPendingApprovals(): Promise<void> {
    for (let i = pendingApprovals.length - 1; i >= 0; i--) {
      const pending = pendingApprovals[i]!
      const row = ctx.db.prepare('SELECT status, result FROM approvals WHERE id = ?').get(pending.approvalId) as
        | { status: string; result: string | null }
        | undefined
      if (!row || row.status === 'pending') continue

      pendingApprovals.splice(i, 1)
      if (row.status === 'rejected') {
        await reportResult(pending.remoteTaskId, {
          success: false,
          conversationId: '',
          status: 'failed',
          error: 'Rejected by the device owner in the local approvals list.',
        })
      } else {
        await reportResult(pending.remoteTaskId, {
          success: true,
          conversationId: '',
          status: 'completed',
          answer: 'Approved and executed on the device.',
          executedTools: [{ tool: pending.tool ?? 'unknown', arguments: {}, result: row.result ? JSON.parse(row.result) : {} }],
        })
      }
    }
  }

  async function pollOnce(): Promise<void> {
    if (busy || stopped) return
    busy = true
    try {
      await checkPendingApprovals()

      const response = await fetch(`${platformApiUrl}/tasks/next`, {
        headers: { Authorization: `Bearer ${deviceToken}` },
      })
      if (!response.ok) return
      const body = (await response.json().catch(() => null)) as { task?: Record<string, unknown> } | null
      const task = body?.task
      if (!task || typeof task.id !== 'string') return

      const message = [task.title, task.description]
        .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
        .join('\n\n')

      let result: ChatResult
      try {
        result = await runChat(ctx, message || 'Perform the requested task.')
      } catch (error) {
        result = {
          success: false,
          conversationId: '',
          status: 'failed',
          error: error instanceof Error ? error.message : 'Task execution failed.',
        }
      }

      if (result.status === 'waiting_approval' && result.approvalId) {
        pendingApprovals.push({ remoteTaskId: task.id, approvalId: result.approvalId, tool: result.approvalTool })
        return
      }

      await reportResult(task.id, result)
    } catch {
      // network hiccup -- the next tick retries; a dispatched task simply
      // stays queued/running on platform-api until this device (or
      // another paired one) successfully claims and completes it.
    } finally {
      busy = false
    }
  }

  const pollTimer = setInterval(() => void pollOnce(), pollIntervalMs)
  const heartbeatTimer = setInterval(() => void sendHeartbeat(platformApiUrl, deviceToken), heartbeatIntervalMs)
  void sendHeartbeat(platformApiUrl, deviceToken)

  return () => {
    stopped = true
    clearInterval(pollTimer)
    clearInterval(heartbeatTimer)
  }
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}
