#!/usr/bin/env node
// Drives test/wllama-harness.html in a real headless Chromium (via
// Playwright, using the browser already provisioned at
// PLAYWRIGHT_BROWSERS_PATH) against a real Vite dev server -- see
// wllama-harness.ts's header comment for exactly what this does and does
// not verify. Not part of `npm test` (that suite is pure Node, no
// browser) -- run explicitly: `node test/wasmLLM.smoke.mjs`.

import { chromium } from 'playwright'
import { createServer } from 'vite'

async function main() {
  // wllama's multi-thread WASM build needs SharedArrayBuffer, which
  // browsers only expose in a cross-origin-isolated context -- these two
  // response headers are what turn that on (see wllama's own README,
  // "Limitations" section).
  const server = await createServer({
    root: process.cwd(),
    server: {
      port: 0,
      headers: { 'Cross-Origin-Opener-Policy': 'same-origin', 'Cross-Origin-Embedder-Policy': 'require-corp' },
    },
  })
  await server.listen()
  const address = server.httpServer?.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const baseUrl = `http://127.0.0.1:${port}`

  // This sandbox's pre-provisioned browser revision doesn't always match
  // whatever revision the installed `playwright` npm version expects --
  // pin the known-good executable directly rather than letting Playwright
  // pick (and fail to find) a revision-specific path. --no-sandbox is
  // required to launch Chromium as root in this container.
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  })
  try {
    const page = await browser.newPage()
    const consoleErrors = []
    page.on('pageerror', (err) => consoleErrors.push(String(err)))
    await page.goto(`${baseUrl}/test/wllama-harness.html`, { waitUntil: 'load' })
    await page.waitForFunction(() => document.title !== 'pending', { timeout: 60_000 })
    const resultText = await page.locator('#result').textContent()

    if (resultText === 'PASS') {
      console.log('[wasmLLM.smoke] PASS -- self-hosted wllama.wasm loaded, initialized, and ran real native code in a real browser.')
      process.exitCode = 0
    } else {
      console.error(`[wasmLLM.smoke] FAIL -- ${resultText}`)
      if (consoleErrors.length) console.error('[wasmLLM.smoke] page errors:', consoleErrors)
      process.exitCode = 1
    }
  } finally {
    await browser.close()
    await server.close()
  }
}

main().catch((error) => {
  console.error('[wasmLLM.smoke] threw:', error)
  process.exitCode = 1
})
