import assert from 'node:assert/strict'
import { createServer as createFakeHttpServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { ctxFrom, createHttpServer } from '../src/server.js'
import type { RuntimeConfig } from '../src/config.js'
import type { Db } from '../src/db.js'
import { openDb } from '../src/db.js'
import { grantPermission } from '../src/permissions.js'
import { LocalModelProcess } from '../src/llm.js'
import { EmbodimentStateMachine } from '../src/embodiment/stateMachine.js'
import { PerceptionManager } from '../src/perception/manager.js'
import { startTaskPoller } from '../src/taskPoller.js'
import { pairDevice } from '../src/devicePairing.js'

// A fake OpenAI-compatible local LLM: a message containing "create a repo"
// asks for github.write (the one GitHub action still gated behind
// approval, see tools.ts) on round 1; any other message answers directly
// with no tool call.
function startFakeLlm(port: number): Promise<Server> {
  const server = createFakeHttpServer(async (req, res) => {
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const lastUser = [...body.messages].reverse().find((m: any) => m.role === 'user')
      const hasToolResult = body.messages.some((m: any) => m.role === 'tool')
      res.writeHead(200, { 'Content-Type': 'application/json' })

      if (hasToolResult) {
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Done.' } }] }))
        return
      }
      if (String(lastUser?.content ?? '').includes('create a repo')) {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    { id: 'call_1', type: 'function', function: { name: 'github.write', arguments: JSON.stringify({ operation: 'create_repo', name: 'new-project' }) } },
                  ],
                },
              },
            ],
          }),
        )
        return
      }
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'The answer is 4.' } }] }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

// Stands in for api.github.com, just for the github.write(create_repo)
// approval-gate test.
function startFakeGithub(port: number): Promise<Server> {
  const server = createFakeHttpServer(async (req, res) => {
    if (req.url === '/user/repos' && req.method === 'POST') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ name: 'new-project', full_name: 'octo-owner/new-project', private: true, html_url: 'https://github.com/octo-owner/new-project' }))
      return
    }
    res.writeHead(404)
    res.end()
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

type FakePlatformApi = {
  server: Server
  completes: Array<{ taskId: string; status?: string; output?: unknown; error?: unknown }>
  heartbeats: number
  setNextTask: (task: Record<string, unknown> | null) => void
}

function startFakePlatformApi(port: number, opts: { expectedCode: string; deviceToken: string }): Promise<FakePlatformApi> {
  let nextTask: Record<string, unknown> | null = null
  const state: FakePlatformApi = {
    server: undefined as unknown as Server,
    completes: [],
    heartbeats: 0,
    setNextTask: (task) => {
      nextTask = task
    },
  }

  const server = createFakeHttpServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const readBody = async () => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const text = Buffer.concat(chunks).toString('utf8')
      return text ? JSON.parse(text) : {}
    }

    if (req.url === '/device_exchange' && req.method === 'POST') {
      const body = await readBody()
      if (body.code !== opts.expectedCode) return send(400, { success: false, error: 'Invalid or expired pairing code.' })
      return send(200, { success: true, device_id: 'device-1', device_name: body.device_name, token: opts.deviceToken })
    }

    if (req.headers.authorization !== `Bearer ${opts.deviceToken}`) {
      return send(401, { success: false, error: 'unauthorized' })
    }

    if (req.url === '/device_heartbeat' && req.method === 'POST') {
      state.heartbeats++
      return send(200, { success: true })
    }
    if (req.url === '/tasks/next' && req.method === 'GET') {
      const task = nextTask
      nextTask = null
      return send(200, { task })
    }
    const completeMatch = req.url?.match(/^\/tasks\/([^/]+)\/complete$/)
    if (completeMatch && req.method === 'POST') {
      const body = await readBody()
      state.completes.push({ taskId: completeMatch[1]!, ...body })
      return send(200, { success: true, task: { id: completeMatch[1] } })
    }
    send(404, { success: false, error: 'no route' })
  })
  state.server = server
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(state)))
}

let projectDir: string
let dataRootDir: string
let db: Db
let fakeLlm: Server
let modelProcess: LocalModelProcess

// This is the only test file in the suite that calls the real
// /device/pair and /device/unpair HTTP endpoints (see the last test
// below), and those endpoints call the real saveConfig() (server.ts),
// which -- confirmed by a real report from an actual dev machine, not a
// hypothetical -- writes straight to the production
// ~/.yahalla/runtime/config.json with zero test isolation, since
// paths.ts's dataRoot() used to be a module-level constant computed once
// at import time with no way for a test to redirect it. Pointing
// YAHALLA_DATA_ROOT_OVERRIDE at an isolated temp directory for the
// duration of this file only is what actually stops this suite from ever
// touching a real user's real runtime state again.
before(() => {
  dataRootDir = mkdtempSync(join(tmpdir(), 'yahalla-runtime-data-root-test-'))
  process.env.YAHALLA_DATA_ROOT_OVERRIDE = dataRootDir
  projectDir = mkdtempSync(join(tmpdir(), 'yahalla-runtime-dispatch-test-'))
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))
  db = openDb(':memory:')
  grantPermission(db, 'project', projectDir, 'write')
})

after(() => {
  delete process.env.YAHALLA_DATA_ROOT_OVERRIDE
  rmSync(projectDir, { recursive: true, force: true })
  rmSync(dataRootDir, { recursive: true, force: true })
})

function buildCtx(dbInstance: Db, llmPort: number) {
  modelProcess = new LocalModelProcess(llmPort)
  ;(modelProcess as any).child = { exitCode: null, killed: false }
  const config: RuntimeConfig = { port: 0, authToken: 'tok', projectRoot: projectDir, allowedOrigins: [] }
  const embodiment = new EmbodimentStateMachine()
  const perception = new PerceptionManager(dbInstance)
  return ctxFrom({ db: dbInstance, config, modelProcess }, embodiment, perception)
}

test('pairDevice exchanges a valid code for a device token', async () => {
  fakeLlm = await startFakeLlm(18091)
  const platformApi = await startFakePlatformApi(18092, { expectedCode: 'GOOD-CODE', deviceToken: 'device-token-1' })
  try {
    const result = await pairDevice('http://127.0.0.1:18092', 'GOOD-CODE', 'Test Laptop')
    assert.equal(result.deviceId, 'device-1')
    assert.equal(result.token, 'device-token-1')
  } finally {
    platformApi.server.close()
    fakeLlm.close()
  }
})

test('pairDevice surfaces the server error for an invalid code', async () => {
  const platformApi = await startFakePlatformApi(18093, { expectedCode: 'GOOD-CODE', deviceToken: 'device-token-1' })
  try {
    await assert.rejects(() => pairDevice('http://127.0.0.1:18093', 'WRONG-CODE', 'Test Laptop'), /Invalid or expired/)
  } finally {
    platformApi.server.close()
  }
})

test('a device with no platform_api_url/device_token configured never calls out', async () => {
  const dbInstance = openDb(':memory:')
  const ctx = buildCtx(dbInstance, 18094)
  const config: RuntimeConfig = { port: 0, authToken: 'tok', projectRoot: projectDir, allowedOrigins: [] }
  const stop = startTaskPoller(ctx, config, { pollIntervalMs: 20 })
  await new Promise((r) => setTimeout(r, 60))
  stop()
  // No assertion target needed beyond "did not throw" -- there is no fake
  // server listening at all, so any outbound fetch would reject/hang.
})

test('the poller claims a queued task, runs it through the real agent loop, and reports completion', async () => {
  const dbInstance = openDb(':memory:')
  fakeLlm = await startFakeLlm(18095)
  const platformApi = await startFakePlatformApi(18096, { expectedCode: 'CODE2', deviceToken: 'device-token-2' })
  try {
    const ctx = buildCtx(dbInstance, 18095)
    const config: RuntimeConfig = {
      port: 0,
      authToken: 'tok',
      projectRoot: projectDir,
      allowedOrigins: [],
      platformApiUrl: 'http://127.0.0.1:18096',
      deviceToken: 'device-token-2',
    }
    platformApi.setNextTask({ id: 'task-abc', title: 'What is 2+2?', description: null })

    const stop = startTaskPoller(ctx, config, { pollIntervalMs: 20, heartbeatIntervalMs: 20 })
    try {
      await waitFor(() => platformApi.completes.length > 0, 2000)
    } finally {
      stop()
    }

    assert.equal(platformApi.completes.length, 1)
    assert.equal(platformApi.completes[0]!.taskId, 'task-abc')
    assert.equal(platformApi.completes[0]!.status, 'completed')
    assert.match(String((platformApi.completes[0]!.output as any)?.answer ?? ''), /answer is 4/)
    assert.ok(platformApi.heartbeats > 0, 'expected at least one heartbeat to have been sent')
  } finally {
    platformApi.server.close()
    fakeLlm.close()
  }
})

test('a task that hits an approval gate is only reported once the device owner decides locally', async () => {
  const dbInstance = openDb(':memory:')
  grantPermission(dbInstance, 'project', projectDir, 'write')
  grantPermission(dbInstance, 'network', '*', 'write')
  const { setPreference } = await import('../src/memory.js')
  setPreference(dbInstance, 'github_token', 'fake-token')

  fakeLlm = await startFakeLlm(18097)
  const fakeGithub = await startFakeGithub(18103)
  process.env.GITHUB_API_BASE_URL = 'http://127.0.0.1:18103'
  const platformApi = await startFakePlatformApi(18098, { expectedCode: 'CODE3', deviceToken: 'device-token-3' })
  try {
    const ctx = buildCtx(dbInstance, 18097)
    const config: RuntimeConfig = {
      port: 0,
      authToken: 'tok',
      projectRoot: projectDir,
      allowedOrigins: [],
      platformApiUrl: 'http://127.0.0.1:18098',
      deviceToken: 'device-token-3',
    }
    platformApi.setNextTask({ id: 'task-needs-approval', title: 'create a repo for this', description: null })

    const stop = startTaskPoller(ctx, config, { pollIntervalMs: 20, heartbeatIntervalMs: 20 })
    try {
      // Give it a few polls' worth of time -- it must NOT complete yet.
      await new Promise((r) => setTimeout(r, 150))
      assert.equal(platformApi.completes.length, 0, 'task must stay open until a human approves/rejects it locally')

      const pending = dbInstance.prepare("SELECT id FROM approvals WHERE status = 'pending' ORDER BY created_at DESC LIMIT 1").get() as
        | { id: string }
        | undefined
      assert.ok(pending, 'expected a pending local approval row for the gated github.write call')

      const { resumeApproval } = await import('../src/agentLoop.js')
      await resumeApproval(ctx, pending!.id, 'approve')

      await waitFor(() => platformApi.completes.length > 0, 2000)
    } finally {
      stop()
    }

    assert.equal(platformApi.completes[0]!.taskId, 'task-needs-approval')
    assert.equal(platformApi.completes[0]!.status, 'completed')
  } finally {
    platformApi.server.close()
    fakeLlm.close()
    fakeGithub.close()
    delete process.env.GITHUB_API_BASE_URL
  }
})

test('local-runtime HTTP server: /device/pair, /device/status, /device/unpair', async () => {
  const dbInstance = openDb(':memory:')
  const platformApi = await startFakePlatformApi(18099, { expectedCode: 'CODE4', deviceToken: 'device-token-4' })
  const config: RuntimeConfig = { port: 0, authToken: 'server-tok', projectRoot: projectDir, allowedOrigins: [] }
  let restartCount = 0
  const httpServer = createHttpServer({
    db: dbInstance,
    config,
    modelProcess: new LocalModelProcess(19999),
    restartTaskPoller: () => {
      restartCount++
    },
  })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address()
  const port = typeof address === 'object' && address ? address!.port : 0
  const base = `http://127.0.0.1:${port}`

  try {
    const statusBefore = (await fetch(`${base}/device/status`, { headers: { Authorization: 'Bearer server-tok' } }).then((r) => r.json())) as any
    assert.equal(statusBefore.paired, false)

    const pairResponse = (await fetch(`${base}/device/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer server-tok' },
      body: JSON.stringify({ platform_api_url: 'http://127.0.0.1:18099', code: 'CODE4', device_name: 'Test Box' }),
    }).then((r) => r.json())) as any
    assert.equal(pairResponse.success, true)
    assert.equal(config.deviceToken, 'device-token-4')
    assert.equal(config.platformApiUrl, 'http://127.0.0.1:18099')
    assert.equal(restartCount, 1)

    const statusAfter = (await fetch(`${base}/device/status`, { headers: { Authorization: 'Bearer server-tok' } }).then((r) => r.json())) as any
    assert.equal(statusAfter.paired, true)

    const unpairResponse = (await fetch(`${base}/device/unpair`, {
      method: 'POST',
      headers: { Authorization: 'Bearer server-tok' },
    }).then((r) => r.json())) as any
    assert.equal(unpairResponse.success, true)
    assert.equal(config.deviceToken, undefined)
    assert.equal(restartCount, 2)
  } finally {
    httpServer.close()
    platformApi.server.close()
  }
})

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((r) => setTimeout(r, 15))
  }
}
