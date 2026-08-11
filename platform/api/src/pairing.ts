import { createHash, randomBytes, randomUUID } from 'node:crypto'
import type pg from 'pg'
import { withServiceRole } from './db.js'

function generatePairingCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = randomBytes(8)
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('')
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export async function createPairingCode(ownerId: string, deviceNameHint?: string): Promise<{ code: string; expiresAt: string }> {
  const code = generatePairingCode()
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString()

  await withServiceRole(async (client) => {
    await client.query(
      'INSERT INTO device_pairing_codes (id, owner_id, code, device_name_hint, expires_at) VALUES ($1, $2, $3, $4, $5)',
      [randomUUID(), ownerId, code, deviceNameHint ?? null, expiresAt],
    )
  })

  return { code, expiresAt }
}

export type DeviceExchangeResult = {
  deviceId: string
  deviceName: string
  token: string
}

export async function exchangePairingCode(
  code: string,
  deviceName: string,
  platform: string,
): Promise<DeviceExchangeResult> {
  return withServiceRole(async (client) => {
    const { rows } = await client.query<{ id: string; owner_id: string; device_name_hint: string | null }>(
      'SELECT id, owner_id, device_name_hint FROM device_pairing_codes WHERE code = $1 AND consumed_at IS NULL AND expires_at > now()',
      [code],
    )
    const pairing = rows[0]
    if (!pairing) throw new Error('Pairing code is invalid, already used, or expired.')

    const authUserId = randomUUID()
    await client.query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [authUserId, `device-${authUserId}@local.invalid`])

    const token = randomBytes(32).toString('hex')
    const deviceId = randomUUID()
    const resolvedName = deviceName || pairing.device_name_hint || `device-${deviceId.slice(0, 8)}`

    await client.query(
      `INSERT INTO devices (id, owner_id, auth_user_id, name, platform, status, token_hash, paired_at, last_heartbeat_at)
       VALUES ($1, $2, $3, $4, $5, 'online', $6, now(), now())`,
      [deviceId, pairing.owner_id, authUserId, resolvedName, platform, hashToken(token)],
    )

    await client.query('UPDATE device_pairing_codes SET consumed_at = now(), device_id = $1 WHERE id = $2', [
      deviceId,
      pairing.id,
    ])

    return { deviceId, deviceName: resolvedName, token }
  })
}

export type AuthenticatedDevice = { deviceId: string; authUserId: string; ownerId: string }

export async function authenticateDevice(token: string): Promise<AuthenticatedDevice | null> {
  return withServiceRole(async (client) => {
    const { rows } = await client.query<{ id: string; auth_user_id: string; owner_id: string }>(
      "SELECT id, auth_user_id, owner_id FROM devices WHERE token_hash = $1 AND status <> 'revoked'",
      [hashToken(token)],
    )
    const device = rows[0]
    return device ? { deviceId: device.id, authUserId: device.auth_user_id, ownerId: device.owner_id } : null
  })
}

export async function recordHeartbeat(client: pg.PoolClient, deviceId: string, capabilities?: Record<string, unknown>): Promise<void> {
  await client.query(
    "UPDATE devices SET status = 'online', last_heartbeat_at = now(), capabilities = COALESCE($2, capabilities), updated_at = now() WHERE id = $1",
    [deviceId, capabilities ? JSON.stringify(capabilities) : null],
  )
}
