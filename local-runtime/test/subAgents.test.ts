import assert from 'node:assert/strict'
import { createServer as createFakeHttpServer } from 'node:http'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { openDb, type Db } from '../src/db.js'
import { grantPermission } from '../src/permissions.js'
import { LocalModelProcess } from '../src/llm.js'
import { createHttpServer } from '../src/server.js'
import type { RuntimeConfig } from '../src/config.js'
import { getSubAgentProfile, SUB_AGENT_PROFILES } from '../src/subAgents.js'

// Unit-level: the profile registry itself is real, static data -- worth
// asserting its shape directly (no tool overlaps with dispatch_subagent,
// every profile has a real bounded round budget).

test('every sub-agent profile has a positive round budget and never includes dispatch_subagent itself', () => {
  for (const profile of Object.values(SUB_AGENT_PROFILES)) {
    assert.ok(profile.maxRounds > 0)
    assert.ok(profile.allowedToolKeys.length > 0)
    assert.equal(profile.allowedToolKeys.includes('dispatch_subagent'), false, `${profile.key} must never be able to nest-dispatch`)
  }
})

test('getSubAgentProfile returns undefined for an unknown key, not a crash', () => {
  assert.equal(getSubAgentProfile('not-a-real-profile'), undefined)
  assert.equal(getSubAgentProfile('researcher')?.name, 'Researcher')
})

// --- Integration: the real /chat surface, dispatching to a real
// sub-agent loop that makes its own real LLM calls (against the same fake
// server, distinguished by its distinct system prompt) and its own real
// tool calls (through the same executeToolNow/permission machinery as any
// top-level tool call) -- proving the orchestrator actually receives a
// result produced by a genuinely different, restricted execution context,
// not a cosmetic label.

function isSubAgentRequest(body: any): boolean {
  const sys = body.messages.find((m: any) => m.role === 'system')
  return typeof sys?.content === 'string' && sys.content.includes('specialized Yahalla AI sub-agent')
}

function taskTextOf(body: any): string {
  return String(body.messages.find((m: any) => m.role === 'user')?.content ?? '')
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
    const toolMessages = body.messages.filter((m: any) => m.role === 'tool')

    if (isSubAgentRequest(body)) {
      const task = taskTextOf(body)

      if (task.includes('find the version')) {
        if (toolMessages.length === 0) {
          toolCallResponse(res, 'sub_call_read', 'read_project_file', { path: 'package.json' })
          return
        }
        answerResponse(res, 'The version is 0.0.0, read from package.json.')
        return
      }

      if (task.includes('attempt to write a file')) {
        if (toolMessages.length === 0) {
          toolCallResponse(res, 'sub_call_write', 'write_project_file', { path: 'x.txt', content: 'should not land' })
          return
        }
        answerResponse(res, 'Not permitted to write as this sub-agent.')
        return
      }

      answerResponse(res, 'sub-agent no-op')
      return
    }

    const firstUser = body.messages.find((m: any) => m.role === 'user')
    const content = String(firstUser?.content ?? '')

    if (content.includes('orchestrate-test')) {
      if (toolMessages.length === 0) {
        toolCallResponse(res, 'call_dispatch', 'dispatch_subagent', { profile: 'researcher', task: 'find the version in package.json' })
        return
      }
      answerResponse(res, 'orchestration-done')
      return
    }

    if (content.includes('orchestrate-restricted-test')) {
      if (toolMessages.length === 0) {
        toolCallResponse(res, 'call_dispatch', 'dispatch_subagent', { profile: 'tester', task: 'attempt to write a file' })
        return
      }
      answerResponse(res, 'orchestration-restricted-done')
      return
    }

    if (content.includes('orchestrate-bad-profile-test')) {
      if (toolMessages.length === 0) {
        toolCallResponse(res, 'call_dispatch', 'dispatch_subagent', { profile: 'astronaut', task: 'go to space' })
        return
      }
      answerResponse(res, 'orchestration-bad-profile-done')
      return
    }

    answerResponse(res, 'no-op')
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
  projectDir = mkdtempSync(join(tmpdir(), 'yahalla-subagent-test-'))
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))

  db = openDb(':memory:')
  grantPermission(db, 'project', projectDir, 'write')

  fakeLlm = await startFakeLlm(18409)
  const modelProcess = new LocalModelProcess(18409)
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

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}`, ...init.headers },
  })
  return { status: response.status, body: (await response.json()) as any }
}

test('dispatch_subagent runs a real, independent sub-agent loop and returns its real findings to the orchestrator', async () => {
  const { body } = await api('/chat', { method: 'POST', body: JSON.stringify({ message: 'orchestrate-test please delegate research' }) })
  assert.equal(body.status, 'completed')
  assert.equal(body.answer, 'orchestration-done')
  assert.equal(body.executedTools.length, 1)

  const dispatch = body.executedTools[0]
  assert.equal(dispatch.tool, 'dispatch_subagent')
  assert.equal(dispatch.result.success, true)
  assert.equal(dispatch.result.profile, 'researcher')
  assert.match(dispatch.result.report, /0\.0\.0/)
  assert.deepEqual(dispatch.result.tools_used, ['read_project_file'])
  assert.equal(dispatch.result.executed_tools[0].tool, 'read_project_file')
  assert.equal(dispatch.result.executed_tools[0].result.success, true)
})

test('a sub-agent profile cannot use a tool outside its allowlist, even though the top-level agent could', async () => {
  const { body } = await api('/chat', { method: 'POST', body: JSON.stringify({ message: 'orchestrate-restricted-test please delegate' }) })
  assert.equal(body.status, 'completed')
  assert.equal(body.answer, 'orchestration-restricted-done')

  const dispatch = body.executedTools[0]
  assert.equal(dispatch.tool, 'dispatch_subagent')
  assert.equal(dispatch.result.profile, 'tester')
  // The sub-agent's own loop still finished (success:true, it reported
  // back), but write_project_file itself was refused before it could run.
  assert.equal(dispatch.result.success, true)
  assert.match(dispatch.result.report, /Not permitted/)
  assert.deepEqual(dispatch.result.executed_tools, [])
  assert.equal(existsSync(join(projectDir, 'x.txt')), false, 'a tool outside the profile allowlist must never actually execute')
})

test('dispatching to an unknown profile fails cleanly with a clear error, no crash', async () => {
  const { body } = await api('/chat', { method: 'POST', body: JSON.stringify({ message: 'orchestrate-bad-profile-test please delegate' }) })
  assert.equal(body.status, 'completed')
  assert.equal(body.answer, 'orchestration-bad-profile-done')

  const dispatch = body.executedTools[0]
  assert.equal(dispatch.tool, 'dispatch_subagent')
  assert.equal(dispatch.result.success, false)
  assert.match(dispatch.result.error, /Unknown sub-agent profile/)
})
