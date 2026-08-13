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

## AI architecture: four independent inference tiers

Tried in this exact priority order, fresh on every message (`src/App.tsx`'s
`sendMessage`):

1. **Cloud tier** (opt-in, `platform/api/src/cloudTier.ts`) — Anthropic or
   Groq, server-side key only. Tried FIRST when `platform/api` is
   configured and reachable. **Down whenever Strato is down.**
2. **local-runtime tier** — the real Agent Runtime: full tool-calling,
   permissions, approvals, memory. Selected when local-runtime's `/health`
   reports `llm_reachable: true`.
3. **Browser tier** — WebGPU (`@mlc-ai/web-llm`) or WASM fallback
   (`@wllama/wllama`) inside the tab. Chat only, no tools, no memory.
4. **Legacy Supabase Edge Function** (`supabase/functions/yahalla-ai`) —
   last resort. Proxies to whatever `servers`/`models` DB row is
   registered; structurally dead without one.

No hidden external-AI fallback exists in the browser or in local-runtime —
the only two hardcoded external-AI endpoint strings in the whole repo
(`api.anthropic.com`, `api.groq.com`) live exclusively inside
`platform/api/src/cloudTier.ts`, a server-only file the browser bundle
never contains.

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

## Self-repair (existing, single-cycle)

`local-runtime/test/repair-loop.test.ts` proves one real cycle: a real
temp npm project with a deterministically-failing test, driven through
the real `/chat` endpoint with "Run the tests and fix them if they fail."
The test asserts the real test command ran twice (fail, then pass), the
patch tool ran once and succeeded, and the flag file's real on-disk
content changed. This is genuine "mechanics work end-to-end" proof, not a
general "always finds the right fix" guarantee — the fake LLM in the test
scripts one plausible fixed conversation, not a search over strategies.

## Multi-agent — does not exist in the real architecture

The "12 specialized agents + orchestrator" concept
(`supabase/migrations/20260810114233_20260810_yahalla_seed_data.sql`) is
inert seed data feeding a cosmetic dropdown (`selectedAgent` in
`src/App.tsx`) in the legacy Supabase Edge-Function chat path only. It has
zero effect on local-runtime's actual behavior. There is no code anywhere
that dispatches a sub-task to a differently-configured agent.

## Browser tool — does not exist

No browser-automation/navigation tool is registered in `tools.ts`. "Browser"
today means only: the Control Center's own React UI runs in a browser, and
the browser tiers (WebGPU/WASM) run a chat model in a tab. Neither is an
agent tool that can navigate/inspect/click a web page.

## Strato / external dependency facts (grep-verified, see prior full audit)

- No hardcoded Strato hostname/IP/secret exists anywhere in source; no
  `.env` file is committed. "Strato" is generic terminology for wherever
  `platform/` is deployed.
- No Cloudflare/OpenAI/Gemini/OpenRouter/Together/Replicate reference
  exists in any active code path (only in explicitly-legacy
  `scripts/llm-tunnel/`/`mac-setup.sh` and `package-lock.json` transitive
  noise).
- Supabase is Auth + dashboard-data + one Realtime channel + the legacy
  Edge Function — **never** AI inference. **Hard coupling to flag**:
  `src/lib/supabase.ts` throws at module load if
  `VITE_SUPABASE_URL`/`VITE_SUPABASE_ANON_KEY` are unset — today, "no
  Supabase" means "the frontend bundle fails to initialize at all," not
  "AI still works, dashboard doesn't."
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
                     23/23 pass
packages/agent-tools: typecheck clean; build clean (no test script)
device-agent:        typecheck clean; build clean (no test script)
local-runtime:       typecheck clean; build clean; npm test: 89/89 pass
                     (76 baseline + 7 from Phase 1 reliability.test.ts + 6
                     from Phase 2 selfDev.test.ts; needs a reachable
                     Postgres for databaseIntegration.test.ts's arbitrary-
                     db-connector tests — fails cleanly and only that suite
                     if Postgres is absent, everything else passes
                     regardless)
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
