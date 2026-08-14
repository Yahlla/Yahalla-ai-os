// Deliberately redefined here (structurally identical to agentLoop.ts's
// ChatMessage) rather than imported from it, to avoid a circular import --
// agentLoop.ts imports from this module, so this module cannot import back.
export type ChatMessage = { role: string; content: string | null; tool_calls?: unknown; tool_call_id?: string; name?: string }

// Real audit finding (measured on this actual repository, not guessed):
// list_project_files('.') here returns 465 entries / ~16.5KB JSON (~4,100
// tokens); a single read_project_file on this repo's own package-lock.json
// (75KB) would be ~19,000 tokens on its own -- more than an entire 8192
// n_ctx budget from ONE tool call; buildOpenAITools() (~11.8KB / ~2,950
// tokens) was being resent in full on every single round. None of this was
// bounded anywhere: runLoop's state.messages accumulated every tool result
// from every round of a task forever and resent the whole array each round.
// That combination -- not the model's ctx-size setting -- is what a real
// "give me a project overview" request could inflate to 15K+ tokens with,
// on exactly the first few tools the system prompt tells the model to call.
//
// Fix strategy: (1) cap any single tool result's serialized size before it
// ever enters the message array (closes the single-call blowup case), (2)
// compact older tool-call/tool-result rounds out of a long-running task
// once the whole array's estimated size approaches the active model's real
// context budget (closes the cumulative-across-rounds case). Both are pure,
// unit-testable functions -- no LLM/DB/network dependency -- so the budget
// math itself can be verified without spinning up a real server.

// A real token count needs the model's own tokenizer (llama-server exposes
// no such endpoint on the OpenAI-compatible surface this app uses); ~4
// characters per token is the standard rough heuristic for English/code
// text and is deliberately a slight overestimate for safety (undercounting
// would risk still exceeding the real budget).
const CHARS_PER_TOKEN_ESTIMATE = 4

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN_ESTIMATE)
}

// Measured: buildOpenAITools() is ~2,950 tokens and the system prompt
// (evidence rules + workflow + tone, before per-request perception/memory
// additions) is a few hundred more -- reserved here so the *budget for
// conversation content* is never computed as if the whole context window
// were available for it. Deliberately generous/conservative (round up)
// since perception/memory context and a self-dev addendum can add more.
const RESERVED_FOR_SYSTEM_AND_TOOLS_TOKENS = 4000
// Room for the model's own reply (an answer or a tool call) -- a budget
// that leaves zero room for output is not usable.
const RESERVED_FOR_OUTPUT_TOKENS = 1000
// Never let the usable budget collapse to (near) zero even on the smallest
// configured ctx-size -- there must always be room for at least a modest
// tool result, or every real tool call would immediately get compacted away.
const MIN_USABLE_BUDGET_CHARS = 2000

// How many characters of conversation/tool-result content are actually
// available for a given model's real context window, after reserving room
// for what's sent alongside it (system prompt + tool schemas) and what the
// model needs to produce back (its next reply).
export function conversationBudgetChars(modelContextTokens: number): number {
  const usableTokens = modelContextTokens - RESERVED_FOR_SYSTEM_AND_TOOLS_TOKENS - RESERVED_FOR_OUTPUT_TOKENS
  return Math.max(usableTokens * CHARS_PER_TOKEN_ESTIMATE, MIN_USABLE_BUDGET_CHARS)
}

// Applied to every tool result before it is pushed into the message array,
// for every tool, unconditionally -- the single choke point every tool's
// output flows through, rather than trying to bound each tool's own
// implementation individually (some of which, like read_project_file's
// 1MB cap, are correctly generous for the *file safety* question "is this
// a reasonable file to read" while being wildly unsafe for the separate
// question "is this a reasonable amount of text to hand an 8K-token
// model"). success/error/truncated fields are preserved untouched so
// existing callers that check result.success keep working unchanged.
const MAX_TOOL_RESULT_CHARS = 6000

export function truncateToolResultForContext(result: Record<string, unknown>): Record<string, unknown> {
  const serialized = JSON.stringify(result)
  if (serialized.length <= MAX_TOOL_RESULT_CHARS) return result

  return {
    success: result.success,
    truncated: true,
    truncated_note: `This tool result was ${serialized.length} characters (~${estimateTokens(serialized)} tokens) -- too large to send to the model in full, so it has been cut down to fit the context window. Ask a narrower question instead (a specific file, a specific subdirectory via the "path" argument, or a smaller command output) rather than retrying the same call.`,
    preview: serialized.slice(0, MAX_TOOL_RESULT_CHARS),
  }
}

// Compacts a task's accumulated message array once it approaches the
// active model's real budget: the system message (index 0, never touched)
// plus the most recent keepRecentRounds assistant/tool exchanges are kept
// verbatim; everything older is collapsed into one short summary message so
// the model still knows work happened earlier in this task without paying
// the full token cost of re-reading every past tool result on every future
// round. A "round" here is one assistant message plus the tool result
// message(s) that immediately follow it, mirroring how runLoop actually
// appends them.
export function compactMessagesForBudget(messages: ChatMessage[], maxChars: number, keepRecentRounds = 2): ChatMessage[] {
  if (messages.length === 0) return messages
  const [system, ...rest] = messages
  const totalChars = rest.reduce((sum, m) => sum + (m.content ?? '').length + JSON.stringify(m.tool_calls ?? '').length, 0)
  if (totalChars <= maxChars) return messages

  // Walk backward from the end, grouping into rounds (an assistant message
  // starts a new round; any tool messages immediately after it belong to
  // that same round), until keepRecentRounds rounds are collected.
  const rounds: ChatMessage[][] = []
  let current: ChatMessage[] = []
  for (let i = rest.length - 1; i >= 0; i--) {
    const m = rest[i]!
    current.unshift(m)
    if (m.role === 'assistant') {
      rounds.unshift(current)
      current = []
    }
  }
  if (current.length > 0) rounds.unshift(current) // any leading fragment (e.g. a lone user message) with no assistant message yet

  const keptRounds = rounds.slice(-keepRecentRounds)
  const droppedRounds = rounds.slice(0, Math.max(rounds.length - keepRecentRounds, 0))
  const droppedToolCalls = droppedRounds.flat().filter((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))
  const droppedToolNames = droppedRounds
    .flat()
    .filter((m) => m.role === 'tool')
    .map((m) => m.name)
    .filter((n): n is string => Boolean(n))

  const kept = keptRounds.flat()
  if (droppedRounds.length === 0) return messages

  const summary: ChatMessage = {
    role: 'system',
    content: `[Context budget: ${droppedToolCalls.length} earlier tool call(s) from this task (${[...new Set(droppedToolNames)].join(', ') || 'no tools'}) were dropped from the visible conversation to stay within the model's context window. Their side effects (file writes, commits, etc.) already happened for real -- only the detailed text of their results was removed here. Re-call a tool if you need to see that data again; do not assume it never ran.]`,
  }

  return [system!, summary, ...kept]
}
