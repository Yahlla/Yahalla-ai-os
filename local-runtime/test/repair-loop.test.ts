import assert from 'node:assert/strict'
import { createServer as createFakeLlmServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { openDb, type Db } from '../src/db.js'
import { grantPermission } from '../src/permissions.js'
import { LocalModelProcess } from '../src/llm.js'
import { createHttpServer } from '../src/server.js'
import type { RuntimeConfig } from '../src/config.js'

// A real, runnable fixture project whose test suite deterministically fails
// or passes based on a flag file -- so "diagnose a real failure, patch a
// real file, re-run the real test command until it actually passes" can be
// exercised against real `npm test` output, not a scripted pretend result.
function buildFixtureProject(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yahalla-repair-fixture-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '1.0.0', scripts: { test: 'node test.js' } }, null, 2))
  writeFileSync(
    join(dir, 'test.js'),
    `const fs = require('fs');\nconst flag = fs.readFileSync('flag.txt', 'utf8').trim();\nif (flag !== 'fixed') { console.error('FAIL: flag is ' + flag); process.exit(1); }\nconsole.log('PASS');\n`,
  )
  writeFileSync(join(dir, 'flag.txt'), 'broken')
  return dir
}

// Scripts a fake local LLM that behaves like a real diagnose-and-repair
// agent would, driven purely by what actually happened in the conversation
// so far (real tool results from a real `npm test` run) -- not a fixed
// script of N steps.
function startRepairFakeLlm(port: number) {
  const server = createFakeLlmServer(async (req, res) => {
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
    const toolMessages = body.messages.filter((m: any) => m.role === 'tool')
    const lastTool = toolMessages[toolMessages.length - 1]
    const lastToolResult = lastTool ? JSON.parse(lastTool.content) : null

    function respondWithToolCall(id: string, name: string, args: Record<string, unknown>) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
        }),
      )
    }
    function respondWithAnswer(text: string) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: text } }] }))
    }

    if (!lastTool) {
      // First turn: run the tests to see real, current state.
      return respondWithToolCall('call_1', 'run_project_command', { command: 'npm test' })
    }

    if (lastTool.name === 'run_project_command') {
      if (lastToolResult.success === false) {
        // Real failure observed -- diagnose from the real stderr and fix it.
        return respondWithToolCall('call_2', 'patch_project_file', { path: 'flag.txt', old_text: 'broken', new_text: 'fixed' })
      }
      return respondWithAnswer('Tests pass now (verified by re-running `npm test`, which exited successfully).')
    }

    if (lastTool.name === 'patch_project_file') {
      // Re-run the real test command to verify the fix actually worked --
      // never claim success from the patch alone.
      return respondWithToolCall('call_3', 'run_project_command', { command: 'npm test' })
    }

    return respondWithAnswer('Unexpected state.')
  })
  return new Promise<import('node:http').Server>((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

let projectDir: string
let db: Db
let fakeLlm: import('node:http').Server
let httpServer: import('node:http').Server
let baseUrl: string
const authToken = 'repair-test-token'

before(async () => {
  projectDir = buildFixtureProject()
  db = openDb(':memory:')
  grantPermission(db, 'project', projectDir, 'write')
  grantPermission(db, 'command_execution', '*', 'execute')

  fakeLlm = await startRepairFakeLlm(18082)
  const modelProcess = new LocalModelProcess(18082)
  ;(modelProcess as any).child = { exitCode: null, killed: false }

  const config: RuntimeConfig = { port: 0, authToken, projectRoot: projectDir, allowedOrigins: [] }
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

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}`, ...init.headers },
  })
  return { status: response.status, body: (await response.json()) as any }
}

async function approveNextPending(): Promise<any> {
  const { body } = await api('/approvals')
  const pending = body.approvals.find((a: any) => a.status === 'pending')
  assert.ok(pending, 'expected a pending approval to approve')
  const decided = await api(`/approvals/${pending.id}/decide`, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) })
  return decided.body
}

test('agent inspects a real failing test, diagnoses it, repairs it, and re-verifies with the real test command', async () => {
  assert.equal(readFileSync(join(projectDir, 'flag.txt'), 'utf8').trim(), 'broken')

  // Round 1: agent runs `npm test` for real -- it will actually fail.
  let result = (await api('/chat', { method: 'POST', body: JSON.stringify({ message: 'Run the tests and fix them if they fail.' }) })).body
  assert.equal(result.status, 'waiting_approval')
  assert.equal(result.approvalTool, 'run_project_command')

  result = await approveNextPending()
  assert.equal(result.status, 'waiting_approval', 'should now be asking to patch flag.txt after a real observed failure')
  assert.equal(result.approvalTool, 'patch_project_file')

  // The patch has not been approved yet -- file must still be broken.
  assert.equal(readFileSync(join(projectDir, 'flag.txt'), 'utf8').trim(), 'broken')

  result = await approveNextPending()
  assert.equal(readFileSync(join(projectDir, 'flag.txt'), 'utf8').trim(), 'fixed', 'patch should have actually been applied to disk')
  assert.equal(result.status, 'waiting_approval', 'should re-run the real test command to verify, not just claim success')
  assert.equal(result.approvalTool, 'run_project_command')

  result = await approveNextPending()
  assert.equal(result.status, 'completed')
  assert.match(result.answer, /pass/i)

  const runResults = result.executedTools.filter((t: any) => t.tool === 'run_project_command')
  assert.equal(runResults.length, 2, 'expected the test command to have actually run twice: once failing, once passing')
  assert.equal(runResults[0].result.success, false)
  assert.equal(runResults[1].result.success, true)
})
