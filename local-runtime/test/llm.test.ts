import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isLlamaServerInstalled } from '../src/llm.js'

test('isLlamaServerInstalled returns true for a real, runnable binary', () => {
  // node itself always exists and supports --version -- a stand-in for
  // "llama-server is actually installed and runs", without depending on
  // llama.cpp being present in this test environment.
  assert.equal(isLlamaServerInstalled(process.execPath), true)
})

test('isLlamaServerInstalled returns false for a binary that does not exist', () => {
  assert.equal(isLlamaServerInstalled('/definitely/not/a/real/path/llama-server'), false)
})

test('isLlamaServerInstalled returns false for a binary that exits non-zero on --version', () => {
  // /bin/false (or an equivalent always-present, always-failing binary)
  // exits 1 for any invocation, including --version -- must not be
  // mistaken for "installed and working".
  assert.equal(isLlamaServerInstalled('/bin/false'), false)
})
