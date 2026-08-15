import type { SupabaseClient } from '@supabase/supabase-js'
import { executeDeviceTool } from './tools/index.js'
import { callYahalla } from './auth.js'
import type { DeviceConfig } from './config.js'

const POLL_INTERVAL_MS = 5_000

type PendingExecution = {
  id: string
  task_id: string
  tool_id: string
  input: Record<string, unknown>
  tools: { key: string; configuration: Record<string, unknown> | null } | null
}

/**
 * The edge function assigns tool_executions directly to a specific online
 * device at dispatch time (resolved server-side) — this device never needs
 * to race other devices for work, it just polls (and listens on realtime as
 * a low-latency nice-to-have) for rows already addressed to it.
 */
export function startClaimLoop(client: SupabaseClient, config: DeviceConfig): () => void {
  let stopped = false
  let running = false

  async function tick() {
    if (stopped || running) return
    running = true

    try {
      const { data: userData } = await client.auth.getUser()
      if (!userData.user) return

      const { data: device } = await client
        .from('devices')
        .select('id')
        .eq('auth_user_id', userData.user.id)
        .maybeSingle()

      if (!device) return

      const { data: pending, error } = await client
        .from('tool_executions')
        .select('id, task_id, tool_id, input, tools ( key, configuration )')
        .eq('assigned_device', device.id)
        .eq('status', 'pending')
        .order('created_at', { ascending: true })
        .limit(1)

      if (error) {
        console.error('[yahalla-agent] failed to poll for work:', error.message)
        return
      }

      for (const execution of (pending ?? []) as unknown as PendingExecution[]) {
        await runOne(client, config, execution)
      }
    } finally {
      running = false
    }
  }

  async function runOne(c: SupabaseClient, cfg: DeviceConfig, execution: PendingExecution) {
    const toolKey = execution.tools?.key

    if (!toolKey) {
      console.error('[yahalla-agent] tool_execution has no resolvable tool key, skipping:', execution.id)
      return
    }

    console.log(`[yahalla-agent] running "${toolKey}" for task ${execution.task_id}`)

    const { error: claimError } = await c
      .from('tool_executions')
      .update({ status: 'running', started_at: new Date().toISOString(), updated_at: new Date().toISOString() })
      .eq('id', execution.id)
      .eq('status', 'pending')

    if (claimError) {
      console.error('[yahalla-agent] failed to mark tool_execution running:', claimError.message)
      return
    }

    const result = await executeDeviceTool(
      toolKey,
      cfg.project_root,
      execution.input ?? {},
      execution.tools?.configuration ?? {},
    )

    await c
      .from('tool_executions')
      .update({
        status: result.success ? 'completed' : 'failed',
        output: result.success ? result : null,
        error: result.success ? null : result,
        completed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', execution.id)

    await c.from('task_logs').insert({
      task_id: execution.task_id,
      level: result.success ? 'info' : 'error',
      message: `Device "${cfg.device_name}" ${result.success ? 'completed' : 'failed'} "${toolKey}".`,
      data: result,
    })

    try {
      const { data: session } = await c.auth.getSession()
      await callYahalla(cfg.supabase_url, cfg.supabase_anon_key, session.session?.access_token ?? null, {
        device_action: 'resume_task',
        task_id: execution.task_id,
        tool_execution_id: execution.id,
      })
    } catch (error) {
      console.error(
        '[yahalla-agent] failed to resume task after tool execution (the reaper will requeue if this stays stuck):',
        error instanceof Error ? error.message : error,
      )
    }
  }

  // Realtime is a low-latency nice-to-have on top of polling, not a
  // replacement for it — Realtime connections can drop silently, so the
  // poll loop is the source of truth for correctness.
  const channel = client
    .channel('yahalla-device-claim')
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'tool_executions' },
      () => {
        void tick()
      },
    )
    .subscribe()

  void tick()
  const interval = setInterval(() => void tick(), POLL_INTERVAL_MS)

  return () => {
    stopped = true
    clearInterval(interval)
    client.removeChannel(channel)
  }
}
