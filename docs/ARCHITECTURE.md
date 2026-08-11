# Yahalla AI OS — Local-First Architecture

Yahalla AI runs on the user's own device. Each user installs it and gets their own
local AI computer: its own model, memory, knowledge, skills, and tool execution —
all on their machine, none of it dependent on any other server (including the
developer's Mac).

```
Yahalla AI App (desktop/, Electron)
        │  local IPC (contextBridge) — base URL + auth token
        ▼
React Control Center (unchanged UI, src/)
        │  http://127.0.0.1:<port>  (Bearer token, 127.0.0.1-only)
        ▼
Local Agent Runtime (local-runtime/)
        │
        ├─ SQLite (~/.yahalla/runtime/yahalla.db): conversations, memory,
        │  knowledge, skills, tasks, permissions, approvals, models
        ├─ Tool execution (@yahalla/agent-tools): files, git, run_command,
        │  sandboxed to the granted project directory
        └─ Local LLM process (llama.cpp's llama-server or compatible)
                │  http://127.0.0.1:<model-port>
                ▼
        Local GGUF model file (~/.yahalla/runtime/models/)
```

Supabase remains available for **optional** account/cloud features (auth, the
legacy multi-agent platform under `supabase/functions/yahalla-ai/`, cross-device
sync later) — it is never on the path required to chat with the local AI.

## Why this replaced the tunnel-based design

The previous iteration ran the LLM on one Mac and exposed it to the internet via a
Cloudflare quick tunnel so Supabase's cloud Edge Function could reach it. That
made one person's machine a shared server for everyone, required it to stay on,
and needed a public tunnel URL kept in sync. None of that is required anymore:
`scripts/llm-tunnel/` and `scripts/mac-setup.sh` still exist and work, but are now
explicitly legacy/optional — see the headers at the top of those files. The
default, documented path is `scripts/setup-local.sh`.

## Components

### `packages/agent-tools/`
The sandboxed tool executors (`read_project_file`, `write_project_file`,
`patch_project_file`, `list_project_files`, `git_status`, `git_diff`,
`git_create_branch`, `git_commit`, `git_push`, `run_project_command`). Shared
between `local-runtime/` (the primary path) and `device-agent/` (the legacy
paired-device mode, still used by the optional cloud-routed path). Path
sandboxing rejects `..`, absolute paths, and symlink escapes
(`resolveProjectPath` in `sandbox.ts`); `run_project_command` never invokes a
shell and only runs a command that exact-matches a configured allowlist.

### `local-runtime/`
A dependency-light Node service (only `@yahalla/agent-tools` — storage is
Node's built-in `node:sqlite`, the HTTP server is built on `node:http`, no
Express, no ORM). Binds strictly to `127.0.0.1`. Owns:
- **Chat / agent loop** (`agentLoop.ts`): the tool-calling loop against the
  local LLM, with the same evidence/verification and coding-agent-workflow
  system prompt rules the platform has used elsewhere in this project — never
  fabricate a tool result, never claim success without a passing verification
  step, read → plan → execute → verify → test → diagnose → fix → retest → report.
- **Model management** (`modelManager.ts`, `hardware.ts`): hardware-aware model
  recommendation, download-with-checksum-verification, activation, deletion.
- **Local LLM process** (`llm.ts`): spawns/health-checks a local
  OpenAI-compatible server (llama.cpp's `llama-server` by default; anything
  else that serves `/v1/chat/completions` + `/v1/models` on localhost works too).
- **Memory / knowledge / skills / preferences** (`memory.ts`): see below.
- **Permissions** (`permissions.ts`): see below.
- **HTTP API** (`server.ts`): `/health` (unauthenticated), `/chat`,
  `/approvals/:id/decide`, `/conversations`, `/tasks`, `/memory`, `/knowledge`,
  `/skills`, `/preferences`, `/permissions`, `/models`, `/runtime/*`, `/hardware`
  — all except `/health` require `Authorization: Bearer <token>`.

Tested end to end in `local-runtime/test/integration.test.ts` (real HTTP server,
real SQLite, real tool execution against a real temp project, a stand-in local
LLM server) — not just typechecked. Run with `npm test` in `local-runtime/`.

### `desktop/`
An Electron shell: on launch it spawns `local-runtime` as a child process,
waits for `/health`, opens a window loading the Control Center, and exposes
`{baseUrl, authToken}` to it through a `contextBridge` preload (no Node
integration in the page itself). Closing the app stops the runtime. This is the
"no Terminal, no manual steps" delivery mechanism for end users.

### `src/` (Control Center frontend)
Unchanged UI. `src/lib/localRuntime.ts` is the new primary AI client — it talks
to the local runtime directly and normalizes responses into the same
`ChatResponse` shape the UI already used, so the rest of the app didn't need to
change. `App.tsx`'s send-message handler checks the local runtime's `/health`
first and only falls back to the legacy Supabase-routed path
(`src/lib/api.ts`'s `sendChatMessage`) if no local runtime is reachable at all —
so an existing dev setup pointed at the old path keeps working rather than
breaking outright.

## Local data (`~/.yahalla/runtime/`)

- `yahalla.db` — SQLite: conversations, messages, memory, knowledge, skills,
  preferences, tasks, task_feedback, permissions, approvals, models.
- `models/` — downloaded GGUF files.
- `config.json` (mode 600) — port, random auth token, granted project root,
  allowed origins.
- `logs/`

All of it stays on the device unless the user explicitly enables a future sync
feature. Nothing here is uploaded anywhere by default.

## Memory, knowledge, skills — how "self-improvement" actually works

There is no claim that the model retrains itself. What genuinely accumulates and
improves future behavior:

- **Memory** (`memory` table): short summaries of past conversations, recalled
  by simple keyword+recency ranking (`recallMemory`) and folded into future
  context. No embeddings/vector index yet — flagged as an optional future
  upgrade, not required for this to work.
- **Knowledge** (`knowledge` table): longer-lived reference material the user
  or agent adds explicitly.
- **Skills** (`skills` table): named, reusable procedures the agent can record
  after solving something non-trivial (e.g. "how this project's tests run"),
  with `success_count`/`failure_count` tracked via `recordSkillOutcome` so a
  skill that keeps working gets reinforced and one that keeps failing doesn't.
- **Task history / feedback** (`tasks`, `task_feedback`): every chat task and
  its outcome, so patterns of what worked are inspectable and reusable.
- **Preferences** (`preferences` table): user-set values (e.g. `max_tool_rounds`,
  `github_token`) the runtime reads back on every request.

If real fine-tuning is added later, it plugs in as an optional advanced feature
consuming these same tables as training signal — it is not required for any of
the above to already be useful.

## Security / permissions

Two independent gates, both enforced server-side in `local-runtime`, not just in
the UI:

1. **Standing permissions** (`permissions` table, `checkAccess`): coarse
   category grants — `project` (read/write, scoped by path prefix), `network`,
   `command_execution`, `sensitive_files`, `system_settings`,
   `application_launching`. Nothing is granted by default; a new project must
   be explicitly trusted once (`POST /permissions/grant`) before any tool can
   touch it — the same pattern as "trust this folder" in other dev tools.
2. **Per-action approval** (`approvals` table, `requiresApproval` on each tool):
   `write_project_file`, `patch_project_file`, `git_commit`, `git_push`, and
   `github.write` always pause for an explicit one-time approval before they
   run, regardless of standing permissions. Approving one only executes it if
   the standing permission is *also* still granted — revoking a permission
   blocks even an already-approved action (verified in the integration tests).

The local HTTP API itself binds only to `127.0.0.1` and requires a random,
locally-generated bearer token for everything except `/health`, so an arbitrary
web page open in the same browser cannot silently call it.

## Offline

Once a model is downloaded and active, chat, tool execution, memory, knowledge,
skills, and permissions all work with no internet connection — everything they
touch is local (SQLite + local files + the local LLM process). Internet is only
needed for: downloading a model, `github.read`/`github.write` (calls the real
GitHub API), `git_push` to a remote, software updates, and the optional legacy
Supabase path.

## Installing / developing

**End users:** `sh scripts/setup-local.sh --with-desktop`, then
`(cd desktop && npm run electron:dev)`. No environment variables, no Cloudflare,
no Supabase secret to configure for AI to work.

**Developers working on this repo:**
```
cd packages/agent-tools && npm install && npm run build
cd ../../local-runtime && npm install && npm run build && npm test
cd .. && npm install && npm run dev   # Vite dev server against local-runtime
```
Requires Node 22.5+ (for the built-in `node:sqlite` module) and, to actually run
a model, `llama-server` on `PATH` (or any other local OpenAI-compatible server —
point `local-runtime`'s active model's process at it, or just run your own
server on `127.0.0.1:8766` before starting the runtime).

## Known limitations, honestly

- `local-runtime`'s model download/verification mechanism is implemented and
  tested against a real local HTTP fixture, but has not been exercised against
  a real multi-gigabyte Hugging Face download in this environment.
- The Electron shell's source is written and typechecked but **could not be
  launched** in the environment this was built in (Electron's binary
  postinstall download fails there) — it needs to be run on a real desktop to
  confirm the window itself opens correctly.
- GPU detection is not implemented (CPU/RAM only); model recommendation is
  conservative as a result.
- No vector/embedding-based memory recall yet (keyword-based only).
