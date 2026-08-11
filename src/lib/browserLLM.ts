// Runs the LLM entirely inside this browser tab via WebGPU -- no server,
// no local-runtime process, no terminal, works identically on a phone or a
// desktop browser as long as the browser supports WebGPU. This is the
// "just open the domain and it works" path: the model downloads once
// (cached by the browser itself) and every completion after that runs on
// this device's own GPU.
//
// The @mlc-ai/web-llm dependency is loaded lazily (dynamic import) so a
// browser without WebGPU, or a first paint before we know whether to use
// it, never pays for it.

export type BrowserLLMProgress = { progress: number; text: string }

export function isWebGPUSupported(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
}

// Rough phone vs. desktop signal: real device capability (RAM/thermals)
// varies a lot more than this, but it is a safe, dependency-free default
// -- err toward the smaller model rather than risk an OOM/hang on a phone.
function isLikelyPhone(): boolean {
  if (typeof navigator === 'undefined') return false
  return /iphone|ipad|android|mobile/i.test(navigator.userAgent)
}

let enginePromise: Promise<import('@mlc-ai/web-llm').MLCEngine> | null = null
let loadedModelId: string | null = null

async function pickModelId(): Promise<string> {
  const webllm = await import('@mlc-ai/web-llm')
  const candidates = webllm.prebuiltAppConfig.model_list
    .filter((m) => m.model_id.includes('Instruct') && typeof m.vram_required_MB === 'number')
    // Largest-first: within whatever this device can handle, prefer the
    // most capable model that still fits, not the smallest one available
    // -- a tiny model answers fast but guesses/hallucinates far more, and
    // "advanced" was the explicit requirement, not just "responds".
    .sort((a, b) => (b.vram_required_MB ?? 0) - (a.vram_required_MB ?? 0))

  // Biased toward a fast first download, not maximum quality: this is the
  // path a brand-new visitor with no local-runtime hits, so the priority
  // is "finishes downloading and answers quickly" over "the single best
  // model that technically fits in VRAM" -- a multi-GB first download on
  // an average connection reads as broken, not just slow. Users who want
  // the strongest local model should run local-runtime instead (small,
  // fast to fetch, no browser download at all).
  const ceilingMB = isLikelyPhone() ? 1200 : 2000
  const withinBudget = candidates.filter((m) => (m.vram_required_MB ?? 0) <= ceilingMB)
  const picked = withinBudget[0] ?? candidates[candidates.length - 1]
  if (!picked) throw new Error('No compatible local model found in the WebLLM catalog.')
  return picked.model_id
}

export async function loadBrowserModel(onProgress?: (p: BrowserLLMProgress) => void): Promise<string> {
  if (enginePromise && loadedModelId) return loadedModelId

  const webllm = await import('@mlc-ai/web-llm')
  const modelId = await pickModelId()
  loadedModelId = modelId

  enginePromise = webllm.CreateMLCEngine(modelId, {
    initProgressCallback: (report) => onProgress?.({ progress: report.progress, text: report.text }),
  })
  await enginePromise
  return modelId
}

export function isBrowserModelLoaded(): boolean {
  return enginePromise !== null
}

export function getLoadedModelId(): string | null {
  return loadedModelId
}

export type BrowserChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export async function browserChatCompletion(messages: BrowserChatMessage[]): Promise<string> {
  if (!enginePromise) throw new Error('Local browser model is not loaded yet. Call loadBrowserModel() first.')
  const engine = await enginePromise
  const completion = await engine.chat.completions.create({ messages, stream: false })
  return completion.choices[0]?.message?.content ?? ''
}

export async function unloadBrowserModel(): Promise<void> {
  if (enginePromise) {
    const engine = await enginePromise
    await engine.unload()
  }
  enginePromise = null
  loadedModelId = null
}
