import type { BrowserChatMessage } from './browserLLM'
import { browserChatCompletion, getLoadedModelId, isBrowserModelLoaded, isWebGPUSupported, loadBrowserModel, type BrowserLLMProgress } from './browserLLM'
import type { ChatResponse } from './types'

// The browser-only inference path: no local-runtime process, no Electron,
// no server -- the model runs on this device's own GPU via WebGPU, in this
// tab. This is what makes "open the site on your phone" and "open the
// site on your laptop" both work locally without either depending on the
// other or on any third machine.
//
// Honest limitation, stated to the model itself: a browser tab cannot read
// or write files, run git, or execute commands -- there is no code path
// here that could fake that. If the user asks for one of those, the model
// is instructed to say so plainly rather than pretend.
const SYSTEM_PROMPT = `
You are Yahalla AI, running entirely inside the user's own web browser via local, on-device inference (WebGPU) -- not a cloud service, not a chatbot with hidden server-side tools.

Hard rules:
- Never claim to have read a file, run a command, checked git, or done anything you cannot actually do from inside a browser tab. You have no file, git, or command access in this mode.
- If the user asks you to read/write project files, run tests, or use git/GitHub, tell them plainly: "I can't do that from the browser -- open the Yahalla AI desktop app (with the local Agent Runtime running) for file/tool access." Do not pretend to do it and do not invent a result.
- Never guess or invent facts and present them as verified. If you don't know, say you don't know.
- Be concise, direct, and honest about your own confidence.
`.trim()

export async function checkBrowserRuntimeAvailable(): Promise<boolean> {
  return isWebGPUSupported()
}

export async function prepareBrowserModel(onProgress?: (p: BrowserLLMProgress) => void): Promise<string> {
  return loadBrowserModel(onProgress)
}

export function browserModelReady(): boolean {
  return isBrowserModelLoaded()
}

export async function sendChatMessage(
  history: BrowserChatMessage[],
  message: string,
): Promise<ChatResponse & { updatedHistory: BrowserChatMessage[] }> {
  const messages: BrowserChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: message },
  ]

  const answer = await browserChatCompletion(messages)
  const updatedHistory: BrowserChatMessage[] = [
    ...history,
    { role: 'user', content: message },
    { role: 'assistant', content: answer },
  ]

  return {
    success: true,
    status: 'completed',
    answer,
    agent: { id: 'browser', key: 'yahalla-core', name_ar: 'يحalla الأساسي', name_de: 'Yahalla Core', status: 'active' },
    model: { id: 'browser', key: getLoadedModelId() ?? 'browser-model', name: getLoadedModelId() ?? 'Local browser model', type: 'general' },
    updatedHistory,
  }
}
