import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { after, before, test } from 'node:test'
import { closePool, getPool } from '../src/db.js'
import { createPlatformServer } from '../src/server.js'

const JWT_SECRET = 'test-secret-not-for-production'

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function signTestJwt(sub: string): string {
  const header = base64Url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = base64Url(JSON.stringify({ sub, exp: Math.floor(Date.now() / 1000) + 3600 }))
  const signature = base64Url(createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest())
  return `${header}.${payload}.${signature}`
}

let httpServer: import('node:http').Server
let baseUrl: string
let humanUserId: string
let humanJwt: string

before(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  if (!process.env.DATABASE_URL) throw new Error('TEST_DATABASE_URL must be set to run these tests.')

  humanUserId = randomUUID()
  await getPool().query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [humanUserId, 'owner@test.local'])
  humanJwt = signTestJwt(humanUserId)

  const server = createPlatformServer({ port: 0, supabaseJwtSecret: JWT_SECRET, allowedOrigins: [] })
  httpServer = server
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`
})

after(async () => {
  httpServer.close()
  await closePool()
})

async function api(path: string, init: RequestInit = {}, token?: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  })
  return { status: response.status, body: (await response.json()) as any }
}

test('health check reaches the real database', async () => {
  const { status, body } = await api('/health')
  assert.equal(status, 200)
  assert.equal(body.status, 'ok')
})

test('unauthenticated requests to protected routes are rejected', async () => {
  const { status } = await api('/tasks')
  assert.equal(status, 401)
})

test('a tampered JWT is rejected', async () => {
  const { status } = await api('/tasks', {}, humanJwt.slice(0, -2) + 'xx')
  assert.equal(status, 401)
})

test('a valid Supabase-style JWT authenticates a human and lists their tasks', async () => {
  const { status, body } = await api('/tasks', {}, humanJwt)
  assert.equal(status, 200)
  assert.ok(Array.isArray(body.tasks))
})

let issuedPairingCode: string
let deviceToken: string
let deviceId: string

test('a human can request a device pairing code', async () => {
  const { status, body } = await api('/pair_device', { method: 'POST', body: JSON.stringify({ device_name: 'Test Mac' }) }, humanJwt)
  assert.equal(status, 200)
  assert.ok(body.pairing_code)
  issuedPairingCode = body.pairing_code
})

test('device_exchange redeems the code and mints a device-scoped token, without needing a human JWT', async () => {
  const { status, body } = await api('/device_exchange', {
    method: 'POST',
    body: JSON.stringify({ code: issuedPairingCode, device_name: 'Test Mac', platform: 'macos' }),
  })
  assert.equal(status, 200)
  assert.ok(body.token)
  deviceToken = body.token
  deviceId = body.device_id
})

test('the same pairing code cannot be redeemed twice', async () => {
  const { status, body } = await api('/device_exchange', {
    method: 'POST',
    body: JSON.stringify({ code: issuedPairingCode, device_name: 'Another Mac', platform: 'macos' }),
  })
  assert.equal(status, 500)
  assert.match(body.error, /invalid|used|expired/)
})

test('the paired device can authenticate with its own token (not a JWT) and send a heartbeat', async () => {
  const { status } = await api('/device_heartbeat', { method: 'POST', body: JSON.stringify({ capabilities: { llm: true } }) }, deviceToken)
  assert.equal(status, 200)

  const pool = getPool()
  const { rows } = await pool.query('SELECT status, last_heartbeat_at FROM devices WHERE id = $1', [deviceId])
  assert.equal(rows[0].status, 'online')
  assert.ok(rows[0].last_heartbeat_at)
})

test('the owning human sees the paired device via RLS-scoped query', async () => {
  const { status, body } = await api('/devices', {}, humanJwt)
  assert.equal(status, 200)
  assert.ok(body.devices.some((d: any) => d.id === deviceId))
})

test('a revoked device is rejected on its next request', async () => {
  const pool = getPool()
  await pool.query("UPDATE devices SET status = 'revoked' WHERE id = $1", [deviceId])
  const { status } = await api('/device_heartbeat', { method: 'POST', body: '{}' }, deviceToken)
  assert.equal(status, 401)
})

test('a stranger cannot see another user\'s tasks (RLS isolation)', async () => {
  const strangerId = randomUUID()
  await getPool().query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [strangerId, 'stranger@test.local'])
  const strangerJwt = signTestJwt(strangerId)

  const { status, body } = await api('/devices', {}, strangerJwt)
  assert.equal(status, 200)
  assert.equal(body.devices.length, 0)
})

// humanUserId was the very first row ever inserted into auth.users this
// test run, so the ported handle_new_user() trigger (same one Supabase
// uses) made it the platform's first-ever "owner" -- exactly the admin
// the deployment_proposals RLS policy (is_admin()) requires.
let proposalId: string

test('an admin can propose a deployment (self-evolving agent path)', async () => {
  const { status, body } = await api(
    '/deployments',
    {
      method: 'POST',
      body: JSON.stringify({
        title: 'Fix flaky heartbeat test',
        description: 'Agent-diagnosed timing issue in device heartbeat handling.',
        git_ref: 'agent/fix-heartbeat-flake',
        diff: '--- a/platform/api/src/pairing.ts\n+++ b/platform/api/src/pairing.ts\n@@ -1 +1 @@\n-old\n+new\n',
        proposed_by_agent: 'coding-agent',
      }),
    },
    humanJwt,
  )
  assert.equal(status, 200)
  assert.equal(body.deployment.status, 'pending')
  assert.equal(body.deployment.base_ref, 'main')
  proposalId = body.deployment.id
})

test('a non-admin cannot see deployment proposals (RLS admin-only isolation)', async () => {
  const strangerId = randomUUID()
  await getPool().query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [strangerId, 'stranger2@test.local'])
  const strangerJwt = signTestJwt(strangerId)

  const { status, body } = await api('/deployments', {}, strangerJwt)
  assert.equal(status, 200)
  assert.equal(body.deployments.length, 0)
})

test('the admin sees the pending proposal and approves it with one click', async () => {
  const list = await api('/deployments', {}, humanJwt)
  assert.equal(list.status, 200)
  assert.ok(list.body.deployments.some((d: any) => d.id === proposalId))

  const { status, body } = await api(`/deployments/${proposalId}/decide`, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) }, humanJwt)
  assert.equal(status, 200)
  assert.equal(body.status, 'approved')
})

test('the same proposal cannot be decided twice', async () => {
  const { status, body } = await api(`/deployments/${proposalId}/decide`, { method: 'POST', body: JSON.stringify({ decision: 'reject' }) }, humanJwt)
  assert.equal(status, 409)
  assert.ok(body.error)
})
