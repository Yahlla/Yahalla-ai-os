// Client-side blink detection for hands-free camera capture, using
// MediaPipe's FaceLandmarker (via @mediapipe/tasks-vision) running
// entirely in-browser via WASM. The video frame never leaves the device --
// no server, no upload, nothing sent anywhere; this only ever reads
// blendshape scores off the local <video> element already showing the
// camera preview.
//
// The WASM runtime is self-hosted (copied from node_modules into
// public/mediapipe/wasm by scripts/copy-mediapipe-assets.mjs at install
// time -- see package.json's "postinstall"), not loaded from a CDN
// script tag. The face-landmark *model* itself (a few MB) isn't shipped
// in the npm package and is fetched once from MediaPipe's public model
// hosting on first use, then cached by the browser -- the same "download
// weights once, run locally forever after" shape as the browser LLM tier
// already uses for its own model (see browserLLM.ts), not a new class of
// dependency.

import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision'

const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task'

// eyeBlinkLeft/eyeBlinkRight blendshape scores above this count as "closed"
// -- MediaPipe's own examples use ~0.5 as the open/closed boundary for
// these two categories specifically.
const BLINK_THRESHOLD = 0.5
// A deliberate blink must be held at least this long (ms) to fire --
// filters out normal fast involuntary blinks, which are typically
// <150ms, without requiring the user to learn a special gesture.
const DELIBERATE_BLINK_MS = 400
// Minimum gap between two triggered blinks, so one long blink can't fire
// the action twice.
const COOLDOWN_MS = 1200

export function isGestureControlSupported(): boolean {
  return typeof WebAssembly !== 'undefined'
}

export type BlinkDetector = { attach: (video: HTMLVideoElement) => void; stop: () => void }

export async function createBlinkDetector(onBlink: () => void, onError: (message: string) => void): Promise<BlinkDetector | null> {
  let landmarker: FaceLandmarker | null = null
  let rafId: number | null = null
  let closedSince: number | null = null
  let lastTriggerAt = 0
  let stopped = false

  try {
    const fileset = await FilesetResolver.forVisionTasks('/mediapipe/wasm')
    landmarker = await FaceLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
    })
  } catch (error) {
    onError(error instanceof Error ? error.message : 'Could not load the gesture-detection model.')
    return null
  }

  function loop(video: HTMLVideoElement) {
    if (stopped || !landmarker) return
    if (video.readyState >= 2) {
      const result = landmarker.detectForVideo(video, performance.now())
      const shapes = result.faceBlendshapes?.[0]?.categories ?? []
      const leftBlink = shapes.find((c) => c.categoryName === 'eyeBlinkLeft')?.score ?? 0
      const rightBlink = shapes.find((c) => c.categoryName === 'eyeBlinkRight')?.score ?? 0
      const eyesClosed = leftBlink > BLINK_THRESHOLD && rightBlink > BLINK_THRESHOLD

      const now = performance.now()
      if (eyesClosed) {
        if (closedSince === null) closedSince = now
        if (now - closedSince >= DELIBERATE_BLINK_MS && now - lastTriggerAt >= COOLDOWN_MS) {
          lastTriggerAt = now
          closedSince = null
          onBlink()
        }
      } else {
        closedSince = null
      }
    }
    rafId = requestAnimationFrame(() => loop(video))
  }

  return {
    attach: (video) => {
      closedSince = null
      lastTriggerAt = 0
      loop(video)
    },
    stop: () => {
      stopped = true
      if (rafId !== null) cancelAnimationFrame(rafId)
      landmarker?.close()
      landmarker = null
    },
  }
}
