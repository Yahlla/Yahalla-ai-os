#!/usr/bin/env node
// Real end-to-end proof, audit Phase 3/4/8: actually spawns the real
// compiled local-runtime binary (dist/src/index.js) as its own OS process
// -- not a function call, not a mock -- with a fake `llama-server` on PATH
// that records its own real argv, and a pre-seeded "active model" in a
// real SQLite db under an isolated $HOME, then:
//
//   1. confirms the real spawned llama-server process actually received
//      --model/--port/--host/--ctx-size with the intended values (closes
//      the audit's "run it for real, then prove the argv of the real
//      process" requirement -- this is not source-code inspection, it is
//      the literal argv the OS gave the child process);
//   2. confirms the CLI-only launch path (`--project=<dir>`, no Electron,
//      no browser pairing) really does grant project trust automatically
//      (this audit's fix in index.ts), by querying the real running
//      runtime's own /permissions endpoint over real HTTP.
//
// Not part of `npm test` (binds the real default port 8765 and spawns a
// real child process) -- run explicitly:
//   node test/cliRuntime.smoke.mjs

import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../dist/src/db.js'

const REAL_DEFAULT_PORT = 8765
const FAKE_LLAMA_SERVER_PORT = 8766 // hardcoded inside index.ts's LocalModelProcess(8766)

async function waitFor(check, timeoutMs = 15_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      if (await check()) return true
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return false
}

async function main() {
  const homeDir = mkdtempSync(join(tmpdir(), 'yahalla-cli-smoke-home-'))
  const projectDir = mkdtempSync(join(tmpdir(), 'yahalla-cli-smoke-project-'))
  const fakeBinDir = mkdtempSync(join(tmpdir(), 'yahalla-cli-smoke-bin-'))
  const argvOutFile = join(fakeBinDir, 'argv.json')

  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'cli-smoke-fixture', version: '1.0.0' }))

  // A real, minimal, executable "llama-server" -- honors --version (so
  // isLlamaServerInstalled() passes), otherwise records its real argv and
  // serves a real /v1/models response so LocalModelProcess.waitUntilReady()
  // (real HTTP polling against a real port) actually succeeds.
  const fakeLlamaServerPath = join(fakeBinDir, 'llama-server')
  writeFileSync(
    fakeLlamaServerPath,
    `#!/usr/bin/env node
const args = process.argv.slice(2)
if (args.includes('--version')) { console.log('fake-llama-server 0.0.0'); process.exit(0) }
require('fs').writeFileSync(${JSON.stringify(argvOutFile)}, JSON.stringify(args))
const http = require('http')
const portIdx = args.indexOf('--port')
const port = Number(args[portIdx + 1])
http.createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }))
    return
  }
  res.writeHead(404)
  res.end()
}).listen(port, '127.0.0.1')
`,
    { mode: 0o755 },
  )
  chmodSync(fakeLlamaServerPath, 0o755)

  // Pre-seed a real, ready, active model row in the real SQLite schema
  // (openDb runs the real schema migrations) at the exact path index.ts
  // itself will open once spawned with HOME=homeDir -- this exercises the
  // real "autostart the previously-active model on launch" code path,
  // with a real spawned child process, not a mocked one.
  const dbFilePath = join(homeDir, '.yahalla', 'runtime', 'yahalla.db')
  mkdirSync(join(homeDir, '.yahalla', 'runtime'), { recursive: true })
  const seedDb = openDb(dbFilePath)
  seedDb
    .prepare(
      `INSERT INTO models (id, key, name, url, file_path, status, active) VALUES ('seed-1', 'cli-smoke-model', 'CLI Smoke Model', null, '/fake/model.gguf', 'ready', 1)`,
    )
    .run()
  seedDb.close?.()

  const child = spawn(
    process.execPath,
    [join(process.cwd(), 'dist', 'src', 'index.js'), `--project=${projectDir}`],
    {
      env: { ...process.env, HOME: homeDir, PATH: `${fakeBinDir}:${process.env.PATH}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => (stdout += d))
  child.stderr.on('data', (d) => (stderr += d))

  try {
    const healthy = await waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${REAL_DEFAULT_PORT}/health`)
      return res.ok
    })
    if (!healthy) {
      console.error('[cliRuntime.smoke] FAIL -- real runtime process never became healthy on the real default port')
      console.error('stdout:', stdout)
      console.error('stderr:', stderr)
      process.exitCode = 1
      return
    }

    // The real llama-server child (spawned BY the runtime process we just
    // spawned) needs a moment past /health to actually write its argv file
    // and start listening -- poll for it rather than assuming timing.
    const llamaReachable = await waitFor(async () => {
      const res = await fetch(`http://127.0.0.1:${FAKE_LLAMA_SERVER_PORT}/v1/models`)
      return res.ok
    })
    if (!llamaReachable) {
      console.error('[cliRuntime.smoke] FAIL -- the real spawned llama-server child never became reachable')
      process.exitCode = 1
      return
    }

    const realArgv = JSON.parse(readFileSync(argvOutFile, 'utf8'))
    console.log('[cliRuntime.smoke] real llama-server argv:', realArgv)

    const modelIdx = realArgv.indexOf('--model')
    const portIdx = realArgv.indexOf('--port')
    const hostIdx = realArgv.indexOf('--host')
    const ctxIdx = realArgv.indexOf('--ctx-size')

    const checks = [
      [modelIdx !== -1 && realArgv[modelIdx + 1] === '/fake/model.gguf', 'real argv must include --model /fake/model.gguf'],
      [portIdx !== -1 && realArgv[portIdx + 1] === String(FAKE_LLAMA_SERVER_PORT), `real argv must include --port ${FAKE_LLAMA_SERVER_PORT}`],
      [hostIdx !== -1 && realArgv[hostIdx + 1] === '127.0.0.1', 'real argv must include --host 127.0.0.1'],
      [ctxIdx !== -1 && Number(realArgv[ctxIdx + 1]) > 0, 'real argv must include a real, positive --ctx-size (audit Phase 3 fix)'],
    ]

    // Real HTTP call to the real running runtime's real /permissions
    // endpoint, using the real authToken this real process just generated
    // and wrote to config.json -- proves the CLI-only auto-trust fix
    // (index.ts's grantPermission call) actually ran in the real process,
    // not just in a unit test double.
    const config = JSON.parse(readFileSync(join(homeDir, '.yahalla', 'runtime', 'config.json'), 'utf8'))
    const permsRes = await fetch(`http://127.0.0.1:${REAL_DEFAULT_PORT}/permissions`, {
      headers: { Authorization: `Bearer ${config.authToken}` },
    })
    const perms = await permsRes.json()
    const projectGrant = perms.permissions.find((p) => p.scope === 'project' && p.target === projectDir)
    checks.push([Boolean(projectGrant) && projectGrant.access === 'write', 'the real running process must have auto-granted project trust for the --project= directory'])

    const failed = checks.filter(([ok]) => !ok)
    if (failed.length > 0) {
      console.error('[cliRuntime.smoke] FAIL:')
      for (const [, msg] of failed) console.error(' -', msg)
      process.exitCode = 1
      return
    }

    console.log('[cliRuntime.smoke] PASS -- real spawned runtime process, real spawned llama-server child, real argv, real CLI-only auto-trust, all verified against actual running processes')
    process.exitCode = 0
  } finally {
    child.kill('SIGTERM')
    await new Promise((r) => setTimeout(r, 300))
    rmSync(homeDir, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
    rmSync(fakeBinDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('[cliRuntime.smoke] threw:', error)
  process.exitCode = 1
})
