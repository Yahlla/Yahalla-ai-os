import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PathEscapeError, resolveProjectPath } from '../dist/sandbox.js'
import { executeDeviceTool } from '../dist/index.js'

// Real audit finding (production certification pass): this security-
// critical module -- the ONLY thing standing between a model-issued
// read_project_file/write_project_file/patch_project_file call and
// arbitrary filesystem access outside the project root -- had zero direct
// test coverage anywhere in the repository (packages/agent-tools had no
// test/ directory at all). These are the real adversarial path-traversal
// cases a malicious or confused tool call could attempt.

test('resolveProjectPath: a normal relative path inside the project resolves cleanly', () => {
  const root = mkdtempSync(join(tmpdir(), 'yahalla-sandbox-test-'))
  try {
    const resolved = resolveProjectPath(root, 'src/index.ts')
    assert.equal(resolved, join(root, 'src', 'index.ts'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveProjectPath: rejects an absolute path outright', () => {
  const root = mkdtempSync(join(tmpdir(), 'yahalla-sandbox-test-'))
  try {
    assert.throws(() => resolveProjectPath(root, '/etc/passwd'), PathEscapeError)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveProjectPath: rejects classic ../ traversal out of the project root', () => {
  const root = mkdtempSync(join(tmpdir(), 'yahalla-sandbox-test-'))
  try {
    assert.throws(() => resolveProjectPath(root, '../../../etc/passwd'), PathEscapeError)
    assert.throws(() => resolveProjectPath(root, '..'), PathEscapeError)
    assert.throws(() => resolveProjectPath(root, '../sibling-dir/file.txt'), PathEscapeError)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveProjectPath: rejects a traversal disguised inside a deeper-looking path', () => {
  const root = mkdtempSync(join(tmpdir(), 'yahalla-sandbox-test-'))
  try {
    // Looks like it stays "inside" at a glance, but normalizes to outside root.
    assert.throws(() => resolveProjectPath(root, 'src/../../outside.txt'), PathEscapeError)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('resolveProjectPath: rejects empty/non-string input rather than resolving to the root itself', () => {
  const root = mkdtempSync(join(tmpdir(), 'yahalla-sandbox-test-'))
  try {
    assert.throws(() => resolveProjectPath(root, ''), PathEscapeError)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Real symlink escape: a directory *inside* the project root that is
// actually a symlink pointing outside it -- resolveProjectPath must catch
// this via realpath, not just string-level "../" checking, since the
// string form of the requested path never mentions ".." at all.
test('resolveProjectPath: rejects a real symlink that escapes the project root', () => {
  const root = mkdtempSync(join(tmpdir(), 'yahalla-sandbox-test-'))
  const outside = mkdtempSync(join(tmpdir(), 'yahalla-sandbox-outside-'))
  try {
    writeFileSync(join(outside, 'secret.txt'), 'top secret, not part of the project')
    symlinkSync(outside, join(root, 'linked-out'))
    assert.throws(() => resolveProjectPath(root, 'linked-out/secret.txt'), PathEscapeError)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})

test('resolveProjectPath: a symlink that stays inside the project root is allowed', () => {
  const root = mkdtempSync(join(tmpdir(), 'yahalla-sandbox-test-'))
  try {
    mkdirSync(join(root, 'real-dir'))
    writeFileSync(join(root, 'real-dir', 'file.txt'), 'hello')
    symlinkSync(join(root, 'real-dir'), join(root, 'linked-in'))
    const resolved = resolveProjectPath(root, 'linked-in/file.txt')
    assert.ok(resolved.length > 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

// Integration-level proof: the exact real path a model-issued tool call
// actually takes (executeDeviceTool, the same function agentLoop.ts's
// executeToolNow dispatches every files/system tool through), not just the
// internal helper in isolation.
test('executeDeviceTool: a path-traversal read_project_file call is rejected cleanly, not thrown as an unhandled error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yahalla-sandbox-test-'))
  try {
    const result = await executeDeviceTool('read_project_file', root, { path: '../../../etc/passwd' })
    assert.equal(result.success, false)
    assert.match(String(result.error), /outside the project root/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('executeDeviceTool: a path-traversal write_project_file call is rejected and never touches disk outside the root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'yahalla-sandbox-test-'))
  const outside = mkdtempSync(join(tmpdir(), 'yahalla-sandbox-outside-write-'))
  try {
    const attackPath = join('..', ...outside.split('/').filter(Boolean).slice(-1), 'pwned.txt')
    const result = await executeDeviceTool('write_project_file', root, { path: attackPath, content: 'pwned' })
    assert.equal(result.success, false)
    assert.match(String(result.error), /outside the project root/)
    assert.equal(existsSync(join(outside, 'pwned.txt')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  }
})
