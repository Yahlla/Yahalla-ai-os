import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createServer as createFakeHttpServer } from 'node:http'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { openDb, type Db } from '../src/db.js'
import { LocalModelProcess } from '../src/llm.js'
import { createHttpServer } from '../src/server.js'
import { DEFAULT_ALLOWED_ORIGINS, mergeAllowedOrigins, type RuntimeConfig } from '../src/config.js'

// --- Pure merge logic: no filesystem involved.

test('mergeAllowedOrigins adds every official origin exactly once, preserving user-added ones', () => {
  const merged = mergeAllowedOrigins(['http://localhost:5173', 'https://my-custom-origin.example'])
  for (const official of DEFAULT_ALLOWED_ORIGINS) {
    assert.ok(merged.includes(official), `expected ${official} to be present`)
  }
  assert.ok(merged.includes('https://my-custom-origin.example'), 'a user-added origin must survive the merge')
  assert.equal(new Set(merged).size, merged.length, 'no duplicates')
})

test('mergeAllowedOrigins is a no-op (same length) when everything official is already present', () => {
  const merged = mergeAllowedOrigins(DEFAULT_ALLOWED_ORIGINS)
  assert.equal(merged.length, DEFAULT_ALLOWED_ORIGINS.length)
})

test('the production Control Center origin is one of the official defaults', () => {
  assert.ok(DEFAULT_ALLOWED_ORIGINS.includes('https://yahalla-ai.yahalla.de'))
})

// --- Real end-to-end: loadOrCreateConfig() against a real, isolated
// $HOME, run in a real child Node process (not just the pure function
// above) -- proves an *existing* config file written by an older version
// (missing the newer official origin) really does get healed on disk, not
// just in an in-memory object shape.

function runConfigScript(homeDir: string, script: string): string {
  return execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: import.meta.dirname,
    env: { ...process.env, HOME: homeDir },
    encoding: 'utf8',
  })
}

test('loadOrCreateConfig heals an existing config file missing a newer official origin', () => {
  const homeDir = mkdtempSync(join(tmpdir(), 'yahalla-config-home-'))
  try {
    // Simulate a config written by an older runtime version: no
    // yahalla-ai.yahalla.de entry, plus one origin the user added
    // themselves that must survive untouched.
    const configDir = join(homeDir, '.yahalla', 'runtime')
    execFileSync('mkdir', ['-p', configDir])
    const staleConfig = {
      port: 8765,
      authToken: 'stale-token-for-test',
      projectRoot: null,
      allowedOrigins: ['http://localhost:5173', 'https://user-added.example'],
    }
    writeFileSync(join(configDir, 'config.json'), JSON.stringify(staleConfig, null, 2))

    runConfigScript(
      homeDir,
      `import { loadOrCreateConfig } from ${JSON.stringify(join(import.meta.dirname, '..', 'src', 'config.js'))}
       loadOrCreateConfig()`,
    )

    const healed = JSON.parse(readFileSync(join(configDir, 'config.json'), 'utf8')) as RuntimeConfig
    assert.ok(healed.allowedOrigins.includes('https://yahalla-ai.yahalla.de'), 'the new official origin must be healed in')
    assert.ok(healed.allowedOrigins.includes('https://user-added.example'), 'a user-added origin must not be dropped')
    assert.equal(healed.authToken, 'stale-token-for-test', 'the real token must be preserved, not regenerated')
  } finally {
    rmSync(homeDir, { recursive: true, force: true })
  }
})

// --- /pair/token over real HTTP: proves the browser-pairing bootstrap
// route actually exists, needs no Authorization header, returns the real
// configured token, and is subject to the same CORS origin allowlist as
// everything else (a disallowed Origin gets no
// Access-Control-Allow-Origin header, which is what makes the response
// unreadable to a cross-origin fetch() from any other page).

let db: Db
let httpServer: import('node:http').Server
let baseUrl: string
const authToken = 'test-pairing-token'
const config: RuntimeConfig = {
  port: 8765,
  authToken,
  projectRoot: null,
  allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
}

before(async () => {
  db = openDb(':memory:')
  const modelProcess = new LocalModelProcess(18410)
  httpServer = createHttpServer({ db, config, modelProcess })
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', () => resolve()))
  const address = httpServer.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`
})

after(() => {
  httpServer.close()
})

test('/pair/token requires no Authorization header and returns the real configured token', async () => {
  const response = await fetch(`${baseUrl}/pair/token`)
  assert.equal(response.status, 200)
  const body = (await response.json()) as { baseUrl: string; authToken: string }
  assert.equal(body.authToken, authToken)
  assert.match(body.baseUrl, /^http:\/\/127\.0\.0\.1:/)
})

test('/pair/token grants Access-Control-Allow-Origin to an official origin', async () => {
  const response = await fetch(`${baseUrl}/pair/token`, { headers: { Origin: 'https://yahalla-ai.yahalla.de' } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://yahalla-ai.yahalla.de')
})

test('/pair/token does not grant Access-Control-Allow-Origin to an arbitrary, non-allowlisted origin', async () => {
  const response = await fetch(`${baseUrl}/pair/token`, { headers: { Origin: 'https://some-random-attacker-site.example' } })
  assert.equal(response.status, 200)
  // The response body is still returned at the network level (CORS is
  // enforced client-side by the browser, not by hiding the payload
  // server-side) -- what actually protects the token is the absence of
  // this header, which makes a real browser's fetch() reject before the
  // caller's JS can read the body. That's the property this test proves.
  assert.equal(response.headers.get('access-control-allow-origin'), null)
})

test('/health also grants CORS to the official production origin (needed for the frontend health-check poll)', async () => {
  const response = await fetch(`${baseUrl}/health`, { headers: { Origin: 'https://yahalla-ai.yahalla.de' } })
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('access-control-allow-origin'), 'https://yahalla-ai.yahalla.de')
})
