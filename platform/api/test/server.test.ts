import assert from 'node:assert/strict'
import { createHmac, randomUUID } from 'node:crypto'
import { createServer as createFakeHttpServer } from 'node:http'
import { after, before, test } from 'node:test'
import { closePool, getPool } from '../src/db.js'
import { createPlatformServer } from '../src/server.js'

const JWT_SECRET = 'test-secret-not-for-production'

function base64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// A 384-length vector with a single distinct component -- enough to make
// cosine-similarity ordering fully predictable in tests without needing a
// real embedding model.
function makeEmbedding(primaryIndex: number, magnitude = 1): number[] {
  const v = Array.from({ length: 384 }, () => 0)
  v[primaryIndex] = magnitude
  return v
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

// A second server instance with the cloud tier configured against a fake
// upstream (standing in for Groq's OpenAI-compatible API), the same
// fake-HTTP-server pattern used throughout this repo instead of a mocking
// library -- real HTTP, real JSON parsing, real error paths.
let cloudTierServer: import('node:http').Server
let cloudTierBaseUrl: string
let fakeUpstream: import('node:http').Server
let fakeUpstreamPort: number
let fakeUpstreamBehavior: 'ok' | 'upstream-error' = 'ok'

// A third server instance with the GitHub webhook secret configured --
// separate from httpServer (which intentionally has none, to prove the
// endpoint stays disabled without one) the same way cloudTierServer is
// separate from the plain one above.
const WEBHOOK_SECRET = 'test-webhook-secret'
let webhookServer: import('node:http').Server
let webhookBaseUrl: string

before(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  if (!process.env.DATABASE_URL) throw new Error('TEST_DATABASE_URL must be set to run these tests.')

  humanUserId = randomUUID()
  await getPool().query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [humanUserId, 'owner@test.local'])
  humanJwt = signTestJwt(humanUserId)

  const server = createPlatformServer({ port: 0, supabaseJwtSecret: JWT_SECRET, allowedOrigins: [], cloudTier: null })
  httpServer = server
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`

  fakeUpstream = createFakeHttpServer(async (req, res) => {
    if (fakeUpstreamBehavior === 'upstream-error') {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'invalid_api_key' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'fake 70B reply' } }] }))
  })
  await new Promise<void>((resolve) => fakeUpstream.listen(0, '127.0.0.1', () => resolve()))
  const upstreamAddress = fakeUpstream.address()
  const upstreamPort = typeof upstreamAddress === 'object' && upstreamAddress ? upstreamAddress.port : 0
  fakeUpstreamPort = upstreamPort

  const cloudServer = createPlatformServer({
    port: 0,
    supabaseJwtSecret: JWT_SECRET,
    allowedOrigins: [],
    cloudTier: { provider: 'openai', url: `http://127.0.0.1:${upstreamPort}`, model: 'fake-70b', apiKey: 'fake-key' },
  })
  cloudTierServer = cloudServer
  await new Promise<void>((resolve) => cloudTierServer.listen(0, '127.0.0.1', () => resolve()))
  const cloudAddress = cloudTierServer.address()
  const cloudPort = typeof cloudAddress === 'object' && cloudAddress ? cloudAddress.port : 0
  cloudTierBaseUrl = `http://127.0.0.1:${cloudPort}`

  const webhookSrv = createPlatformServer({ port: 0, supabaseJwtSecret: JWT_SECRET, allowedOrigins: [], cloudTier: null, githubWebhookSecret: WEBHOOK_SECRET })
  webhookServer = webhookSrv
  await new Promise<void>((resolve) => webhookServer.listen(0, '127.0.0.1', () => resolve()))
  const webhookAddress = webhookServer.address()
  const webhookPort = typeof webhookAddress === 'object' && webhookAddress ? webhookAddress.port : 0
  webhookBaseUrl = `http://127.0.0.1:${webhookPort}`
})

after(async () => {
  httpServer.close()
  cloudTierServer.close()
  fakeUpstream.close()
  webhookServer.close()
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

// Real device task dispatch, while the device from above is still
// 'online' (the next test after this block revokes it).

let dispatchedTaskId: string

test('a human creates a task and it auto-assigns to their one online device', async () => {
  const { status, body } = await api('/tasks', { method: 'POST', body: JSON.stringify({ title: 'Fix the bug', description: 'in App.tsx' }) }, humanJwt)
  assert.equal(status, 200)
  assert.equal(body.success, true)
  assert.equal(body.task.status, 'queued')
  assert.equal(body.task.assigned_device, deviceId)
  dispatchedTaskId = body.task.id
})

test('a device (not a human) cannot create a task', async () => {
  const { status, body } = await api('/tasks', { method: 'POST', body: JSON.stringify({ title: 'nope' }) }, deviceToken)
  assert.equal(status, 403)
  assert.match(body.error, /human/)
})

test('a human (not a device) cannot claim the next task', async () => {
  const { status, body } = await api('/tasks/next', {}, humanJwt)
  assert.equal(status, 403)
  assert.match(body.error, /device/)
})

test('the paired device polls and atomically claims the queued task', async () => {
  const { status, body } = await api('/tasks/next', {}, deviceToken)
  assert.equal(status, 200)
  assert.ok(body.task)
  assert.equal(body.task.id, dispatchedTaskId)
  assert.equal(body.task.status, 'running')
})

test('polling again finds nothing left to claim (already running, not queued)', async () => {
  const { status, body } = await api('/tasks/next', {}, deviceToken)
  assert.equal(status, 200)
  assert.equal(body.task, null)
})

test('the device reports the task complete with real output', async () => {
  const { status, body } = await api(
    `/tasks/${dispatchedTaskId}/complete`,
    { method: 'POST', body: JSON.stringify({ status: 'completed', output: { summary: 'Fixed it.' } }) },
    deviceToken,
  )
  assert.equal(status, 200)
  assert.equal(body.task.status, 'completed')
  assert.equal(body.task.output.summary, 'Fixed it.')
  assert.ok(body.task.completed_at)
})

test('the requesting human sees the completed task with its output', async () => {
  const { status, body } = await api('/tasks', {}, humanJwt)
  assert.equal(status, 200)
  const task = body.tasks.find((t: any) => t.id === dispatchedTaskId)
  assert.equal(task.status, 'completed')
  assert.equal(task.output.summary, 'Fixed it.')
})

test('the requesting human can poll a single task by id (GET /tasks/:id) until it completes', async () => {
  const { status, body } = await api(`/tasks/${dispatchedTaskId}`, {}, humanJwt)
  assert.equal(status, 200)
  assert.equal(body.success, true)
  assert.equal(body.task.id, dispatchedTaskId)
  assert.equal(body.task.status, 'completed')
  assert.equal(body.task.output.summary, 'Fixed it.')
})

test('a stranger cannot poll another user\'s task by id (RLS: requested_by isolation)', async () => {
  const strangerId = randomUUID()
  await getPool().query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [strangerId, 'task-snooper@test.local'])
  const strangerJwt = signTestJwt(strangerId)

  const { status, body } = await api(`/tasks/${dispatchedTaskId}`, {}, strangerJwt)
  assert.equal(status, 404)
  assert.match(body.error, /not found/i)
})

test('polling a nonexistent task id returns 404', async () => {
  const { status } = await api(`/tasks/${randomUUID()}`, {}, humanJwt)
  assert.equal(status, 404)
})

test('creating a task with no paired online device gives a clear error, not a silent stuck task', async () => {
  const strangerId = randomUUID()
  await getPool().query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [strangerId, 'no-device@test.local'])
  const strangerJwt = signTestJwt(strangerId)

  const { status, body } = await api('/tasks', { method: 'POST', body: JSON.stringify({ title: 'orphan task' }) }, strangerJwt)
  assert.equal(status, 409)
  assert.match(body.error, /No paired, online device/)
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

// The server under test (created in before(), above) was constructed
// without a custom githubRepo, so it falls back to the project's own
// default ('Yahlla/Yahalla-ai-os') -- the fake GitHub server below has to
// answer for that exact repo path to be reached at all.
async function withFakeGithub(
  handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void,
  run: () => Promise<void>,
): Promise<void> {
  const fakeGithub = createFakeHttpServer(handler)
  await new Promise<void>((resolve) => fakeGithub.listen(0, '127.0.0.1', () => resolve()))
  const address = fakeGithub.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const previous = process.env.GITHUB_API_BASE_URL
  process.env.GITHUB_API_BASE_URL = `http://127.0.0.1:${port}`
  try {
    await run()
  } finally {
    if (previous === undefined) delete process.env.GITHUB_API_BASE_URL
    else process.env.GITHUB_API_BASE_URL = previous
    fakeGithub.close()
  }
}

test('propose_latest fetches the real latest commit from GitHub and proposes it (no prior deployment to diff against yet)', async () => {
  await withFakeGithub(
    (req, res) => {
      if (req.url === '/repos/Yahlla/Yahalla-ai-os/commits/main') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ sha: 'abc123deadbeef0000000000000000000000000', commit: { message: 'Fix the thing' } }))
        return
      }
      res.writeHead(404)
      res.end()
    },
    async () => {
      const { status, body } = await api('/deployments/propose_latest', { method: 'POST' }, humanJwt)
      assert.equal(status, 200)
      assert.equal(body.success, true)
      assert.equal(body.deployment.git_ref, 'abc123deadbeef0000000000000000000000000')
      assert.match(body.deployment.title, /abc123d/)
      assert.equal(body.deployment.description, 'Fix the thing')
      assert.match(body.deployment.diff, /No prior deployment on record/)
      assert.equal(body.deployment.status, 'pending')
    },
  )
})

test('propose_latest fetches a real diff against the last deployed commit when one exists', async () => {
  await getPool().query(
    "INSERT INTO deployment_proposals (title, git_ref, base_ref, diff, status, proposed_by, deployed_at) VALUES ('prior', 'sha-old', 'main', 'x', 'deployed', $1, now())",
    [humanUserId],
  )

  await withFakeGithub(
    (req, res) => {
      if (req.url === '/repos/Yahlla/Yahalla-ai-os/commits/main') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ sha: 'sha-new', commit: { message: 'Second commit' } }))
        return
      }
      if (req.url === '/repos/Yahlla/Yahalla-ai-os/compare/sha-old...sha-new') {
        res.writeHead(200, { 'Content-Type': 'text/plain' })
        res.end('--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new\n')
        return
      }
      res.writeHead(404)
      res.end()
    },
    async () => {
      const { status, body } = await api('/deployments/propose_latest', { method: 'POST' }, humanJwt)
      assert.equal(status, 200)
      assert.equal(body.deployment.base_ref, 'sha-old')
      assert.equal(body.deployment.git_ref, 'sha-new')
      assert.match(body.deployment.diff, /-old\n\+new/)
    },
  )
})

test('propose_latest reports up-to-date instead of a pointless duplicate proposal', async () => {
  await getPool().query(
    "INSERT INTO deployment_proposals (title, git_ref, base_ref, diff, status, proposed_by, deployed_at) VALUES ('prior2', 'sha-current', 'main', 'x', 'deployed', $1, now())",
    [humanUserId],
  )

  await withFakeGithub(
    (req, res) => {
      if (req.url === '/repos/Yahlla/Yahalla-ai-os/commits/main') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ sha: 'sha-current', commit: { message: 'Nothing new' } }))
        return
      }
      res.writeHead(404)
      res.end()
    },
    async () => {
      const { status, body } = await api('/deployments/propose_latest', { method: 'POST' }, humanJwt)
      assert.equal(status, 200)
      assert.equal(body.up_to_date, true)
    },
  )
})

test('propose_latest surfaces a clean error when GitHub is unreachable, instead of a crash', async () => {
  await withFakeGithub(
    (_req, res) => {
      res.writeHead(500)
      res.end()
    },
    async () => {
      const { status, body } = await api('/deployments/propose_latest', { method: 'POST' }, humanJwt)
      assert.equal(status, 502)
      assert.match(body.error, /Could not reach GitHub/)
    },
  )
})

test('a device (not a human) cannot propose a deployment', async () => {
  // deviceToken (from earlier in this file) was revoked by the "a revoked
  // device is rejected" test above, so a fresh device is paired here to
  // test the identity.kind check specifically, not revocation.
  const pairing = await api('/pair_device', { method: 'POST', body: JSON.stringify({ device_name: 'Second Device' }) }, humanJwt)
  const exchange = await api('/device_exchange', { method: 'POST', body: JSON.stringify({ code: pairing.body.pairing_code, device_name: 'Second Device' }) })
  const freshDeviceToken = exchange.body.token as string

  const { status, body } = await api('/deployments/propose_latest', { method: 'POST' }, freshDeviceToken)
  assert.equal(status, 403)
  assert.match(body.error, /human/)
})

test('a brand-new human (no pre-existing auth.users row) is auto-provisioned on first request', async () => {
  const freshUserId = randomUUID()
  const freshJwt = signTestJwt(freshUserId)

  const { status, body } = await api('/tasks', {}, freshJwt)
  assert.equal(status, 200)
  assert.ok(Array.isArray(body.tasks))

  const { rows } = await getPool().query('SELECT id FROM auth.users WHERE id = $1', [freshUserId])
  assert.equal(rows.length, 1)
})

// Vector DB core: the embedding is computed by the caller (browser/
// local-runtime), never by platform-api itself -- these tests send
// synthetic 384-dim vectors, not real embeddings, since the point here is
// verifying storage/search/RLS behave correctly, not embedding quality.
test('storing a memory entry rejects a wrong-length embedding', async () => {
  const { status, body } = await api('/memory', { method: 'POST', body: JSON.stringify({ content: 'x', embedding: [1, 2, 3] }) }, humanJwt)
  assert.equal(status, 400)
  assert.match(body.error, /384/)
})

test('a human can store a memory entry with a valid embedding', async () => {
  const { status, body } = await api(
    '/memory',
    { method: 'POST', body: JSON.stringify({ content: 'remember this', embedding: makeEmbedding(0), source: 'agent' }) },
    humanJwt,
  )
  assert.equal(status, 200)
  assert.equal(body.entry.content, 'remember this')
  assert.equal(body.entry.source, 'agent')
})

test('semantic search ranks the closest embedding first, by real cosine distance', async () => {
  await api('/memory', { method: 'POST', body: JSON.stringify({ content: 'about apples', embedding: makeEmbedding(10) }) }, humanJwt)
  await api('/memory', { method: 'POST', body: JSON.stringify({ content: 'about oranges', embedding: makeEmbedding(50) }) }, humanJwt)

  const { status, body } = await api('/memory/search', { method: 'POST', body: JSON.stringify({ embedding: makeEmbedding(10), limit: 5 }) }, humanJwt)
  assert.equal(status, 200)
  assert.ok(body.results.length >= 1)
  assert.equal(body.results[0].content, 'about apples')
  assert.ok(body.results[0].similarity > 0.99, `expected near-1.0 similarity for an exact match, got ${body.results[0].similarity}`)
})

test('a stranger cannot see or search another user\'s memory entries (RLS isolation)', async () => {
  const strangerId = randomUUID()
  await getPool().query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [strangerId, 'memory-stranger@test.local'])
  const strangerJwt = signTestJwt(strangerId)

  const list = await api('/memory', {}, strangerJwt)
  assert.equal(list.status, 200)
  assert.equal(list.body.entries.length, 0)

  const search = await api('/memory/search', { method: 'POST', body: JSON.stringify({ embedding: makeEmbedding(10) }) }, strangerJwt)
  assert.equal(search.status, 200)
  assert.equal(search.body.results.length, 0)
})

// Conversation persistence: chat history survives a reload or a different
// device signing into the same account, backed by the existing
// conversations/conversation_messages tables and their RLS policies.
let conversationId: string

test('a human can create a conversation', async () => {
  const { status, body } = await api('/conversations', { method: 'POST', body: JSON.stringify({ title: 'Test chat' }) }, humanJwt)
  assert.equal(status, 200)
  assert.equal(body.conversation.title, 'Test chat')
  assert.equal(body.conversation.owner_id, humanUserId)
  conversationId = body.conversation.id
})

test('the owner sees the new conversation in their list', async () => {
  const { status, body } = await api('/conversations', {}, humanJwt)
  assert.equal(status, 200)
  assert.ok(body.conversations.some((c: any) => c.id === conversationId))
})

test('messages can be appended and are returned in order', async () => {
  const first = await api(`/conversations/${conversationId}/messages`, { method: 'POST', body: JSON.stringify({ role: 'user', content: 'hello' }) }, humanJwt)
  assert.equal(first.status, 200)
  assert.equal(first.body.message.role, 'user')

  const second = await api(
    `/conversations/${conversationId}/messages`,
    { method: 'POST', body: JSON.stringify({ role: 'assistant', content: 'hi there', tool_activity: [{ tool: 'noop', result: {} }] }) },
    humanJwt,
  )
  assert.equal(second.status, 200)

  const list = await api(`/conversations/${conversationId}/messages`, {}, humanJwt)
  assert.equal(list.status, 200)
  assert.equal(list.body.messages.length, 2)
  assert.equal(list.body.messages[0].content, 'hello')
  assert.equal(list.body.messages[1].content, 'hi there')
})

test('appending a message also bumps the conversation\'s updated_at', async () => {
  const before = await api('/conversations', {}, humanJwt)
  const beforeUpdatedAt = before.body.conversations.find((c: any) => c.id === conversationId).updated_at

  await new Promise((r) => setTimeout(r, 10))
  await api(`/conversations/${conversationId}/messages`, { method: 'POST', body: JSON.stringify({ role: 'user', content: 'again' }) }, humanJwt)

  const after = await api('/conversations', {}, humanJwt)
  const afterUpdatedAt = after.body.conversations.find((c: any) => c.id === conversationId).updated_at
  assert.ok(new Date(afterUpdatedAt) > new Date(beforeUpdatedAt))
})

test('a stranger cannot append to or list someone else\'s conversation (RLS isolation)', async () => {
  const strangerId = randomUUID()
  await getPool().query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [strangerId, 'convo-stranger@test.local'])
  const strangerJwt = signTestJwt(strangerId)

  const post = await api(`/conversations/${conversationId}/messages`, { method: 'POST', body: JSON.stringify({ role: 'user', content: 'nope' }) }, strangerJwt)
  assert.equal(post.status, 404)

  const list = await api(`/conversations/${conversationId}/messages`, {}, strangerJwt)
  assert.equal(list.status, 200)
  assert.equal(list.body.messages.length, 0)

  const conversations = await api('/conversations', {}, strangerJwt)
  assert.equal(conversations.status, 200)
  assert.equal(conversations.body.conversations.some((c: any) => c.id === conversationId), false)
})

test('posting a message with an invalid role is rejected', async () => {
  const { status, body } = await api(`/conversations/${conversationId}/messages`, { method: 'POST', body: JSON.stringify({ role: 'villain', content: 'x' }) }, humanJwt)
  assert.equal(status, 400)
  assert.match(body.error, /role/)
})

// Cloud smart tier: off-by-default against the main server, on against a
// second server instance pointed at a fake upstream (see `before` above).

test('cloud smart tier is 503 when not configured on this deployment', async () => {
  const { status, body } = await api('/smart-tier/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) }, humanJwt)
  assert.equal(status, 503)
  assert.match(body.error, /not configured/)
})

async function cloudApi(path: string, init: RequestInit, token: string): Promise<{ status: number; body: any }> {
  const response = await fetch(`${cloudTierBaseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}`, ...init.headers },
  })
  return { status: response.status, body: await response.json() }
}

test('cloud smart tier requires authentication like every other route', async () => {
  const response = await fetch(`${cloudTierBaseUrl}/smart-tier/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(response.status, 401)
})

test('cloud smart tier forwards to the configured upstream and returns its reply', async () => {
  fakeUpstreamBehavior = 'ok'
  const { status, body } = await cloudApi('/smart-tier/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) }, humanJwt)
  assert.equal(status, 200)
  assert.equal(body.success, true)
  assert.equal(body.content, 'fake 70B reply')
  assert.equal(body.model, 'fake-70b')
})

test('cloud smart tier surfaces an upstream auth failure as a clean error, not a crash', async () => {
  fakeUpstreamBehavior = 'upstream-error'
  const { status, body } = await cloudApi('/smart-tier/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) }, humanJwt)
  fakeUpstreamBehavior = 'ok'
  assert.equal(status, 502)
  assert.equal(body.success, false)
  assert.match(body.error, /HTTP 401/)
})

test('cloud smart tier rejects a malformed messages array', async () => {
  const { status, body } = await cloudApi('/smart-tier/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user' }] }) }, humanJwt)
  assert.equal(status, 400)
  assert.match(body.error, /messages/)
})

// Zero-terminal settings: the admin configures the cloud tier's API key
// from the Control Center (POST /settings/cloud-tier), not by editing
// platform/.env by hand -- and it takes effect on the very next chat
// message, no restart. Run against the plain `httpServer` (statically
// configured with cloudTier: null) specifically to prove the database is
// what turns the feature on, not the env var.

test('cloud tier settings start out not configured', async () => {
  const { status, body } = await api('/settings/cloud-tier', {}, humanJwt)
  assert.equal(status, 200)
  assert.equal(body.configured, false)
})

test('a non-admin cannot save platform settings', async () => {
  const strangerId = randomUUID()
  await getPool().query('INSERT INTO auth.users (id, email) VALUES ($1, $2)', [strangerId, 'settings-stranger@test.local'])
  const strangerJwt = signTestJwt(strangerId)

  const { status, body } = await api('/settings/cloud-tier', { method: 'POST', body: JSON.stringify({ api_key: 'nope' }) }, strangerJwt)
  assert.equal(status, 403)
  assert.match(body.error, /admin/)
})

test('an admin saves a cloud-tier key from the settings API and it works immediately, no restart', async () => {
  fakeUpstreamBehavior = 'ok'

  const save = await api(
    '/settings/cloud-tier',
    { method: 'POST', body: JSON.stringify({ api_key: 'db-stored-key', url: `http://127.0.0.1:${fakeUpstreamPort}`, model: 'db-model' }) },
    humanJwt,
  )
  assert.equal(save.status, 200)
  assert.equal(save.body.success, true)

  const status = await api('/settings/cloud-tier', {}, humanJwt)
  assert.equal(status.body.configured, true)
  assert.equal(status.body.model, 'db-model')

  // The plain httpServer was created with cloudTier: null -- this only
  // works at all because resolveCloudTierConfig reads the database.
  const chat = await api('/smart-tier/chat', { method: 'POST', body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }) }, humanJwt)
  assert.equal(chat.status, 200)
  assert.equal(chat.body.content, 'fake 70B reply')
  assert.equal(chat.body.model, 'db-model')
})

// GitHub push webhook: the permanent replacement for manually clicking
// "Ship latest main" -- once configured, every push to main auto-creates a
// pending proposal on its own (still requiring the normal human Approve &
// Ship click, same as every other proposal). Uses raw fetch (not the api()
// helper, which always JSON-stringifies) since the signature is computed
// over the exact raw bytes GitHub would send.

function pushPayload(ref: string): Buffer {
  return Buffer.from(JSON.stringify({ ref, head_commit: { id: 'sha-webhook', message: 'Webhook-triggered commit' } }))
}

function signWebhookPayload(payload: Buffer, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`
}

async function webhookApi(base: string, body: Buffer, headers: Record<string, string>): Promise<{ status: number; body: any }> {
  const response = await fetch(`${base}/webhooks/github`, { method: 'POST', body, headers })
  return { status: response.status, body: (await response.json()) as any }
}

test('the webhook endpoint is disabled (404) on a server with no secret configured', async () => {
  const payload = pushPayload('refs/heads/main')
  const { status } = await webhookApi(baseUrl, payload, {
    'Content-Type': 'application/json',
    'X-GitHub-Event': 'push',
    'X-Hub-Signature-256': signWebhookPayload(payload, 'irrelevant'),
  })
  assert.equal(status, 404)
})

test('a push to main with a valid signature auto-creates a pending proposal, attributed to the webhook not a human', async () => {
  await withFakeGithub(
    (req, res) => {
      if (req.url === '/repos/Yahlla/Yahalla-ai-os/commits/main') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ sha: 'sha-webhook-push', commit: { message: 'Webhook-triggered commit' } }))
        return
      }
      res.writeHead(404)
      res.end()
    },
    async () => {
      const payload = pushPayload('refs/heads/main')
      const { status, body } = await webhookApi(webhookBaseUrl, payload, {
        'Content-Type': 'application/json',
        'X-GitHub-Event': 'push',
        'X-Hub-Signature-256': signWebhookPayload(payload, WEBHOOK_SECRET),
      })
      assert.equal(status, 200)
      assert.equal(body.success, true)
      assert.equal(body.outcome, 'proposed')
      assert.equal(body.deployment.git_ref, 'sha-webhook-push')
      assert.equal(body.deployment.status, 'pending')
      assert.equal(body.deployment.proposed_by, null)
      assert.equal(body.deployment.proposed_by_agent, 'github-webhook')
    },
  )
})

test('a push webhook with an invalid signature is rejected', async () => {
  const payload = pushPayload('refs/heads/main')
  const { status, body } = await webhookApi(webhookBaseUrl, payload, {
    'Content-Type': 'application/json',
    'X-GitHub-Event': 'push',
    'X-Hub-Signature-256': signWebhookPayload(payload, 'wrong-secret'),
  })
  assert.equal(status, 401)
  assert.match(body.error, /signature/)
})

test('a push webhook with no signature header at all is rejected', async () => {
  const payload = pushPayload('refs/heads/main')
  const { status } = await webhookApi(webhookBaseUrl, payload, { 'Content-Type': 'application/json', 'X-GitHub-Event': 'push' })
  assert.equal(status, 401)
})

test('a push to a branch other than main is ignored, not proposed', async () => {
  const payload = pushPayload('refs/heads/feature-branch')
  const { status, body } = await webhookApi(webhookBaseUrl, payload, {
    'Content-Type': 'application/json',
    'X-GitHub-Event': 'push',
    'X-Hub-Signature-256': signWebhookPayload(payload, WEBHOOK_SECRET),
  })
  assert.equal(status, 200)
  assert.equal(body.ignored, true)
})
