import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { isSafeGitRef, runDeploy } from '../src/deploy.js'

test('isSafeGitRef accepts ordinary branch/tag/SHA-shaped refs', () => {
  assert.ok(isSafeGitRef('main'))
  assert.ok(isSafeGitRef('agent/fix-heartbeat-flake'))
  assert.ok(isSafeGitRef('v1.2.3'))
  assert.ok(isSafeGitRef('a1b2c3d4'))
})

test('isSafeGitRef rejects flag-injection and shell-metacharacter attempts', () => {
  assert.equal(isSafeGitRef(''), false)
  assert.equal(isSafeGitRef('-x'), false)
  assert.equal(isSafeGitRef('--upload-pack=evil'), false)
  assert.equal(isSafeGitRef('main; rm -rf /'), false)
  assert.equal(isSafeGitRef('main && echo pwned'), false)
  assert.equal(isSafeGitRef('$(whoami)'), false)
})

// Real git/docker binaries aren't safe (or possible, given this sandbox's
// blocked image pulls) to exercise end-to-end here, so this stands in
// fake-but-executable `git`/`docker` scripts on PATH and drives runDeploy's
// actual node:child_process spawning against them -- this is the same
// argv construction and error handling that will run against the real
// binaries on the VPS, just pointed at stand-ins.
async function makeFakeBin(dir: string, name: string, script: string): Promise<void> {
  const path = join(dir, name)
  await writeFile(path, `#!/bin/sh\n${script}\n`)
  await chmod(path, 0o755)
}

test('runDeploy runs fetch, checkout, and compose up in order and reports success', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'yahalla-deploy-'))
  const binDir = join(workDir, 'bin')
  await mkdir(binDir)
  await makeFakeBin(binDir, 'git', 'echo "git $*"')
  await makeFakeBin(binDir, 'docker', 'echo "docker $*"')

  const originalPath = process.env.PATH
  process.env.PATH = `${binDir}:${originalPath}`
  try {
    const result = await runDeploy({ repoDir: workDir, composeFile: 'platform/docker-compose.yml', gitRef: 'main' })
    assert.equal(result.success, true)
    assert.match(result.log, /git -C .* fetch origin main/)
    assert.match(result.log, /git -C .* checkout FETCH_HEAD/)
    assert.match(result.log, /docker compose -f platform\/docker-compose\.yml up -d --build/)
  } finally {
    process.env.PATH = originalPath
  }
})

test('runDeploy reports failure and captures the error when a step fails', async () => {
  const workDir = await mkdtemp(join(tmpdir(), 'yahalla-deploy-'))
  const binDir = join(workDir, 'bin')
  await mkdir(binDir)
  await makeFakeBin(binDir, 'git', 'echo "fetch failed: unknown ref" >&2\nexit 1')
  await makeFakeBin(binDir, 'docker', 'echo "docker $*"')

  const originalPath = process.env.PATH
  process.env.PATH = `${binDir}:${originalPath}`
  try {
    const result = await runDeploy({ repoDir: workDir, composeFile: 'platform/docker-compose.yml', gitRef: 'nonexistent-ref' })
    assert.equal(result.success, false)
    assert.match(result.log, /fetch failed/)
  } finally {
    process.env.PATH = originalPath
  }
})

test('runDeploy refuses an unsafe git ref without spawning anything', async () => {
  const result = await runDeploy({ repoDir: '/tmp', composeFile: 'x.yml', gitRef: '--upload-pack=evil' })
  assert.equal(result.success, false)
  assert.match(result.log, /Refusing to deploy/)
})
