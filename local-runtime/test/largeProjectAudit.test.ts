import assert from 'node:assert/strict'
import { createServer as createFakeHttpServer } from 'node:http'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { openDb, type Db } from '../src/db.js'
import { grantPermission } from '../src/permissions.js'
import { LocalModelProcess } from '../src/llm.js'
import { createHttpServer } from '../src/server.js'
import type { RuntimeConfig } from '../src/config.js'

// Real end-to-end proof for the audit's central finding: a realistic
// "inspect the whole project" request (get_project_overview, then
// list_project_files, then read_project_file on a large file -- exactly
// the workflow the system prompt tells the model to follow, and exactly
// the shape of the originally-reported ~15,533-token request against an
// 8192-token model) must not silently build a request larger than the
// model can accept. This fixture is deliberately larger than this real
// repository (2,500 files + a 300KB file) specifically so that, WITHOUT
// the contextBudget.ts fix, the raw accumulated tool results alone
// (list_project_files's ~2000-entry cap plus a 300KB file read) would be
// several hundred KB -- tens of thousands of tokens -- while this test
// proves what the LLM backend actually receives on every round stays
// bounded no matter how large the underlying project is.

function makeLargeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yahalla-large-audit-fixture-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'huge-fixture', version: '1.0.0' }))
  const srcDir = join(dir, 'src')
  writeFileSync(join(dir, '.gitkeep'), '')
  mkdirSync(srcDir, { recursive: true })
  // 2,500 small files -- enough to exceed listProjectFiles' MAX_LIST_ENTRIES
  // (2000) on its own, the same way a real large monorepo (with build
  // output, generated assets, etc.) would.
  for (let i = 0; i < 2500; i++) {
    writeFileSync(join(srcDir, `file-${i}.ts`), `export const value${i} = ${i};\n`)
  }
  // A single large file -- bigger than this repo's own largest committed
  // text file (package-lock.json, ~75KB) -- to stand in for "the agent
  // reads one real, sizeable source/config/lock file."
  writeFileSync(join(dir, 'big-generated-file.json'), JSON.stringify({ data: 'x'.repeat(300_000) }))
  return dir
}

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

// Captures the exact request body size (in characters) the "LLM" received
// on every round, so the test can assert on what was actually sent, not
// just on the final outcome. Which tool to call next is driven by a plain
// round counter (not by counting tool messages in the request) -- counting
// tool messages would break once compaction starts dropping older ones
// from the request, the same way it would for a real model that tracked
// "how many things have I already done" by re-deriving it from what's
// visible in context rather than just continuing the task.
function startFakeLlm(port: number, requestSizes: number[]) {
  let round = 0
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
    const raw = Buffer.concat(chunks).toString('utf8')
    requestSizes.push(raw.length)
    round += 1

    if (round === 1) {
      toolCallResponse(res, 'call_overview', 'get_project_overview', {})
      return
    }
    if (round === 2) {
      toolCallResponse(res, 'call_list', 'list_project_files', { path: 'src' })
      return
    }
    if (round === 3) {
      toolCallResponse(res, 'call_read', 'read_project_file', { path: 'big-generated-file.json' })
      return
    }
    answerResponse(res, 'I inspected the project: it has many source files and one large generated data file.')
  })
  return new Promise<import('node:http').Server>((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

let projectDir: string
let db: Db
let fakeLlm: import('node:http').Server
let httpServer: import('node:http').Server
let baseUrl: string
const authToken = 'test-token'
const requestSizes: number[] = []

before(async () => {
  projectDir = makeLargeFixture()
  db = openDb(':memory:')
  grantPermission(db, 'project', projectDir, 'write')

  fakeLlm = await startFakeLlm(18442, requestSizes)
  const modelProcess = new LocalModelProcess(18442)
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

test('REGRESSION: a real large-project audit request stays within a bounded request size at every round, no matter how large the underlying project is', async () => {
  const response = await fetch(`${baseUrl}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
    // Deliberately kept under 80 chars: a longer first message in a fresh
    // conversation triggers agentLoop's shouldPlan()/generatePlan() -- a
    // separate, extra, tool-less LLM round before the main loop starts --
    // which is real, correct behavior but not what this test is measuring.
    body: JSON.stringify({ message: 'Inspect this project fully and report back.' }),
  })
  const body = (await response.json()) as any

  assert.equal(body.status, 'completed', `expected the task to complete, got: ${JSON.stringify(body).slice(0, 500)}`)
  assert.deepEqual(
    body.executedTools.map((t: any) => t.tool),
    ['get_project_overview', 'list_project_files', 'read_project_file'],
  )

  // The real tool executions themselves are untouched by the context
  // budget -- executedTools (the HTTP response, not what the LLM saw) must
  // still reflect the real, full result, proving truncation is purely a
  // "what we tell the model" concern.
  const listResult = body.executedTools[1].result
  assert.equal(listResult.success, true)
  assert.ok(listResult.entries.length > 1900, 'the real tool result returned to the API caller must not be truncated')
  const readResult = body.executedTools[2].result
  assert.equal(readResult.success, true)
  assert.ok(readResult.content.length > 250_000, 'the real file content returned to the API caller must not be truncated')

  // What was captured on the LLM side: 4 rounds happened (3 tool calls +
  // 1 final answer). Without the contextBudget.ts fix, round 3 and 4 would
  // include the ~2000-entry file listing AND the 300KB file content in
  // full, in addition to every earlier round's tool results -- hundreds of
  // KB. With the fix, every round must stay small.
  assert.equal(requestSizes.length, 4, `expected exactly 4 LLM round-trips, got ${requestSizes.length}`)
  for (const [i, size] of requestSizes.entries()) {
    assert.ok(size < 40_000, `round ${i + 1}'s request to the LLM was ${size} chars (~${Math.round(size / 4)} tokens) -- expected it to stay well under a small model's real budget`)
  }
})
