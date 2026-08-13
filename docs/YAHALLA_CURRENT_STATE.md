# Yahalla Current State (baseline)

This document is the real, code-verified baseline of Yahalla AI OS as of the
start of the "Autonomous AI Partner" build-out (see `docs/YAHALLA_ARCHITECTURE.md`
once it exists for the target). Every claim here was verified by directly
reading the relevant source file or by actually running the relevant
build/test command — not inferred or assumed. Update this file's specific
claims as the codebase changes; do not let it silently drift out of date the
way `docs/ARCHITECTURE.md` had (it still describes a pre-vector-memory,
pre-cloud-tier state as of this writing).

## Repository shape

No workspaces config anywhere (no root `"workspaces"` field). Every
package below is built and dependency-managed independently:

| Path | Package | Role | Runtime |
|---|---|---|---|
| `/` | `yahalla-ai-os` | Control Center UI (React 19 + Vite 8) | Browser |
| `local-runtime/` | `@yahalla/local-runtime` | **The real local AI engine** — LLM process, agent loop, SQLite, permissions, tools | Node ≥22.5 |
| `packages/agent-tools/` | `@yahalla/agent-tools` | Shared sandboxed tool executors (files/git/run_command) | Node ≥20 |
| `device-agent/` | `@yahalla/device-agent` | Legacy paired-device execution agent (Supabase-routed) | Node ≥20 |
| `desktop/` | `@yahalla/desktop` | Electron shell, spawns local-runtime + loads the UI | Electron 33 |
| `platform/api/` | `@yahalla/platform-api` | Self-hosted Strato control plane: accounts, pairing, cloud tier proxy, GitHub OAuth/webhook, vector memory | Node ≥22.5 |
| `platform/deploy-agent/` | `@yahalla/deploy-agent` | The only thing allowed to `git pull`/`docker compose up` on the VPS | Node ≥22.5 |
| `supabase/` | — | Migrations (schema source of truth) + `functions/yahalla-ai` (legacy Edge Function chat) | Deno (Supabase-hosted) |

## AI architecture: local-runtime is the real primary path (fixed, tested)

**This section describes the current, fixed routing.** An earlier phase of
this build-out had made the opt-in cloud tier try FIRST on every message
whenever `platform/api` was merely *configured* (not necessarily reachable
or working) — meaning a deployment with a configured-but-down or
misconfigured Strato server would show "Cloud smart tier is not reachable"
instead of ever trying the local-runtime that might actually be running on
the user's own machine. That default was removed; see the "Local-runtime ↔
frontend connection" section below for the real fix and its end-to-end
proof.

Tried in this order, fresh on every message (`src/App.tsx`'s `sendMessage`):

1. **Explicit user-toggled cloud escalations** (Coding Agent / Remote
   Device / Cloud Boost) — only ever used when the user deliberately turns
   one on for that message. Never automatic.
2. **local-runtime tier** — the real Agent Runtime: full tool-calling,
   permissions, approvals, memory, browser automation, multi-agent
   dispatch. Selected whenever this tab is both (a) talking to a
   local-runtime whose `/health` reports `llm_reachable: true`, and (b)
   actually paired with it (has a real auth token — see below). This is
   now the real default/primary path, not a fallback.
3. **Browser tier** — WebGPU (`@mlc-ai/web-llm`) or WASM fallback
   (`@wllama/wllama`) inside the tab. Chat only, no tools, no memory, but
   still zero external AI inference (runs entirely on-device in the tab).
4. **Cloud tier, true last resort** (opt-in, `platform/api/src/cloudTier.ts`)
   — only reached when neither 2 nor 3 exists at all (e.g. iOS Safari, no
   WebGPU, no local-runtime installed) *and* platform-api is configured.
5. **Legacy Supabase Edge Function** (`supabase/functions/yahalla-ai`) —
   absolute last resort when platform-api isn't configured either.
   Structurally dead without a manually-registered live server row.

No hidden external-AI fallback exists in the browser or in local-runtime —
the only two hardcoded external-AI endpoint strings in the whole repo
(`api.anthropic.com`, `api.groq.com`) live exclusively inside
`platform/api/src/cloudTier.ts`, a server-only file the browser bundle
never contains.

## Local-runtime ↔ frontend connection (fixed, tested end-to-end)

Two real, distinct bugs were fixing this: the tier-priority bug above, and
a second, more fundamental one — **a plain browser tab (not the Electron
desktop app) had no way to authenticate to a local-runtime running on the
same machine at all**, even if it correctly detected one was running.

- `src/lib/localRuntime.ts`'s `getRuntimeInfo()` had exactly two sources
  for the `{baseUrl, authToken}` pair every authenticated call needs: the
  Electron IPC bridge (`window.yahallaDesktop`), or a `VITE_YAHALLA_RUNTIME_TOKEN`
  build-time env var that's a documented dev-only convenience (impossible
  to bake into a public production build, since every machine's
  local-runtime generates its own random per-device token). A plain
  browser tab at the hosted Control Center (`https://yahalla-ai.yahalla.de`)
  had no third option — `checkRuntimeHealth()` could still succeed (that
  route needs no auth), giving the false impression local-runtime was
  usable, but the actual `/chat` call would immediately throw "Local Agent
  Runtime is not reachable from this window."
- Separately, local-runtime's own CORS allowlist (`config.ts`'s
  `DEFAULT_ALLOWED_ORIGINS`) didn't include that production origin at all,
  so even the no-auth `/health` poll would have been blocked by the
  browser once the tier-priority bug above was fixed.

**Fixed with a real, tested local pairing flow — no new server, no
Strato involvement, token never leaves the machine except to a tab already
running at a known Yahalla origin:**

- `local-runtime/src/server.ts` adds `GET /pair/token` (no auth required —
  nothing to authenticate with yet): returns `{baseUrl, authToken}`.
  Protected the same way every other route already is: `applyCors()`
  only attaches `Access-Control-Allow-Origin` for a request whose `Origin`
  is in the exact-match `allowedOrigins` list, so only a tab already
  running at a known Yahalla origin can read the response — a random
  third-party page can still send the request but the browser blocks it
  from reading the body back, per standard CORS enforcement (tested: real
  HTTP requests with an allowed vs. a disallowed `Origin` header, asserting
  the header is/isn't present).
- `local-runtime/src/config.ts`'s `DEFAULT_ALLOWED_ORIGINS` now includes
  `https://yahalla-ai.yahalla.de` (the real production Control Center
  origin), and `loadOrCreateConfig()` self-heals an *existing* config file
  written by an older version to include any newer official origin on next
  load — tested end-to-end in a real isolated `$HOME`, via a real child
  Node process, proving the merge actually persists to disk and preserves
  a user-added origin.
- `src/lib/localRuntime.ts` adds `pairWithLocalRuntime()` (fetches
  `/pair/token`, stores the result in `localStorage`), `isPairedWithLocalRuntime()`,
  and `clearStoredPairing()`. `getRuntimeInfo()` now checks, in order:
  Electron bridge → stored browser pairing → dev env var.
  `App.tsx` shows a distinct "Local Runtime detected · not connected yet"
  status with a one-click "Connect local Yahalla" button whenever
  `/health` succeeds but this tab isn't paired yet, instead of silently
  falling through to another tier or showing a blocking cloud error.
- Also fixed while making this actually testable: `src/lib/supabase.ts`
  used to `throw` at module load (crashing the entire frontend bundle,
  local-runtime/browser tiers included) if Supabase env vars were unset.
  Now degrades the same way `platformApi.ts` already documents for its own
  optional dependency — a console warning, not a crash; sign-in/sync are
  disabled, AI features are unaffected.

**Proven end-to-end, not just by inspection** — `test/localRuntimeE2E.smoke.mjs`
(+ `test/localRuntimeE2E-harness.{html,ts}`) starts a real local-runtime
HTTP server (local-runtime's actual compiled `server.js`, only its LLM
backend swapped for a deterministic fake HTTP server — the same discipline
local-runtime's own test suite uses everywhere, since a real GGUF model is
multi-gigabytes and not something a CI sandbox can fetch) bound to the real
default port 8765, a real Vite dev server for the frontend with
platform-api deliberately left unconfigured, and drives a real headless
Chromium through: health check → pairing handshake → a real `/chat`
request → a real `read_project_file` tool call against a real file on
disk → a real answer. Confirms, for real: local-runtime is reached,
"the LLM" produces a response, a real tool executes, and platform-api/
Strato is never configured or touched anywhere in the path (structurally
cannot be, since it's never imported/reachable in this harness). Run
explicitly: `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node
test/localRuntimeE2E.smoke.mjs` (not part of `npm test` — spins up two
real HTTP servers plus a browser). Passed twice in a row when last run.
- `local-runtime/test/localPairing.test.ts` (8 tests) covers the
  server-side pieces in isolation: the origin-merge logic, the real
  config-file self-heal, and `/pair/token`'s CORS behavior. local-runtime
  suite now 121/121.

## local-runtime deep facts (the part this build-out extends)

- HTTP surface (`local-runtime/src/server.ts`): `/health` (no auth),
  `/chat`, `/chat/stream` (SSE), `/approvals/:id/decide`, `/approvals`,
  `/conversations(/:id/messages)`, `/tasks`, `/runtime/status`,
  `/runtime/start|stop`, `/live/stream` (SSE perception+embodiment),
  `/perception/events`, `/device/pair`, plus `/memory`, `/knowledge`,
  `/skills`, `/preferences`, `/permissions`, `/models`, `/hardware`. Every
  route but `/health` requires `Authorization: Bearer <token>` (random,
  locally generated, `~/.yahalla/runtime/config.json`, mode 600).
- Agent loop: `local-runtime/src/agentLoop.ts`'s `runLoop` — bounded
  (`max_tool_rounds` preference, default 15), calls the LLM, inspects
  `tool_calls`, executes or pauses for approval, appends a `tool` message,
  repeats until plain content or the round limit. `generatePlan` is a
  single upfront tools-free call for long first messages (≥80 chars),
  folded into the system prompt as extra context — not re-invoked mid-task.
- Tools (`local-runtime/src/tools.ts`, 14 total, 2 approval-gated —
  `github.write` and `db_execute`): `read_project_file`,
  `list_project_files`, `write_project_file`, `patch_project_file`,
  `git_status`, `git_diff`, `git_create_branch`, `git_commit`, `git_push`,
  `run_project_command`, `github.read`, `github.write`, `github.open_pr`,
  `db_list_connections`, `db_query`, `db_execute`.
- Sandboxing: `packages/agent-tools/src/sandbox.ts`'s
  `resolveProjectPath` rejects absolute paths/`..` and resolves symlinks
  on the nearest existing ancestor to block symlink escape even for
  not-yet-existing write targets.
- Command allowlist: `packages/agent-tools/src/run_command.ts`'s
  `runProjectCommand` requires an **exact** match against an allowlist
  array, plus the resolved binary must be in a hardcoded
  `ALLOWED_BINARIES` set (`git`, `npm`, `node`, `npx`, `tsc`); `spawnSync`
  with `shell: false` always — no shell is ever invoked. **The allowlist
  local-runtime actually uses is `tools.ts`'s hardcoded
  `DEFAULT_RUN_COMMAND_ALLOWLIST`** (`npm run build`, `npm run lint`,
  `npm test`, `tsc --noEmit`, `git status`, `git diff`, `git log`) — a
  stray comment in `run_command.ts` claims it's "configuration-driven"
  from a Supabase-seeded table, but that path belongs to the old
  device-agent design and local-runtime never reads it
  (`agentLoop.ts:202` always passes the hardcoded list).
- Permissions: two independent gates. Standing permissions
  (`permissions.ts`'s `checkAccess`, longest-matching-project-path-prefix,
  nothing granted by default) and per-action approval (`approvals` table,
  only the 2 tools above). Revoking a standing permission blocks an
  already-approved action (tested).
- Memory: keyword+recency ranking (`memory.ts`, fully local) plus an
  **optional** vector/embedding tier (`vectorMemory.ts` + `embeddings.ts`)
  that only activates when this device is paired to a live `platform/api`
  deployment — silently no-ops otherwise.
- Model catalog (`modelManager.ts`): Qwen2.5 1.5B/3B/7B Instruct, Q4_K_M
  GGUF, all from `huggingface.co/Qwen/...`. Selection is
  `hardware.ts`-driven, CPU/RAM only — **no GPU detection exists**, stated
  explicitly as a known gap in that file's own comments.
- Streaming: real, both at `llm.ts` level (`chatCompletionStream`, SSE
  delta reassembly, including multi-chunk tool-call argument splitting)
  and exposed via `POST /chat/stream`, proven end-to-end (a tool call
  executes correctly mid-stream while content still streams for the final
  answer).
- **Phase 1 reliability work (done, tested)** — `local-runtime/src/agentLoop.ts`
  and `local-runtime/src/llm.ts`, covered by `local-runtime/test/reliability.test.ts`
  (7 new tests, all against real HTTP servers, no stubs):
  - **Same-round tool-call dedup**: an LLM emitting the identical
    `{tool, arguments}` call twice in one response's `tool_calls` batch now
    executes it once; the duplicate is served the cached result instead of
    re-running the side effect. Scoped to one round only — the same call in
    a *later* round (e.g. re-running a test after a fix) still runs for real.
  - **LLM-call retry** (`llm.ts`'s `chatCompletionWithRetry` /
    `chatCompletionStreamWithRetry`): a transient failure (HTTP 5xx/429, or
    any network-level error without a parsed status) is retried up to 2
    times with exponential backoff (500ms, 1000ms); a permanent failure
    (parsed HTTP 4xx) is never retried. The streaming variant only retries
    while zero tokens have been forwarded to the caller — once the user has
    seen live output, a failure is returned as-is rather than risking
    duplicate/contradictory partial output.
  - **Malformed tool-call arguments are surfaced, not swallowed**: invalid
    JSON in a `tool_calls[].function.arguments` string now produces an
    explicit `role: 'tool'` error message telling the model its own
    arguments didn't parse, instead of silently proceeding with `{}`.
  - **Cross-round repeated-failure detection**
    (`local-runtime/src/diagnostics.ts`'s `diagnoseCommandFailure` /
    `signatureForToolFailure`): every failed tool result is fingerprinted
    (structured command/exit-code/first-output-line for
    `run_project_command`, generic `{tool, args, error}` hash for every
    other tool). A second occurrence of the exact same failure within one
    task gets a `repeated_failure_warning` field injected into the tool
    result telling the model repeating it again will not help. Counts are
    carried through an approval pause/resume via `LoopState.failureSignatures`
    (a plain `Record<string, number>`, not a `Map`, since the loop state
    round-trips through `JSON.stringify`/`JSON.parse` in the `approvals.context`
    column and a `Map` does not survive that).
  - **Structured command diagnosis** (`diagnostics.ts`'s
    `diagnoseCommandFailure`): classifies a failed `run_project_command`
    result into an `errorType` (`test_failure` / `build_failure` /
    `syntax_error` / `type_error` / `module_not_found` / `permission_denied`
    / `timeout` / `unknown`) and extracts a likely `file`/`line` from the
    output, without replacing the raw `stdout`/`stderr` the model already saw.

## Self-development (Phase 2, done, tested)

Yahalla can now develop on its own repository through the exact same
generic coding-agent mechanism it uses on any other project — `projectRoot`
was already a configurable value (`local-runtime --project=<path>`, or
`config.projectRoot` in `~/.yahalla/runtime/config.json`), so pointing a
running local-runtime at a checkout of `yahalla-ai-os` itself already works
mechanically. What Phase 2 adds is the safety rail and change record that
make doing so safe and auditable, in `local-runtime/src/selfDev.ts`
(covered by `local-runtime/test/selfDev.test.ts`, 6 tests, real git repos
and a real HTTP `/chat` round-trip, no stubs):

- **Detection** (`isSelfDevProject`): a real, verifiable check — true only
  when `<projectRoot>/local-runtime/package.json` exists and its `name` is
  exactly `@yahalla/local-runtime`. Never a directory-name guess.
- **Branch guard, enforced in code, not just prompted**: when
  `isSelfDevProject` is true, `write_project_file`, `patch_project_file`,
  `git_commit`, and `git_push` are refused outright
  (`agentLoop.ts`'s `executeToolNow`) while the real current git branch
  (`currentGitBranch`, read fresh via `git rev-parse --abbrev-ref HEAD` on
  every check, never cached) is `main` or `master`. The model is told to
  call `git_create_branch` first; if it doesn't, the tool call itself fails
  with a clear error instead of silently writing to the default branch.
- **System prompt addendum**: only injected when self-dev is detected —
  reiterates the branch rule, asks for small verifiable changes, requires
  running the changed package's real test suite before considering a task
  done, and warns that a change to already-loaded source needs a process
  restart to take effect (it does not claim a change is "live" just
  because a file was written).
- **Change record**: once a self-dev task's `git_commit` actually succeeds,
  `runChat` persists a `knowledge` row (`source_type: 'self_dev'`,
  via the existing `addKnowledge`/`/knowledge` mechanism — no new storage
  subsystem) summarizing the goal, branch, files touched, commit/push
  status, and which verification commands ran and whether they passed
  (`summarizeSelfDevOutcome`). This is the durable "what changed and why"
  record a later Yahalla session (or a human) can read back.
- **What this does not do**: it does not auto-merge, auto-open a PR, or
  auto-restart the running process — opening a PR still goes through the
  existing `github.open_pr` tool and step 9 of the normal coding-agent
  workflow, and a human still reviews/merges. There is no scheduler or
  trigger that makes Yahalla start a self-dev task on its own; a human (or
  a future Routine) still has to send the initial message. That is the
  intended bound on autonomy here — "no uncontrolled self-modification."
- **How to actually use it**: run local-runtime with `--project=<path to a
  yahalla-ai-os checkout>` (a *separate* clone from the one currently
  running the server is the safe way to do this, so a self-dev change
  can't corrupt the very process applying it mid-task), then send it a
  development goal through `/chat` as normal.

## Local project understanding (Phase 3, done, tested)

`local-runtime/src/projectIndex.ts` (covered by
`local-runtime/test/projectIndex.test.ts`, 7 tests against real fixture
directories and real git repos) adds a `get_project_overview` tool
(`tools.ts`) so the agent can get oriented on a project in one call instead
of several rounds of `list_project_files`/`read_project_file` guessing:

- A single real filesystem walk (excluding `.git`, `node_modules`, `dist`,
  `build`, and similar generated/vendor directories) that reports a
  language/file-type breakdown by extension, every `package.json` found up
  to 4 directories deep (name, version, real `scripts`/`dependencies`/
  `devDependencies` keys, monorepo-aware — not just the root one), a list
  of recognized config files present (`tsconfig.json`, `vite.config.*`,
  `docker-compose.yml`, `Dockerfile`, etc.), and the top-level directory
  layout.
- Real git state via `git rev-parse`/`git log`/`git remote`/`git status`
  (branch, latest commit, remote URL, and whether the working tree is
  dirty) — not a guess, and correctly distinguishing "clean" (empty
  `git status --porcelain` output) from "not a git repo at all" (both are
  real, different states, previously conflated by a bug caught by this
  phase's own tests: `output.trim() || null` collapsed a clean repo's
  legitimately-empty status into the same `null` used for a failed git
  call — fixed by giving status its own boolean-returning helper instead
  of reusing the string-or-null convention that only fits branch/commit/
  remote).
- No embeddings, no network call, nothing sent anywhere — this is exactly
  the kind of project understanding the local-runtime tier can offer that
  the browser/cloud tiers cannot.
- In-memory cached per project root with a 5-minute TTL (not persisted to
  disk — a hot-path performance cache, not a record); the tool accepts
  `refresh: true` to force a fresh scan, meant for right after the agent
  itself has just written several files.
- `read_project_file`/`list_project_files` remain the only source of truth
  for a file's exact content — the overview is a summary layer on top, and
  the coding-agent workflow in the system prompt now points the model at
  `get_project_overview` first, before falling back to the finer-grained
  tools for anything the overview doesn't cover.

## Self-repair (existing, single-cycle)

`local-runtime/test/repair-loop.test.ts` proves one real cycle: a real
temp npm project with a deterministically-failing test, driven through
the real `/chat` endpoint with "Run the tests and fix them if they fail."
The test asserts the real test command ran twice (fail, then pass), the
patch tool ran once and succeeded, and the flag file's real on-disk
content changed. This is genuine "mechanics work end-to-end" proof, not a
general "always finds the right fix" guarantee — the fake LLM in the test
scripts one plausible fixed conversation, not a search over strategies.

## Real multi-agent orchestration (Phase 5, done, tested)

`local-runtime/src/subAgents.ts` + `agentLoop.ts`'s `runSubAgentLoop`/
`runSubAgent` (covered by `local-runtime/test/subAgents.test.ts`, 5 tests
against a real /chat round-trip where the same fake LLM server plays both
the orchestrator and the dispatched sub-agent, distinguished by their
genuinely different system prompts) replace the old cosmetic "12 agents"
concept with a real dispatch mechanism:

- A new `dispatch_subagent` tool the top-level agent can call with
  `{profile, task}`. Four real, differently-restricted worker profiles
  (`researcher`, `coder`, `tester`, `reviewer`), each with its own system
  prompt focus, its own tool allowlist, and its own round budget
  (`SUB_AGENT_PROFILES` in `subAgents.ts`).
- A dispatched sub-agent runs a genuinely independent, real tool-calling
  loop against the same local model: its own LLM calls, its own tool
  execution through the exact same `executeToolNow`/permission checks
  every top-level tool call goes through (so it can never do more than a
  real granted permission allows), but the LLM is only ever offered the
  tools in its profile's allowlist — a tool outside that list is refused
  before it can execute, proven by a test that dispatches to `tester` with
  a task that tries to write a file: the write is refused and the file
  never lands on disk, even though the top-level agent has write access to
  the same project.
- The result returned to the orchestrator is real: the sub-agent's own
  final report plus exactly which tools it actually used and their real
  results (`tools_used`, `executed_tools`) — not a synthetic summary.
- Nesting is prevented by construction, not a runtime check that could be
  forgotten: `dispatch_subagent` is never included in any profile's
  allowlist, so a sub-agent's LLM is never even offered the tool.
- Deliberately simpler than the top-level loop where the difference is
  safe to take: no task/conversation persistence (a sub-agent run isn't a
  first-class browsable task), no approval-gated pause (there's no human
  present mid-subtask — an approval-requiring tool is refused outright
  instead of hanging), no dedup/repeated-failure bookkeeping (the small
  per-profile round budget bounds a runaway sub-agent regardless).
- An unknown profile name fails cleanly with a clear error instead of
  crashing or silently no-op'ing.

## Browser agent tool (Phase 4, done, tested)

`local-runtime/src/browser.ts` (covered by `local-runtime/test/browser.test.ts`,
12 tests against a real local HTTP fixture site and — where a real browser
is present — a real headless Chromium) adds 5 new agent tools
(`browser_open`, `browser_read`, `browser_click`, `browser_type`,
`browser_close`) — real automation the agent can call as part of a
multi-step task, not a browser page the user opens themselves:

- Uses `playwright-core` (the driver library only, no bundled
  browser-download step) pointed at a real Chrome/Chromium/Edge already on
  the machine — auto-detected from common install paths per OS, or a
  pre-provisioned `PLAYWRIGHT_BROWSERS_PATH` install, or an explicit
  `YAHALLA_CHROMIUM_PATH` override. Nothing is downloaded at runtime;
  `findChromiumExecutable()` returns `null` (an honest "not available on
  this machine" error surfaced to the model) rather than guessing or
  faking a result when no browser is found.
- One persistent headless session (browser + page) reused across
  `browser_open`/`read`/`click`/`type` calls within a task, so a multi-step
  flow (open → click a result → read it → fill a form → submit) is a
  sequence of tool calls against the same live page, not a fresh
  disconnected browser each time. Auto-closed after 10 minutes idle;
  `browser_close` releases it explicitly when a task is done.
- Sandboxed: only `http://`/`https://` URLs may be opened (`file://`,
  `javascript:`, `data:`, and anything else is refused before a browser
  session is even created); a new `browser` permission scope gates the
  whole capability (`scope: 'browser', access: 'execute'`) — nothing
  granted by default, same standing-permission model as every other tool
  category.
- `browser_read` returns the page title + visible text (truncated at
  15,000 chars) with no selector, or the text of every element matching a
  given CSS selector — this is how "extract specific info" works (e.g.
  `selector: "table td"`), on top of the same read used for general page
  understanding.
- Action timeouts are deliberately short (8s for click/type, so a wrong
  selector fails back to the model quickly instead of stalling a whole
  task) versus navigation (20s, real page loads can be slower).
- Running the local-runtime test suite in this dev/CI sandbox specifically
  (not a general requirement) needs `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`
  set for `browser.test.ts`'s live-Chromium tests to run instead of
  cleanly skipping; a real desktop install finds a real installed
  Chrome/Chromium/Edge on its own via `findChromiumExecutable()`.
- Also caught and fixed while adding this phase's tests: several existing
  local-runtime test files independently picked overlapping hardcoded
  localhost ports (`deviceDispatch.test.ts`'s internal 18091–18100 range
  collided with the new Phase 1–4 test files, and separately with
  `chatStream.test.ts`'s 18100) — invisible most of the time because
  `node --test` runs test files concurrently and lucky scheduling usually
  kept them from overlapping, but a real, reproducible source of flaky
  `EADDRINUSE` failures once enough test files ran side by side. Given
  each new test file's own fixed port block (18401–18408) and moved the
  one genuine pre-existing collision (`deviceDispatch.test.ts`'s fake
  GitHub server at 18100) to a free port -- confirmed stable across
  repeated full-suite runs.

## Voice/camera (Phase 6, done+tested where testable, one gap documented honestly)

Voice call mode and camera capture already existed from earlier work
(`src/App.tsx`, `src/lib/voiceInput.ts`, `src/lib/voiceOutput.ts`,
`src/lib/gestureControl.ts`) — genuinely hands-free (auto-restarts
listening after each reply, no re-clicking a mic button per turn), and
already used `speechSynthesis` for genuinely local TTS. This phase fixed
two real gaps and documented one real limitation rather than working
around it:

- **Language was hardcoded to Arabic** for both STT and TTS regardless of
  what the user actually spoke. Fixed: call mode now starts from the
  browser's own locale (`navigator.language`) and adapts per turn to
  whatever `detectLanguage()` (already used for text chat) finds in the
  user's transcript, via a new `speechLangTag()` mapping
  (`src/lib/langDetect.ts`) from `detectLanguage`'s codes to real BCP-47
  tags. Both the next recognition pass and the reply's TTS voice follow a
  mid-call language switch. 7 new tests in `test/langDetect.test.ts`.
- **No way to interrupt Yahalla while it was replying.** Added
  tap-to-interrupt (click the call orb while speaking) as the real,
  working form of barge-in. True voice-activated barge-in (interrupting
  just by speaking, no tap) is **not implemented** — documented honestly
  inline (`App.tsx`'s `interruptSpeaking()`) and in
  `voiceInput.ts`: it needs real echo-cancellation audio-pipeline work
  the plain Web Speech API cannot provide (a live recognizer would
  otherwise pick up Yahalla's own voice from the speakers as if it were
  the user talking).
- **`voiceInput.ts`'s header comment was inaccurate**, describing Chrome's
  Web Speech API as purely local. Corrected: in Chrome/Edge, STT audio is
  actually sent to the browser vendor's own cloud recognition service —
  not routed through any Yahalla/Strato server and no chat/agent
  inference happens there, but it is not on-device recognition either,
  unlike this app's TTS (`speechSynthesis`, genuinely local) or its
  text-chat LLM tiers. A fully local STT path (e.g. a WASM-compiled
  Whisper build, following the same self-hosted-asset pattern already
  used for OCR/wllama/MediaPipe) is a real, scoped follow-up, **not
  implemented in this pass** — flagged rather than glossed over.
- Camera: capture-to-attach and blink-to-capture already worked and were
  left as-is (already a real "foundation," per the audit that preceded
  this phase — one-shot capture, not continuous monitoring; that's an
  accurate description of what exists, not a gap introduced now).
- Added a short "warm, human, light personality welcome" tone line to both
  real system prompts (`local-runtime/src/agentLoop.ts`,
  `src/lib/browserRuntime.ts`), explicit that personality never overrides
  the evidence/verification hard rules already there.

## Desktop packaging (Phase 7, done+tested where testable)

The Electron shell (`desktop/src/main.cjs`, 121→163 lines) already
auto-started local-runtime as a child process and bridged its auth token
to the renderer via IPC (`desktop/src/preload.cjs`) — genuinely real, not
a stub. This phase closed the three biggest real gaps found by an
explicit audit before writing any code:

- **No automatic model setup.** Hardware detection and a model
  catalog/downloader already existed in local-runtime
  (`hardware.ts`, `modelManager.ts`, exposed over HTTP by `server.ts`) but
  were dead code from the desktop app's perspective — nothing ever called
  them, so a fresh install had no model and no in-app way to get one.
  Fixed: `desktop/src/runtimeSupervisor.cjs`'s `ensureModelReady()` runs
  in the background after the window opens (never blocking it) and
  orchestrates the existing, already-tested local-runtime REST endpoints:
  check `/runtime/status` → if nothing's running, `/hardware` for a
  recommendation → register/download/activate that model → `/runtime/start`.
  Reports only coarse, non-technical phases (`checking`/`downloading`/
  `starting_engine`/`ready`/`engine-missing`/`error`) over a new IPC
  channel (`yahalla:model-status`, `preload.cjs`) — never raw byte
  progress or log lines, matching the existing "hide numeric download
  progress" design already used for the browser tier. `src/App.tsx`
  renders these as a plain, friendly banner strip
  (`.desktop-status-banner`) that never blocks chat — the user can keep
  talking to Yahalla (browser tier) while this runs.
- **No crash/restart handling.** local-runtime's `exit` handler used to
  just log and stop. Fixed: `computeRestartDecision()` (pure function,
  unit-tested) restarts with exponential backoff (1s → 2s → 4s → …),
  resets its attempt count after a healthy run (≥60s uptime), and gives up
  after 5 consecutive quick crashes, reporting `starting`/`restarting`/
  `failed` over a second new IPC channel (`yahalla:runtime-status`).
- **llama-server itself is still not bundled/auto-installed** — real
  per-OS binary distribution (fetching and staging a matching
  llama-server release binary for macOS/Windows/Linux) was judged out of
  scope for this pass: it needs real network access and real execution
  verification on all three OSes, neither of which this sandbox can
  provide honestly. `ensureModelReady()` detects this case
  (`llama_server_installed: false`) and reports `engine-missing` plainly
  instead of hanging or pretending — the browser tier remains usable
  meanwhile. Manual install (`brew install llama.cpp` etc., per
  `desktop/README.md`) is still required today. This is the single
  largest remaining gap toward "never touch a terminal."
- 11 new tests in `desktop/test/runtimeSupervisor.test.cjs` (new
  `desktop` test suite, `npm test` in `desktop/`): the restart-backoff
  math, and `ensureModelReady()`'s full orchestration against a real fake
  local-runtime-shaped HTTP server (already-reachable / engine-missing /
  full first-run download flow / already-downloaded-model / a download
  failure) — not mocked fetch, a real server receiving real requests in
  the right order with the right bodies.

## Weak-hardware capability selection (Phase 8, audited — mostly already real+wired, one test gap closed)

Real hardware-tier detection already existed from earlier work on both
sides and was already wired in, not dead code (worth stating plainly since
an earlier planning note in this project's history had flagged
`capabilities.ts`'s tier detector as unwired — that was true at the time
it was written and is no longer true):

- Browser tier: `src/lib/capabilities.ts`'s `detectHardwareTier()`
  (`navigator.deviceMemory`/`navigator.hardwareConcurrency`) is imported
  and used by both `src/lib/browserLLM.ts` (WebGPU VRAM ceiling →
  model choice) and `src/lib/wasmLLM.ts` (small vs. medium GGUF for the
  WASM fallback engine) — confirmed by grep, not assumed. Covered by
  `test/capabilities.test.ts`.
- local-runtime tier: `hardware.ts`'s CPU/RAM tiering feeds
  `modelManager.ts`'s `recommendCatalogEntry()`, which Phase 7's
  `ensureModelReady()` now calls for the desktop app's automatic first-run
  model selection. **Real gap found and closed**: this tiering logic had
  zero dedicated tests anywhere in `local-runtime/test/` despite Phase 7
  now depending on it for correctness. Fixed: the boundary rule was
  factored into a pure `computeRecommendedTier(totalMemoryGb, cpuCores)`
  (both dimensions must clear a tier's floor — a high-core/low-RAM or the
  reverse machine never gets over-recommended, since a local LLM is
  RAM-bound, not just compute-bound) and covered by 7 new tests in
  `local-runtime/test/hardwareTiering.test.ts`, including an explicit
  assertion that a weak device's recommended catalog entry is never larger
  than its tier. local-runtime suite now 128/128.
- GPU/NPU detection from the local-runtime (Node) process is honestly
  reported as unavailable (`hardware.ts`'s `perception.gpuDetectable:
  false`), not guessed — there is no portable, dependency-free way to
  query GPU VRAM across macOS/Windows/Linux from plain Node. The browser
  side's `navigator.gpu`/WebGPU check is the real GPU signal this project
  actually has, and it is what both `browserLLM.ts` and `wasmLLM.ts` key
  off already.
- Maximizing capability through tools rather than model size alone: this
  is what Phases 1–5 collectively are — `get_project_overview`,
  `dispatch_subagent`, `browser_*`, and structured diagnosis all give even
  the smallest catalog model (Qwen2.5 1.5B) real leverage a bare small
  model would not have on its own, rather than trying to compensate for
  weak hardware with a bigger model.

## Strato / external dependency facts (grep-verified, see prior full audit)

- No hardcoded Strato hostname/IP/secret exists anywhere in source; no
  `.env` file is committed. "Strato" is generic terminology for wherever
  `platform/` is deployed.
- No Cloudflare/OpenAI/Gemini/OpenRouter/Together/Replicate reference
  exists in any active code path (only in explicitly-legacy
  `scripts/llm-tunnel/`/`mac-setup.sh` and `package-lock.json` transitive
  noise).
- Supabase is Auth + dashboard-data + one Realtime channel + the legacy
  Edge Function — **never** AI inference. **Fixed hard coupling**:
  `src/lib/supabase.ts` used to throw at module load if
  `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` were unset, crashing the
  entire frontend bundle (local-runtime/browser AI tiers included, since
  they share the same bundle). Now degrades the same way
  `src/lib/platformApi.ts` already documents for its own optional
  dependency: a console warning, not a crash — "no Supabase" now correctly
  means "sign-in and cross-device sync are unavailable," AI still works.
- Every Strato-exclusive feature (cloud tier, cross-device sync, vector
  memory, Cloud Coding Agent, GitHub OAuth/webhook, the deploy pipeline)
  degrades to a silent no-op when `platform/api` is unset/unreachable —
  this is deliberate existing design (`src/lib/platformApi.ts`), not new
  work needed.

## Baseline build/test results (this exact commit, all commands actually run)

```
root:               tsc -b clean; vite build succeeds (6 chunks, lib chunk
                     flagged oversized by Vite, not code-split); oxlint: 3
                     warnings, 0 errors; npm test (langDetect+capabilities):
                     23/23 pass; test/localRuntimeE2E.smoke.mjs (real
                     local-runtime + real Vite + real headless Chromium,
                     needs PLAYWRIGHT_BROWSERS_PATH in this sandbox): PASS,
                     confirmed twice in a row (not part of npm test)
packages/agent-tools: typecheck clean; build clean (no test script)
device-agent:        typecheck clean; build clean (no test script)
local-runtime:       typecheck clean; build clean; npm test: 121/121 pass,
                     confirmed stable across repeated runs (76 baseline +
                     7 from Phase 1 reliability.test.ts + 6 from Phase 2
                     selfDev.test.ts + 7 from Phase 3 projectIndex.test.ts
                     + 12 from Phase 4 browser.test.ts + 5 from Phase 5
                     subAgents.test.ts + 8 from the local-runtime↔frontend
                     connection fix's localPairing.test.ts; needs a
                     reachable Postgres for databaseIntegration.test.ts's
                     arbitrary-db-connector tests — fails cleanly and only
                     that suite if Postgres is absent, everything else
                     passes regardless; browser.test.ts's live-browser
                     tests need a real Chrome/Chromium/Edge findable on the
                     machine — see the browser-tool section below — or
                     they skip cleanly rather than failing)
platform/api:        typecheck clean; build clean; npm test: 101/101 pass
                     (needs TEST_DATABASE_URL + schema applied via
                     platform/db/apply.sh)
platform/deploy-agent: typecheck clean; build clean; npm test: 9/9 pass
                     (needs the same test DB; shares it with platform/api's
                     suite, so reset the DB between consecutive runs of the
                     two suites or a stale-row false failure can appear)
```

No test in any package is a scripted-to-always-pass stub — all use real
HTTP servers, real SQLite, real subprocess execution, or real Postgres.

## Git state at baseline

Branch `claude/yahalla-ai-os-audit-fix-t459k9`, tracking
`origin/claude/yahalla-ai-os-audit-fix-t459k9`, clean working tree, 6
commits ahead of `main`'s last merge (the "Yahalla Core" local-AI phase
work: language detection, hardware tiering, WASM fallback +
local-runtime streaming, thinking-state UI, local OCR, local image
compositing). `claude/yahalla-ai-os-final-unified` is a stale branch 43
commits behind `main` — not the current source of truth.

## Repo hygiene notes (not fixed here, just recorded)

Four committed `.backup` files exist and are dead weight:
`src/App.tsx.backup`, `src/App.css.backup`, `src/index.css.backup`,
`supabase/functions/yahalla-ai/index.ts.backup`.
