// Real-browser end-to-end test for src/lib/ocr.ts: draws known text onto
// a real <canvas>, runs it through the real self-hosted Tesseract.js
// pipeline (worker + WASM core + bundled eng.traineddata, all under
// public/tesseract/), and reports back what was actually recognized --
// driven by test/ocr.smoke.mjs via a real Playwright/Chromium instance.
// Unlike the wllama smoke test, this needs no external network at all:
// English trained-data is pre-fetched by copy-tesseract-assets.mjs, so
// this is a full, real download-free OCR round trip, not a partial check.

import { recognizeText } from '../src/lib/ocr'

const result = document.getElementById('result')!

function report(text: string) {
  result.textContent = text
  document.title = text
}

;(async () => {
  try {
    const canvas = document.getElementById('canvas') as HTMLCanvasElement
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#000000'
    ctx.font = '40px sans-serif'
    ctx.fillText('HELLO WORLD', 20, 70)

    const dataUrl = canvas.toDataURL('image/png')
    const { text } = await recognizeText(dataUrl, 'read this receipt for me please')
    report(text || '(empty)')
  } catch (error) {
    report(`FAIL:${error instanceof Error ? error.message : String(error)}`)
  }
})()
