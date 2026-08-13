import assert from 'node:assert/strict'
import { createServer as createFakeHttpServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { openDb, type Db } from '../src/db.js'
import { grantPermission } from '../src/permissions.js'
import { LocalModelProcess } from '../src/llm.js'
import { createHttpServer } from '../src/server.js'
import type { RuntimeConfig } from '../src/config.js'
import { canChangeRole, getDeviceRole, isToolAllowedForRole, setDeviceRole } from '../src/roles.js'

// --- Unit-level: pure role logic, no server.

test('getDeviceRole defaults to owner when nothing was ever explicitly set -- preserves existing single-user behavior', () => {
  const db = openDb(':memory:')
  assert.equal(getDeviceRole(db), 'owner')
})

test('setDeviceRole persists and getDeviceRole reflects it back', () => {
  const db = openDb(':memory:')
  setDeviceRole(db, 'normal')
  assert.equal(getDeviceRole(db), 'normal')
  setDeviceRole(db, 'trainer')
  assert.equal(getDeviceRole(db), 'trainer')
})

test('isToolAllowedForRole: normal role is read-only across every category', () => {
  const allowed = ['read_project_file', 'list_project_files', 'get_project_overview', 'git_status', 'git_diff', 'github.read', 'db_list_connections', 'db_query']
  const blocked = [
    'write_project_file',
    'patch_project_file',
    'git_create_branch',
    'git_commit',
    'git_push',
    'run_project_command',
    'github.write',
    'github.open_pr',
    'db_execute',
    'browser_open',
    'browser_click',
    'dispatch_subagent',
  ]
  for (const key of allowed) assert.equal(isToolAllowedForRole('normal', key), true, `expected ${key} allowed for normal`)
  for (const key of blocked) assert.equal(isToolAllowedForRole('normal', key), false, `expected ${key} blocked for normal`)
})

test('isToolAllowedForRole: owner and trainer both have full access to every tool key', () => {
  const keys = ['read_project_file', 'write_project_file', 'run_project_command', 'db_execute', 'browser_open', 'dispatch_subagent', 'some_future_tool_key']
  for (const key of keys) {
    assert.equal(isToolAllowedForRole('owner', key), true, `expected ${key} allowed for owner`)
    assert.equal(isToolAllowedForRole('trainer', key), true, `expected ${key} allowed for trainer`)
  }
})

test('canChangeRole: only owner/trainer can change a device role, never normal', () => {
  assert.equal(canChangeRole('owner'), true)
  assert.equal(canChangeRole('trainer'), true)
  assert.equal(canChangeRole('normal'), false)
})

// --- Integration: the real /chat and /role HTTP surface, proving the
// role gate holds through a real agentLoop tool-calling round, and that
// a normal-role session cannot escalate itself via the real endpoint.

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
    const firstUser = body.messages.find((m: any) => m.role === 'user')
    const content = String(firstUser?.content ?? '')

    if (content.includes('role-write-test-owner')) {
      if (toolMessages.length === 0) {
        toolCallResponse(res, 'call_write', 'write_project_file', { path: 'owner-write.txt', content: 'written by owner' })
        return
      }
      answerResponse(res, 'done-write-test')
      return
    }

    if (content.includes('role-write-test-normal')) {
      if (toolMessages.length === 0) {
        toolCallResponse(res, 'call_write', 'write_project_file', { path: 'blocked.txt', content: 'should not land' })
        return
      }
      answerResponse(res, 'done-write-test')
      return
    }

    if (content.includes('role-read-test')) {
      if (toolMessages.length === 0) {
        toolCallResponse(res, 'call_read', 'read_project_file', { path: 'package.json' })
        return
      }
      answerResponse(res, 'done-read-test')
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
  projectDir = mkdtempSync(join(tmpdir(), 'yahalla-roles-test-'))
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }))

  db = openDb(':memory:')
  grantPermission(db, 'project', projectDir, 'write')

  fakeLlm = await startFakeLlm(18440)
  const modelProcess = new LocalModelProcess(18440)
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

test('GET /role reports the real default (owner) on a fresh device', async () => {
  const { body } = await api('/role')
  assert.equal(body.role, 'owner')
})

test('a write tool succeeds normally while this device is owner-role (unchanged existing behavior)', async () => {
  const { body } = await api('/chat', { method: 'POST', body: JSON.stringify({ message: 'role-write-test-owner as owner' }) })
  assert.equal(body.status, 'completed')
  assert.equal(body.executedTools[0].tool, 'write_project_file')
  assert.equal(body.executedTools[0].result.success, true)
})

test('POST /role to normal succeeds while owner, and a normal-role session cannot escalate itself back', async () => {
  const setNormal = await api('/role', { method: 'POST', body: JSON.stringify({ role: 'normal' }) })
  assert.equal(setNormal.status, 200)
  assert.equal(setNormal.body.role, 'normal')

  const check = await api('/role')
  assert.equal(check.body.role, 'normal')

  const escalate = await api('/role', { method: 'POST', body: JSON.stringify({ role: 'owner' }) })
  assert.equal(escalate.status, 403)

  const stillNormal = await api('/role')
  assert.equal(stillNormal.body.role, 'normal', 'role must not have changed after the rejected escalation attempt')

  // Reset for later tests in this file.
  setDeviceRole(db, 'owner')
})

test('while normal-role, a write tool is blocked in code -- never actually touches disk -- but a read tool still works', async () => {
  setDeviceRole(db, 'normal')
  try {
    const writeAttempt = await api('/chat', { method: 'POST', body: JSON.stringify({ message: 'role-write-test-normal as normal' }) })
    assert.equal(writeAttempt.body.status, 'completed')
    assert.equal(writeAttempt.body.executedTools[0].tool, 'write_project_file')
    assert.equal(writeAttempt.body.executedTools[0].result.success, false)
    assert.match(writeAttempt.body.executedTools[0].result.error, /not available to the "normal" role/)

    const { existsSync } = await import('node:fs')
    assert.equal(existsSync(join(projectDir, 'blocked.txt')), false, 'a role-blocked write must never touch disk')

    const readAttempt = await api('/chat', { method: 'POST', body: JSON.stringify({ message: 'role-read-test as normal' }) })
    assert.equal(readAttempt.body.status, 'completed')
    assert.equal(readAttempt.body.executedTools[0].tool, 'read_project_file')
    assert.equal(readAttempt.body.executedTools[0].result.success, true)
  } finally {
    setDeviceRole(db, 'owner')
  }
})
