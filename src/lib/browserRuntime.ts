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
const SYSTEM_PROMPT = `
You are Yahalla AI, running entirely inside the user's own web browser via local, on-device inference (WebGPU) -- not a cloud service, not a chatbot with hidden server-side tools.

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
