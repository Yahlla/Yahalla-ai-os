import assert from 'node:assert/strict'
import { createServer as createFakeHttpServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { openDb, type Db } from '../src/db.js'
import { LocalModelProcess } from '../src/llm.js'
import { createHttpServer } from '../src/server.js'
import type { RuntimeConfig } from '../src/config.js'

// Regression test for a real bug found by repository audit: nothing in
// src/ (frontend) or desktop/ (Electron shell) ever called
// POST /permissions/grant with scope=project -- meaning every fresh
// install permanently denied get_project_overview/read_project_file/
// list_project_files with "Permission denied", no matter what the user
// did, because the standing permission checkAccess() requires was never
// created. This reproduces that exact symptom through the real /chat HTTP
// path (not a direct unit-test shortcut), then proves /project/trust
// fixes it -- and that the granted target is always the server's own
// resolved projectRoot, never a client-suppliable path, which is what
// closes off the "permission target doesn't match ctx.projectRoot"
// variant of the same bug class too.
function toolCallResponse(res: import('node:http').ServerResponse, id: string, name: string, args: Record<string, unknown>): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(
    JSON.stringify({
      choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
    }),
  )
}

function answerResponse(res: import('node:http').ServerResponse, text: string): void {
  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }))
}

function startFakeLlm(port: number) {
  const server = createFakeHttpServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }))
      return
    }
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {
      res.writeHead(404)
      res.end()
      return
    }
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const toolMessages = body.messages.filter((m: any) => m.role === 'tool')

    if (toolMessages.length === 0) {
      toolCallResponse(res, 'call_overview', 'get_project_overview', {})
      return
    }
    answerResponse(res, 'done-overview')
  })
  return new Promise<import('node:http').Server>((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

let projectDir: string
let db: Db
let fakeLlm: import('node:http').Server
let httpServer: import('node:http').Server
let baseUrl: string
const authToken = 'test-token'

before(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'yahalla-project-trust-test-'))
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))

  db = openDb(':memory:')
  // Deliberately NO grantPermission call here -- a completely fresh
  // install's permissions table, exactly as db.ts's schema leaves it.

  fakeLlm = await startFakeLlm(18441)
  const modelProcess = new LocalModelProcess(18441)
  ;(modelProcess as any).child = { exitCode: null, killed: false }

  const config: RuntimeConfig = { port: 0, authToken, projectRoot: projectDir, allowedOrigins: ['http://localhost:5173'] }
  httpServer = createHttpServer({ db, config, modelProcess })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`
})

after(async () => {
  httpServer.close()
  fakeLlm.close()
  rmSync(projectDir, { recursive: true, force: true })
})

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}`, ...init.headers },
  })
  return { status: response.status, body: (await response.json()) as any }
}

test('REGRESSION: a fresh install with no permission ever granted really does deny get_project_overview through the real /chat path', async () => {
  const { body: status } = await api('/project/status')
  assert.equal(status.projectRoot, projectDir)
  assert.equal(status.trusted, false, 'a fresh install must not be trusted until /project/trust is called')

  const { body } = await api('/chat', { method: 'POST', body: JSON.stringify({ message: 'give me a project overview' }) })
  assert.equal(body.status, 'completed')
  assert.equal(body.executedTools[0].tool, 'get_project_overview')
  assert.equal(body.executedTools[0].result.success, false)
  assert.match(body.executedTools[0].result.error, /Permission denied/)
})

test('POST /project/trust grants access to the server-resolved project root, never a client-supplied path', async () => {
  const trust = await api('/project/trust', { method: 'POST', body: JSON.stringify({ access: 'write', target: '/some/other/attacker-controlled/path' }) })
  assert.equal(trust.status, 200)
  assert.equal(trust.body.projectRoot, projectDir, 'the granted target must be the real projectRoot, ignoring any client-supplied target')
  assert.equal(trust.body.permission.target, projectDir)
  assert.equal(trust.body.permission.access, 'write')

  const status = await api('/project/status')
  assert.equal(status.body.trusted, true)
})

test('after trust, get_project_overview succeeds through the real /chat HTTP path', async () => {
  const { body } = await api('/chat', { method: 'POST', body: JSON.stringify({ message: 'give me a project overview now' }) })
  assert.equal(body.status, 'completed')
  assert.equal(body.executedTools[0].tool, 'get_project_overview')
  assert.equal(body.executedTools[0].result.success, true)
  assert.equal(body.executedTools[0].result.overview.projectRoot, projectDir)
})
