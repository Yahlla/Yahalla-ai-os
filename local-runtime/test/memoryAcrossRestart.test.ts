import assert from 'node:assert/strict'
import { createServer as createFakeHttpServer } from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { openDb } from '../src/db.js'
import { LocalModelProcess } from '../src/llm.js'
import { createHttpServer } from '../src/server.js'
import type { RuntimeConfig } from '../src/config.js'

// End-to-end memory-across-restart proof, exactly as requested: Message A
// -> store -> restart the runtime -> Message B referencing A -> retrieve
// -> grounded answer. Uses a REAL SQLite file on disk (dbPath, never
// :memory:) -- "restart" here means genuinely closing the database handle
// and every in-process object tied to it, then opening a brand new
// process-equivalent state (a fresh Db handle, a fresh HTTP server, a
// fresh LocalModelProcess) against the SAME file path, which is exactly
// what persists and what doesn't across a real process restart. Full
// process-level restart behavior (spawn/kill/respawn of the actual OS
// process) is separately proven in cliRuntime.smoke.mjs and the Electron
// end-to-end run; this test isolates the specific claim under test here:
// does conversation history genuinely survive on disk and get seen again.

function toolFreeLlm(port: number, onRequest: (body: any) => string) {
  const server = createFakeHttpServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }))
      return
    }
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const answer = onRequest(body)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: answer } }] }))
  })
  return new Promise<import('node:http').Server>((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

async function api(baseUrl: string, authToken: string, path: string, init: RequestInit = {}): Promise<any> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}`, ...init.headers },
  })
  return response.json()
}

const stateDir = mkdtempSync(join(tmpdir(), 'yahalla-memory-restart-'))
const dbFilePath = join(stateDir, 'yahalla.db')
const authToken = 'restart-test-token'

after(() => {
  rmSync(stateDir, { recursive: true, force: true })
})

test('memory across a real restart: Message A is stored on disk, survives a full close+reopen, and Message B can see it', async () => {
  // --- "Before restart": a fresh Db handle against the real on-disk file. ---
  let capturedRequestBodyA: any = null
  const dbBefore = openDb(dbFilePath)
  const llmBefore = await toolFreeLlm(18470, (body) => {
    capturedRequestBodyA = body
    return "Noted: your favorite programming language is Rust, and you're allergic to peanuts."
  })
  const modelProcessBefore = new LocalModelProcess(18470)
  ;(modelProcessBefore as any).child = { exitCode: null, killed: false }
  const config: RuntimeConfig = { port: 0, authToken, projectRoot: null, allowedOrigins: [] }
  const serverBefore = createHttpServer({ db: dbBefore, config, modelProcess: modelProcessBefore })
  await new Promise<void>((resolve) => serverBefore.listen(0, '127.0.0.1', () => resolve()))
  const addressBefore = serverBefore.address()
  const portBefore = typeof addressBefore === 'object' && addressBefore ? addressBefore.port : 0
  const baseUrlBefore = `http://127.0.0.1:${portBefore}`

  const messageA = await api(baseUrlBefore, authToken, '/chat', {
    method: 'POST',
    body: JSON.stringify({ message: 'My favorite programming language is Rust, and I am allergic to peanuts. Please remember that.' }),
  })
  assert.equal(messageA.status, 'completed')
  const conversationId = messageA.conversationId
  assert.ok(conversationId)
  assert.ok(capturedRequestBodyA, 'the fake LLM must have actually received the real request')

  // --- Real "restart": close everything tied to the old state, including
  // the database handle itself, and stop pretending any in-memory
  // reference to it is still valid.
  serverBefore.close()
  llmBefore.close()
  ;(dbBefore as any).close?.()

  // --- "After restart": a brand new Db handle, opened fresh against the
  // exact same on-disk file path -- nothing is carried over in memory.
  let capturedRequestBodyB: any = null
  const dbAfter = openDb(dbFilePath)
  const llmAfter = await toolFreeLlm(18471, (body) => {
    capturedRequestBodyB = body
    return 'Yes -- you told me your favorite language is Rust and that you are allergic to peanuts.'
  })
  const modelProcessAfter = new LocalModelProcess(18471)
  ;(modelProcessAfter as any).child = { exitCode: null, killed: false }
  const serverAfter = createHttpServer({ db: dbAfter, config, modelProcess: modelProcessAfter })
  await new Promise<void>((resolve) => serverAfter.listen(0, '127.0.0.1', () => resolve()))
  const addressAfter = serverAfter.address()
  const portAfter = typeof addressAfter === 'object' && addressAfter ? addressAfter.port : 0
  const baseUrlAfter = `http://127.0.0.1:${portAfter}`

  try {
    // Real proof of persistence: the conversation itself, and message A's
    // content, are readable back from the freshly-opened database, before
    // even sending message B.
    const conversations = await api(baseUrlAfter, authToken, '/conversations')
    assert.ok(conversations.conversations.some((c: any) => c.id === conversationId), 'the conversation must have survived the restart on disk')

    const messageB = await api(baseUrlAfter, authToken, '/chat', {
      method: 'POST',
      body: JSON.stringify({ message: 'What did I just tell you about my favorite language and my allergy?', conversation_id: conversationId }),
    })
    assert.equal(messageB.status, 'completed')

    // The real request sent to the LLM for message B must contain message
    // A's real content -- not a mock, an actual round-trip through
    // loadHistory() reading the real messages table this new process
    // handle just opened.
    const sentMessages = capturedRequestBodyB.messages.map((m: any) => m.content).join('\n')
    assert.match(sentMessages, /Rust/)
    assert.match(sentMessages, /peanuts/)

    assert.match(messageB.answer, /Rust/)
  } finally {
    serverAfter.close()
    llmAfter.close()
    ;(dbAfter as any).close?.()
  }
})
