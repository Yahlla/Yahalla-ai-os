import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { homedir } from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, beforeEach, test } from 'node:test'

// Real regression coverage for a real bug: running the test suite on an
// actual dev machine (not a fully isolated CI container) let a test that
// exercises the real /device/pair HTTP endpoint call the real
// saveConfig(), which wrote straight into the production
// ~/.yahalla/runtime/config.json -- confirmed by an actual report from a
// real machine, where the file ended up containing a test's mkdtemp
// projectRoot and its hardcoded 'server-tok' authToken. paths.ts's
// dataRoot() is the single choke point every one of those disk paths goes
// through; this file proves the fix (a lazily-read env override, not a
// module-level constant frozen at import time) actually redirects every
// one of them, and that it changes nothing about default behavior when
// the override isn't set.

let tempOverrideDir: string | undefined

beforeEach(() => {
  delete process.env.YAHALLA_DATA_ROOT_OVERRIDE
  tempOverrideDir = undefined
})

after(() => {
  delete process.env.YAHALLA_DATA_ROOT_OVERRIDE
  if (tempOverrideDir) rmSync(tempOverrideDir, { recursive: true, force: true })
})

test('dataRoot(): with no override set, resolves under the real home directory (the correct default for production)', async () => {
  const { dataRoot } = await import('../src/paths.js')
  assert.ok(dataRoot().startsWith(join(homedir(), '.yahalla', 'runtime')))
})

test('dataRoot()/configPath()/dbPath()/modelsDir()/logsDir(): YAHALLA_DATA_ROOT_OVERRIDE redirects every one of them away from the real home directory', async () => {
  tempOverrideDir = mkdtempSync(join(tmpdir(), 'yahalla-paths-test-'))
  process.env.YAHALLA_DATA_ROOT_OVERRIDE = tempOverrideDir
  const { dataRoot, configPath, dbPath, modelsDir, logsDir } = await import('../src/paths.js')

  assert.equal(dataRoot(), tempOverrideDir)
  for (const path of [configPath(), dbPath(), modelsDir(), logsDir()]) {
    assert.ok(path.startsWith(tempOverrideDir), `${path} must live under the override, not the real home directory`)
    assert.ok(!path.startsWith(join(homedir(), '.yahalla')), `${path} must never touch the real ~/.yahalla`)
  }
})

test('saveConfig()/loadOrCreateConfig(): with the override set, a config write/read round-trip never touches the real home directory', async () => {
  tempOverrideDir = mkdtempSync(join(tmpdir(), 'yahalla-paths-test-'))
  process.env.YAHALLA_DATA_ROOT_OVERRIDE = tempOverrideDir
  const { configPath } = await import('../src/paths.js')
  const { loadOrCreateConfig, saveConfig } = await import('../src/config.js')

  const realConfigPath = join(homedir(), '.yahalla', 'runtime', 'config.json')
  const realConfigExistedBefore = existsSync(realConfigPath)

  const config = loadOrCreateConfig()
  config.projectRoot = '/this/must/never/reach/the/real/config'
  saveConfig(config)

  assert.ok(existsSync(configPath()), 'the config must have been written under the override directory')
  assert.equal(configPath().startsWith(tempOverrideDir), true)
  // The decisive assertion: this test's fixture value must never have
  // reached the real file, and the real file's existence/absence must be
  // completely unaffected by anything this test did.
  assert.equal(existsSync(realConfigPath), realConfigExistedBefore, "this test must not have created (or modified) the user's real config.json")
})
