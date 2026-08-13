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

import { detectHardwareTier, type HardwareTier } from './capabilities'

export type BrowserLLMProgress = { progress: number; text: string }

export function isWebGPUSupported(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
}

// Real capability-based ceiling (navigator.deviceMemory/hardwareConcurrency,
// see capabilities.ts's detectHardwareTier -- falls back to a UA phone/
// desktop guess only for whichever signal this browser doesn't expose),
// not a bare UA-string guess. A weak device (low RAM/cores, most low-end
// phones) gets the smaller ceiling that used to apply to every phone
// regardless of its actual specs; a strong one (most desktops, high-end
// phones) gets the larger one.
function vramCeilingMB(tier: HardwareTier): number {
  if (tier === 'weak') return 1500
  if (tier === 'strong') return 3200
  return 2000
}

async function pickModelId(): Promise<string> {
  const webllm = await import('@mlc-ai/web-llm')
  const candidates = webllm.prebuiltAppConfig.model_list
    .filter((m) => m.model_id.includes('Instruct') && typeof m.vram_required_MB === 'number')
    // Largest-first: within whatever this device can handle, prefer the
    // most capable model that still fits, not the smallest one available
    // -- a tiny model answers fast but guesses/hallucinates far more, and
    // "advanced" was the explicit requirement, not just "responds".
    .sort((a, b) => (b.vram_required_MB ?? 0) - (a.vram_required_MB ?? 0))

  // A real floor, not just "smallest that downloads fast": the ~1.5B
  // class was tried first and is genuinely too weak for real use in
  // Arabic specifically -- it mixes in tokens from the model's stronger
  // languages (Chinese/English) mid-sentence and degrades into generic
  // filler across multi-turn context. Raising the ceiling into 3B-class
  // territory (~1.5-2.5GB for a Q4 model) is still a one-time download
  // that finishes in a reasonable time on an average connection, and is
  // a meaningfully more capable and coherent model -- not just larger.
  // Users who want the strongest fully-local model should still run
  // local-runtime (up to 7B, no browser download at all).
  const ceilingMB = vramCeilingMB(detectHardwareTier().tier)
  const withinBudget = candidates.filter((m) => (m.vram_required_MB ?? 0) <= ceilingMB)
  const picked = withinBudget[0] ?? candidates[candidates.length - 1]
  if (!picked) throw new Error('No compatible local model found in the WebLLM catalog.')
  return picked.model_id
}

// Assigned synchronously, before any `await` inside the load sequence
// below runs -- this is what makes a second loadBrowserModel() call that
// arrives while the first is still in its early async steps (the dynamic
// import, picking a model) join the *same* in-flight load instead of
// starting a brand new one. The previous version set its "is it loading"
// flag only after two awaits, leaving a window where two overlapping
// calls (a fast retry after an interrupted request, e.g.) could each
// kick off their own full model download at once -- exactly the "every
// single message re-downloads the model" symptom this fixes.
let loadingPromise: Promise<import('@mlc-ai/web-llm').MLCEngine> | null = null
let resolvedModelId: string | null = null

export async function loadBrowserModel(onProgress?: (p: BrowserLLMProgress) => void): Promise<string> {
  if (!loadingPromise) {
    loadingPromise = (async () => {
      const webllm = await import('@mlc-ai/web-llm')
      const modelId = await pickModelId()
      const engine = await webllm.CreateMLCEngine(modelId, {
        initProgressCallback: (report) => onProgress?.({ progress: report.progress, text: report.text }),
      })
      resolvedModelId = modelId
      return engine
    })().catch((error: unknown) => {
      // A failed/interrupted load must not get stuck forever -- the next
      // call has to be a real retry, not an immediate re-throw of the
      // same stale rejection every time.
      loadingPromise = null
      resolvedModelId = null
      throw error
    })
  }
  await loadingPromise
  return resolvedModelId!
}

export function isBrowserModelLoaded(): boolean {
  return loadingPromise !== null
}

export function getLoadedModelId(): string | null {
  return resolvedModelId
}

export type BrowserChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

// Lower temperature + a repetition penalty measurably cuts down on the
// "collapses into generic filler" failure mode small models are prone to
// over a multi-turn conversation -- it doesn't fix the underlying capacity
// limit, but it does make the model commit to an actual answer more often
// instead of hedging into the same safe-sounding non-answer every turn.
const GENERATION_PARAMS = {
  temperature: 0.6,
  repetition_penalty: 1.15,
  max_tokens: 768,
}

// Streams tokens as they're generated (onToken) instead of blocking until
// the full answer is ready -- this is what lets the UI show live
// "typing," the same visible-progress ChatGPT has, rather than a static
// "processing" state that only updates once at the very end.
export async function browserChatCompletion(
  messages: BrowserChatMessage[],
  onToken?: (delta: string) => void,
): Promise<string> {
  if (!loadingPromise) throw new Error('Local browser model is not loaded yet. Call loadBrowserModel() first.')
  const engine = await loadingPromise

  if (!onToken) {
    const completion = await engine.chat.completions.create({ messages, stream: false, ...GENERATION_PARAMS })
    return completion.choices[0]?.message?.content ?? ''
  }

  const stream = await engine.chat.completions.create({ messages, stream: true, ...GENERATION_PARAMS })
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

export async function unloadBrowserModel(): Promise<void> {
  if (loadingPromise) {
    const engine = await loadingPromise.catch(() => null)
    if (engine) await engine.unload()
  }
  loadingPromise = null
  resolvedModelId = null
}
