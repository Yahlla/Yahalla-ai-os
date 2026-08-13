#!/usr/bin/env node
// Copies @wllama/wllama's WASM binary into public/wllama so it's served
// as a same-origin static asset instead of being fetched from a
// third-party CDN at runtime (wllama ships a wasm-from-cdn.js helper for
// exactly that, which this project deliberately does not use). Same
// self-hosting pattern as copy-mediapipe-assets.mjs. Run automatically on
// `npm install` (see package.json's "postinstall") -- not committed to
// git, regenerated from node_modules every time, same as any other build
// output.

import { cpSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(repoRoot, 'node_modules', '@wllama', 'wllama', 'esm', 'wasm', 'wllama.wasm')
const dest = join(repoRoot, 'public', 'wllama', 'wllama.wasm')

if (!existsSync(source)) {
  console.log('[copy-wllama-assets] @wllama/wllama not installed -- skipping (the no-WebGPU fallback engine will stay unavailable).')
  process.exit(0)
}

mkdirSync(dirname(dest), { recursive: true })
cpSync(source, dest)
console.log(`[copy-wllama-assets] copied ${source} -> ${dest}`)
