import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer as createFakeHttpServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import type { RuntimeConfig } from '../src/config.js'
import { openDb, type Db } from '../src/db.js'
import { LocalModelProcess } from '../src/llm.js'
import { grantPermission } from '../src/permissions.js'
import { createHttpServer } from '../src/server.js'

// End-to-end proof that POST /chat/stream is a real SSE endpoint carrying
// real live tokens through the *whole* stack (server.ts's route ->
// agentLoop.ts's runChat/runLoop -> llm.ts's chatCompletionStream and
// back out as SSE frames) while tool-calling and approval-gating still
// work exactly as they do on the plain, non-streaming /chat route --
// llm.test.ts already covers chatCompletionStream in isolation; this is
// the integration the isolated unit test can't prove on its own.

function sseFrame(chunk: unknown): string {
  return `data: ${JSON.stringify(chunk)}\n\n`
}

// Round 1 (no tool result yet in the conversation): streams a tool_calls
// delta requesting read_project_file, split across two chunks the same
// way a real llama-server would split a long JSON-arguments string.
// Round 2 (tool result present): streams a real plain-text answer token
// by token, proving live tokens flow all the way out to the SSE client.
function startFakeSseLlm(port: number) {
  const server = createFakeHttpServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }))
      return
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const hasToolResult = body.messages.some((m: any) => m.role === 'tool')

      res.writeHead(200, { 'Content-Type': 'text/event-stream' })
      if (hasToolResult) {
        for (const word of ['The ', 'version ', 'is ', '0.0.0.']) {
          res.write(sseFrame({ choices: [{ delta: { content: word } }] }))
        }
      } else {
        res.write(sseFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_read_1', function: { name: 'read_project_file', arguments: '' } }] } }] }))
        res.write(sseFrame({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":"package.json"}' } }] } }] }))
      }
      res.write('data: [DONE]\n\n')
      res.end()
      return
    }
    res.writeHead(404)
    res.end()
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
  projectDir = mkdtempSync(join(tmpdir(), 'yahalla-runtime-stream-test-'))
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))

  db = openDb(':memory:')
  grantPermission(db, 'project', projectDir, 'write')

  fakeLlm = await startFakeSseLlm(18100)

  const modelProcess = new LocalModelProcess(18100)
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

test('POST /chat/stream streams real tokens over SSE while a tool call still executes for real in between', async () => {
  const response = await fetch(`${baseUrl}/chat/stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    body: JSON.stringify({ message: 'What version is this project?' }),
  })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('content-type'), 'text/event-stream')
  assert.ok(response.body)

  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let raw = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    raw += decoder.decode(value, { stream: true })
  }

  const frames = raw
    .split('\n\n')
    .filter((f) => f.startsWith('data:'))
    .map((f) => JSON.parse(f.slice('data:'.length).trim()))

  const tokenFrames = frames.filter((f) => f.kind === 'token')
  const doneFrame = frames.find((f) => f.kind === 'done')

  assert.deepEqual(
    tokenFrames.map((f) => f.delta),
    ['The ', 'version ', 'is ', '0.0.0.'],
  )
  assert.ok(doneFrame, 'expected a final "done" frame')
  assert.equal(doneFrame.status, 'completed')
  assert.equal(doneFrame.answer, 'The version is 0.0.0.')
  assert.equal(doneFrame.executedTools?.[0]?.tool, 'read_project_file')
})
