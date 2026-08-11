import type { SupabaseClient } from '@supabase/supabase-js'

const HEARTBEAT_INTERVAL_MS = 20_000

/**
 * Heartbeats directly via Postgrest using the device's own scoped session —
 * RLS ("Devices can heartbeat their own row": auth_user_id = auth.uid())
 * guarantees this can only ever touch this device's own row.
 */
export function startHeartbeat(client: SupabaseClient, capabilities: Record<string, unknown>): () => void {
  let stopped = false

  async function beat() {
    if (stopped) return

    const { data: userData, error: userError } = await client.auth.getUser()

    if (userError || !userData.user) {
      console.error('[yahalla-agent] heartbeat: no active session:', userError?.message)
      return
    }

    const { error } = await client
      .from('devices')
      .update({
        status: 'online',
        last_heartbeat_at: new Date().toISOString(),
        capabilities,
        updated_at: new Date().toISOString(),
      })
      .eq('auth_user_id', userData.user.id)

    if (error) {
      console.error('[yahalla-agent] heartbeat failed:', error.message)
    }
  }

  beat()
  const interval = setInterval(beat, HEARTBEAT_INTERVAL_MS)

  return () => {
    stopped = true
    clearInterval(interval)
  }
}
