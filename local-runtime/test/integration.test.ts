import assert from 'node:assert/strict'
import { createServer as createFakeLlmServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { openDb, type Db } from '../src/db.js'
import { grantPermission, checkAccess } from '../src/permissions.js'
import { LocalModelProcess } from '../src/llm.js'
import { createHttpServer } from '../src/server.js'
import type { RuntimeConfig } from '../src/config.js'
import { listMemory } from '../src/memory.js'

// A fake OpenAI-compatible local LLM: round 1 always asks to call
// read_project_file on README.md, round 2 (once it sees the tool result in
// the conversation) answers using that content. Also handles a
// "please write" trigger message that requests write_project_file instead,
// to exercise the approval-gated path.
function startFakeLlm(port: number) {
  const server = createFakeLlmServer(async (req, res) => {
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }))
      return
    }
    if (req.url === '/v1/chat/completions' && req.method === 'POST') {
      const chunks: Buffer[] = []
      for await (const c of req) chunks.push(c as Buffer)
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      const lastUser = [...body.messages].reverse().find((m: any) => m.role === 'user')
      const hasToolResult = body.messages.some((m: any) => m.role === 'tool')

      res.writeHead(200, { 'Content-Type': 'application/json' })

      if (hasToolResult) {
        res.end(
          JSON.stringify({
            choices: [{ message: { role: 'assistant', content: 'The project version is 0.0.0, read from package.json.' } }],
          }),
        )
        return
      }

      if (String(lastUser?.content ?? '').includes('write')) {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_write_1',
                      type: 'function',
                      function: { name: 'write_project_file', arguments: JSON.stringify({ path: 'output.txt', content: 'hello' }) },
                    },
                  ],
                },
              },
            ],
          }),
        )
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
                  {
                    id: 'call_read_1',
                    type: 'function',
                    function: { name: 'read_project_file', arguments: JSON.stringify({ path: 'package.json' }) },
                  },
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
  return new Promise<import('node:http').Server>((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

let projectDir: string
let db: Db
let fakeLlm: import('node:http').Server
let httpServer: import('node:http').Server
let baseUrl: string
let authToken = 'test-token'

before(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'yahalla-runtime-test-'))
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))

  db = openDb(':memory:')
  grantPermission(db, 'project', projectDir, 'write')

  fakeLlm = await startFakeLlm(18081)

  const modelProcess = new LocalModelProcess(18081)
  // Force isRunning()/baseUrl to point at our fake server without actually
  // spawning a child process -- we're testing the runtime's HTTP+DB+tool
  // logic here, not llama.cpp itself (which needs a real model file).
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

test('health endpoint requires no auth and reports runtime status', async () => {
  const response = await fetch(`${baseUrl}/health`)
  const body = (await response.json()) as any
  assert.equal(response.status, 200)
  assert.equal(body.runtime, 'local')
})

test('unauthenticated requests to protected routes are rejected', async () => {
  const response = await fetch(`${baseUrl}/tasks`)
  assert.equal(response.status, 401)
})

test('permission check reflects the granted project permission', async () => {
  assert.equal(checkAccess(db, 'project', projectDir, 'write'), true)
  assert.equal(checkAccess(db, 'project', projectDir, 'execute'), false)
})

test('chat: read-only tool executes inline and produces a grounded answer', async () => {
  const { status, body } = await api('/chat', { method: 'POST', body: JSON.stringify({ message: 'read package.json and tell me the version' }) })
  assert.equal(status, 200)
  assert.equal(body.status, 'completed')
  assert.match(body.answer, /0\.0\.0/)
  assert.equal(body.executedTools.length, 1)
  assert.equal(body.executedTools[0].tool, 'read_project_file')
  assert.equal(body.executedTools[0].result.success, true)
})

test('chat persists conversation messages and local memory', async () => {
  const { body: conversations } = await api('/conversations')
  assert.ok(conversations.conversations.length >= 1)
  const conv = conversations.conversations[0]
  const { body: messages } = await api(`/conversations/${conv.id}/messages`)
  assert.ok(messages.messages.some((m: any) => m.role === 'user'))
  assert.ok(messages.messages.some((m: any) => m.role === 'assistant'))
  assert.ok(listMemory(db).length >= 1)
})

test('chat: dangerous tool pauses for approval and does not execute yet', async () => {
  const { body } = await api('/chat', { method: 'POST', body: JSON.stringify({ message: 'please write a file' }) })
  assert.equal(body.status, 'waiting_approval')
  assert.equal(body.approvalTool, 'write_project_file')

  const { existsSync } = await import('node:fs')
  assert.equal(existsSync(join(projectDir, 'output.txt')), false)
})

test('approving the pending approval actually executes the write and completes the task', async () => {
  const { body: approvals } = await api('/approvals')
  const pending = approvals.approvals.find((a: any) => a.status === 'pending')
  assert.ok(pending, 'expected a pending approval')

  const { body } = await api(`/approvals/${pending.id}/decide`, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) })
  assert.equal(body.status, 'completed')

  const { readFileSync, existsSync } = await import('node:fs')
  assert.equal(existsSync(join(projectDir, 'output.txt')), true)
  assert.equal(readFileSync(join(projectDir, 'output.txt'), 'utf8'), 'hello')
})

test('knowledge persists locally and is readable back', async () => {
  await api('/knowledge', { method: 'POST', body: JSON.stringify({ title: 'Deploy notes', content: 'Run npm run build then npm run deploy.' }) })
  const { body } = await api('/knowledge')
  assert.ok(body.knowledge.some((k: any) => k.title === 'Deploy notes'))
})

test('user preferences persist locally and round-trip', async () => {
  await api('/preferences', { method: 'POST', body: JSON.stringify({ key: 'max_tool_rounds', value: 20 }) })
  const { body } = await api('/preferences')
  assert.equal(body.preferences.max_tool_rounds, 20)
})

test('skills/procedures persist locally', async () => {
  const { upsertSkill, listSkills, recordSkillOutcome } = await import('../src/memory.js')
  upsertSkill(db, 'run-fixture-tests', 'Run fixture tests', 'Use `npm test` in the project root.')
  recordSkillOutcome(db, 'run-fixture-tests', true)
  const skills = listSkills(db)
  const skill = skills.find((s) => s.key === 'run-fixture-tests')
  assert.ok(skill)
  assert.equal(skill!.success_count, 1)
})

test('revoked project permission blocks tool execution even for an approved action', async () => {
  const { revokePermission } = await import('../src/permissions.js')
  revokePermission(db, 'project', projectDir)

  const chat = await api('/chat', { method: 'POST', body: JSON.stringify({ message: 'please write a file' }) })
  assert.equal(chat.body.status, 'waiting_approval')

  const { body: approvals } = await api('/approvals')
  const pending = approvals.approvals.find((a: any) => a.status === 'pending')

  const decided = await api(`/approvals/${pending.id}/decide`, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) })
  // The approval succeeds as an *approval*, but the tool result inside it
  // must reflect the permission denial -- approval and permission are
  // independent gates.
  assert.equal(decided.status, 200)

  const { body: approvalsAfter } = await api('/approvals')
  const decidedApproval = approvalsAfter.approvals.find((a: any) => a.id === pending.id)
  assert.equal(decidedApproval.status, 'approved')

  const toolResult = JSON.parse(decidedApproval.result)
  assert.equal(toolResult.success, false)
  assert.match(toolResult.error, /Permission denied/)
})
