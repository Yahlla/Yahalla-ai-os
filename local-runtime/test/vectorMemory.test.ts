import assert from 'node:assert/strict'
import { createServer as createFakeHttpServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { cosineSimilarity, embedText, EMBEDDING_DIMENSIONS } from '../src/embeddings.js'
import { searchMemory, storeMemory } from '../src/vectorMemory.js'
import { ctxFrom, createHttpServer } from '../src/server.js'
import type { RuntimeConfig } from '../src/config.js'
import type { Db } from '../src/db.js'
import { openDb } from '../src/db.js'
import { grantPermission } from '../src/permissions.js'
import { LocalModelProcess } from '../src/llm.js'
import { EmbodimentStateMachine } from '../src/embodiment/stateMachine.js'
import { PerceptionManager } from '../src/perception/manager.js'
import { runChat } from '../src/agentLoop.js'

test('embedText is deterministic: the same text always produces the same vector', () => {
  const a = embedText('fix the login bug in auth.ts')
  const b = embedText('fix the login bug in auth.ts')
  assert.deepEqual(a, b)
})

test('embedText produces a unit-length vector of the exact dimension platform-api requires', () => {
  const v = embedText('the quick brown fox')
  assert.equal(v.length, EMBEDDING_DIMENSIONS)
  const magnitude = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0))
  assert.ok(Math.abs(magnitude - 1) < 1e-9, `expected unit vector, got magnitude ${magnitude}`)
})

test('embedText: real cosine similarity ranks vocabulary-sharing text higher than unrelated text', () => {
  const query = embedText('fix the authentication bug in login.ts')
  const related = embedText('the login.ts authentication bug is now fixed')
  const unrelated = embedText('order forty two pizzas for the office party')

  const simRelated = cosineSimilarity(query, related)
  const simUnrelated = cosineSimilarity(query, unrelated)
  assert.ok(simRelated > simUnrelated, `expected ${simRelated} > ${simUnrelated}`)
})

test('searchMemory/storeMemory no-op (no network call) when the device is not paired', async () => {
  const results = await searchMemory({}, 'anything')
  assert.deepEqual(results, [])
  await storeMemory({}, 'anything', 'agent') // must not throw
})

type FakePlatformApi = {
  server: Server
  storedEntries: { content: string; source: string; embedding: number[] }[]
  searchRequests: { embedding: number[]; limit: number }[]
  searchResponse: { id: string; content: string; source: string; similarity: number; created_at: string }[]
}

function startFakePlatformApi(port: number, deviceToken: string): Promise<FakePlatformApi> {
  const state: FakePlatformApi = { server: undefined as unknown as Server, storedEntries: [], searchRequests: [], searchResponse: [] }
  const server = createFakeHttpServer(async (req, res) => {
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    if (req.headers.authorization !== `Bearer ${deviceToken}`) return send(401, { success: false })

    const readBody = async () => {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const text = Buffer.concat(chunks).toString('utf8')
      return text ? JSON.parse(text) : {}
    }

    if (req.url === '/memory' && req.method === 'POST') {
      const body = await readBody()
      state.storedEntries.push({ content: body.content, source: body.source, embedding: body.embedding })
      return send(200, { success: true, entry: { id: 'mem-1' } })
    }
    if (req.url === '/memory/search' && req.method === 'POST') {
      const body = await readBody()
      state.searchRequests.push({ embedding: body.embedding, limit: body.limit })
      return send(200, { results: state.searchResponse })
    }
    send(404, { success: false })
  })
  state.server = server
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(state)))
}

test('searchMemory sends a real embedding and returns the real results platform-api sent back', async () => {
  const platformApi = await startFakePlatformApi(18301, 'tok-a')
  platformApi.searchResponse = [{ id: 'mem-1', content: 'we decided to use Postgres', source: 'agent', similarity: 0.9, created_at: new Date().toISOString() }]
  try {
    const results = await searchMemory({ platformApiUrl: 'http://127.0.0.1:18301', deviceToken: 'tok-a' }, 'what database did we pick?', 3)
    assert.equal(results.length, 1)
    assert.equal(results[0]!.content, 'we decided to use Postgres')
    assert.equal(platformApi.searchRequests.length, 1)
    assert.equal(platformApi.searchRequests[0]!.embedding.length, EMBEDDING_DIMENSIONS)
    assert.equal(platformApi.searchRequests[0]!.limit, 3)
  } finally {
    platformApi.server.close()
  }
})

test('storeMemory sends the real content with a real matching embedding', async () => {
  const platformApi = await startFakePlatformApi(18302, 'tok-b')
  try {
    await storeMemory({ platformApiUrl: 'http://127.0.0.1:18302', deviceToken: 'tok-b' }, 'fixed the login bug in auth.ts', 'agent')
    assert.equal(platformApi.storedEntries.length, 1)
    assert.equal(platformApi.storedEntries[0]!.content, 'fixed the login bug in auth.ts')
    assert.deepEqual(platformApi.storedEntries[0]!.embedding, embedText('fixed the login bug in auth.ts'))
  } finally {
    platformApi.server.close()
  }
})

// End-to-end proof that agentLoop actually uses this, not just that the two
// halves are independently correct: a real chat searches memory before
// answering (the fake platform-api receives a real /memory/search call)
// and, once a tool actually ran, stores a real memory entry afterward.
let projectDir: string
let db: Db
let fakeLlm: Server
let httpServer: Server
let baseUrl: string
const authToken = 'e2e-token'

before(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'yahalla-vectormem-test-'))
  writeFileSync(join(projectDir, 'README.md'), '# fixture')
  db = openDb(':memory:')
  grantPermission(db, 'project', projectDir, 'read')

  fakeLlm = await createFakeHttpServer(async (req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Done, no tools needed.' } }] }))
  })
  await new Promise<void>((resolve) => fakeLlm.listen(18303, '127.0.0.1', () => resolve()))

  const modelProcess = new LocalModelProcess(18303)
  ;(modelProcess as any).child = { exitCode: null, killed: false }
  const config: RuntimeConfig = {
    port: 0,
    authToken,
    projectRoot: projectDir,
    allowedOrigins: [],
    platformApiUrl: 'http://127.0.0.1:18304',
    deviceToken: 'e2e-device-token',
  }
  httpServer = createHttpServer({ db, config, modelProcess })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`
})

after(() => {
  httpServer.close()
  fakeLlm.close()
  rmSync(projectDir, { recursive: true, force: true })
})

test('runChat searches project memory before answering when this device is paired', async () => {
  const platformApi = await startFakePlatformApi(18304, 'e2e-device-token')
  platformApi.searchResponse = [{ id: 'm1', content: 'This project uses pnpm, not npm.', source: 'agent', similarity: 0.8, created_at: new Date().toISOString() }]
  try {
    const embodiment = new EmbodimentStateMachine()
    const perception = new PerceptionManager(db)
    const modelProcess = new LocalModelProcess(18303)
    ;(modelProcess as any).child = { exitCode: null, killed: false }
    const config: RuntimeConfig = { port: 0, authToken, projectRoot: projectDir, allowedOrigins: [], platformApiUrl: 'http://127.0.0.1:18304', deviceToken: 'e2e-device-token' }
    const ctx = ctxFrom({ db, config, modelProcess }, embodiment, perception)

    const result = await runChat(ctx, 'how do I install dependencies here?')
    assert.equal(result.success, true)
    assert.equal(platformApi.searchRequests.length, 1, 'expected exactly one real /memory/search call before answering')
  } finally {
    platformApi.server.close()
  }
})

test('runChat stores a real memory entry after a chat that actually used a tool', async () => {
  const toolFakeLlm = await createFakeHttpServer(async (req, res) => {
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const hasToolResult = body.messages.some((m: any) => m.role === 'tool')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (hasToolResult) {
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'Read the README for you.' } }] }))
      return
    }
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_project_file', arguments: JSON.stringify({ path: 'README.md' }) } }] } }],
      }),
    )
  })
  await new Promise<void>((resolve) => toolFakeLlm.listen(18305, '127.0.0.1', () => resolve()))
  const platformApi = await startFakePlatformApi(18306, 'e2e-device-token-2')
  try {
    const embodiment = new EmbodimentStateMachine()
    const perception = new PerceptionManager(db)
    const modelProcess = new LocalModelProcess(18305)
    ;(modelProcess as any).child = { exitCode: null, killed: false }
    const config: RuntimeConfig = { port: 0, authToken, projectRoot: projectDir, allowedOrigins: [], platformApiUrl: 'http://127.0.0.1:18306', deviceToken: 'e2e-device-token-2' }
    const ctx = ctxFrom({ db, config, modelProcess }, embodiment, perception)

    const result = await runChat(ctx, 'read the README and summarize it')
    assert.equal(result.status, 'completed')
    assert.ok((result.executedTools?.length ?? 0) > 0)

    await new Promise((r) => setTimeout(r, 50)) // storeMemory is fire-and-forget
    assert.equal(platformApi.storedEntries.length, 1, 'expected a real memory entry to be stored after a tool-using chat')
    assert.match(platformApi.storedEntries[0]!.content, /read_project_file/)
  } finally {
    platformApi.server.close()
    toolFakeLlm.close()
  }
})
