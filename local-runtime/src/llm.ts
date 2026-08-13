import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
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

// Streaming counterpart of chatCompletion, for the same purely-local
// llama-server endpoint with `stream: true` -- llama-server's OpenAI-
// compatible endpoint emits a standard SSE `text/event-stream` body
// (`data: {...}\n\n` per chunk, `data: [DONE]\n\n` at the end), so this
// just accumulates the deltas the same shape a non-streaming response
// would have (choices[0].message.{content,tool_calls}) while also handing
// each content delta to onToken as it arrives -- callers that don't care
// about live tokens keep using the plain chatCompletion above untouched.
export async function chatCompletionStream(
  baseUrl: string,
  payload: Record<string, unknown>,
  onToken: (delta: string) => void,
  timeoutMs = 120_000,
): Promise<LlmCallResult> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...payload, stream: true }),
      signal: controller.signal,
    })
    if (!response.ok || !response.body) {
      const text = response.body ? await response.text() : ''
      return { ok: false, errorMessage: `Local LLM returned HTTP ${response.status}: ${text.slice(0, 500)}` }
    }

    let content = ''
    let toolCallsAccumulator: any[] | null = null
    let buffer = ''
    const reader = response.body.getReader()
    const decoder = new TextDecoder()

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE frames are separated by a blank line; a chunk of bytes from
      // the network can contain zero, one, or several complete frames, so
      // this has to loop over whatever full frames are currently in the
      // buffer rather than assuming one read() == one frame.
      let frameEnd: number
      while ((frameEnd = buffer.indexOf('\n\n')) !== -1) {
        const frame = buffer.slice(0, frameEnd)
        buffer = buffer.slice(frameEnd + 2)
        const dataLine = frame.split('\n').find((line) => line.startsWith('data:'))
        if (!dataLine) continue
        const data = dataLine.slice('data:'.length).trim()
        if (data === '[DONE]') continue

        let chunk: any
        try {
          chunk = JSON.parse(data)
        } catch {
          continue
        }
        const delta = chunk?.choices?.[0]?.delta
        if (typeof delta?.content === 'string' && delta.content) {
          content += delta.content
          onToken(delta.content)
        }
        if (Array.isArray(delta?.tool_calls)) {
          toolCallsAccumulator ??= []
          for (const tc of delta.tool_calls) {
            const index = typeof tc.index === 'number' ? tc.index : 0
            toolCallsAccumulator[index] ??= { id: tc.id, type: 'function', function: { name: '', arguments: '' } }
            const entry = toolCallsAccumulator[index]
            if (tc.id) entry.id = tc.id
            if (tc.function?.name) entry.function.name += tc.function.name
            if (tc.function?.arguments) entry.function.arguments += tc.function.arguments
          }
        }
      }
    }

    return {
      ok: true,
      data: { choices: [{ message: { role: 'assistant', content: toolCallsAccumulator ? null : content, tool_calls: toolCallsAccumulator ?? undefined } }] },
    }
  } catch (error) {
    const isAbort = error instanceof DOMException && error.name === 'AbortError'
    return {
      ok: false,
      errorMessage: isAbort
        ? `Local LLM request timed out after ${timeoutMs}ms.`
        : error instanceof Error
          ? error.message
          : 'Local LLM streaming request failed.',
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

// Actually verifies a llama-server binary runs, rather than just guessing
// from fixed paths -- findLlamaServerBinary() falls back to the bare
// "llama-server" name when nothing at a known path exists, which is not
// the same as confirming it resolves via PATH. This is what lets the
// desktop app show "llama-server isn't installed yet" instead of a
// generic, unexplained "model not reachable" the first time someone opens
// it without ever having run scripts/setup-local.sh.
export function isLlamaServerInstalled(binary: string = findLlamaServerBinary()): boolean {
  try {
    const result = spawnSync(binary, ['--version'], { stdio: 'ignore', timeout: 5000 })
    return result.error === undefined && result.status === 0
  } catch {
    return false
  }
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
