#!/usr/bin/env node
// Drives test/ocr-harness.html in a real headless Chromium against a real
// Vite dev server -- see ocr-harness.ts's header comment for what this
// verifies. Not part of `npm test` (pure Node, no browser) -- run
// explicitly: `node test/ocr.smoke.mjs`.

import { chromium } from 'playwright'
import { createServer } from 'vite'

async function main() {
  const server = await createServer({ root: process.cwd(), server: { port: 0 } })
  await server.listen()
  const address = server.httpServer?.address()
  const port = typeof address === 'object' && address ? address.port : 0
  const baseUrl = `http://127.0.0.1:${port}`

  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  })
  try {
    const page = await browser.newPage()
    const consoleErrors = []
    page.on('pageerror', (err) => consoleErrors.push(String(err)))
    await page.goto(`${baseUrl}/test/ocr-harness.html`, { waitUntil: 'load' })
    await page.waitForFunction(() => document.title !== 'pending', { timeout: 60_000 })
    const resultText = await page.locator('#result').textContent()

    if (resultText && /hello/i.test(resultText) && /world/i.test(resultText)) {
      console.log(`[ocr.smoke] PASS -- recognized: "${resultText.trim()}"`)
      process.exitCode = 0
    } else {
      console.error(`[ocr.smoke] FAIL -- recognized text did not contain "HELLO WORLD": "${resultText}"`)
      if (consoleErrors.length) console.error('[ocr.smoke] page errors:', consoleErrors)
      process.exitCode = 1
    }
  } finally {
    await browser.close()
    await server.close()
  }
}

main().catch((error) => {
  console.error('[ocr.smoke] threw:', error)
  process.exitCode = 1
})
