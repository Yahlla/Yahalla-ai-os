import assert from 'node:assert/strict'
import { createServer as createFakeLlmServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { openDb, type Db } from '../src/db.js'
import { grantPermission } from '../src/permissions.js'
import { LocalModelProcess } from '../src/llm.js'
import { createHttpServer } from '../src/server.js'
import type { RuntimeConfig } from '../src/config.js'
import { parsePlanResponse, shouldPlan } from '../src/agentLoop.js'

// Unit tests for the two pure functions -- no server/DB needed.

test('shouldPlan requires both a first message and a substantial one', () => {
  assert.equal(shouldPlan('a'.repeat(80), true), true)
  assert.equal(shouldPlan('a'.repeat(79), true), false, 'too short')
  assert.equal(shouldPlan('a'.repeat(200), false), false, 'not the first message in the conversation')
})

test('parsePlanResponse accepts a clean JSON array of 2-10 strings', () => {
  const plan = parsePlanResponse('["Set up the schema", "Build the API", "Wire the frontend"]')
  assert.deepEqual(plan, ['Set up the schema', 'Build the API', 'Wire the frontend'])
})

test('parsePlanResponse strips a fenced code block the model added anyway', () => {
  const plan = parsePlanResponse('```json\n["Step one", "Step two"]\n```')
  assert.deepEqual(plan, ['Step one', 'Step two'])
})

test('parsePlanResponse rejects malformed JSON, non-arrays, and out-of-range lengths', () => {
  assert.equal(parsePlanResponse('not json at all'), null)
  assert.equal(parsePlanResponse('{"not": "an array"}'), null)
  assert.equal(parsePlanResponse('["only one step"]'), null, 'below the 2-step minimum')
  assert.equal(parsePlanResponse(JSON.stringify(Array.from({ length: 11 }, (_, i) => `step ${i}`))), null, 'above the 10-step maximum')
})

// Integration: a real fake LLM (same pattern as integration.test.ts) that
// distinguishes the dedicated planning call (no `tools` field on the
// request) from the normal tool-calling loop, driven through the real
// HTTP server + runChat + SQLite path.
function startFakeLlm(port: number) {
  const server = createFakeLlmServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }))
      return
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      res.writeHead(200, { 'Content-Type': 'application/json' })

      // The planning call never sends `tools` -- that's how the fake
      // distinguishes it from the main ReAct loop's requests.
      if (!body.tools) {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: JSON.stringify(['Design the database schema', 'Build the API endpoints', 'Wire the frontend', 'Write tests']),
                },
              },
            ],
          }),
        )
        return
      }

      // Main loop: answer immediately with no tool calls, so the task
      // (and therefore its subtasks) reaches 'completed'.
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: 'Understood -- here is my plan-following response.' } }],
        }),
      )
    } else {
      res.writeHead(404)
      res.end()
    }
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
  projectDir = mkdtempSync(join(tmpdir(), 'yahalla-planning-test-'))
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))

  db = openDb(':memory:')
  grantPermission(db, 'project', projectDir, 'write')

  fakeLlm = await startFakeLlm(18082)

  const modelProcess = new LocalModelProcess(18082)
  ;(modelProcess as any).child = { exitCode: null, killed: false }

  const config: RuntimeConfig = {
    port: 0,
    authToken,
    projectRoot: projectDir,
    allowedOrigins: ['http://localhost:5173'],
  }

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
  return { status: response.status, body: await response.json() }
}

test('a substantial first message gets broken into persisted subtasks', async () => {
  const longGoal = 'Design and build a full messaging application with real-time chat, user accounts, and push notifications end to end.'
  assert.ok(longGoal.length >= 80, 'fixture goal must actually trigger shouldPlan')

  const { status, body } = await api('/chat', { method: 'POST', body: JSON.stringify({ message: longGoal }) })
  assert.equal(status, 200)
  assert.equal(body.success, true)

  const subtasks = db
    .prepare('SELECT title, status, plan_order FROM tasks WHERE parent_task_id = ? ORDER BY plan_order ASC')
    .all(body.taskId) as { title: string; status: string; plan_order: number }[]

  assert.equal(subtasks.length, 4)
  assert.deepEqual(
    subtasks.map((s) => s.title),
    ['Design the database schema', 'Build the API endpoints', 'Wire the frontend', 'Write tests'],
  )
  assert.deepEqual(subtasks.map((s) => s.plan_order), [0, 1, 2, 3])
  // The main task succeeded (no tool calls, immediate answer), so the
  // bookkeeping pass should have marked every subtask completed too.
  assert.ok(subtasks.every((s) => s.status === 'completed'), 'all subtasks marked completed once the parent task succeeds')
})

test('a short message does not trigger planning (no subtasks created)', async () => {
  const { status, body } = await api('/chat', { method: 'POST', body: JSON.stringify({ message: 'hi there' }) })
  assert.equal(status, 200)

  const subtasks = db.prepare('SELECT id FROM tasks WHERE parent_task_id = ?').all(body.taskId) as { id: string }[]
  assert.equal(subtasks.length, 0)
})

test('a second, later message in the same conversation does not re-plan', async () => {
  const longGoal = 'Design and build a complete e-commerce platform with checkout, inventory management, and shipping integration end to end.'
  const first = await api('/chat', { method: 'POST', body: JSON.stringify({ message: longGoal }) })
  const conversationId = first.body.conversationId

  const secondLongMessage = 'Now also add a full loyalty rewards system with tiered points and redeemable coupons end to end please.'
  const second = await api('/chat', {
    method: 'POST',
    body: JSON.stringify({ message: secondLongMessage, conversation_id: conversationId }),
  })
  assert.equal(second.status, 200)

  const subtasksForSecondTask = db.prepare('SELECT id FROM tasks WHERE parent_task_id = ?').all(second.body.taskId) as { id: string }[]
  assert.equal(subtasksForSecondTask.length, 0, 'no new plan for a follow-up message in an existing conversation')
})
