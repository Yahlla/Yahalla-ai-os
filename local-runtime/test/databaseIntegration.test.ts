import assert from 'node:assert/strict'
import { createServer as createFakeHttpServer, type Server } from 'node:http'
import { after, before, test } from 'node:test'
import { Client } from 'pg'
import { addDatabaseConnection, executeDatabase, listDatabaseConnections, queryDatabase, removeDatabaseConnection } from '../src/database.js'
import { EmbodimentStateMachine } from '../src/embodiment/stateMachine.js'
import { PerceptionManager } from '../src/perception/manager.js'
import type { RuntimeConfig } from '../src/config.js'
import type { Db } from '../src/db.js'
import { openDb } from '../src/db.js'
import { grantPermission } from '../src/permissions.js'
import { createHttpServer, ctxFrom } from '../src/server.js'
import { runChat } from '../src/agentLoop.js'
import { LocalModelProcess } from '../src/llm.js'

const TEST_DB_URL = process.env.TEST_DATABASE_URL_RUNTIME_DBTOOL ?? 'postgresql://postgres:testpass123@127.0.0.1:5432/yahalla_runtime_dbtool_test'

let db: Db
let httpServer: Server
let baseUrl: string
const authToken = 'test-token'

before(async () => {
  const setup = new Client({ connectionString: TEST_DB_URL })
  await setup.connect()
  await setup.query('DROP TABLE IF EXISTS widgets')
  await setup.query('CREATE TABLE widgets (id serial primary key, name text not null)')
  await setup.query("INSERT INTO widgets (name) VALUES ('gizmo'), ('gadget')")
  await setup.end()

  db = openDb(':memory:')
  const modelProcess = new LocalModelProcess(18201)
  const config: RuntimeConfig = { port: 0, authToken, projectRoot: null, allowedOrigins: [] }
  const embodiment = new EmbodimentStateMachine()
  const perception = new PerceptionManager(db)

  httpServer = createHttpServer({ db, config, modelProcess, embodiment, perception })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`
})

after(() => {
  httpServer.close()
})

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}`, ...init.headers },
  })
  return { status: response.status, body: (await response.json()) as any }
}

test('adding a connection with a bad connection string is rejected and not stored', async () => {
  await assert.rejects(() => addDatabaseConnection(db, 'bad', 'postgresql://nobody:nothing@127.0.0.1:1/does-not-exist'))
  assert.deepEqual(listDatabaseConnections(db), [])
})

let connectionId: string

test('adding a connection with a real, valid connection string validates with SELECT 1 and stores it', async () => {
  const connection = await addDatabaseConnection(db, 'Widgets DB', TEST_DB_URL)
  assert.equal(connection.name, 'Widgets DB')
  assert.ok(connection.id)
  connectionId = connection.id

  const listed = listDatabaseConnections(db)
  assert.equal(listed.length, 1)
  assert.equal(listed[0]!.name, 'Widgets DB')
})

test('queryDatabase runs a real SELECT against the real database', async () => {
  const result = await queryDatabase(db, connectionId, 'SELECT name FROM widgets ORDER BY name')
  assert.equal(result.success, true)
  assert.equal((result as any).row_count, 2)
  assert.deepEqual(
    (result as any).rows.map((r: any) => r.name),
    ['gadget', 'gizmo'],
  )
})

test('queryDatabase rejects a write attempt -- enforced by Postgres itself, not app logic', async () => {
  const result = await queryDatabase(db, connectionId, "INSERT INTO widgets (name) VALUES ('sneaky')")
  assert.equal(result.success, false)
  assert.match(String((result as any).message), /read-only transaction/i)

  const after = await queryDatabase(db, connectionId, 'SELECT count(*)::int AS n FROM widgets')
  assert.equal((after as any).rows[0].n, 2)
})

test('executeDatabase actually performs a real write that persists', async () => {
  const result = await executeDatabase(db, connectionId, "INSERT INTO widgets (name) VALUES ('widget-3') RETURNING id, name")
  assert.equal(result.success, true)
  assert.equal((result as any).row_count, 1)
  assert.equal((result as any).rows[0].name, 'widget-3')

  const after = await queryDatabase(db, connectionId, 'SELECT count(*)::int AS n FROM widgets')
  assert.equal((after as any).rows[0].n, 3)
})

test('querying an unknown connection id gives a clear error, not a crash', async () => {
  const result = await queryDatabase(db, 'not-a-real-id', 'SELECT 1')
  assert.equal(result.success, false)
  assert.match(String((result as any).message), /Unknown database connection/)
})

test('HTTP: GET /integrations/database lists the stored connection without its secret', async () => {
  const { status, body } = await api('/integrations/database')
  assert.equal(status, 200)
  assert.equal(body.connections.length, 1)
  assert.equal(body.connections[0].name, 'Widgets DB')
  assert.equal(body.connections[0].connection_string, undefined)
})

test('HTTP: POST /integrations/database with a bad connection string returns a clean 400', async () => {
  const { status, body } = await api('/integrations/database', {
    method: 'POST',
    body: JSON.stringify({ name: 'Broken', connection_string: 'postgresql://nobody:nothing@127.0.0.1:1/nope' }),
  })
  assert.equal(status, 400)
  assert.ok(body.error)
})

test('HTTP: DELETE /integrations/database/:id removes it', async () => {
  const { status, body } = await api(`/integrations/database/${connectionId}`, { method: 'DELETE' })
  assert.equal(status, 200)
  assert.equal(body.success, true)

  const after = await api('/integrations/database')
  assert.equal(after.body.connections.length, 0)
})

test('end-to-end: agentLoop actually calls db_query through the LLM tool-calling loop against a real database', async () => {
  const connection = await addDatabaseConnection(db, 'E2E DB', TEST_DB_URL)
  grantPermission(db, 'network', '*', 'write')

  const fakeLlm = createFakeHttpServer(async (req, res) => {
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const hasToolResult = body.messages.some((m: any) => m.role === 'tool')
      res.writeHead(200, { 'Content-Type': 'application/json' })
      if (hasToolResult) {
        res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'There are 2 widgets.' } }] }))
        return
      }
      res.end(
        JSON.stringify({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  { id: 'call_db_1', type: 'function', function: { name: 'db_query', arguments: JSON.stringify({ connection_id: connection.id, query: 'SELECT count(*) FROM widgets' }) } },
                ],
              },
            },
          ],
        }),
      )
    } else {
      res.writeHead(404)
      res.end()
    }
  })
  await new Promise<void>((resolve) => fakeLlm.listen(18202, '127.0.0.1', () => resolve()))

  try {
    const modelProcess = new LocalModelProcess(18202)
    ;(modelProcess as any).child = { exitCode: null, killed: false }
    const embodiment = new EmbodimentStateMachine()
    const perception = new PerceptionManager(db)
    const ctx = ctxFrom({ db, config: { port: 0, authToken, projectRoot: null, allowedOrigins: [] }, modelProcess }, embodiment, perception)

    const result = await runChat(ctx, 'How many widgets are there?')
    assert.equal(result.success, true)
    assert.equal(result.status, 'completed')
    assert.equal(result.executedTools?.[0]?.tool, 'db_query')
    const toolResult = result.executedTools?.[0]?.result as any
    assert.equal(toolResult.success, true)
    // Real count from the real database (3 rows: the original 2 + the one
    // inserted by the earlier executeDatabase test) -- proves the tool
    // actually reached Postgres, not a canned/stubbed result.
    assert.equal(toolResult.rows[0].count, '3')
    assert.equal(result.answer, 'There are 2 widgets.')
  } finally {
    fakeLlm.close()
  }
})
