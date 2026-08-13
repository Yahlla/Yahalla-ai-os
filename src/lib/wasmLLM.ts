// Runs the LLM entirely inside this browser tab via WebAssembly
// (@wllama/wllama, a WASM build of llama.cpp) -- the fallback engine for
// browsers/devices with no WebGPU support at all (older phones, locked-
// down browsers), so "works on the weakest phone" doesn't quietly mean
// "works on the weakest phone that also happens to have WebGPU." Same
// shape as browserLLM.ts (loadWasmModel/wasmChatCompletion, singleton-
// safe loading, token streaming) so the composer's call site barely
// differs between the two engines.
//
// Model weights: pulled once from Hugging Face's open-weights hosting
// (the exact same GGUF files local-runtime's modelManager.ts already
// downloads for its own catalog, and the same *kind* of one-time static
// weight download @mlc-ai/web-llm's engine already does for the WebGPU
// tier) and cached by the browser after that -- this is a one-time file
// fetch for open model weights, not a live API call to any AI provider:
// no request goes out at chat time, no data leaves the device, nothing
// about it resembles calling OpenAI/Google/any hosted inference API.
//
// The wllama.wasm binary itself is self-hosted (public/wllama/, copied by
// scripts/copy-wllama-assets.mjs) rather than fetched from wllama's own
// CDN helper, mirroring browserLLM's neighbor gestureControl.ts's
// self-hosted MediaPipe assets -- no third-party script/binary is ever
// fetched from a third-party host at runtime in this codebase.

import type { BrowserChatMessage } from './browserLLM'
import { detectHardwareTier } from './capabilities'

export type WasmLLMProgress = { progress: number; text: string }

export function isWasmLLMSupported(): boolean {
  return typeof WebAssembly !== 'undefined'
}

// Deliberately kept in sync by hand with local-runtime/src/modelManager.ts's
// MODEL_CATALOG (same key/name/url/sha convention) -- see langDetect.ts's
// header comment for why this codebase duplicates small, static config
// like this instead of introducing cross-package plumbing between the
// Vite frontend and the separate local-runtime Node package. Only
// small/medium are listed here on purpose: this engine runs on CPU via
// WASM SIMD, with no GPU offload, so even a "strong" (per capabilities.ts)
// no-WebGPU device is capped at medium rather than attempting a 7B model
// with no hardware acceleration.
const WASM_MODEL_CATALOG = {
  small: {
    key: 'qwen2.5-1.5b-instruct-q4_k_m',
    url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf',
  },
  medium: {
    key: 'qwen2.5-3b-instruct-q4_k_m',
    url: 'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf',
  },
} as const

export function pickWasmModelKey(): keyof typeof WASM_MODEL_CATALOG {
  return detectHardwareTier().tier === 'weak' ? 'small' : 'medium'
}

// Imported from the explicit esm/ subpath rather than the bare package
// specifier: @wllama/wllama@3.5.1's published package.json has a broken
// "main" field ("index.js", which doesn't exist) and no "exports" map, so
// resolving the bare specifier falls through to the package's raw
// uncompiled src/ (which uses `enum`, incompatible with this project's
// erasableSyntaxOnly tsconfig flag) instead of its built esm/index.js --
// this is exactly the import path the package's own README documents for
// plain ES6 module usage, just resolved through node_modules instead of a
// relative path.
let loadingPromise: Promise<import('@wllama/wllama/esm/index.js').Wllama> | null = null
let resolvedModelKey: string | null = null

export async function loadWasmModel(onProgress?: (p: WasmLLMProgress) => void): Promise<string> {
  if (!loadingPromise) {
    loadingPromise = (async () => {
      const { Wllama } = await import('@wllama/wllama/esm/index.js')
      const modelKey = pickWasmModelKey()
      const entry = WASM_MODEL_CATALOG[modelKey]
      const wllama = new Wllama({ default: `${import.meta.env.BASE_URL}wllama/wllama.wasm` })
      await wllama.loadModelFromUrl(entry.url, {
        useCache: true,
        n_ctx: 2048,
        progressCallback: ({ loaded, total }) => {
          const progress = total > 0 ? loaded / total : 0
          onProgress?.({ progress, text: `Downloading local model (WASM)… ${Math.round(progress * 100)}%` })
        },
      })
      resolvedModelKey = entry.key
      return wllama
    })().catch((error: unknown) => {
      // Same rationale as browserLLM.ts: a failed/interrupted load must
      // not get stuck forever -- the next call has to actually retry.
      loadingPromise = null
      resolvedModelKey = null
      throw error
    })
  }
  await loadingPromise
  return resolvedModelKey!
}

export function isWasmModelLoaded(): boolean {
  return loadingPromise !== null
}

export function getLoadedWasmModelKey(): string | null {
  return resolvedModelKey
}

const GENERATION_PARAMS = {
  temperature: 0.6,
  max_tokens: 512,
}

export async function wasmChatCompletion(
  messages: BrowserChatMessage[],
  onToken?: (delta: string) => void,
): Promise<string> {
  if (!loadingPromise) throw new Error('Local WASM model is not loaded yet. Call loadWasmModel() first.')
  const wllama = await loadingPromise

  if (!onToken) {
    const completion = await wllama.createChatCompletion({ messages, stream: false, ...GENERATION_PARAMS })
    return completion.choices[0]?.message?.content ?? ''
  }

  const stream = await wllama.createChatCompletion({ messages, stream: true, ...GENERATION_PARAMS })
  let full = ''
  for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content ?? ''
    if (delta) {
      full += delta
      onToken(delta)
    }
  }
  return full
}

export async function unloadWasmModel(): Promise<void> {
  if (loadingPromise) {
    const wllama = await loadingPromise.catch(() => null)
    if (wllama) await wllama.exit()
  }
  loadingPromise = null
  resolvedModelKey = null
}
