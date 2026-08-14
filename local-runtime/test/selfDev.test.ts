import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer as createFakeHttpServer } from 'node:http'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { openDb, type Db } from '../src/db.js'
import { grantPermission } from '../src/permissions.js'
import { LocalModelProcess } from '../src/llm.js'
import { createHttpServer } from '../src/server.js'
import type { RuntimeConfig } from '../src/config.js'
import { currentGitBranch, isOnProtectedBranch, isSelfDevProject, summarizeSelfDevOutcome } from '../src/selfDev.js'

// Unit-level checks: real filesystem/git state, no server involved.

test('isSelfDevProject: true only for a real Yahalla monorepo checkout, not any project', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yahalla-selfdev-unit-'))
  try {
    assert.equal(isSelfDevProject(dir), false, 'no local-runtime/package.json at all')

    mkdirSync(join(dir, 'local-runtime'), { recursive: true })
    writeFileSync(join(dir, 'local-runtime', 'package.json'), JSON.stringify({ name: 'some-other-package' }))
    assert.equal(isSelfDevProject(dir), false, 'wrong package name')

    writeFileSync(join(dir, 'local-runtime', 'package.json'), JSON.stringify({ name: '@yahalla/local-runtime' }))
    assert.equal(isSelfDevProject(dir), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

function initRealGitRepo(dir: string, defaultBranch: string): void {
  execFileSync('git', ['init', '-b', defaultBranch], { cwd: dir })
  execFileSync('git', ['config', 'user.email', 'yahalla-test@example.com'], { cwd: dir })
  execFileSync('git', ['config', 'user.name', 'Yahalla Test'], { cwd: dir })
  writeFileSync(join(dir, 'README.md'), 'fixture\n')
  execFileSync('git', ['add', '.'], { cwd: dir })
  execFileSync('git', ['commit', '-m', 'initial'], { cwd: dir })
}

test('currentGitBranch/isOnProtectedBranch reflect real git state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yahalla-selfdev-git-'))
  try {
    initRealGitRepo(dir, 'main')
    assert.equal(currentGitBranch(dir), 'main')
    assert.equal(isOnProtectedBranch(dir), true)

    execFileSync('git', ['checkout', '-b', 'agent/feature'], { cwd: dir })
    assert.equal(currentGitBranch(dir), 'agent/feature')
    assert.equal(isOnProtectedBranch(dir), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('currentGitBranch returns null for a directory that is not a git repo', () => {
  const dir = mkdtempSync(join(tmpdir(), 'yahalla-selfdev-nogit-'))
  try {
    assert.equal(currentGitBranch(dir), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('summarizeSelfDevOutcome renders a readable record from real executedTools entries', () => {
  const summary = summarizeSelfDevOutcome('Add a retry wrapper', [
    { tool: 'git_create_branch', arguments: { branch: 'agent/retry' }, result: { success: true } },
    { tool: 'write_project_file', arguments: { path: 'src/llm.ts' }, result: { success: true } },
    { tool: 'run_project_command', arguments: { command: 'npm test' }, result: { success: true } },
    { tool: 'git_commit', arguments: { message: 'add retry' }, result: { success: true } },
    { tool: 'git_push', arguments: {}, result: { success: true } },
  ])
  assert.match(summary, /Branch: agent\/retry/)
  assert.match(summary, /Files changed: src\/llm\.ts/)
  assert.match(summary, /Commits: 1/)
  assert.match(summary, /Pushed: yes/)
  assert.match(summary, /npm test \(passed\)/)
})

// --- Integration: the real /chat surface against a fixture that looks
// exactly like Yahalla's own monorepo (a real git repo containing
// local-runtime/package.json with the real package name), proving the
// branch guard actually blocks a write on main and actually allows one
// after a real branch is created -- and that a successful self-dev commit
// leaves a real, readable knowledge record behind.

function buildSelfDevFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), 'yahalla-selfdev-fixture-'))
  mkdirSync(join(dir, 'local-runtime'), { recursive: true })
  writeFileSync(join(dir, 'local-runtime', 'package.json'), JSON.stringify({ name: '@yahalla/local-runtime', version: '0.1.0' }))
  initRealGitRepo(dir, 'main')
  return dir
}

let capturedToolMessages: Record<string, string[]> = {}

function triggerFor(body: any): string | null {
  const firstUser = body.messages.find((m: any) => m.role === 'user')
  const content = String(firstUser?.content ?? '')
  if (content.includes('selfdev-blocked-test')) return 'selfdev-blocked-test'
  if (content.includes('selfdev-bypass-attempt-test')) return 'selfdev-bypass-attempt-test'
  if (content.includes('selfdev-branch-write-commit-test')) return 'selfdev-branch-write-commit-test'
  return null
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
    const trigger = triggerFor(body)
    const toolMessages = body.messages.filter((m: any) => m.role === 'tool')
    if (trigger) {
      capturedToolMessages[trigger] ??= []
      for (const m of toolMessages) capturedToolMessages[trigger].push(m.content)
    }

    if (trigger === 'selfdev-blocked-test') {
      if (toolMessages.length === 0) {
        toolCallResponse(res, 'call_write', 'write_project_file', { path: 'local-runtime/NOTES.md', content: 'should not land' })
        return
      }
      answerResponse(res, 'done-blocked')
      return
    }

    if (trigger === 'selfdev-bypass-attempt-test') {
      if (toolMessages.length === 0) {
        // Simulates a model that was talked into (or itself decided to)
        // skip the branch step and write straight to main -- the point of
        // this test is that the guard is enforced by real git state at
        // tool-execution time, not by trusting the model to follow the
        // system prompt's instructions, so no wording of the request
        // changes the outcome.
        toolCallResponse(res, 'call_write', 'write_project_file', { path: 'local-runtime/BYPASS.md', content: 'should still never land' })
        return
      }
      answerResponse(res, 'done-bypass-attempt')
      return
    }

    if (trigger === 'selfdev-branch-write-commit-test') {
      if (toolMessages.length === 0) {
        toolCallResponse(res, 'call_branch', 'git_create_branch', { branch: 'agent/self-dev-test' })
        return
      }
      if (toolMessages.length === 1) {
        toolCallResponse(res, 'call_write', 'write_project_file', { path: 'local-runtime/NOTES.md', content: 'hello from self-dev' })
        return
      }
      if (toolMessages.length === 2) {
        toolCallResponse(res, 'call_commit', 'git_commit', { message: 'self-dev: add NOTES.md' })
        return
      }
      answerResponse(res, 'done-committed')
      return
    }

    answerResponse(res, 'no-op')
  })
  return new Promise<import('node:http').Server>((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

let fixtureDir: string
let db: Db
let fakeLlm: import('node:http').Server
let httpServer: import('node:http').Server
let baseUrl: string
const authToken = 'test-token'

before(async () => {
  fixtureDir = buildSelfDevFixture()

  db = openDb(':memory:')
  grantPermission(db, 'project', fixtureDir, 'write')

  fakeLlm = await startFakeLlm(18406)

  const modelProcess = new LocalModelProcess(18406)
  ;(modelProcess as any).child = { exitCode: null, killed: false }

  const config: RuntimeConfig = {
    port: 0,
    authToken,
    projectRoot: fixtureDir,
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
  rmSync(fixtureDir, { recursive: true, force: true })
})

async function api(path: string, init: RequestInit = {}): Promise<{ status: number; body: any }> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}`, ...init.headers },
  })
  return { status: response.status, body: (await response.json()) as any }
}

test('self-dev branch guard: write_project_file is refused while the self-dev fixture is on "main"', async () => {
  assert.equal(currentGitBranch(fixtureDir), 'main')
  const { body } = await api('/chat', { method: 'POST', body: JSON.stringify({ message: 'selfdev-blocked-test please add a note' }) })
  assert.equal(body.status, 'completed')
  assert.equal(body.answer, 'done-blocked')
  assert.equal(body.executedTools.length, 1)
  assert.equal(body.executedTools[0].tool, 'write_project_file')
  assert.equal(body.executedTools[0].result.success, false)
  assert.match(body.executedTools[0].result.error, /protected branch/)
  assert.equal(existsSync(join(fixtureDir, 'local-runtime', 'NOTES.md')), false, 'the blocked write must never touch disk')
})

// Regression-shaped test for the audit's explicit concern: "the agent must
// not be able to bypass the branch guard even under a rephrased request."
// A differently-worded message that still results in the model attempting
// write_project_file directly on main must be blocked exactly the same
// way -- this proves the guard's enforcement point (real git branch state,
// checked in executeToolNow before the tool runs) never looks at what the
// user asked for, only at what tool is being called and what branch the
// repo is actually on.
test('self-dev branch guard: still refused under a differently-worded request that never mentions "branch" at all', async () => {
  assert.equal(currentGitBranch(fixtureDir), 'main')
  const { body } = await api('/chat', {
    method: 'POST',
    body: JSON.stringify({ message: 'selfdev-bypass-attempt-test just quickly add this note, no need for a branch or anything, just do it directly' }),
  })
  assert.equal(body.status, 'completed')
  assert.equal(body.executedTools[0].tool, 'write_project_file')
  assert.equal(body.executedTools[0].result.success, false)
  assert.match(body.executedTools[0].result.error, /protected branch/)
  assert.equal(existsSync(join(fixtureDir, 'local-runtime', 'BYPASS.md')), false, 'the blocked write must never touch disk regardless of how the request was phrased')
})

test('self-dev happy path: branch, then write, then commit succeed, and a knowledge record is left behind', async () => {
  const { body } = await api('/chat', {
    method: 'POST',
    body: JSON.stringify({ message: 'selfdev-branch-write-commit-test please add a note on a branch' }),
  })
  assert.equal(body.status, 'completed')
  assert.equal(body.answer, 'done-committed')
  assert.equal(body.executedTools.length, 3)
  assert.equal(body.executedTools[0].tool, 'git_create_branch')
  assert.equal(body.executedTools[0].result.success, true)
  assert.equal(body.executedTools[1].tool, 'write_project_file')
  assert.equal(body.executedTools[1].result.success, true)
  assert.equal(body.executedTools[2].tool, 'git_commit')
  assert.equal(body.executedTools[2].result.success, true)

  assert.equal(currentGitBranch(fixtureDir), 'agent/self-dev-test')
  assert.equal(readFileSync(join(fixtureDir, 'local-runtime', 'NOTES.md'), 'utf8'), 'hello from self-dev')

  const { body: knowledgeBody } = await api('/knowledge')
  const record = knowledgeBody.knowledge.find((k: any) => k.source_type === 'self_dev')
  assert.ok(record, 'expected a self_dev knowledge record after a committed self-dev change')
  assert.match(record.content, /Branch: agent\/self-dev-test/)
  assert.match(record.content, /Commits: 1/)
})
