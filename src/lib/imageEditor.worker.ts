// Runs entirely inside a Web Worker via OffscreenCanvas so pixel work
// (crop, color adjustment, logo/watermark compositing) never blocks the
// main thread's UI -- important specifically on weak phones, where a
// synchronous canvas operation on the main thread is exactly the kind of
// thing that makes a page feel frozen. No network, no dependency: plain
// Canvas 2D API only.

export type CropOp = { op: 'crop'; image: ImageBitmap; x: number; y: number; width: number; height: number }
export type AdjustOp = { op: 'adjust'; image: ImageBitmap; brightness: number; contrast: number; saturation: number }
export type OverlayOp = {
  op: 'overlay'
  image: ImageBitmap
  overlay: ImageBitmap
  position: 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center'
  scale: number
  opacity: number
  margin: number
}
export type ImageEditorOp = CropOp | AdjustOp | OverlayOp
export type ImageEditorRequest = ImageEditorOp & { id: number }
export type ImageEditorResponse = { id: number; ok: true; blob: Blob } | { id: number; ok: false; error: string }

function drawImage(image: ImageBitmap): OffscreenCanvas {
  const canvas = new OffscreenCanvas(image.width, image.height)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(image, 0, 0)
  return canvas
}

function crop(req: CropOp): OffscreenCanvas {
  const width = Math.max(1, Math.min(req.width, req.image.width - req.x))
  const height = Math.max(1, Math.min(req.height, req.image.height - req.y))
  const canvas = new OffscreenCanvas(width, height)
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(req.image, req.x, req.y, width, height, 0, 0, width, height)
  return canvas
}

// Plain per-pixel brightness/contrast + a real (not approximated)
// luminance-based saturation adjustment -- no external color library, the
// whole point of using Canvas 2D's raw pixel buffer directly.
function adjust(req: AdjustOp): OffscreenCanvas {
  const canvas = drawImage(req.image)
  const ctx = canvas.getContext('2d')!
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const { data } = imageData
  const brightness = req.brightness // -100..100
  const contrastFactor = (259 * (req.contrast + 255)) / (255 * (259 - req.contrast)) // req.contrast: -100..100
  const saturation = req.saturation / 100 + 1 // req.saturation: -100..100 -> 0..2

  for (let i = 0; i < data.length; i += 4) {
    let r = data[i]! + brightness
    let g = data[i + 1]! + brightness
    let b = data[i + 2]! + brightness

    r = contrastFactor * (r - 128) + 128
    g = contrastFactor * (g - 128) + 128
    b = contrastFactor * (b - 128) + 128

    const gray = 0.299 * r + 0.587 * g + 0.114 * b
    r = gray + (r - gray) * saturation
    g = gray + (g - gray) * saturation
    b = gray + (b - gray) * saturation

    data[i] = Math.max(0, Math.min(255, r))
    data[i + 1] = Math.max(0, Math.min(255, g))
    data[i + 2] = Math.max(0, Math.min(255, b))
  }

  ctx.putImageData(imageData, 0, 0)
  return canvas
}

function overlay(req: OverlayOp): OffscreenCanvas {
  const canvas = drawImage(req.image)
  const ctx = canvas.getContext('2d')!

  const overlayWidth = canvas.width * req.scale
  const overlayHeight = overlayWidth * (req.overlay.height / req.overlay.width)

  let x = req.margin
  let y = req.margin
  if (req.position.includes('right')) x = canvas.width - overlayWidth - req.margin
  if (req.position.includes('bottom')) y = canvas.height - overlayHeight - req.margin
  if (req.position === 'center') {
    x = (canvas.width - overlayWidth) / 2
    y = (canvas.height - overlayHeight) / 2
  }

  ctx.save()
  ctx.globalAlpha = req.opacity
  ctx.drawImage(req.overlay, x, y, overlayWidth, overlayHeight)
  ctx.restore()
  return canvas
}

self.onmessage = async (event: MessageEvent<ImageEditorRequest>) => {
  const req = event.data
  try {
    const canvas = req.op === 'crop' ? crop(req) : req.op === 'adjust' ? adjust(req) : overlay(req)
    const blob = await canvas.convertToBlob({ type: 'image/png' })
    const response: ImageEditorResponse = { id: req.id, ok: true, blob }
    ;(self as unknown as Worker).postMessage(response)
  } catch (error) {
    const response: ImageEditorResponse = { id: req.id, ok: false, error: error instanceof Error ? error.message : String(error) }
    ;(self as unknown as Worker).postMessage(response)
  }
}
