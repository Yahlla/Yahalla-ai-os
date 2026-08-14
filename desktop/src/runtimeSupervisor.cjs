// Pure/testable pieces of the desktop shell's local-runtime lifecycle
// management -- factored out of main.cjs so they can run against a real
// local-runtime-shaped HTTP server in a real Node test process, not just
// be trusted untested inside Electron. Everything here is plain
// Node/fetch, no Electron API dependency.

const MAX_RESTART_ATTEMPTS = 5
// A restart is only counted against the giving-up budget if the process
// died quickly -- one that ran cleanly for a while and then crashed once
// is a fresh transient failure, not evidence of a persistently broken
// install, so its backoff/attempt count resets.
const HEALTHY_UPTIME_MS = 60_000

// Given how long the previous run lasted and how many consecutive quick
// failures have happened so far, decides whether to give up automatic
// restarting and how long to wait before the next attempt. Pure function,
// no timers/process access -- the caller (main.cjs) is responsible for
// actually calling setTimeout/spawn with this decision.
function computeRestartDecision(uptimeMs, previousAttempts) {
  const ranHealthily = uptimeMs >= HEALTHY_UPTIME_MS
  const attempts = ranHealthily ? 1 : previousAttempts + 1
  if (attempts > MAX_RESTART_ATTEMPTS) {
    return { shouldRestart: false, attempts }
  }
  const delayMs = Math.min(1000 * 2 ** (attempts - 1), 30_000)
  return { shouldRestart: true, attempts, delayMs }
}

// Fetch helper for local-runtime's own authenticated REST API -- every
// route but /health needs the bearer token the same config file already
// holds. Never throws; callers get {ok:false} on any failure so the setup
// flow below can report a friendly status instead of crashing.
async function runtimeApi(baseUrl, authToken, path, init = {}) {
  try {
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}`, ...(init.headers || {}) },
    })
    const data = await response.json().catch(() => null)
    if (!response.ok) return { ok: false, error: data?.error || `HTTP ${response.status}` }
    return { ok: true, data }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Request failed.' }
  }
}

// The one-time "trust this project folder" step that local-runtime's
// /project/trust route implements server-side (see server.ts): launching
// the desktop app pointed at a project folder (main.cjs's --project=
// argument) IS this device's real consent signal, so this grants it
// automatically once the runtime is reachable, rather than leaving every
// project-scoped tool permanently permission-denied the way it was before
// this route existed (nothing anywhere previously called
// /permissions/grant with scope=project on a real user's machine).
// Idempotent -- grantPermission's ON CONFLICT upsert makes calling this
// on every launch harmless.
async function trustProjectRoot(baseUrl, authToken) {
  return runtimeApi(baseUrl, authToken, '/project/trust', { method: 'POST', body: JSON.stringify({ access: 'write' }) })
}

// First-run (and every-run) model setup. Uses local-runtime's own
// already-tested REST endpoints (hardware detection, model catalog/
// download/activate, runtime start) rather than reimplementing any of
// that logic here -- this is purely the orchestration a human would
// otherwise have to do by hand in a terminal (detect hardware -> pick a
// model -> download it -> start the engine). Reports coarse, non-
// technical phases via `notify` -- never raw byte-progress or technical
// log lines, matching the existing "hide numeric download progress"
// design already used for the browser tier. `notify` is injected so a
// test can collect the phase sequence instead of needing a real Electron
// renderer.
async function ensureModelReady(baseUrl, authToken, notify) {
  const status = await runtimeApi(baseUrl, authToken, '/runtime/status')
  if (status.ok && status.data.reachable) {
    notify({ phase: 'ready' })
    return
  }

  if (status.ok && status.data.llama_server_installed === false) {
    // Bundling/auto-installing the llama-server engine binary itself is
    // not implemented -- real per-OS binary distribution is out of scope
    // here (see docs/YAHALLA_CURRENT_STATE.md). Report this plainly
    // instead of hanging or silently failing; the browser tier (WebGPU/
    // WASM, still zero external AI) remains usable in the meantime.
    notify({ phase: 'engine-missing' })
    return
  }

  notify({ phase: 'checking' })

  const modelsResult = await runtimeApi(baseUrl, authToken, '/models')
  const alreadyReady = modelsResult.ok ? modelsResult.data.installed.find((m) => m.status === 'ready') : null

  let modelKey = alreadyReady?.key ?? null

  if (!modelKey) {
    const hardwareResult = await runtimeApi(baseUrl, authToken, '/hardware')
    if (!hardwareResult.ok) {
      notify({ phase: 'error', error: hardwareResult.error })
      return
    }
    const recommended = hardwareResult.data.recommended
    const registerResult = await runtimeApi(baseUrl, authToken, `/models/${recommended.key}/register`, {
      method: 'POST',
      body: JSON.stringify({ name: recommended.name, url: recommended.url, sha256: recommended.sha256 }),
    })
    if (!registerResult.ok) {
      notify({ phase: 'error', error: registerResult.error })
      return
    }

    notify({ phase: 'downloading', modelName: recommended.name })
    const downloadResult = await runtimeApi(baseUrl, authToken, `/models/${recommended.key}/download`, { method: 'POST' })
    if (!downloadResult.ok || downloadResult.data.status !== 'ready') {
      notify({ phase: 'error', error: downloadResult.error || 'Download did not complete.' })
      return
    }
    modelKey = recommended.key
  }

  const activateResult = await runtimeApi(baseUrl, authToken, `/models/${modelKey}/activate`, { method: 'POST' })
  if (!activateResult.ok) {
    notify({ phase: 'error', error: activateResult.error })
    return
  }

  notify({ phase: 'starting_engine' })
  const startResult = await runtimeApi(baseUrl, authToken, '/runtime/start', { method: 'POST' })
  if (!startResult.ok || !startResult.data.success) {
    notify({ phase: 'error', error: startResult.error || 'The local model engine did not start in time.' })
    return
  }

  notify({ phase: 'ready' })
}

module.exports = { computeRestartDecision, runtimeApi, trustProjectRoot, ensureModelReady, MAX_RESTART_ATTEMPTS, HEALTHY_UPTIME_MS }
