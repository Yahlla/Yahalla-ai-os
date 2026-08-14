import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  compactMessagesForBudget,
  conversationBudgetChars,
  estimateTokens,
  truncateToolResultForContext,
  type ChatMessage,
} from '../src/contextBudget.js'

test('estimateTokens is a real character-based estimate, not a constant', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens('a'.repeat(4)), 1)
  assert.equal(estimateTokens('a'.repeat(4000)), 1000)
})

test('conversationBudgetChars scales with the model context size and never goes below the floor', () => {
  const small = conversationBudgetChars(4096)
  const medium = conversationBudgetChars(8192)
  const large = conversationBudgetChars(32768)
  assert.ok(small < medium)
  assert.ok(medium < large)
  assert.ok(small >= 2000, 'must never collapse to ~0, or every real tool result would get compacted away')

  // A tiny/unrealistic ctx size must still produce a usable, positive floor
  // rather than a negative or zero budget.
  assert.ok(conversationBudgetChars(100) >= 2000)
})

test('truncateToolResultForContext leaves small results untouched', () => {
  const small = { success: true, path: 'a.txt', content: 'hello world' }
  assert.deepEqual(truncateToolResultForContext(small), small)
})

// Regression test for the real measured finding: read_project_file allows
// up to 1MB of file content with no context-aware cap, and
// list_project_files can return up to 2000 entries -- either one alone can
// exceed an 8192-token model's entire context window in a single tool
// result. This proves the generic truncation choke point actually catches
// that, for any tool, without needing every tool's own implementation to
// know about context budgets.
test('truncateToolResultForContext bounds an oversized real-shaped result (e.g. a large file read)', () => {
  const hugeFileContent = 'x'.repeat(200_000) // matches the real 75KB-plus files this repo actually has
  const oversized = { success: true, path: 'package-lock.json', content: hugeFileContent }
  const result = truncateToolResultForContext(oversized)

  assert.equal(result.success, true, 'success must survive truncation so callers can still tell it worked')
  assert.equal(result.truncated, true)
  assert.ok(typeof result.truncated_note === 'string' && (result.truncated_note as string).length > 0)
  const serialized = JSON.stringify(result)
  assert.ok(serialized.length < JSON.stringify(oversized).length, 'must actually be smaller than the original')
  assert.ok(serialized.length < 10_000, `expected a bounded result, got ${serialized.length} chars`)
})

test('truncateToolResultForContext preserves success:false so error handling still works after truncation', () => {
  const oversized = { success: false, error: 'x'.repeat(50_000) }
  const result = truncateToolResultForContext(oversized)
  assert.equal(result.success, false)
  assert.equal(result.truncated, true)
})

function toolRound(name: string, content: string): ChatMessage[] {
  return [
    { role: 'assistant', content: null, tool_calls: [{ id: `call_${name}`, type: 'function', function: { name, arguments: '{}' } }] },
    { role: 'tool', tool_call_id: `call_${name}`, name, content },
  ]
}

test('compactMessagesForBudget leaves a small conversation untouched', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'hi' },
    ...toolRound('get_project_overview', JSON.stringify({ success: true, overview: {} })),
  ]
  const result = compactMessagesForBudget(messages, 100_000)
  assert.deepEqual(result, messages)
})

// Regression test mirroring the actually-reported failure shape: several
// real tool rounds in a row (get_project_overview -> list_project_files ->
// multiple read_project_file calls), each with a realistically-sized
// result, accumulating past a small model's real budget within ONE task.
test('compactMessagesForBudget drops older rounds once the budget is exceeded, keeping the system message and the most recent rounds', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'audit the whole project' },
    ...toolRound('get_project_overview', 'x'.repeat(3000)),
    ...toolRound('list_project_files', 'y'.repeat(3000)),
    ...toolRound('read_project_file', 'z'.repeat(3000)),
    ...toolRound('read_project_file', 'w'.repeat(3000)),
  ]
  const budget = 5000 // deliberately small to force compaction
  const result = compactMessagesForBudget(messages, budget, 2)

  assert.equal(result[0], messages[0], 'system message must survive untouched, in place')
  assert.ok(result.length < messages.length, 'must actually be shorter than the original')
  assert.ok(result.some((m) => m.role === 'system' && typeof m.content === 'string' && m.content.includes('dropped')), 'must leave a real summary of what was dropped, not silently disappear')

  // The most recent round (the last read_project_file, content 'w'...) must
  // still be present verbatim -- compaction must never lose the newest work.
  assert.ok(result.some((m) => m.role === 'tool' && m.content === 'w'.repeat(3000)))
})

test('compactMessagesForBudget never drops the system message even under an extremely tight budget', () => {
  const messages: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    ...toolRound('a', 'x'.repeat(10_000)),
    ...toolRound('b', 'y'.repeat(10_000)),
  ]
  const result = compactMessagesForBudget(messages, 10)
  assert.equal(result[0]!.role, 'system')
  assert.equal(result[0]!.content, 'sys')
})
