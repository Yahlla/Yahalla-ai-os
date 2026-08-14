import assert from 'node:assert/strict'
import { createServer as createFakeHttpServer } from 'node:http'
import { after, before, test } from 'node:test'
import { openDb, type Db } from '../src/db.js'
import { LocalModelProcess } from '../src/llm.js'
import { createHttpServer } from '../src/server.js'
import type { RuntimeConfig } from '../src/config.js'

// Failure-injection pass (audit request #23): real scenarios, through the
// real /chat HTTP path, that were not covered by reliability.test.ts's
// unit-level retry tests -- the LLM being completely unreachable (not
// just returning an HTTP error) and a runaway tool-calling loop that
// never produces a final answer. Both must be handled cleanly: a bounded
// 'failed' result, never a hang and never an unhandled crash.

const authToken = 'reliability-injection-token'

test('LLM completely unreachable (nothing listening on the port): /chat fails cleanly and quickly, no hang, no crash', async () => {
  const db = openDb(':memory:')
  // A real port with no server ever started on it -- a genuine
  // ECONNREFUSED at the TCP level, not a scripted HTTP error response.
  const modelProcess = new LocalModelProcess(18499)
  const config: RuntimeConfig = { port: 0, authToken, projectRoot: null, allowedOrigins: [] }
  const httpServer = createHttpServer({ db, config, modelProcess })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const baseUrl = `http://127.0.0.1:${port}`

  try {
    const start = Date.now()
    const response = await fetch(`${baseUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ message: 'hello' }),
    })
    const body = (await response.json()) as any
    const elapsedMs = Date.now() - start

    assert.equal(body.status, 'failed')
    assert.ok(typeof body.error === 'string' && body.error.length > 0, 'must report a real, non-empty error, not silently fail')
    // chatCompletionWithRetry's own bounded retry+backoff (reliability.test.ts
    // covers the retry math directly) means this resolves in a few seconds
    // at most, never hangs indefinitely -- generous ceiling for a slow CI
    // sandbox, still far below "hung."
    assert.ok(elapsedMs < 20_000, `expected a bounded failure, took ${elapsedMs}ms`)
  } finally {
    httpServer.close()
  }
})

function startInfiniteToolCallLlm(port: number) {
  const server = createFakeHttpServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }))
      return
    }
    // Never produces a final answer -- always another tool call, as if the
    // model were stuck in a loop. git_status is real, read-only, and cheap
    // to actually execute every round (this must not be an infinite loop
    // in the RUNTIME even though the model itself never stops asking).
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: `call_${Date.now()}_${Math.random()}`, type: 'function', function: { name: 'git_status', arguments: '{}' } }] } }],
      }),
    )
  })
  return new Promise<import('node:http').Server>((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

let db: Db
let fakeLlm: import('node:http').Server
let httpServer: import('node:http').Server
let baseUrl: string

before(async () => {
  db = openDb(':memory:')
  fakeLlm = await startInfiniteToolCallLlm(18498)
  const modelProcess = new LocalModelProcess(18498)
  ;(modelProcess as any).child = { exitCode: null, killed: false }
  const config: RuntimeConfig = { port: 0, authToken, projectRoot: process.cwd(), allowedOrigins: [] }
  httpServer = createHttpServer({ db, config, modelProcess })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`

  // Keep the round budget small so this test is fast, but real -- the
  // point under test is that a bound exists and is enforced, not any
  // particular number.
  await fetch(`${baseUrl}/preferences`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    body: JSON.stringify({ key: 'max_tool_rounds', value: 4 }),
  })
})

after(() => {
  httpServer.close()
  fakeLlm.close()
})

test('a model that never stops calling tools is bounded by max_tool_rounds, not an infinite loop', async () => {
  const response = await fetch(`${baseUrl}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    body: JSON.stringify({ message: 'do something' }),
  })
  const body = (await response.json()) as any

  assert.equal(body.status, 'failed')
  assert.match(body.error, /Exceeded max tool rounds \(4\)/)
  // Real tools genuinely ran up to the bound (git_status against process.cwd()
  // -- this repository's own git tree, real read-only command) -- not a
  // fast-path bail-out that skipped execution.
  assert.equal(body.executedTools.length, 4)
  assert.ok(body.executedTools.every((t: any) => t.tool === 'git_status'))
})
