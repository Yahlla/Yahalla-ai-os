import type { BrowserChatMessage } from './browserLLM'
import { browserChatCompletion, getLoadedModelId, isBrowserModelLoaded, isWebGPUSupported, loadBrowserModel, type BrowserLLMProgress } from './browserLLM'
import { detectLanguage, languageInstructionLine } from './langDetect'
import type { ChatResponse } from './types'
import { getLoadedWasmModelKey, isWasmLLMSupported, isWasmModelLoaded, loadWasmModel, wasmChatCompletion } from './wasmLLM'

// The browser-only inference path: no local-runtime process, no Electron,
// no server -- the model runs entirely on this device, in this tab. Two
// engines share this one entry point: WebGPU (browserLLM.ts, via
// @mlc-ai/web-llm) when the browser supports it, and a WASM fallback
// (wasmLLM.ts, via @wllama/wllama) when it doesn't -- this is what makes
// "works on the weakest phone" actually true instead of silently meaning
// "works on the weakest phone that also happens to support WebGPU," which
// falls through to the cloud tier (or nothing, on a deployment with no
// cloud tier configured) otherwise. Both engines are picked once per
// browser (the support check is static for a given browser) and never
// switch mid-session.
type Engine = 'webgpu' | 'wasm'

function selectedEngine(): Engine | null {
  if (isWebGPUSupported()) return 'webgpu'
  if (isWasmLLMSupported()) return 'wasm'
  return null
}

// Honest limitation, stated to the model itself: a browser tab cannot read
// or write files, run git, execute commands, or query Yahalla's own
// database (tasks/projects/servers/devices/approvals) -- there is no code
// path here that could fake any of that, and this mode is deliberately a
// small, fast model (weaker instruction-following than local-runtime's),
// so the boundary has to be spelled out explicitly and concretely rather
// than left for the model to infer -- a vague rule like "don't claim tools
// you don't have" still leaves room for a small model to invent a plausible-
// sounding "I have access to your data" answer instead of admitting it
// doesn't. This has actually happened (asked to list tasks, it claimed
// access to "local, localized data" instead of saying no) -- the explicit
// examples below exist because of that, not hypothetically.
// The language-matching line used to be missing here entirely (it only
// existed in the cloud-boost tier's system prompt) -- a real gap, since
// this is the tier every visitor with no local-runtime and no cloud
// smart tier falls back to. Built fresh per message now (buildSystemPrompt
// below) from a real per-message language detection instead of a single
// static instruction that can't react to the user switching languages
// mid-conversation.
function buildSystemPrompt(detectedLanguageLine: string, engine: Engine): string {
  const engineDescription = engine === 'wasm' ? 'local, on-device inference (WebAssembly/CPU)' : 'local, on-device inference (WebGPU)'
  return `
You are Yahalla AI, running entirely inside the user's own web browser via ${engineDescription} -- not a cloud service, not a chatbot with hidden server-side tools.

${detectedLanguageLine}

What you can do: hold a conversation, answer general questions, explain things, help draft or reason through something the user describes to you directly in the chat.

What you cannot do, ever, in this mode -- say so plainly the moment it's relevant, do not claim otherwise and do not stall with a vague clarifying question instead of stating the limitation:
- Read or write project files, run commands, or use git/GitHub. ("I can't do that from the browser -- open the Yahalla AI desktop app, with the local Agent Runtime running, for file/tool access.")
- See or query the user's actual Yahalla data: tasks, projects, servers, devices, approvals, or anything else stored in their account. You were not given any of it and have no way to fetch it. ("I can't see your real tasks/projects from this browser-only mode -- open the Tasks/Projects page in the sidebar for your actual data.")
- Anything requiring a live tool, sensor, or network call. You only ever see the text the user typed into this chat.

Hard rules:
- Never invent or imply access to data, tools, or actions you don't have. If a request needs any of the above, name the specific limitation and point at the real path (desktop app or the relevant sidebar page) -- don't answer as if you might have it.
- When asked what you can do, answer concretely from the "what you can do" / "what you cannot do" lists above -- never reply with only a vague clarifying question.
- Never guess or invent facts and present them as verified. If you don't know, say you don't know.
- Be concise and direct.
`.trim()
}

export async function checkBrowserRuntimeAvailable(): Promise<boolean> {
  return selectedEngine() !== null
}

export function activeBrowserEngine(): Engine | null {
  return selectedEngine()
}

export async function prepareBrowserModel(onProgress?: (p: BrowserLLMProgress) => void): Promise<string> {
  if (selectedEngine() === 'wasm') return loadWasmModel(onProgress)
  return loadBrowserModel(onProgress)
}

export function browserModelReady(): boolean {
  return selectedEngine() === 'wasm' ? isWasmModelLoaded() : isBrowserModelLoaded()
}

export async function sendChatMessage(
  history: BrowserChatMessage[],
  message: string,
  onToken?: (delta: string) => void,
): Promise<ChatResponse & { updatedHistory: BrowserChatMessage[] }> {
  const engine = selectedEngine() ?? 'webgpu'
  const detectedLanguage = detectLanguage(message)
  const messages: BrowserChatMessage[] = [
    { role: 'system', content: buildSystemPrompt(languageInstructionLine(detectedLanguage), engine) },
    ...history,
    { role: 'user', content: message },
  ]

  const answer = engine === 'wasm' ? await wasmChatCompletion(messages, onToken) : await browserChatCompletion(messages, onToken)
  const updatedHistory: BrowserChatMessage[] = [
    ...history,
    { role: 'user', content: message },
    { role: 'assistant', content: answer },
  ]

  const loadedModelId = engine === 'wasm' ? getLoadedWasmModelKey() : getLoadedModelId()
  return {
    success: true,
    status: 'completed',
    answer,
    agent: { id: 'browser', key: 'yahalla-core', name_ar: 'يحalla الأساسي', name_de: 'Yahalla Core', status: 'active' },
    model: { id: 'browser', key: loadedModelId ?? 'browser-model', name: loadedModelId ?? 'Local browser model', type: 'general' },
    updatedHistory,
  }
}
