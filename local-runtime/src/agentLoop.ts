import { executeDeviceTool } from '@yahalla/agent-tools'
import { listDatabaseConnections, queryDatabase, executeDatabase } from './database.js'
import type { Db } from './db.js'
import { newId } from './db.js'
import type { EmbodimentStateMachine } from './embodiment/stateMachine.js'
import { githubOpenPr, githubRead, githubWrite } from './github.js'
import { diagnoseCommandFailure, signatureForToolFailure, sortKeys } from './diagnostics.js'
import { detectLanguage, languageInstructionLine } from './langDetect.js'
import { chatCompletion, chatCompletionStreamWithRetry, chatCompletionWithRetry } from './llm.js'
import { browserClick, browserClose, browserOpen, browserRead, browserType } from './browser.js'
import { addKnowledge, addMemory, getPreference, recordTaskFeedback } from './memory.js'
import { checkAccess } from './permissions.js'
import { compactMessagesForBudget, conversationBudgetChars, truncateToolResultForContext } from './contextBudget.js'
import { recommendedContextSize } from './modelManager.js'
import type { WorldModel } from './perception/worldModel.js'
import { getProjectIndex } from './projectIndex.js'
import { getDeviceRole, isToolAllowedForRole, roleDeniedMessage } from './roles.js'
import {
  isOnProtectedBranch,
  isSelfDevProject,
  SELF_DEV_MUTATING_TOOLS,
  SELF_DEV_SYSTEM_PROMPT_ADDENDUM,
  selfDevBranchGuardMessage,
  summarizeSelfDevOutcome,
} from './selfDev.js'
import { getSubAgentProfile, type SubAgentProfile } from './subAgents.js'
import { buildOpenAITools, DEFAULT_RUN_COMMAND_ALLOWLIST, getTool, type ToolDef } from './tools.js'
import { searchMemory, storeMemory } from './vectorMemory.js'

export type ChatMessage = { role: string; content: string | null; tool_calls?: any; tool_call_id?: string; name?: string }

export type ChatResult = {
  success: boolean
  conversationId: string
  taskId?: string
  status: 'completed' | 'waiting_approval' | 'failed' | 'cancelled'
  answer?: string
  error?: string
  executedTools?: { tool: string; arguments: Record<string, unknown>; result: Record<string, unknown> }[]
  approvalId?: string
  approvalTool?: string
}

export type RuntimeContext = {
  db: Db
  projectRoot: string
  llmBaseUrl: string
  modelKey: string
  embodiment: EmbodimentStateMachine
  worldModel: WorldModel
  // Set once this device is paired to a platform-api deployment (see
  // devicePairing.ts) -- lets the agent loop pull relevant project memory
  // into context automatically (vectorMemory.ts) instead of the user
  // having to re-explain history every conversation. Both unset just means
  // memory search/store silently no-ops.
  platformApiUrl?: string
  deviceToken?: string
}

// Evidence/verification and coding-agent-workflow rules carried over
// verbatim in spirit from the platform's Supabase edge function system
// prompt -- these are the behavioral rules that matter, independent of
// where the agent loop actually executes.
async function buildSystemPrompt(projectRoot: string, ctx: RuntimeContext, currentMessage: string): Promise<string> {
  // Real, near-instant step (the detector itself runs in <5ms, see
  // langDetect.ts) surfaced through the same embodiment.transition() +
  // /live/stream SSE mechanism the "Analyzing request"/"Continuing
  // analysis" steps right after this already use -- the frontend's
  // Live Thinking Card (App.tsx's thinkingSteps) picks this up with no
  // changes needed on that side, since it already renders any transition
  // this loop emits.
  ctx.embodiment.transition('THINKING', 'Detecting language')
  const detectedLanguage = detectLanguage(currentMessage)

  const perceptionContext = buildPerceptionContext(ctx)
  const memoryContext = await buildMemoryContext(ctx, currentMessage)
  const selfDevContext = isSelfDevProject(projectRoot) ? `\n${SELF_DEV_SYSTEM_PROMPT_ADDENDUM}\n` : ''
  const role = getDeviceRole(ctx.db)
  const roleContext =
    role === 'normal'
      ? `\nThis device is set to the "normal" role: you only have read-only access (reading files/project structure, git status/diff, GitHub reads, database reads). Writing files, running commands, git mutation, GitHub writes, database writes, browser automation, self-development, and dispatching sub-agents are all blocked at the tool level on this device -- do not repeatedly retry them. If asked for one of those, say plainly that this device's role does not allow it and an owner/trainer would need to change the role first.\n`
      : ''
  return `
You are Yahalla AI, a real local coding agent running entirely on this device -- not a chatbot that talks about code. The project you work on is at: ${projectRoot}
${selfDevContext}${roleContext}

Evidence and verification -- hard rules:
- Never guess or invent any fact about the project (file contents, versions, config, git state, test results). Every claim about the project must come from an actual tool result you just received.
- Never invent, assume, or fabricate a tool result. If you have not called the tool, you do not know the answer.
- If a tool call fails or is unavailable, say so plainly ("I could not verify this -- <reason>"). Do not paper over it with a guess.
- Never say a task is done, fixed, or succeeded without a tool result that actually proves it. A file write is not "done" until you have read it back or diffed it; a fix is not "done" until the relevant test/build command has actually been run and passed.

Coding-agent workflow for any request that touches the project. You are autonomous through this entire sequence -- no step here pauses for approval, so work it end-to-end without asking the user to confirm each action:
1. Analyze the request. 2. Inspect the project for real -- call get_project_overview first to get oriented cheaply (languages, detected packages/scripts, config files, git state), then list_project_files / read_project_file for anything the overview doesn't cover -- before assuming anything. 3. Plan the change -- for anything non-trivial, create a branch first (git_create_branch). 4. Execute it (write_project_file / patch_project_file) -- old_text must be copied verbatim from a read you just did. 5. Verify by reading the file back or using git_diff. 6. Run the relevant test/build command (run_project_command) when one applies. 7. If it fails, diagnose the real output, fix it, and re-run the same command. Repeat until it passes or you have a concrete, evidence-based reason it cannot. 8. Commit (git_commit) and push (git_push) the branch. 9. Open a pull request (github.open_pr) describing what changed, why, and what you verified -- this PR is the human's review checkpoint, not a request for permission first. 10. Report the outcome and the PR link, citing what you actually verified.

Git and GitHub: git_status/git_diff/git_create_branch/git_commit/git_push/github.open_pr are all free to use without asking -- call them directly as part of the workflow above, never ask the user to run a command themselves, and never fabricate a commit hash, repo URL, PR number, or push result. github.write (creating a brand-new repository, not a PR) is the one GitHub action that still requires the user's approval -- the platform enforces this automatically, just call the tool and wait.

Databases: call db_list_connections first if you don't already know a connection's id. db_query is read-only (enforced by the database itself, not just convention) and safe to use freely for inspecting data/schema, debugging, and diagnostics. db_execute runs writes/DDL and requires the user's approval -- call it directly, never ask the user to run SQL themselves, and never fabricate query results or row counts.

Delegation: for a distinct, self-contained piece of work worth handing off rather than doing inline yourself -- e.g. "go research how X currently works" while you keep planning, or "implement this specific change" as its own focused unit -- use dispatch_subagent with the profile that matches (researcher/coder/tester/reviewer). The sub-agent runs its own real bounded tool-calling loop and reports back exactly what it found or did, plus which tools it used; it has no memory of this conversation, so write its task description as a complete, standalone instruction.
${perceptionContext ? `\n${perceptionContext}\n` : ''}${memoryContext ? `\n${memoryContext}\n` : ''}
Tone: be concise and useful, but also warm and human -- a sharp colleague, not a terminal. A short bit of genuine personality (light humor, a natural aside) is welcome when it fits and never gets in the way of the actual answer; never force it, and never let it soften or hide a real evidence/verification finding above. ${languageInstructionLine(detectedLanguage)}
`.trim()
}

// Folds relevant prior project memory into the prompt as weak supporting
// context, the same trust level as the perception context above -- real
// past entries this project actually recorded, ranked by a real cosine
// similarity search (see vectorMemory.ts), but never presented as
// something the user just said. Silently empty when this device isn't
// paired to platform-api, or nothing relevant was ever recorded.
async function buildMemoryContext(ctx: RuntimeContext, currentMessage: string): Promise<string> {
  const results = await searchMemory({ platformApiUrl: ctx.platformApiUrl, deviceToken: ctx.deviceToken }, currentMessage, 5)
  const relevant = results.filter((r) => r.similarity > 0.3)
  if (relevant.length === 0) return ''

  const lines = relevant.map((r) => `- (${new Date(r.created_at).toLocaleDateString()}, ${r.source}) ${r.content}`)
  return `Relevant memory from this project's history (retrieved by similarity to the current message, not guaranteed relevant -- use only what's actually applicable):\n${lines.join('\n')}`
}

function summarizeForMemory(message: string, result: ChatResult): string {
  const tools = (result.executedTools ?? []).map((t) => t.tool).join(', ')
  const answer = (result.answer ?? '').slice(0, 400)
  return `Task: ${message.slice(0, 300)}\nTools used: ${tools || 'none'}\nOutcome: ${answer}`
}

// Folds the World Model into the prompt as weak, explicitly-probabilistic
// supporting context -- never as a substitute for what the user actually
// typed/said. This is the concrete "Agent reasons over perception events"
// integration point: nothing here claims to read emotion or intent, only
// the same confidence-scored signals the perception layer produced.
function buildPerceptionContext(ctx: RuntimeContext): string {
  const snapshot = ctx.worldModel.getSnapshot()
  if (snapshot.humans.length === 0) return ''

  const lines = snapshot.humans.map((human) => {
    const parts: string[] = [`state=${human.interactionState}`]
    if (human.gaze?.target) parts.push(`gaze target="${human.gaze.target}" (confidence ${human.gaze.confidence.toFixed(2)})`)
    if (human.voice.lastFinal) parts.push(`last speech="${human.voice.lastFinal}"`)
    return `- person ${human.trackId}: ${parts.join(', ')}`
  })

  return `Local perception context (probabilistic signals, not facts -- use only as weak supporting context; the user's actual text/voice message always takes precedence):\n${lines.join('\n')}`
}

function summarizeToolCall(tool: ToolDef, args: Record<string, unknown>): string {
  switch (tool.key) {
    case 'dispatch_subagent':
      return `Dispatching to the ${args.profile ?? 'sub-agent'}`
    case 'get_project_overview':
      return 'Getting oriented on the project'
    case 'read_project_file':
      return `Reading ${args.path ?? 'a file'}`
    case 'list_project_files':
      return `Inspecting ${args.path && args.path !== '.' ? args.path : 'project structure'}`
    case 'write_project_file':
      return `Writing ${args.path ?? 'a file'}`
    case 'patch_project_file':
      return `Applying correction to ${args.path ?? 'a file'}`
    case 'git_status':
      return 'Checking git status'
    case 'git_diff':
      return 'Reviewing changes'
    case 'git_create_branch':
      return `Creating branch ${args.branch ?? ''}`
    case 'git_commit':
      return 'Committing changes'
    case 'git_push':
      return 'Pushing to remote'
    case 'run_project_command':
      return `Running ${args.command ?? 'command'}`
    case 'github.read':
      return 'Checking GitHub repositories'
    case 'github.write':
      return 'Creating GitHub repository'
    case 'github.open_pr':
      return `Opening pull request "${args.title ?? ''}"`
    case 'db_list_connections':
      return 'Listing connected databases'
    case 'db_query':
      return 'Querying the database'
    case 'db_execute':
      return 'Modifying the database'
    case 'browser_open':
      return `Opening ${args.url ?? 'a web page'}`
    case 'browser_read':
      return 'Reading the web page'
    case 'browser_click':
      return `Clicking "${args.selector ?? ''}"`
    case 'browser_type':
      return 'Typing into the web page'
    case 'browser_close':
      return 'Closing the browser'
    default:
      return `Using ${tool.key}`
  }
}

function summarizeToolResult(tool: ToolDef, result: Record<string, unknown>): string {
  if (tool.key === 'run_project_command') {
    return result.success ? 'Command completed successfully' : 'Command failed'
  }
  if (result.success === false) return `${summarizeToolCall(tool, {})} failed`
  return `${summarizeToolCall(tool, {})} -- done`
}

// Cross-round repeated-failure detection: a failed result gets a stable
// signature (structured, via diagnostics.ts's diagnoseCommandFailure for
// run_project_command since it has stdout/stderr to fingerprint; generic
// for every other tool). If this exact {tool, arguments, error} has
// already failed before in this task, the model is told explicitly instead
// of being left to silently repeat the same failing strategy until
// max_tool_rounds runs out. A successful result is left untouched.
function annotateRepeatedFailure(
  state: LoopState,
  tool: ToolDef,
  args: Record<string, unknown>,
  result: Record<string, unknown>,
): Record<string, unknown> {
  if (result.success !== false) return result

  const signature =
    tool.key === 'run_project_command'
      ? diagnoseCommandFailure(String(args.command ?? ''), result as { exit_code?: number | null; stdout?: string; stderr?: string })
          .failureSignature
      : signatureForToolFailure(tool.key, args, result.error ?? result)

  state.failureSignatures ??= {}
  const priorCount = state.failureSignatures[signature] ?? 0
  state.failureSignatures[signature] = priorCount + 1

  if (priorCount === 0) return result
  return {
    ...result,
    repeated_failure_warning: `This exact call has already failed the same way ${priorCount} time(s) before in this task. Repeating it unchanged will not help -- try a different approach, inspect more context first, or explain to the user why it cannot proceed.`,
  }
}

function toolPermissionTarget(tool: ToolDef, projectRoot: string): string {
  return tool.permission.scope === 'project' ? projectRoot : '*'
}

async function executeToolNow(
  ctx: RuntimeContext,
  tool: ToolDef,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  // Real, code-enforced role gate -- checked fresh from the database on
  // every single call, before the existing standing-permission check
  // below. A 'normal'-role device can never reach a write/execute/
  // browser/self-dev/sub-agent tool no matter what the model is asked to
  // do or how the request is phrased; this is not a system-prompt
  // instruction the model could be talked out of.
  const role = getDeviceRole(ctx.db)
  if (!isToolAllowedForRole(role, tool.key)) {
    return { success: false, error: roleDeniedMessage(role, tool.key) }
  }

  const allowed = checkAccess(ctx.db, tool.permission.scope, toolPermissionTarget(tool, ctx.projectRoot), tool.permission.access)
  if (!allowed) {
    return {
      success: false,
      error: `Permission denied: this tool needs "${tool.permission.access}" access to "${tool.permission.scope}", which has not been granted. Grant it in Settings > Permissions.`,
    }
  }

  // Self-development safety rail: when the project being modified is
  // Yahalla's own source, mutating tools are blocked outright while the
  // working tree sits on a protected branch. Checked here (not just asked
  // for in the system prompt) so it holds even if the model ignores the
  // instruction -- real git state, read fresh, not a cached assumption.
  if (SELF_DEV_MUTATING_TOOLS.has(tool.key) && isSelfDevProject(ctx.projectRoot) && isOnProtectedBranch(ctx.projectRoot)) {
    return { success: false, error: selfDevBranchGuardMessage(tool.key) }
  }

  if (tool.key === 'get_project_overview') {
    return { success: true, overview: getProjectIndex(ctx.projectRoot, { forceRefresh: args.refresh === true }) }
  }

  if (tool.category === 'browser') {
    if (tool.key === 'browser_open') return browserOpen(args)
    if (tool.key === 'browser_read') return browserRead(args)
    if (tool.key === 'browser_click') return browserClick(args)
    if (tool.key === 'browser_type') return browserType(args)
    return browserClose()
  }

  if (tool.category === 'orchestration') {
    return runSubAgent(ctx, String(args.profile ?? ''), String(args.task ?? ''))
  }

  if (tool.category === 'github') {
    const token = getPreference<string>(ctx.db, 'github_token')
    if (tool.key === 'github.read') return githubRead(token, args)
    if (tool.key === 'github.open_pr') return githubOpenPr(token, args)
    return githubWrite(token, args)
  }

  if (tool.category === 'database') {
    if (tool.key === 'db_list_connections') {
      return { success: true, connections: listDatabaseConnections(ctx.db) }
    }
    const connectionId = String(args.connection_id ?? '')
    const query = String(args.query ?? '')
    return tool.key === 'db_query' ? queryDatabase(ctx.db, connectionId, query) : executeDatabase(ctx.db, connectionId, query)
  }

  const config = tool.key === 'run_project_command' ? { allowlist: DEFAULT_RUN_COMMAND_ALLOWLIST } : {}
  return executeDeviceTool(tool.key, ctx.projectRoot, args, config, signal)
}

type SubAgentLoopResult = {
  success: boolean
  answer?: string
  error?: string
  executedTools: { tool: string; arguments: Record<string, unknown>; result: Record<string, unknown> }[]
}

// A real, bounded, independent tool-calling loop for a dispatched
// sub-agent -- its own LLM calls, its own tool execution (through the same
// executeToolNow/permission checks every top-level tool call goes
// through, so a sub-agent can never do more than a real granted
// permission allows), but restricted to exactly profile.allowedToolKeys
// and never offered dispatch_subagent itself, so nesting is impossible by
// construction, not by a runtime check that could be forgotten. Deliberately
// simpler than the top-level runLoop: no task/conversation persistence (a
// sub-agent run is not a first-class task the user browses), no
// approval-gated pause (there is no human present mid-subtask to decide --
// an approval-requiring tool is refused outright instead), no
// dedup/repeated-failure bookkeeping (the profile's small round budget
// keeps a runaway sub-agent bounded regardless).
async function runSubAgentLoop(ctx: RuntimeContext, profile: SubAgentProfile, task: string): Promise<SubAgentLoopResult> {
  const systemPrompt = `You are a specialized Yahalla AI sub-agent ("${profile.name}") dispatched by an orchestrating agent to handle exactly one bounded subtask -- you have no memory of the orchestrator's conversation, only what is written below. ${profile.focus}

The project you work on is at: ${ctx.projectRoot}

Never guess or invent a fact -- every claim must come from an actual tool result you just received. When you are done, give one clear, concise final report of what you found or did; this is returned directly to the orchestrator, which cannot see your intermediate tool calls.`

  const messages: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task },
  ]
  const executedTools: SubAgentLoopResult['executedTools'] = []
  const llmTools = buildOpenAITools().filter((t) => t.function.name !== 'dispatch_subagent' && profile.allowedToolKeys.includes(t.function.name))
  const budgetChars = conversationBudgetChars(recommendedContextSize(ctx.modelKey))

  for (let round = 0; round < profile.maxRounds; round++) {
    messages.splice(0, messages.length, ...compactMessagesForBudget(messages, budgetChars))
    ctx.embodiment.transition('THINKING', `[${profile.name}] working on: ${task.slice(0, 80)}`)
    const result = await chatCompletionWithRetry(ctx.llmBaseUrl, { model: ctx.modelKey, messages, tools: llmTools })
    if (!result.ok) return { success: false, error: result.errorMessage, executedTools }

    const message = result.data?.choices?.[0]?.message
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : []

    if (toolCalls.length === 0) {
      const answer: string = message?.content ?? ''
      if (!answer) return { success: false, error: 'Sub-agent returned no usable answer.', executedTools }
      return { success: true, answer, executedTools }
    }

    messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: toolCalls })

    for (const call of toolCalls) {
      const toolName = call.function?.name
      const tool = getTool(toolName)
      let args: Record<string, unknown> = {}
      let argsParseFailed = false
      try {
        args = typeof call.function?.arguments === 'string' ? JSON.parse(call.function.arguments) : (call.function?.arguments ?? {})
      } catch {
        argsParseFailed = true
      }

      if (!tool || !profile.allowedToolKeys.includes(tool.key)) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: toolName,
          content: JSON.stringify({ success: false, error: `Tool "${toolName}" is not available to the ${profile.name} sub-agent.` }),
        })
        continue
      }
      if (argsParseFailed) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: tool.key,
          content: JSON.stringify({ success: false, error: `Arguments for "${tool.key}" were not valid JSON.` }),
        })
        continue
      }
      if (tool.requiresApproval) {
        messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: tool.key,
          content: JSON.stringify({ success: false, error: `"${tool.key}" requires human approval, which is not available to a dispatched sub-agent. Report this back instead of retrying.` }),
        })
        continue
      }

      const toolResult = await executeToolNow(ctx, tool, args)
      executedTools.push({ tool: tool.key, arguments: args, result: toolResult })
      messages.push({ role: 'tool', tool_call_id: call.id, name: tool.key, content: JSON.stringify(truncateToolResultForContext(toolResult)) })
    }
  }

  return { success: false, error: `Sub-agent exceeded its round budget (${profile.maxRounds}) without a final answer.`, executedTools }
}

async function runSubAgent(ctx: RuntimeContext, profileKey: string, task: string): Promise<Record<string, unknown>> {
  const profile = getSubAgentProfile(profileKey)
  if (!profile) {
    return { success: false, error: `Unknown sub-agent profile "${profileKey}". Valid profiles: researcher, coder, tester, reviewer.` }
  }
  if (!task.trim()) {
    return { success: false, error: 'A task description is required to dispatch a sub-agent.' }
  }

  const result = await runSubAgentLoop(ctx, profile, task)
  return {
    success: result.success,
    profile: profile.key,
    report: result.success ? result.answer : (result.error ?? 'Sub-agent failed.'),
    tools_used: result.executedTools.map((t) => t.tool),
    executed_tools: result.executedTools,
  }
}

function getOrCreateConversation(db: Db, conversationId: string | undefined, firstMessage: string): string {
  if (conversationId) {
    const existing = db.prepare('SELECT id FROM conversations WHERE id = ?').get(conversationId)
    if (existing) return conversationId
  }
  const id = newId()
  db.prepare('INSERT INTO conversations (id, title) VALUES (?, ?)').run(id, firstMessage.slice(0, 80))
  return id
}

function loadHistory(db: Db, conversationId: string, limit = 20): ChatMessage[] {
  const rows = db
    .prepare('SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(conversationId, limit) as { role: string; content: string }[]
  return rows.reverse().map((r) => ({ role: r.role, content: r.content }))
}

function saveMessage(db: Db, conversationId: string, role: string, content: string, toolActivity: unknown[] = []): void {
  db.prepare(
    'INSERT INTO messages (id, conversation_id, role, content, tool_activity) VALUES (?, ?, ?, ?, ?)',
  ).run(newId(), conversationId, role, content, JSON.stringify(toolActivity))
  db.prepare("UPDATE conversations SET updated_at = datetime('now') WHERE id = ?").run(conversationId)
}

type LoopState = {
  messages: ChatMessage[]
  executedTools: { tool: string; arguments: Record<string, unknown>; result: Record<string, unknown> }[]
  // Signature -> occurrence count, for cross-round repeated-failure
  // detection (see diagnostics.ts). Plain Record, not a Map: this whole
  // object round-trips through JSON.stringify/JSON.parse when a task pauses
  // for approval (see resumeApproval below), and a Map does not survive
  // that round-trip.
  failureSignatures?: Record<string, number>
}

async function runLoop(
  ctx: RuntimeContext,
  taskId: string,
  conversationId: string,
  state: LoopState,
  onToken?: (delta: string) => void,
  signal?: AbortSignal,
): Promise<ChatResult> {
  const maxRounds = getPreference<number>(ctx.db, 'max_tool_rounds') ?? 15
  const llmTools = buildOpenAITools()
  // Real context budgeting, not just a bigger --ctx-size: derived from
  // *this* active model's real context window (see modelManager.ts's
  // recommendedContextSize/CONTEXT_SIZE_BY_TIER), so a task that runs
  // several tool rounds in a row (get_project_overview, then
  // list_project_files, then a few read_project_file calls -- exactly the
  // workflow the system prompt above tells the model to follow) gets
  // compacted before it silently exceeds what the model can actually
  // accept, instead of failing with an opaque LLM error only after the
  // request was already too large to send.
  const budgetChars = conversationBudgetChars(recommendedContextSize(ctx.modelKey))

  for (let round = 0; round < maxRounds; round++) {
    // Real cancellation checkpoint, not just a hope that the LLM fetch's
    // own abort fires in time: checked at the start of every round, so a
    // cancel requested while a tool was executing (or right as a round
    // finished) stops the loop here even if nothing else caught it.
    if (signal?.aborted) {
      ctx.embodiment.transition('ERROR', 'Task cancelled')
      ctx.db.prepare("UPDATE tasks SET status='cancelled', completed_at=datetime('now') WHERE id=?").run(taskId)
      return { success: false, conversationId, taskId, status: 'cancelled', error: 'Task was cancelled.', executedTools: state.executedTools }
    }

    state.messages = compactMessagesForBudget(state.messages, budgetChars)
    ctx.embodiment.transition('THINKING', round === 0 ? 'Analyzing request' : 'Continuing analysis')

    // onToken (only ever set by runChat, not generatePlan/resumeApproval)
    // is threaded all the way down to a real streaming HTTP call
    // (chatCompletionStream) so the caller sees live tokens the same way
    // the browser tier already does -- every round still ends up with the
    // exact same accumulated { message: { content, tool_calls } } shape
    // either way, so tool-call detection and approval-gating below are
    // byte-for-byte unaffected by which one ran. In practice a single
    // round is either a plain-text answer or a tool call, never a mix, so
    // forwarding content deltas live as they arrive never ends up
    // "retracting" text the user already saw.
    const callLlmForRound = () =>
      onToken
        ? chatCompletionStreamWithRetry(ctx.llmBaseUrl, { model: ctx.modelKey, messages: state.messages, tools: llmTools }, onToken, { signal })
        : chatCompletionWithRetry(ctx.llmBaseUrl, { model: ctx.modelKey, messages: state.messages, tools: llmTools }, { signal })

    let result = await callLlmForRound()

    // Real audit finding, confirmed against the real qwen3-4b model on real
    // hardware: llama-server can return a genuinely successful HTTP
    // response (valid JSON, result.ok === true) whose message has BOTH
    // empty content and no tool_calls -- the local model's own generation
    // variance under a tool-calling grammar, not an HTTP/JSON/permission/
    // tool failure (those already return earlier via result.ok === false
    // below, or happen in the entirely separate tool-execution code path
    // once tool_calls actually exist -- this check never sees either).
    // Treated as transient exactly once: one immediate retry of the
    // identical request -- same state.messages (same conversation/tool
    // context), same tools, same signal -- never more than one, and never
    // for any other failure class. A cancellation requested in between is
    // respected rather than spending a second real inference on a task the
    // user already stopped.
    if (result.ok) {
      const firstMessage = result.data?.choices?.[0]?.message
      const firstToolCalls = Array.isArray(firstMessage?.tool_calls) ? firstMessage.tool_calls : []
      const firstAnswer = firstToolCalls.length === 0
        ? (firstMessage?.content ?? result.data?.choices?.[0]?.text ?? (typeof result.data === 'string' ? result.data : ''))
        : ''
      if (firstToolCalls.length === 0 && !firstAnswer && !(signal?.aborted ?? false)) {
        result = await callLlmForRound()
      }
    }

    if (!result.ok) {
      const wasCancelled = signal?.aborted ?? false
      ctx.embodiment.transition('ERROR', wasCancelled ? 'Task cancelled' : 'Local LLM request failed')
      db(ctx).prepare(`UPDATE tasks SET status=?, error=?, completed_at=datetime('now') WHERE id=?`).run(
        wasCancelled ? 'cancelled' : 'failed',
        JSON.stringify({ message: result.errorMessage }),
        taskId,
      )
      return { success: false, conversationId, taskId, status: wasCancelled ? 'cancelled' : 'failed', error: result.errorMessage, executedTools: state.executedTools }
    }

    const message = result.data?.choices?.[0]?.message
    const toolCalls = Array.isArray(message?.tool_calls) ? message.tool_calls : []

    if (toolCalls.length === 0) {
      const answer: string =
        message?.content ?? result.data?.choices?.[0]?.text ?? (typeof result.data === 'string' ? result.data : '')

      if (!answer) {
        ctx.embodiment.transition('ERROR', 'No usable answer from the local model')
        db(ctx).prepare("UPDATE tasks SET status='failed', error=?, completed_at=datetime('now') WHERE id=?").run(
          JSON.stringify({ message: 'Local LLM returned no usable answer.' }),
          taskId,
        )
        return { success: false, conversationId, taskId, status: 'failed', error: 'Local LLM returned no usable answer.' }
      }

      ctx.embodiment.transition('SPEAKING', answer.slice(0, 120))
      saveMessage(ctx.db, conversationId, 'assistant', answer, state.executedTools)
      addMemory(ctx.db, `User: ${state.messages[state.messages.length - 1]?.content ?? ''}\nYahalla: ${answer}`, {
        scope: 'conversation',
        key: conversationId,
        importance: 30,
      })
      ctx.db.prepare("UPDATE tasks SET status='completed', output=?, completed_at=datetime('now') WHERE id=?").run(
        JSON.stringify({ answer, executed_tools: state.executedTools }),
        taskId,
      )
      recordTaskFeedback(ctx.db, taskId, 'success')
      ctx.embodiment.transition('SUCCESS', 'Task completed')

      return { success: true, conversationId, taskId, status: 'completed', answer, executedTools: state.executedTools }
    }

    state.messages.push({ role: 'assistant', content: message.content ?? null, tool_calls: toolCalls })

    // Same-round dedup: a model that emits the exact same {tool, arguments}
    // call twice in one response (models do this, especially smaller ones)
    // should get the same result echoed back for the repeat, not run the
    // side effect twice. Only scoped to this one round -- calling the same
    // tool with the same arguments again in a *later* round is legitimate
    // (e.g. re-running a test command after a fix) and is handled by
    // repeated-failure detection below, not blocked here.
    const seenThisRound = new Map<string, Record<string, unknown>>()

    for (const call of toolCalls) {
      const toolName = call.function?.name
      const tool = getTool(toolName)
      let args: Record<string, unknown> = {}
      let argsParseFailed = false
      try {
        args = typeof call.function?.arguments === 'string' ? JSON.parse(call.function.arguments) : (call.function?.arguments ?? {})
      } catch {
        argsParseFailed = true
      }

      if (!tool) {
        state.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: toolName,
          content: JSON.stringify({ success: false, error: `Tool "${toolName}" is not available.` }),
        })
        continue
      }

      if (argsParseFailed) {
        state.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: tool.key,
          content: JSON.stringify({
            success: false,
            error: `Arguments for "${tool.key}" were not valid JSON: ${String(call.function?.arguments).slice(0, 300)}. Re-call the tool with valid JSON arguments.`,
          }),
        })
        continue
      }

      const dedupKey = `${tool.key}::${JSON.stringify(sortKeys(args))}`
      const cached = seenThisRound.get(dedupKey)
      if (cached) {
        state.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          name: tool.key,
          content: JSON.stringify(
            truncateToolResultForContext({ ...cached, note: 'Duplicate call in the same round -- reusing the prior result instead of re-executing.' }),
          ),
        })
        continue
      }

      if (tool.requiresApproval) {
        const approvalId = newId()
        ctx.db
          .prepare('INSERT INTO approvals (id, task_id, tool_key, arguments, reason, context) VALUES (?, ?, ?, ?, ?, ?)')
          .run(
            approvalId,
            taskId,
            tool.key,
            JSON.stringify(args),
            `Yahalla AI requested "${tool.key}".`,
            JSON.stringify({ ...state, conversationId, pendingToolCallId: call.id, pendingToolName: tool.key }),
          )
        ctx.db.prepare("UPDATE tasks SET status='waiting_approval' WHERE id=?").run(taskId)
        ctx.embodiment.transition('WAITING', `Waiting for approval: ${summarizeToolCall(tool, args)}`)
        return { success: true, conversationId, taskId, status: 'waiting_approval', approvalId, approvalTool: tool.key }
      }

      ctx.embodiment.transition('ACTING', summarizeToolCall(tool, args))
      const toolResult = await executeToolNow(ctx, tool, args, signal)
      ctx.embodiment.transition('ACTING', summarizeToolResult(tool, toolResult))
      state.executedTools.push({ tool: tool.key, arguments: args, result: toolResult })
      seenThisRound.set(dedupKey, toolResult)

      // annotateRepeatedFailure's signature/executedTools bookkeeping above
      // always sees the real, untruncated result -- only what actually goes
      // to the model is bounded, so failure fingerprinting and the HTTP
      // response's executedTools[].result stay exact.
      const reportedResult = annotateRepeatedFailure(state, tool, args, toolResult)
      state.messages.push({ role: 'tool', tool_call_id: call.id, name: tool.key, content: JSON.stringify(truncateToolResultForContext(reportedResult)) })
    }
  }

  ctx.embodiment.transition('ERROR', 'Exceeded maximum tool rounds')
  ctx.db.prepare("UPDATE tasks SET status='failed', error=?, completed_at=datetime('now') WHERE id=?").run(
    JSON.stringify({ message: `Exceeded max tool rounds (${maxRounds}) without a final answer.`, executed_tools: state.executedTools }),
    taskId,
  )
  // Real audit finding: this failure path previously dropped
  // state.executedTools entirely, so a caller (frontend, API consumer, a
  // diagnostic tool) had zero visibility into what the agent actually
  // attempted before giving up -- only "it failed," never "here's what it
  // tried." Every other terminal path (completed, waiting_approval) already
  // returns this; a runaway loop is exactly the case where it matters most.
  return { success: false, conversationId, taskId, status: 'failed', error: `Exceeded max tool rounds (${maxRounds}).`, executedTools: state.executedTools }
}

function db(ctx: RuntimeContext): Db {
  return ctx.db
}

// A short, dedicated call (no tools) that asks the model to break a large
// or vague goal into concrete ordered steps before the main tool-calling
// loop starts -- the same "1. Analyze 2. Inspect 3. Plan..." workflow the
// system prompt already asks for, made explicit and persisted instead of
// left implicit in the model's head. Failure here (unparseable response,
// LLM error) is never fatal to the chat itself: it just means no plan was
// recorded, and runChat falls back to the loop's existing behavior.
const PLANNING_SYSTEM_PROMPT = `You are a planning assistant. Break the user's goal into 2 to 8 concrete, ordered, actionable subtasks. Respond with ONLY a JSON array of short subtask title strings -- no prose, no markdown, nothing else. Example: ["Set up the database schema", "Build the API endpoints", "Wire the frontend", "Test end to end"]`

export function parsePlanResponse(content: string): string[] | null {
  // Models sometimes wrap JSON in a fenced code block despite being told
  // not to -- strip that before parsing rather than rejecting outright.
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?\n?/, '')
    .replace(/```$/, '')
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(cleaned)
  } catch {
    return null
  }
  if (!Array.isArray(parsed)) return null

  const subtasks = parsed.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((s) => s.trim())
  if (subtasks.length < 2 || subtasks.length > 10) return null
  return subtasks
}

// Only worth the extra LLM round-trip for a substantial, first-in-
// conversation request -- a short follow-up ("what does that mean?") or a
// message deep into an existing conversation doesn't need a fresh plan.
export function shouldPlan(message: string, isFirstMessageInConversation: boolean): boolean {
  return isFirstMessageInConversation && message.trim().length >= 80
}

export async function generatePlan(ctx: RuntimeContext, goal: string): Promise<string[] | null> {
  const result = await chatCompletion(ctx.llmBaseUrl, {
    model: ctx.modelKey,
    messages: [
      { role: 'system', content: PLANNING_SYSTEM_PROMPT },
      { role: 'user', content: goal },
    ],
  })
  if (!result.ok) return null
  const content = result.data?.choices?.[0]?.message?.content
  if (typeof content !== 'string') return null
  return parsePlanResponse(content)
}

export async function runChat(
  ctx: RuntimeContext,
  message: string,
  conversationId?: string,
  onToken?: (delta: string) => void,
  signal?: AbortSignal,
): Promise<ChatResult> {
  // Checked before saveMessage inserts the current message, so it
  // reflects whether a conversation existed *before* this request --
  // loadHistory after saving would always see at least this one message.
  const isFirstMessage = !conversationId || loadHistory(ctx.db, conversationId, 1).length === 0

  const convId = getOrCreateConversation(ctx.db, conversationId, message)
  saveMessage(ctx.db, convId, 'user', message)

  const taskId = newId()
  ctx.db.prepare('INSERT INTO tasks (id, title, status, input, conversation_id) VALUES (?, ?, ?, ?, ?)').run(
    taskId,
    message.slice(0, 120),
    'running',
    JSON.stringify({ message }),
    convId,
  )

  let planContext = ''
  if (shouldPlan(message, isFirstMessage)) {
    ctx.embodiment.transition('THINKING', 'Breaking the goal into steps')
    const plan = await generatePlan(ctx, message)
    if (plan) {
      const insertSubtask = ctx.db.prepare(
        'INSERT INTO tasks (id, title, status, input, conversation_id, parent_task_id, plan_order) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      plan.forEach((title, index) => {
        insertSubtask.run(newId(), title, 'pending', JSON.stringify({}), convId, taskId, index)
      })
      planContext = `\n\nYou already broke this goal into ${plan.length} steps:\n${plan.map((title, i) => `${i + 1}. ${title}`).join('\n')}\nWork through them in order using the available tools, treating each as a checkpoint before moving to the next. Do not silently skip a step.`
    }
  }

  const history = loadHistory(ctx.db, convId)
  const systemPrompt = await buildSystemPrompt(ctx.projectRoot, ctx, message)
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt + planContext }, ...history]

  const chatResult = await runLoop(ctx, taskId, convId, { messages, executedTools: [] }, onToken, signal)

  // Only worth remembering across conversations when real project work
  // happened (a tool actually ran) -- not every trivial Q&A, which would
  // just flood future context with noise. Best-effort: a failed memory
  // write never fails the chat it came from.
  if (chatResult.status === 'completed' && (chatResult.executedTools?.length ?? 0) > 0) {
    void storeMemory({ platformApiUrl: ctx.platformApiUrl, deviceToken: ctx.deviceToken }, summarizeForMemory(message, chatResult), 'agent')
  }

  // Self-development change record: once a self-dev task actually commits
  // something, persist a durable "what changed and why" entry independent
  // of chat history -- this is what lets a later Yahalla session (or a
  // human) see the real history of self-modifications without re-reading
  // every conversation.
  if (
    chatResult.status === 'completed' &&
    isSelfDevProject(ctx.projectRoot) &&
    (chatResult.executedTools ?? []).some((t) => t.tool === 'git_commit' && t.result.success)
  ) {
    addKnowledge(ctx.db, `Self-dev: ${message.slice(0, 80)}`, summarizeSelfDevOutcome(message, chatResult.executedTools ?? []), {
      sourceType: 'self_dev',
      tags: ['self_dev'],
    })
  }

  // Honest bookkeeping, not fine-grained per-subtask tracking the loop
  // doesn't actually do: once the parent task the plan belongs to
  // succeeds, its still-pending subtasks are marked completed too --
  // there is no separate signal for "step 3 of 5 done" mid-loop, only
  // "the whole goal succeeded" or it didn't.
  if (chatResult.status === 'completed') {
    ctx.db
      .prepare("UPDATE tasks SET status='completed', completed_at=datetime('now') WHERE parent_task_id = ? AND status = 'pending'")
      .run(taskId)
  }

  return chatResult
}

export async function resumeApproval(
  ctx: RuntimeContext,
  approvalId: string,
  decision: 'approve' | 'reject',
): Promise<ChatResult> {
  const approval = ctx.db.prepare('SELECT * FROM approvals WHERE id = ?').get(approvalId) as
    | { id: string; task_id: string; tool_key: string; arguments: string; status: string; context: string }
    | undefined

  if (!approval) throw new Error(`Unknown approval "${approvalId}".`)
  if (approval.status !== 'pending') throw new Error(`Approval "${approvalId}" was already decided (${approval.status}).`)

  const changed = ctx.db
    .prepare("UPDATE approvals SET status = ?, decided_at = datetime('now') WHERE id = ? AND status = 'pending'")
    .run(decision === 'approve' ? 'approved' : 'rejected', approvalId)
  if (changed.changes === 0) throw new Error(`Approval "${approvalId}" was already decided.`)

  const context = JSON.parse(approval.context) as LoopState & {
    conversationId: string
    pendingToolCallId: string
    pendingToolName: string
  }
  const tool = getTool(approval.tool_key)!
  const args = JSON.parse(approval.arguments)

  if (decision === 'approve') {
    ctx.embodiment.transition('ACTING', summarizeToolCall(tool, args))
  }
  const toolResult =
    decision === 'approve'
      ? await executeToolNow(ctx, tool, args)
      : { success: false, error: 'Rejected by user.' }
  ctx.embodiment.transition('ACTING', decision === 'approve' ? summarizeToolResult(tool, toolResult) : 'Action rejected by user')

  ctx.db.prepare('UPDATE approvals SET result = ? WHERE id = ?').run(JSON.stringify(toolResult), approvalId)

  context.executedTools.push({ tool: tool.key, arguments: args, result: toolResult })
  const reportedResult =
    decision === 'approve' ? annotateRepeatedFailure(context, tool, args, toolResult) : toolResult
  context.messages.push({
    role: 'tool',
    tool_call_id: context.pendingToolCallId,
    name: tool.key,
    content: JSON.stringify(reportedResult),
  })

  ctx.db.prepare("UPDATE tasks SET status='running' WHERE id=?").run(approval.task_id)

  return runLoop(ctx, approval.task_id, context.conversationId, {
    messages: context.messages,
    executedTools: context.executedTools,
    failureSignatures: context.failureSignatures ?? {},
  })
}
