#!/usr/bin/env node
// Copies @mediapipe/tasks-vision's WASM runtime into public/mediapipe/wasm
// so it's served as a same-origin static asset instead of being fetched
// from Google's CDN at runtime (the pattern the official MediaPipe docs
// default to). This keeps the gesture-control feature (src/lib/
// gestureControl.ts) consistent with the rest of this codebase: no
// third-party script is ever loaded at runtime, only self-hosted, bundled
// code. Run automatically on `npm install` (see package.json's
// "postinstall") -- not committed to git, regenerated from node_modules
// every time, same as any other build output.

import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(repoRoot, 'node_modules', '@mediapipe', 'tasks-vision', 'wasm')
const dest = join(repoRoot, 'public', 'mediapipe', 'wasm')

if (!existsSync(source)) {
  console.log('[copy-mediapipe-assets] @mediapipe/tasks-vision not installed -- skipping (gesture control will stay unavailable).')
  process.exit(0)
}

mkdirSync(dirname(dest), { recursive: true })
cpSync(source, dest, { recursive: true })
console.log(`[copy-mediapipe-assets] copied ${source} -> ${dest}`)
