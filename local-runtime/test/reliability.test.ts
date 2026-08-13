import assert from 'node:assert/strict'
import { createServer as createFakeHttpServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { openDb, type Db } from '../src/db.js'
import { grantPermission } from '../src/permissions.js'
import { LocalModelProcess, chatCompletionStreamWithRetry, chatCompletionWithRetry } from '../src/llm.js'
import { createHttpServer } from '../src/server.js'
import type { RuntimeConfig } from '../src/config.js'

// --- Phase 1 reliability: agentLoop-level behaviors (dedup, malformed
// tool arguments, cross-round repeated-failure detection) -- exercised
// through the real /chat HTTP surface against a fake LLM, same discipline
// as integration.test.ts. The fake LLM's replies are keyed by which
// trigger phrase is in the first user message and by how many tool-result
// messages are already present in the conversation it's replaying, so each
// scenario below drives a real multi-round agentLoop conversation.

let capturedToolMessages: Record<string, string[]> = {}

function triggerFor(body: any): string | null {
  const firstUser = body.messages.find((m: any) => m.role === 'user')
  const content = String(firstUser?.content ?? '')
  if (content.includes('dedup-test')) return 'dedup-test'
  if (content.includes('malformed-test')) return 'malformed-test'
  if (content.includes('repeat-fail-test')) return 'repeat-fail-test'
  return null
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
    const trigger = triggerFor(body)
    const toolMessages = body.messages.filter((m: any) => m.role === 'tool')
    if (trigger) {
      capturedToolMessages[trigger] ??= []
      for (const m of toolMessages) capturedToolMessages[trigger].push(m.content)
    }

    res.writeHead(200, { 'Content-Type': 'application/json' })

    if (trigger === 'dedup-test') {
      if (toolMessages.length === 0) {
        // Model (incorrectly) emits the exact same tool call twice in one
        // response -- both calls target the identical file with identical
        // arguments.
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    { id: 'call_a', type: 'function', function: { name: 'read_project_file', arguments: JSON.stringify({ path: 'package.json' }) } },
                    { id: 'call_b', type: 'function', function: { name: 'read_project_file', arguments: JSON.stringify({ path: 'package.json' }) } },
                  ],
                },
              },
            ],
          }),
        )
        return
      }
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done-dedup' } }] }))
      return
    }

    if (trigger === 'malformed-test') {
      if (toolMessages.length === 0) {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    { id: 'call_bad', type: 'function', function: { name: 'read_project_file', arguments: '{not valid json' } },
                  ],
                },
              },
            ],
          }),
        )
        return
      }
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done-malformed' } }] }))
      return
    }

    if (trigger === 'repeat-fail-test') {
      if (toolMessages.length < 2) {
        // Two rounds in a row, calling a disallowed command with identical
        // arguments -- a deterministic, environment-independent failure
        // (allowlist rejection happens before any subprocess runs).
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    { id: `call_cmd_${toolMessages.length}`, type: 'function', function: { name: 'run_project_command', arguments: JSON.stringify({ command: 'rm -rf /' }) } },
                  ],
                },
              },
            ],
          }),
        )
        return
      }
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'done-repeat-fail' } }] }))
      return
    }

    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'no-op' } }] }))
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
  projectDir = mkdtempSync(join(tmpdir(), 'yahalla-reliability-test-'))
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))

  db = openDb(':memory:')
  grantPermission(db, 'project', projectDir, 'write')
  grantPermission(db, 'command_execution', '*', 'execute')
  grantPermission(db, 'network', '*', 'write')

  fakeLlm = await startFakeLlm(18401)

  const modelProcess = new LocalModelProcess(18401)
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
  return { status: response.status, body: (await response.json()) as any }
}

test('same-round tool-call dedup: an identical duplicate call in one round is not re-executed', async () => {
  const { body } = await api('/chat', { method: 'POST', body: JSON.stringify({ message: 'dedup-test please read the file' }) })
  assert.equal(body.status, 'completed')
  assert.equal(body.answer, 'done-dedup')
  // Two tool_calls were emitted, but only one real execution should have
  // happened -- the duplicate is served from the same-round cache.
  assert.equal(body.executedTools.length, 1)
  assert.equal(body.executedTools[0].tool, 'read_project_file')
})

test('malformed tool-call JSON arguments are surfaced to the model instead of silently becoming {}', async () => {
  capturedToolMessages['malformed-test'] = []
  const { body } = await api('/chat', { method: 'POST', body: JSON.stringify({ message: 'malformed-test please read a file' }) })
  assert.equal(body.status, 'completed')
  assert.equal(body.answer, 'done-malformed')
  // No tool actually executed (the tool def was never reached, arguments
  // never parsed) -- executedTools stays empty.
  assert.equal(body.executedTools.length, 0)

  const captured = capturedToolMessages['malformed-test']
  assert.ok(captured.length >= 1, 'expected the fake LLM to have seen a tool-result message on round 2')
  const parsed = JSON.parse(captured[0]!)
  assert.equal(parsed.success, false)
  assert.match(parsed.error, /not valid JSON/)
})

test('a repeated identical tool failure is flagged to the model on its second occurrence', async () => {
  capturedToolMessages['repeat-fail-test'] = []
  const { body } = await api('/chat', { method: 'POST', body: JSON.stringify({ message: 'repeat-fail-test run a bad command' }) })
  assert.equal(body.status, 'completed')
  assert.equal(body.answer, 'done-repeat-fail')
  assert.equal(body.executedTools.length, 2)
  assert.equal(body.executedTools[0].result.success, false)
  assert.equal(body.executedTools[1].result.success, false)

  const captured = capturedToolMessages['repeat-fail-test']
  // Round 2's request carries both tool messages so far: the first
  // failure (no warning yet) and, after the second failure, round 3's
  // request should carry a second tool message that does have the
  // warning. The handler pushes onto capturedToolMessages on every round
  // it's asked to respond to, so the *last* captured batch is the fullest.
  const allParsed = captured.map((c) => JSON.parse(c))
  const withWarning = allParsed.filter((p) => typeof p.repeated_failure_warning === 'string')
  assert.ok(withWarning.length >= 1, 'expected at least one tool message to carry a repeated_failure_warning')
})

// --- llm.ts-level retry behavior: real HTTP against a fake server that
// fails N times before succeeding (or never succeeds, for the
// non-retryable case), proving the retry wrapper actually re-issues the
// request rather than just re-shaping the error.

function startFlakyServer(
  port: number,
  behavior: (attempt: number) => { status: number; body: unknown },
): { server: import('node:http').Server; getAttempts: () => number } {
  let attempts = 0
  const server = createFakeHttpServer((req, res) => {
    attempts++
    const { status, body } = behavior(attempts)
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(body))
  })
  return { server, getAttempts: () => attempts }
}

async function listenOn(server: import('node:http').Server, port: number): Promise<void> {
  await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', () => resolve()))
}

test('chatCompletionWithRetry retries a transient 503 and eventually succeeds', async () => {
  const { server, getAttempts } = startFlakyServer(18402, (attempt) =>
    attempt < 3
      ? { status: 503, body: 'service unavailable' }
      : { status: 200, body: { choices: [{ message: { role: 'assistant', content: 'ok' } }] } },
  )
  await listenOn(server, 18402)
  try {
    const result = await chatCompletionWithRetry('http://127.0.0.1:18402', { model: 'x', messages: [] }, { maxRetries: 3 })
    assert.equal(result.ok, true)
    assert.equal(getAttempts(), 3)
  } finally {
    server.close()
  }
})

test('chatCompletionWithRetry does not retry a permanent 400', async () => {
  const { server, getAttempts } = startFlakyServer(18403, () => ({ status: 400, body: 'bad request' }))
  await listenOn(server, 18403)
  try {
    const result = await chatCompletionWithRetry('http://127.0.0.1:18403', { model: 'x', messages: [] }, { maxRetries: 3 })
    assert.equal(result.ok, false)
    assert.equal(getAttempts(), 1)
  } finally {
    server.close()
  }
})

test('chatCompletionWithRetry gives up after maxRetries on a persistent transient failure', async () => {
  const { server, getAttempts } = startFlakyServer(18404, () => ({ status: 500, body: 'nope' }))
  await listenOn(server, 18404)
  try {
    const result = await chatCompletionWithRetry('http://127.0.0.1:18404', { model: 'x', messages: [] }, { maxRetries: 2 })
    assert.equal(result.ok, false)
    assert.equal(getAttempts(), 3) // initial attempt + 2 retries
  } finally {
    server.close()
  }
})

test('chatCompletionStreamWithRetry retries a transient failure before any token is forwarded', async () => {
  let attempts = 0
  const server = createFakeHttpServer((req, res) => {
    attempts++
    if (attempts < 2) {
      res.writeHead(502, { 'Content-Type': 'text/plain' })
      res.end('bad gateway')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`)
    res.write('data: [DONE]\n\n')
    res.end()
  })
  await listenOn(server, 18405)
  try {
    const tokens: string[] = []
    const result = await chatCompletionStreamWithRetry(
      'http://127.0.0.1:18405',
      { model: 'x', messages: [] },
      (delta) => tokens.push(delta),
      { maxRetries: 2 },
    )
    assert.equal(result.ok, true)
    assert.deepEqual(tokens, ['hi'])
    assert.equal(attempts, 2)
  } finally {
    server.close()
  }
})
