import assert from 'node:assert/strict'
import { createServer as createFakeHttpServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { openDb, type Db } from '../src/db.js'
import { grantPermission, checkAccess } from '../src/permissions.js'
import { LocalModelProcess } from '../src/llm.js'
import { createHttpServer } from '../src/server.js'
import type { RuntimeConfig } from '../src/config.js'
import { listMemory, setPreference } from '../src/memory.js'

// A fake OpenAI-compatible local LLM: round 1 always asks to call
// read_project_file on README.md, round 2 (once it sees the tool result in
// the conversation) answers using that content. A "please write" trigger
// requests write_project_file (now non-gated, part of the autonomous
// coding loop -- see tools.ts), and a "create a repo" trigger requests
// github.write (create_repo), which is still the one approval-gated
// GitHub action.
function startFakeLlm(port: number) {
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

      if (String(lastUser?.content ?? '').includes('create a repo')) {
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  role: 'assistant',
                  content: null,
                  tool_calls: [
                    {
                      id: 'call_repo_1',
                      type: 'function',
                      function: { name: 'github.write', arguments: JSON.stringify({ operation: 'create_repo', name: 'new-project' }) },
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

// Stands in for api.github.com, just for the still approval-gated
// github.write(create_repo) path -- validates the bearer token and records
// whether a repo-creation request actually landed, so the test can prove
// the real API call only happens after approval, not before.
let githubCreateRepoCalls = 0
function startFakeGithub(port: number) {
  const server = createFakeHttpServer(async (req, res) => {
    if (req.url === '/user/repos' && req.method === 'POST') {
      githubCreateRepoCalls++
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ name: 'new-project', full_name: 'octo-owner/new-project', private: true, html_url: 'https://github.com/octo-owner/new-project' }))
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
let fakeGithub: import('node:http').Server
let httpServer: import('node:http').Server
let baseUrl: string
let authToken = 'test-token'

before(async () => {
  projectDir = mkdtempSync(join(tmpdir(), 'yahalla-runtime-test-'))
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))

  db = openDb(':memory:')
  grantPermission(db, 'project', projectDir, 'write')
  grantPermission(db, 'network', '*', 'write')
  setPreference(db, 'github_token', 'fake-token')

  fakeLlm = await startFakeLlm(18081)
  fakeGithub = await startFakeGithub(18083)
  process.env.GITHUB_API_BASE_URL = 'http://127.0.0.1:18083'

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
  fakeGithub.close()
  delete process.env.GITHUB_API_BASE_URL
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

test('chat: write_project_file executes immediately, no approval needed (autonomous coding loop)', async () => {
  const { body } = await api('/chat', { method: 'POST', body: JSON.stringify({ message: 'please write a file' }) })
  assert.equal(body.status, 'completed')
  assert.equal(body.executedTools[0].tool, 'write_project_file')
  assert.equal(body.executedTools[0].result.success, true)

  const { readFileSync, existsSync } = await import('node:fs')
  assert.equal(existsSync(join(projectDir, 'output.txt')), true)
  assert.equal(readFileSync(join(projectDir, 'output.txt'), 'utf8'), 'hello')
})

test('chat: github.write (create_repo) still pauses for approval and does not call GitHub yet', async () => {
  const before = githubCreateRepoCalls
  const { body } = await api('/chat', { method: 'POST', body: JSON.stringify({ message: 'create a repo for this' }) })
  assert.equal(body.status, 'waiting_approval')
  assert.equal(body.approvalTool, 'github.write')
  assert.equal(githubCreateRepoCalls, before, 'GitHub must not be called before approval')
})

test('approving the pending github.write approval actually calls the real GitHub API', async () => {
  const before = githubCreateRepoCalls
  const { body: approvals } = await api('/approvals')
  const pending = approvals.approvals.find((a: any) => a.status === 'pending')
  assert.ok(pending, 'expected a pending approval')
  assert.equal(pending.tool_key, 'github.write')

  const { body } = await api(`/approvals/${pending.id}/decide`, { method: 'POST', body: JSON.stringify({ decision: 'approve' }) })
  assert.equal(body.status, 'completed')
  assert.equal(githubCreateRepoCalls, before + 1, 'expected exactly one real call to the fake GitHub server')
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

test('revoked project permission blocks a write from executing, inline, with a clear denial', async () => {
  const { revokePermission } = await import('../src/permissions.js')
  revokePermission(db, 'project', projectDir)

  // write_project_file is no longer approval-gated (see tools.ts), so a
  // revoked permission must now be caught inline, at execution time --
  // the chat still completes (the model sees the denial and can react to
  // it), it just never touches the filesystem.
  const chat = await api('/chat', { method: 'POST', body: JSON.stringify({ message: 'please write a file' }) })
  assert.equal(chat.body.status, 'completed')
  assert.equal(chat.body.executedTools[0].tool, 'write_project_file')
  assert.equal(chat.body.executedTools[0].result.success, false)
  assert.match(chat.body.executedTools[0].result.error, /Permission denied/)

  grantPermission(db, 'project', projectDir, 'write')
})
