import assert from 'node:assert/strict'
import { createServer as createFakeHttpServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'
import { Client } from 'pg'
import { addDatabaseConnection } from '../src/database.js'
import { EmbodimentStateMachine } from '../src/embodiment/stateMachine.js'
import { PerceptionManager } from '../src/perception/manager.js'
import type { RuntimeConfig } from '../src/config.js'
import type { Db } from '../src/db.js'
import { openDb } from '../src/db.js'
import { grantPermission } from '../src/permissions.js'
import { createHttpServer } from '../src/server.js'
import { LocalModelProcess } from '../src/llm.js'

// Full approval lifecycle, both directions, against a REAL Postgres table
// (not a mock) -- the audit explicitly asked to prove both:
//   request -> pending -> user approval -> execute -> result
//   request -> pending -> user rejection -> no execution
// and specifically that the dangerous tool never runs before the decision
// arrives. This had no reject-path coverage anywhere in the repo before
// this pass -- resumeApproval's 'reject' branch (agentLoop.ts) existed in
// source but was never exercised by a real test.

const TEST_DB_URL = process.env.TEST_DATABASE_URL_RUNTIME_DBTOOL ?? 'postgresql://postgres:testpass123@127.0.0.1:5432/yahalla_runtime_dbtool_test'

let db: Db
let httpServer: Server
let fakeLlm: Server
let baseUrl: string
let connectionId: string
const authToken = 'test-token'

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

before(async () => {
  const setup = new Client({ connectionString: TEST_DB_URL })
  await setup.connect()
  await setup.query('DROP TABLE IF EXISTS approval_widgets')
  await setup.query('CREATE TABLE approval_widgets (id serial primary key, name text not null)')
  await setup.query("INSERT INTO approval_widgets (name) VALUES ('precious')")
  await setup.end()

  db = openDb(':memory:')
  // db_execute's standing permission (scope: 'network', access: 'write') --
  // approving a pending action does NOT bypass this: executeToolNow still
  // checks it fresh when resumeApproval finally calls it. Without this
  // grant, the "approve" path below would correctly still fail with
  // Permission denied, which is itself the right behavior but not what
  // this test file is specifically proving (approval lifecycle mechanics).
  grantPermission(db, 'network', '*', 'write')
  const connection = await addDatabaseConnection(db, 'Approval Test DB', TEST_DB_URL)
  connectionId = connection.id

  fakeLlm = await new Promise<Server>((resolve) => {
    const server = createFakeHttpServer(async (req, res) => {
      if (req.url === '/v1/models') {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }))
        return
      }
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const toolMessages = body.messages.filter((m: any) => m.role === 'tool')
      if (toolMessages.length === 0) {
        toolCallResponse(res, 'call_1', 'db_execute', { connection_id: connectionId, query: 'DELETE FROM approval_widgets' })
        return
      }
      answerResponse(res, 'done')
    })
    server.listen(18460, '127.0.0.1', () => resolve(server))
  })

  const modelProcess = new LocalModelProcess(18460)
  ;(modelProcess as any).child = { exitCode: null, killed: false }
  const config: RuntimeConfig = { port: 0, authToken, projectRoot: null, allowedOrigins: [] }
  const embodiment = new EmbodimentStateMachine()
  const perception = new PerceptionManager(db)

  httpServer = createHttpServer({ db, config, modelProcess, embodiment, perception })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`
})

after(async () => {
  httpServer.close()
  fakeLlm.close()
  const cleanup = new Client({ connectionString: TEST_DB_URL })
  await cleanup.connect()
  await cleanup.query('DROP TABLE IF EXISTS approval_widgets')
  await cleanup.end()
})

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}`, ...init.headers },
  })
  return { status: response.status, body: (await response.json()) as any }
}

async function rowCount(): Promise<number> {
  const client = new Client({ connectionString: TEST_DB_URL })
  await client.connect()
  const result = await client.query('SELECT count(*) FROM approval_widgets')
  await client.end()
  return Number(result.rows[0].count)
}

test('REJECT path: a dangerous db_execute pauses for approval and the row is untouched before any decision', async () => {
  const before = await api('/chat', { method: 'POST', body: JSON.stringify({ message: 'delete the widget' }) })
  assert.equal(before.status, 200)
  assert.equal(before.body.status, 'waiting_approval')
  assert.equal(before.body.approvalTool, 'db_execute')

  // The dangerous statement must not have run yet -- checked against the
  // real database, not the app's own state.
  assert.equal(await rowCount(), 1, 'the row must still exist -- db_execute must not run before a decision is made')

  const rejected = await api(`/approvals/${before.body.approvalId}/decide`, { method: 'POST', body: JSON.stringify({ decision: 'reject' }) })
  assert.equal(rejected.status, 200)
  assert.equal(rejected.body.executedTools.at(-1).tool, 'db_execute')
  assert.equal(rejected.body.executedTools.at(-1).result.success, false)
  assert.equal(rejected.body.executedTools.at(-1).result.error, 'Rejected by user.')

  assert.equal(await rowCount(), 1, 'the row must STILL exist after rejection -- the statement must genuinely never have run')
})

test('deciding an already-decided approval a second time fails cleanly instead of re-executing', async () => {
  const start = await api('/chat', { method: 'POST', body: JSON.stringify({ message: 'delete the widget again' }) })
  const approvalId = start.body.approvalId

  const first = await api(`/approvals/${approvalId}/decide`, { method: 'POST', body: JSON.stringify({ decision: 'reject' }) })
  assert.equal(first.status, 200)

  const second = await api(`/approvals/${approvalId}/decide`, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) })
  assert.equal(second.status, 500, 'a second decision on the same approval must be refused, not silently accepted')
  assert.match(String(second.body.error ?? ''), /already decided/)

  assert.equal(await rowCount(), 1, 'the second (approve) decision must never have executed -- the first decision (reject) is final')
})

test('APPROVE path: approving a pending db_execute actually performs the real write', async () => {
  const start = await api('/chat', { method: 'POST', body: JSON.stringify({ message: 'please delete the widget for real this time' }) })
  assert.equal(start.body.status, 'waiting_approval')
  assert.equal(await rowCount(), 1, 'still untouched before the decision')

  const approved = await api(`/approvals/${start.body.approvalId}/decide`, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) })
  assert.equal(approved.status, 200)
  assert.equal(approved.body.executedTools.at(-1).tool, 'db_execute')
  assert.equal(approved.body.executedTools.at(-1).result.success, true)

  assert.equal(await rowCount(), 0, 'the row must be genuinely gone -- a real DELETE actually ran against the real database')
})
