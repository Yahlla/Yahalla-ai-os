import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { DeviceConfig } from './config.js'

export function functionUrl(supabaseUrl: string): string {
  return `${supabaseUrl}/functions/v1/yahalla-ai`
}

export async function callYahalla(
  supabaseUrl: string,
  anonKey: string,
  accessToken: string | null,
  body: Record<string, unknown>,
): Promise<any> {
  const response = await fetch(functionUrl(supabaseUrl), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: anonKey,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: JSON.stringify(body),
  })

  const result = (await response.json()) as any

  if (!response.ok) {
    throw new Error(result?.error || `Yahalla AI returned HTTP ${response.status}`)
  }

  return result
}

/**
 * Redeem a one-time pairing code minted by the Control Center's "Connect
 * this device" flow. Runs before this device has any Supabase session.
 */
export async function exchangePairingCode(
  supabaseUrl: string,
  anonKey: string,
  pairingCode: string,
  deviceName: string,
  devicePlatform: string,
): Promise<{ device_id: string; device_name: string; access_token: string; refresh_token: string }> {
  const result = await callYahalla(supabaseUrl, anonKey, null, {
    device_action: 'device_exchange',
    pairing_code: pairingCode,
    device_name: deviceName,
    device_platform: devicePlatform,
  })

  return result
}

/**
 * A live, auto-refreshing Supabase client for this device's own scoped
 * identity — never the owner's session, never the service role key. RLS
 * (current_device_id() in the device_execution migration) restricts it to
 * only the task/tool_execution rows explicitly assigned to this device.
 */
export async function createDeviceClient(config: DeviceConfig): Promise<SupabaseClient> {
  const client = createClient(config.supabase_url, config.supabase_anon_key, {
    auth: {
      autoRefreshToken: true,
      persistSession: false,
      detectSessionInUrl: false,
    },
  })

  // Bootstrap the session from the persisted refresh token alone (this
  // process never sees the device's original password). Once set, the
  // client's built-in auto-refresh keeps it alive for the life of the
  // process and re-attaches the access token to every request.
  const { error } = await client.auth.refreshSession({
    refresh_token: config.refresh_token,
  })

  if (error) {
    throw new Error(`Failed to establish device session: ${error.message}`)
  }

  return client
}
