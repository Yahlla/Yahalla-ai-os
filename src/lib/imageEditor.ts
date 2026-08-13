// Local image compositing (crop, color adjustment, logo/watermark
// overlay) -- entirely on-device via a Web Worker + OffscreenCanvas (see
// imageEditor.worker.ts), no model, no network, no image data ever
// leaving this browser tab. The worker is what keeps this off the main
// thread: on a weak phone, running these pixel operations synchronously
// in the UI thread is exactly the kind of thing that freezes the page.

import type { ImageEditorOp, ImageEditorRequest, ImageEditorResponse } from './imageEditor.worker'

export function isImageEditorSupported(): boolean {
  return typeof OffscreenCanvas !== 'undefined' && typeof Worker !== 'undefined'
}

let worker: Worker | null = null
let nextRequestId = 1
const pending = new Map<number, { resolve: (blob: Blob) => void; reject: (error: Error) => void }>()

function getWorker(): Worker {
  if (!worker) {
    worker = new Worker(new URL('./imageEditor.worker.ts', import.meta.url), { type: 'module' })
    worker.onmessage = (event: MessageEvent<ImageEditorResponse>) => {
      const entry = pending.get(event.data.id)
      if (!entry) return
      pending.delete(event.data.id)
      if (event.data.ok) entry.resolve(event.data.blob)
      else entry.reject(new Error(event.data.error))
    }
  }
  return worker
}

function runInWorker(req: ImageEditorOp, transfer: Transferable[]): Promise<Blob> {
  const id = nextRequestId++
  return new Promise<Blob>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    getWorker().postMessage({ ...req, id } as ImageEditorRequest, transfer)
  })
}

async function dataUrlToImageBitmap(dataUrl: string): Promise<ImageBitmap> {
  const response = await fetch(dataUrl)
  const blob = await response.blob()
  return createImageBitmap(blob)
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read image blob.'))
    reader.readAsDataURL(blob)
  })
}

export async function cropImage(dataUrl: string, rect: { x: number; y: number; width: number; height: number }): Promise<string> {
  const image = await dataUrlToImageBitmap(dataUrl)
  const blob = await runInWorker({ op: 'crop', image, ...rect }, [image])
  return blobToDataUrl(blob)
}

export async function adjustImage(
  dataUrl: string,
  adjustments: { brightness?: number; contrast?: number; saturation?: number },
): Promise<string> {
  const image = await dataUrlToImageBitmap(dataUrl)
  const blob = await runInWorker(
    {
      op: 'adjust',
      image,
      brightness: adjustments.brightness ?? 0,
      contrast: adjustments.contrast ?? 0,
      saturation: adjustments.saturation ?? 0,
    },
    [image],
  )
  return blobToDataUrl(blob)
}

export type WatermarkPosition = 'top-left' | 'top-right' | 'bottom-left' | 'bottom-right' | 'center'

export async function overlayWatermark(
  dataUrl: string,
  watermarkDataUrl: string,
  options: { position?: WatermarkPosition; scale?: number; opacity?: number; margin?: number } = {},
): Promise<string> {
  const [image, overlay] = await Promise.all([dataUrlToImageBitmap(dataUrl), dataUrlToImageBitmap(watermarkDataUrl)])
  const blob = await runInWorker(
    {
      op: 'overlay',
      image,
      overlay,
      position: options.position ?? 'bottom-right',
      scale: options.scale ?? 0.22,
      opacity: options.opacity ?? 0.85,
      margin: options.margin ?? Math.round(Math.min(image.width, image.height) * 0.04),
    },
    [image, overlay],
  )
  return blobToDataUrl(blob)
}
