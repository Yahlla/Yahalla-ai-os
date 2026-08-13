// Local OCR (Tesseract.js), fully in-browser -- reads text out of a
// receipt/document/screenshot the user attaches or captures, entirely
// on-device, no image or extracted text ever leaves the browser tab.
// Worker script, WASM core, and trained-data files are all self-hosted
// under public/tesseract/ (scripts/copy-tesseract-assets.mjs) instead of
// Tesseract.js's own CDN defaults -- same "no third-party host at
// runtime" rule as browserLLM.ts/wasmLLM.ts/gestureControl.ts.

import { detectLanguage, type LanguageMatch } from './langDetect'

// Maps langDetect.ts's BCP-47-ish codes to Tesseract's trained-data
// codes. Only languages actually pre-fetched by
// copy-tesseract-assets.mjs are listed as "bundled" (instant, already on
// disk); anything else still works, Tesseract.js just fetches that one
// language's file from the same self-hosted langPath the first time it's
// needed (still never a third-party host, just not pre-warmed).
const TESSERACT_LANG_CODES: Record<string, string> = {
  ar: 'ara',
  en: 'eng',
  zh: 'chi_sim',
  fr: 'fra',
  es: 'spa',
  de: 'deu',
  ru: 'rus',
  hi: 'hin',
  ja: 'jpn',
  ko: 'kor',
  it: 'ita',
  pt: 'por',
  nl: 'nld',
  tr: 'tur',
  vi: 'vie',
  th: 'tha',
  he: 'heb',
  el: 'ell',
  id: 'ind',
}

const BUNDLED_TESSERACT_LANGS = new Set(['ara', 'eng', 'chi_sim', 'fra', 'spa', 'deu', 'rus', 'hin'])

export function tesseractLangFor(match: LanguageMatch): string {
  return TESSERACT_LANG_CODES[match.code] ?? 'eng'
}

export function isOcrLanguageBundled(tesseractLang: string): boolean {
  return BUNDLED_TESSERACT_LANGS.has(tesseractLang)
}

export type OcrProgress = { status: string; progress: number }

let workerPromise: Promise<import('tesseract.js').Worker> | null = null
let loadedLang: string | null = null

async function getWorker(lang: string, onProgress?: (p: OcrProgress) => void): Promise<import('tesseract.js').Worker> {
  // A worker is bound to whichever language(s) it was created with --
  // switching language means creating a fresh one, the same singleton-
  // per-configuration pattern browserLLM.ts uses for its model.
  if (workerPromise && loadedLang === lang) return workerPromise

  if (workerPromise) {
    const stale = await workerPromise.catch(() => null)
    if (stale) await stale.terminate()
  }

  loadedLang = lang
  workerPromise = (async () => {
    const { createWorker } = await import('tesseract.js')
    const base = `${import.meta.env.BASE_URL}tesseract`
    return createWorker(lang, 1, {
      workerPath: `${base}/worker.min.js`,
      corePath: `${base}/core`,
      langPath: `${base}/lang-data`,
      // The files copy-tesseract-assets.mjs fetches from tessdata_fast
      // are plain .traineddata, not the .traineddata.gz Tesseract.js
      // expects by default.
      gzip: false,
      logger: (m) => onProgress?.({ status: m.status, progress: m.progress }),
    })
  })().catch((error: unknown) => {
    workerPromise = null
    loadedLang = null
    throw error
  })
  return workerPromise
}

export type OcrResult = { text: string; confidence: number; lang: string }

// instructionText (the user's own chat message, e.g. "read this receipt")
// is used only to pick which trained-data language to OCR with via a
// real detection (langDetect.ts) -- never sent anywhere, never seen by
// any model. Defaults to English when no hint is available.
export async function recognizeText(
  imageDataUrl: string,
  instructionText = '',
  onProgress?: (p: OcrProgress) => void,
): Promise<OcrResult> {
  const lang = tesseractLangFor(detectLanguage(instructionText, { code: 'en', name: 'English', confidence: 0 }))
  const worker = await getWorker(lang, onProgress)
  const { data } = await worker.recognize(imageDataUrl)
  return { text: data.text.trim(), confidence: data.confidence, lang }
}

export async function unloadOcrWorker(): Promise<void> {
  if (workerPromise) {
    const worker = await workerPromise.catch(() => null)
    if (worker) await worker.terminate()
  }
  workerPromise = null
  loadedLang = null
}
