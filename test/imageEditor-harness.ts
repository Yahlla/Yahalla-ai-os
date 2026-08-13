// Real-browser end-to-end test for src/lib/imageEditor.ts: builds real
// canvas images, runs them through the real Worker+OffscreenCanvas
// pipeline, and asserts real pixel-level results (not just "no error") --
// driven by test/imageEditor.smoke.mjs via a real Playwright/Chromium
// instance. Entirely local, no network dependency of any kind.

import { adjustImage, cropImage, overlayWatermark } from '../src/lib/imageEditor'

const result = document.getElementById('result')!

function report(text: string) {
  result.textContent = text
  document.title = text
}

function solidColorDataUrl(width: number, height: number, color: string): string {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = color
  ctx.fillRect(0, 0, width, height)
  return canvas.toDataURL('image/png')
}

async function readPixel(dataUrl: string, x: number, y: number): Promise<[number, number, number, number]> {
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('failed to load result image'))
    img.src = dataUrl
  })
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0)
  const data = ctx.getImageData(x, y, 1, 1).data
  return [data[0]!, data[1]!, data[2]!, data[3]!]
}

async function readDimensions(dataUrl: string): Promise<{ width: number; height: number }> {
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('failed to load result image'))
    img.src = dataUrl
  })
  return { width: img.width, height: img.height }
}

;(async () => {
  const failures: string[] = []

  try {
    // crop: a 200x100 solid-blue image cropped to a 50x50 corner should
    // come back exactly 50x50, still blue.
    const base = solidColorDataUrl(200, 100, '#0000ff')
    const cropped = await cropImage(base, { x: 0, y: 0, width: 50, height: 50 })
    const dims = await readDimensions(cropped)
    if (dims.width !== 50 || dims.height !== 50) failures.push(`crop: expected 50x50, got ${dims.width}x${dims.height}`)
    const [r, g, b] = await readPixel(cropped, 25, 25)
    if (!(r < 20 && g < 20 && b > 235)) failures.push(`crop: expected blue pixel, got rgb(${r},${g},${b})`)
  } catch (error) {
    failures.push(`crop threw: ${error instanceof Error ? error.message : error}`)
  }

  try {
    // adjust: a mid-gray image brightened by +80 should read back
    // noticeably lighter.
    const base = solidColorDataUrl(40, 40, '#808080')
    const brightened = await adjustImage(base, { brightness: 80 })
    const [origR] = await readPixel(base, 20, 20)
    const [newR] = await readPixel(brightened, 20, 20)
    if (!(newR > origR + 40)) failures.push(`adjust: expected brightened pixel > ${origR + 40}, got ${newR}`)
  } catch (error) {
    failures.push(`adjust threw: ${error instanceof Error ? error.message : error}`)
  }

  try {
    // overlay: a green base with a solid-red watermark placed top-left
    // should read back red (not green) in that corner, at full opacity.
    const base = solidColorDataUrl(200, 200, '#00ff00')
    const mark = solidColorDataUrl(40, 40, '#ff0000')
    const branded = await overlayWatermark(base, mark, { position: 'top-left', scale: 0.5, opacity: 1, margin: 0 })
    const [r, g, b] = await readPixel(branded, 10, 10)
    if (!(r > 200 && g < 20 && b < 20)) failures.push(`overlay: expected red pixel in top-left, got rgb(${r},${g},${b})`)
    const [br, bg] = await readPixel(branded, 190, 190)
    if (!(br < 20 && bg > 200)) failures.push(`overlay: expected untouched green pixel in bottom-right, got rgb(${br},${bg})`)
  } catch (error) {
    failures.push(`overlay threw: ${error instanceof Error ? error.message : error}`)
  }

  report(failures.length === 0 ? 'PASS' : `FAIL:${failures.join(' | ')}`)
})()
