import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { runProjectCommand } from '../dist/run_command.js'

// Real audit finding closed: runProjectCommand used to call spawnSync,
// which blocks the entire single-threaded Node.js event loop -- not just
// the caller -- for up to the command's timeout. Since local-runtime is
// one process serving every HTTP route, a single run_project_command
// tool call (e.g. `npm test` during self-repair) froze the ENTIRE
// runtime, including unrelated chat requests and even a cancellation
// request, for that whole window. This file directly proves the async
// (spawn-based) rewrite: real success/failure/allowlist behavior
// unchanged, plus the two things spawnSync structurally could never
// support -- the event loop staying free while a command runs, and a
// real external AbortSignal actually killing the child process instead
// of only being checkable after the fact.

const tempDirs: string[] = []
function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}
after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

test('runProjectCommand rejects a command not on the allowlist without spawning anything', async () => {
  const root = tempDir('yahalla-run-command-test-')
  const result = await runProjectCommand(root, { command: 'rm -rf /' }, ['git status'])
  assert.equal(result.success, false)
  assert.match(String(result.error), /not in the allowlist/)
})

test('runProjectCommand rejects an allowlisted string whose binary is not itself allowlisted', async () => {
  const root = tempDir('yahalla-run-command-test-')
  const result = await runProjectCommand(root, { command: 'curl http://evil.example' }, ['curl http://evil.example'])
  assert.equal(result.success, false)
  assert.match(String(result.error), /not allowlisted/)
})

test('runProjectCommand actually runs a real allowlisted command asynchronously and reports its real exit code/output', async () => {
  const root = tempDir('yahalla-run-command-test-')
  const result = await runProjectCommand(root, { command: 'git status' }, ['git status'])
  // Not a git repo -- the real, meaningful assertion is that this is a
  // genuine spawned process result (a real non-zero exit and real stderr
  // text from git itself), not a a stub.
  assert.equal(result.success, false)
  assert.equal(typeof result.exit_code, 'number')
  assert.notEqual(result.exit_code, 0)
  assert.ok(String(result.stderr).trim().length > 0)
})

test('runProjectCommand: an already-aborted signal is rejected before any process is spawned', async () => {
  const root = tempDir('yahalla-run-command-test-')
  const controller = new AbortController()
  controller.abort()
  const result = await runProjectCommand(root, { command: 'git status' }, ['git status'], controller.signal)
  assert.equal(result.success, false)
  assert.match(String(result.error), /cancelled before it started/)
})

test('runProjectCommand: aborting mid-execution actually kills the real subprocess, quickly, instead of waiting for its own completion', async () => {
  const root = tempDir('yahalla-run-command-test-')
  const scriptDir = tempDir('yahalla-run-command-script-')
  const scriptPath = join(scriptDir, 'sleep.js')
  // A real long-running process (10s) -- if the abort signal did nothing,
  // this test would take 10s (or hit the 120s command timeout) instead of
  // the ~200ms this asserts on.
  writeFileSync(scriptPath, 'setTimeout(() => {}, 10_000)')

  const controller = new AbortController()
  const startedAt = Date.now()
  const resultPromise = runProjectCommand(root, { command: `node ${scriptPath}` }, [`node ${scriptPath}`], controller.signal)
  setTimeout(() => controller.abort(), 200)

  const result = await resultPromise
  const elapsedMs = Date.now() - startedAt
  assert.equal(result.success, false)
  assert.match(String(result.error), /cancelled/i)
  assert.ok(elapsedMs < 5000, `expected the subprocess to be killed within a few seconds of aborting, took ${elapsedMs}ms`)
})

// The concrete, structural proof that this is genuinely non-blocking now
// (the actual point of moving off spawnSync): while a real subprocess is
// still running, ordinary async work elsewhere in the same process
// continues to make progress instead of the whole event loop being
// frozen until the command finishes.
test('runProjectCommand does not block the event loop while a command is running', async () => {
  const root = tempDir('yahalla-run-command-test-')
  const scriptDir = tempDir('yahalla-run-command-script-')
  const scriptPath = join(scriptDir, 'sleep.js')
  writeFileSync(scriptPath, 'setTimeout(() => {}, 1_000)')

  let ticks = 0
  const ticker = setInterval(() => ticks++, 20)
  try {
    await runProjectCommand(root, { command: `node ${scriptPath}` }, [`node ${scriptPath}`])
  } finally {
    clearInterval(ticker)
  }
  // A blocked event loop would let zero (or almost zero) timer ticks fire
  // during the ~1s the command was running; a healthy one lets most of
  // them through.
  assert.ok(ticks > 5, `expected the event loop to keep ticking while the command ran, only saw ${ticks} ticks`)
})
