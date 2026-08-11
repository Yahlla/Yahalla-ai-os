import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'

export type ChatMessage = { role: string; content: string | null; tool_calls?: unknown; tool_call_id?: string; name?: string }

export type LlmCallResult =
  | { ok: true; data: any }
  | { ok: false; errorMessage: string }

// Talks to whatever OpenAI-compatible server is running the local model
// (llama.cpp's own server, Ollama's OpenAI-compatible endpoint, LM Studio,
// etc.) at a purely local address. This function never reaches outside
// 127.0.0.1 -- there is no code path here that can be pointed at a remote
// host, unlike the old YAHALLA_LLM_URL design.
export async function chatCompletion(
  baseUrl: string,
  payload: Record<string, unknown>,
  timeoutMs = 120_000,
): Promise<LlmCallResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
    const text = await response.text()
    let data: any
    try {
      data = JSON.parse(text)
    } catch {
      data = text
    }
    if (!response.ok) {
      return { ok: false, errorMessage: `Local LLM returned HTTP ${response.status}: ${text.slice(0, 500)}` }
    }
    return { ok: true, data }
  } catch (error) {
    const isAbort = error instanceof DOMException && error.name === 'AbortError'
    return {
      ok: false,
      errorMessage: isAbort
        ? `Local LLM request timed out after ${timeoutMs}ms.`
        : error instanceof Error
          ? error.message
          : 'Local LLM request failed.',
    }
  } finally {
    clearTimeout(timeout)
  }
}

export async function isLlmReachable(baseUrl: string, timeoutMs = 3000): Promise<boolean> {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    const response = await fetch(`${baseUrl}/v1/models`, { signal: controller.signal })
    clearTimeout(timeout)
    return response.ok
  } catch {
    return false
  }
}

const SERVER_BINARY_CANDIDATES = [
  'llama-server',
  '/opt/homebrew/bin/llama-server',
  '/usr/local/bin/llama-server',
  '/usr/bin/llama-server',
]

export function findLlamaServerBinary(): string {
  for (const candidate of SERVER_BINARY_CANDIDATES) {
    if (candidate.includes('/')) {
      if (existsSync(candidate)) return candidate
    }
  }
  // Bare "llama-server" is left for the spawn call itself to resolve via
  // PATH -- existsSync can't check PATH-relative binaries portably.
  return SERVER_BINARY_CANDIDATES[0]!
}

export class LocalModelProcess {
  private child: ChildProcess | undefined
  readonly port: number
  readonly baseUrl: string

  constructor(port: number) {
    this.port = port
    this.baseUrl = `http://127.0.0.1:${port}`
  }

  isRunning(): boolean {
    return Boolean(this.child && this.child.exitCode === null && !this.child.killed)
  }

  start(binary: string, modelPath: string, extraArgs: string[] = []): void {
    if (this.isRunning()) return
    this.child = spawn(
      binary,
      ['--model', modelPath, '--port', String(this.port), '--host', '127.0.0.1', ...extraArgs],
      { stdio: 'ignore', detached: false },
    )
  }

  stop(): void {
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM')
    }
    this.child = undefined
  }

  async waitUntilReady(timeoutMs = 60_000): Promise<boolean> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (await isLlmReachable(this.baseUrl, 2000)) return true
      await new Promise((r) => setTimeout(r, 1000))
    }
    return false
  }
}
