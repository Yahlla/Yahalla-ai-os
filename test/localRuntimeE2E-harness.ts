// Real end-to-end proof that the frontend's "local-runtime is the real
// primary Agent path" fix actually works: this runs in a real browser
// (via test/localRuntimeE2E.smoke.mjs) against a real local-runtime HTTP
// server -- only the LLM backend behind it is swapped for a deterministic
// fake, the same discipline local-runtime's own test suite uses
// throughout (real HTTP, real SQLite, real permission checks, real tool
// execution; only token generation itself is stood in for, since a real
// GGUF model is multi-gigabytes and not something a CI sandbox can fetch).
// Everything this file calls -- pairWithLocalRuntime, getRuntimeInfo,
// isPairedWithLocalRuntime, sendChatMessage -- is the real
// src/lib/localRuntime.ts code, unmodified for the test.

import * as localRuntime from '../src/lib/localRuntime'
import { isPlatformApiConfigured } from '../src/lib/platformApi'

const result = document.getElementById('result')!

function report(text: string) {
  result.textContent = text
  document.title = text
}

function must(condition: boolean, message: string): void {
  if (!condition) throw new Error(message)
}

;(async () => {
  try {
    const runtimeBase = new URLSearchParams(location.search).get('runtimeBase')
    must(Boolean(runtimeBase), 'runtimeBase query param missing')

    // Proves this harness (and by extension the routing fix) never
    // depends on Strato/platform-api being configured at all.
    must(!isPlatformApiConfigured(), 'platform-api must NOT be configured in this harness')

    const before = await localRuntime.getRuntimeInfo()
    must(before === null, 'expected no stored pairing before pairWithLocalRuntime()')

    const health = await localRuntime.checkRuntimeHealth()
    must(Boolean(health?.llm_reachable), `expected llm_reachable=true from the real local-runtime health check, got: ${JSON.stringify(health)}`)

    const pairResult = await localRuntime.pairWithLocalRuntime(runtimeBase!)
    must(pairResult.ok, `pairing failed: ${!pairResult.ok ? pairResult.error : ''}`)

    const after = await localRuntime.getRuntimeInfo()
    must(after !== null, 'expected a stored pairing after pairWithLocalRuntime()')

    const paired = await localRuntime.isPairedWithLocalRuntime()
    must(paired, 'isPairedWithLocalRuntime() should be true after a successful pairing')

    // A real chat request through the real local-runtime /chat endpoint,
    // driving its real agentLoop: real tool-call parsing, real permission
    // check, real read_project_file execution against a real fixture
    // file on disk, real second round-trip back to the (fake) LLM with
    // the real tool result.
    const chatResult = await localRuntime.sendChatMessage({ message: 'read package.json and tell me the version' })
    must(chatResult.status === 'completed', `chat did not complete: ${JSON.stringify(chatResult)}`)
    must(Boolean(chatResult.answer && /9\.9\.9/.test(chatResult.answer)), `unexpected answer: ${chatResult.answer}`)
    must(
      Boolean(chatResult.executed_tools && chatResult.executed_tools.length === 1 && chatResult.executed_tools[0].tool === 'read_project_file'),
      `expected exactly one real read_project_file tool call, got: ${JSON.stringify(chatResult.executed_tools)}`,
    )

    report('PASS')
  } catch (error) {
    report(`FAIL:${error instanceof Error ? error.message : String(error)}`)
  }
})()
