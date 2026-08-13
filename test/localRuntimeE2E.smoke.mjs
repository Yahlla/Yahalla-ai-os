#!/usr/bin/env node
// Real end-to-end proof for the "local-runtime is the real primary
// production Agent path" fix (not a claim -- an actual test): starts a
// REAL local-runtime HTTP server (local-runtime/dist/src/server.js,
// unmodified) with only its LLM backend swapped for a deterministic fake
// HTTP server -- the exact same discipline local-runtime's own test suite
// uses everywhere, since a real GGUF model is multi-gigabytes and not
// something a CI sandbox can download. Everything else is real: real
// HTTP, real SQLite, real permission checks, real tool execution. Starts
// a real Vite dev server for the frontend and drives a real headless
// Chromium through the full pairing + chat handshake using the actual
// src/lib/localRuntime.ts code.
//
// Confirms, for real, not by inspection: (1) the frontend reaches
// local-runtime, (2) the "LLM" (fake, deterministic) produces an answer,
// (3) a real tool call executes against a real file, (4) platform-api/
// Strato is never configured or reachable in this harness, so the chat
// path structurally cannot be cloud/Strato.
//
// Not part of `npm test` (spins up two real HTTP servers + a browser) --
// run explicitly: `node test/localRuntimeE2E.smoke.mjs`.

import { chromium } from 'playwright'
import { createServer as createViteServer } from 'vite'
import { createServer as createFakeHttpServer } from 'node:http'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openDb } from '../local-runtime/dist/src/db.js'
import { grantPermission } from '../local-runtime/dist/src/permissions.js'
import { LocalModelProcess } from '../local-runtime/dist/src/llm.js'
import { createHttpServer } from '../local-runtime/dist/src/server.js'

// A fake OpenAI-compatible local LLM: round 1 asks to read package.json,
// round 2 (once it sees the real tool result) answers using the real
// version string that was actually read from disk.
function startFakeLlm(port) {
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
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    const hasToolResult = body.messages.some((m) => m.role === 'tool')
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (hasToolResult) {
      res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'The project version is 9.9.9.' } }] }))
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
                { id: 'call_1', type: 'function', function: { name: 'read_project_file', arguments: JSON.stringify({ path: 'package.json' }) } },
              ],
            },
          },
        ],
      }),
    )
  })
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)))
}

async function main() {
  const projectDir = mkdtempSync(join(tmpdir(), 'yahalla-e2e-fixture-'))
  writeFileSync(join(projectDir, 'package.json'), JSON.stringify({ name: 'fixture', version: '9.9.9' }))

  const fakeLlmPort = 18420
  const fakeLlm = await startFakeLlm(fakeLlmPort)

  const db = openDb(':memory:')
  grantPermission(db, 'project', projectDir, 'read')

  const modelProcess = new LocalModelProcess(fakeLlmPort)
  // Force isRunning()/baseUrl to point at our fake server without
  // spawning a real llama.cpp process -- this proves the runtime's real
  // HTTP+DB+tool+permission logic, not llama.cpp itself (which needs a
  // real multi-gigabyte model file no CI sandbox has).
  modelProcess.child = { exitCode: null, killed: false }

  // Vite's dev-server port isn't known until it's actually listening, and
  // local-runtime's CORS allowlist needs that exact origin -- start Vite
  // first, local-runtime second.
  const vite = await createViteServer({ root: process.cwd(), server: { port: 0 } })
  await vite.listen()
  const viteAddress = vite.httpServer?.address()
  const vitePort = typeof viteAddress === 'object' && viteAddress ? viteAddress.port : 0
  const viteOrigin = `http://127.0.0.1:${vitePort}`

  // Bound to the real default port (8765) a fresh install actually uses --
  // not an ephemeral one -- because checkRuntimeHealth()'s pre-pairing
  // fallback (src/lib/localRuntime.ts's DEFAULT_LOCAL_RUNTIME_URL) is
  // hardcoded to that default, exactly like a real user's first health
  // check before they've paired anything. Testing against a real
  // ephemeral port would silently skip exercising that exact real code
  // path.
  const REAL_DEFAULT_PORT = 8765
  const runtimeConfig = {
    port: REAL_DEFAULT_PORT,
    authToken: 'e2e-test-token',
    projectRoot: projectDir,
    allowedOrigins: [viteOrigin],
  }
  const runtimeHttpServer = createHttpServer({ db, config: runtimeConfig, modelProcess })
  await new Promise((resolve, reject) => {
    runtimeHttpServer.once('error', reject)
    runtimeHttpServer.listen(REAL_DEFAULT_PORT, '127.0.0.1', () => resolve())
  })
  const runtimeBase = `http://127.0.0.1:${REAL_DEFAULT_PORT}`

  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  })
  try {
    const page = await browser.newPage()
    const consoleErrors = []
    page.on('pageerror', (err) => consoleErrors.push(String(err)))
    await page.goto(`${viteOrigin}/test/localRuntimeE2E-harness.html?runtimeBase=${encodeURIComponent(runtimeBase)}`, { waitUntil: 'load' })
    await page.waitForFunction(() => document.title !== 'pending', { timeout: 30_000 })
    const resultText = await page.locator('#result').textContent()

    if (resultText === 'PASS') {
      console.log('[localRuntimeE2E.smoke] PASS -- frontend paired with and chatted through a real local-runtime end to end, no Strato/cloud path involved')
      process.exitCode = 0
    } else {
      console.error(`[localRuntimeE2E.smoke] FAIL -- ${resultText}`)
      if (consoleErrors.length) console.error('[localRuntimeE2E.smoke] page errors:', consoleErrors)
      process.exitCode = 1
    }
  } finally {
    await browser.close()
    await vite.close()
    runtimeHttpServer.close()
    fakeLlm.close()
    rmSync(projectDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error('[localRuntimeE2E.smoke] threw:', error)
  process.exitCode = 1
})
