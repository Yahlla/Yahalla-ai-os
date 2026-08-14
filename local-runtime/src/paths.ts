import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Everything the local-first runtime owns lives under the user's own home
// directory -- never anywhere shared, never on a server. This is the same
// root the legacy device-agent already uses for its pairing config
// (~/.yahalla/agent.json), kept alongside it rather than replacing it.
//
// Confirmed real-world bug (not hypothetical): running the test suite on
// an actual dev machine -- not a fully isolated CI container -- let a test
// that exercises the real /device/pair HTTP endpoint (deviceDispatch.test.ts)
// call the real saveConfig(), which wrote straight to this path with no
// isolation at all. Because this was a module-level constant computed once
// at import time, there was no way for a test to redirect it even if it
// tried. That overwrote a real user's actual ~/.yahalla/runtime/config.json
// with the test's fixture projectRoot (a mkdtemp path) and authToken --
// the exact cause of a real "permission exists but is still denied" report,
// unrelated to the path-normalization matching bugs fixed separately in
// permissions.ts. Resolving this lazily on every call (instead of caching
// a module-level constant) lets YAHALLA_DATA_ROOT_OVERRIDE be set in a
// test's before() hook and take effect immediately, since paths.ts is
// already imported (and would otherwise have already frozen the real
// homedir path) long before any test body runs. Never set in normal
// production use -- this is a test-only escape hatch.
function resolveDataRoot(): string {
  return process.env.YAHALLA_DATA_ROOT_OVERRIDE || join(homedir(), '.yahalla', 'runtime')
}

export function dataRoot(): string {
  const dir = resolveDataRoot()
  mkdirSync(dir, { recursive: true })
  return dir
}

export function dbPath(): string {
  return join(dataRoot(), 'yahalla.db')
}

export function modelsDir(): string {
  const dir = join(dataRoot(), 'models')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function logsDir(): string {
  const dir = join(dataRoot(), 'logs')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function configPath(): string {
  return join(dataRoot(), 'config.json')
}
