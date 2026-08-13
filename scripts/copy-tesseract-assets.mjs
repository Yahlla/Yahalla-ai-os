#!/usr/bin/env node
// Self-hosts everything Tesseract.js needs (worker script, WASM core, and
// a curated set of trained-data language files) under public/tesseract/
// instead of the library's own defaults, which fetch from jsDelivr's CDN
// (worker/core) and tessdata.projectnaptha.com (language data) at OCR
// time -- same "no third-party host at runtime" rule this project already
// applies to MediaPipe (copy-mediapipe-assets.mjs) and wllama
// (copy-wllama-assets.mjs).
//
// Worker + core come straight from node_modules (already downloaded by
// `npm install`, no extra network call). Trained-data files are NOT
// bundled in the npm packages -- they're fetched once, here, from
// tesseract-ocr's own official tessdata_fast GitHub repo (small, fast-
// variant files, ~1-4MB each), then cached on disk under public/ like any
// other build output. Only a curated default set is pre-fetched (broad
// language/trade coverage: Arabic, English, Chinese Simplified, French,
// Spanish, German, Russian, Hindi) -- src/lib/ocr.ts falls back to
// fetching any other language from this same self-hosted langPath at
// runtime (still never a third-party host, just not pre-warmed).
//
// Run automatically on `npm install` (see package.json's "postinstall").
// Not committed to git (public/tesseract/ is gitignored, same as
// public/mediapipe/ and public/wllama/) -- regenerated every install.

import { cpSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = join(repoRoot, 'public', 'tesseract')

const workerSource = join(repoRoot, 'node_modules', 'tesseract.js', 'dist', 'worker.min.js')
const coreSourceDir = join(repoRoot, 'node_modules', 'tesseract.js-core')

if (!existsSync(workerSource) || !existsSync(coreSourceDir)) {
  console.log('[copy-tesseract-assets] tesseract.js / tesseract.js-core not installed -- skipping (OCR will stay unavailable).')
  process.exit(0)
}

mkdirSync(publicDir, { recursive: true })
cpSync(workerSource, join(publicDir, 'worker.min.js'))

const coreDest = join(publicDir, 'core')
mkdirSync(coreDest, { recursive: true })
for (const file of readdirSync(coreSourceDir)) {
  if (file.endsWith('.js') || file.endsWith('.wasm')) {
    cpSync(join(coreSourceDir, file), join(coreDest, file))
  }
}
console.log(`[copy-tesseract-assets] copied worker + core -> ${publicDir}`)

// Tesseract's own ISO-639-2/3-ish codes, not the langDetect.ts BCP-47
// codes -- ocr.ts maps between the two (see its LANGUAGE_CODE_MAP).
const DEFAULT_LANGUAGES = ['ara', 'eng', 'chi_sim', 'fra', 'spa', 'deu', 'rus', 'hin']
const TESSDATA_FAST_BASE = 'https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main'

const langDataDest = join(publicDir, 'lang-data')
mkdirSync(langDataDest, { recursive: true })

for (const lang of DEFAULT_LANGUAGES) {
  const dest = join(langDataDest, `${lang}.traineddata`)
  if (existsSync(dest)) {
    console.log(`[copy-tesseract-assets] ${lang}.traineddata already present, skipping`)
    continue
  }
  try {
    const response = await fetch(`${TESSDATA_FAST_BASE}/${lang}.traineddata`)
    if (!response.ok) {
      console.warn(`[copy-tesseract-assets] could not fetch ${lang}.traineddata (HTTP ${response.status}) -- OCR will lazy-fetch it at runtime instead.`)
      continue
    }
    const bytes = Buffer.from(await response.arrayBuffer())
    writeFileSync(dest, bytes)
    console.log(`[copy-tesseract-assets] fetched ${lang}.traineddata (${(bytes.length / 1e6).toFixed(1)}MB)`)
  } catch (error) {
    console.warn(`[copy-tesseract-assets] could not fetch ${lang}.traineddata (${error instanceof Error ? error.message : error}) -- OCR will lazy-fetch it at runtime instead.`)
  }
}
