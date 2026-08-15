import assert from 'node:assert/strict'
import { createServer as createFakeHttpServer } from 'node:http'
import { after, before, test } from 'node:test'
import { openDb, type Db } from '../src/db.js'
import { LocalModelProcess } from '../src/llm.js'
import { grantPermission } from '../src/permissions.js'
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
  // Real audit finding: without this, every git_status call below is a
  // permission-DENIAL, identical every round -- which is exactly what the
  // repeated-failure hard stop (agentLoop.ts's MAX_REPEATED_FAILURE_ATTEMPTS)
  // now correctly intercepts after 3 attempts, well before max_tool_rounds
  // is ever reached. Granting read access here makes git_status a real,
  // harmless, repeatable SUCCESS instead, so this test isolates exactly
  // what it says it tests -- the max_tool_rounds bound on a genuinely
  // never-ending tool-calling loop -- independent of the separate
  // repeated-failure behavior, which has its own dedicated test.
  grantPermission(db, 'project', process.cwd(), 'read')
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
  // fast-path bail-out that skipped execution. Each call succeeds for
  // real (see the before() hook's permission grant) so this test is
  // bounded purely by max_tool_rounds, not by the separate repeated-
  // failure hard stop.
  assert.equal(body.executedTools.length, 4)
  assert.ok(body.executedTools.every((t: any) => t.tool === 'git_status' && t.result.success === true))
})

// Real audit finding (confirmed against the real qwen3-4b model on real
// hardware, not hypothetical): llama-server can return a genuinely
// successful HTTP 200 response -- valid JSON, no network/HTTP/JSON error at
// all -- whose message has both empty content and no tool_calls. Before
// this fix that always failed the whole task immediately with "Local LLM
// returned no usable answer.", even though a plain re-ask of the exact same
// request routinely succeeds. These tests prove: (1) that specific,
// narrow condition now gets exactly one same-context retry and can recover,
// (2) it never retries more than once, and (3) every other failure class
// (HTTP error, malformed/non-JSON body, a tool call that fails on
// permission) is completely unaffected -- no extra LLM call is ever made
// for those.
function startCountingFakeLlm(port: number, respond: (callIndex: number, body: any) => { status: number; payload: unknown } | { status: number; raw: string }) {
  const requestBodies: any[] = []
  const server = createFakeHttpServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }))
      return
    }
    const chunks: Buffer[] = []
    for await (const c of req) chunks.push(c as Buffer)
    const parsedBody = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const callIndex = requestBodies.length
    requestBodies.push(parsedBody)
    const outcome = respond(callIndex, parsedBody)
    res.writeHead(outcome.status, { 'Content-Type': 'application/json' })
    res.end('raw' in outcome ? outcome.raw : JSON.stringify(outcome.payload))
  })
  return {
    requestBodies,
    listen: () => new Promise<import('node:http').Server>((resolve) => server.listen(port, '127.0.0.1', () => resolve(server))),
  }
}

function emptyAnswerMessage() {
  return { status: 200, payload: { choices: [{ message: { role: 'assistant', content: '', tool_calls: [] } }] } }
}

async function chatOnPort(port: number, message: string, projectRoot: string | null = null): Promise<any> {
  const db = openDb(':memory:')
  const modelProcess = new LocalModelProcess(port)
  ;(modelProcess as any).child = { exitCode: null, killed: false }
  const config: RuntimeConfig = { port: 0, authToken, projectRoot, allowedOrigins: [] }
  const httpServer = createHttpServer({ db, config, modelProcess })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address()
  const httpPort = typeof address === 'object' && address ? address.port : 0
  try {
    const response = await fetch(`http://127.0.0.1:${httpPort}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ message }),
    })
    return await response.json()
  } finally {
    httpServer.close()
  }
}

test('REGRESSION: an empty-content/no-tool_calls response is treated as transient -- one automatic retry with the same conversation/tool context recovers it', async () => {
  const fake = startCountingFakeLlm(18495, (callIndex) =>
    callIndex === 0
      ? emptyAnswerMessage()
      : { status: 200, payload: { choices: [{ message: { role: 'assistant', content: 'The answer is 42.' } }] } },
  )
  const fakeServer = await fake.listen()
  try {
    const body = await chatOnPort(18495, 'what is the answer?')
    assert.equal(body.status, 'completed')
    assert.equal(body.answer, 'The answer is 42.')
    // Exactly one retry -- not zero (it did recover) and not more than one.
    assert.equal(fake.requestBodies.length, 2)
    // Same conversation/tool context on the retry -- not a fresh/rebuilt
    // request, not extra synthetic messages appended for the retry itself.
    assert.deepEqual(fake.requestBodies[0].messages, fake.requestBodies[1].messages)
    assert.deepEqual(fake.requestBodies[0].tools, fake.requestBodies[1].tools)
  } finally {
    fakeServer.close()
  }
})

test('REGRESSION: an empty-content/no-tool_calls response that recurs on the retry fails cleanly with the same clear error -- never a second retry', async () => {
  const fake = startCountingFakeLlm(18496, () => emptyAnswerMessage())
  const fakeServer = await fake.listen()
  try {
    const body = await chatOnPort(18496, 'what is the answer?')
    assert.equal(body.status, 'failed')
    assert.equal(body.error, 'Local LLM returned no usable answer.')
    // Exactly one retry attempt total -- two calls, never a third.
    assert.equal(fake.requestBodies.length, 2)
  } finally {
    fakeServer.close()
  }
})

test('a real HTTP error is never treated as the transient empty-answer case -- no extra retry, fails immediately with the real error', async () => {
  const fake = startCountingFakeLlm(18493, () => ({ status: 400, payload: { error: 'bad request' } }))
  const fakeServer = await fake.listen()
  try {
    const body = await chatOnPort(18493, 'hello')
    assert.equal(body.status, 'failed')
    assert.match(body.error, /HTTP 400/)
    // A real HTTP-level failure short-circuits before the empty-answer
    // retry check even runs -- exactly one call, not two.
    assert.equal(fake.requestBodies.length, 1)
  } finally {
    fakeServer.close()
  }
})

test('a real malformed/non-JSON response body is never treated as the transient empty-answer case -- no extra retry', async () => {
  const fake = startCountingFakeLlm(18494, () => ({ status: 200, raw: 'This is not JSON at all <html>error</html>' }))
  const fakeServer = await fake.listen()
  try {
    const body = await chatOnPort(18494, 'hello')
    // The existing defensive-JSON-parsing behavior (llm.ts's chatCompletion)
    // treats an unparsable-but-HTTP-200 body as literal answer text rather
    // than an empty answer, so it is never eligible for the empty-answer
    // retry either way -- confirmed here by the call count, not just the
    // outcome.
    assert.equal(body.status, 'completed')
    assert.equal(body.answer, 'This is not JSON at all <html>error</html>')
    assert.equal(fake.requestBodies.length, 1)
  } finally {
    fakeServer.close()
  }
})

test('a tool call that fails on permission is never treated as the transient empty-answer case -- no extra LLM call for that round', async () => {
  // Deliberately no project permission granted (projectRoot set, but never
  // trusted) -- get_project_overview must fail with a real permission
  // denial, not a made-up one.
  const fake = startCountingFakeLlm(18492, (callIndex) =>
    callIndex === 0
      ? { status: 200, payload: { choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_project_overview', arguments: '{}' } }] } }] } }
      : { status: 200, payload: { choices: [{ message: { role: 'assistant', content: "I couldn't access the project -- permission denied." } }] } },
  )
  const fakeServer = await fake.listen()
  try {
    const body = await chatOnPort(18492, 'give me a project overview', process.cwd())
    assert.equal(body.status, 'completed')
    assert.equal(body.executedTools[0].tool, 'get_project_overview')
    assert.equal(body.executedTools[0].result.success, false)
    assert.match(body.executedTools[0].result.error, /Permission denied/)
    // Round 1 (the tool call) + round 2 (the model's follow-up after seeing
    // the permission failure) -- normal round progression, never an extra
    // same-round retry call on top of it.
    assert.equal(fake.requestBodies.length, 2)
  } finally {
    fakeServer.close()
  }
})
