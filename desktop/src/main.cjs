// Yahalla AI desktop shell (Electron main process).
//
// Responsibility: own the lifecycle of the local Agent Runtime child
// process, and give the renderer (the existing React Control Center,
// unmodified) a way to reach it -- nothing more. This process never talks
// to any cloud LLM, never opens a tunnel, and the runtime it spawns only
// ever binds to 127.0.0.1.
const { app, BrowserWindow, ipcMain } = require('electron')
const { spawn } = require('node:child_process')
const { existsSync, readFileSync } = require('node:fs')
const { homedir } = require('node:os')
const { join } = require('node:path')
const { computeRestartDecision, ensureModelReady, trustProjectRoot } = require('./runtimeSupervisor.cjs')

// In the monorepo (dev), local-runtime and the frontend build live as
// sibling directories. In a packaged app there is no monorepo -- everything
// desktop/scripts/stage-resources.mjs staged into desktop/resources/ ships
// inside the app under process.resourcesPath instead (see build.extraResources
// in package.json). Same shape either way, just a different root.
const RESOURCES_ROOT = app.isPackaged ? process.resourcesPath : join(__dirname, '..', 'resources')
const RUNTIME_ENTRY = join(RESOURCES_ROOT, 'local-runtime', 'dist', 'src', 'index.js')
const FRONTEND_INDEX = join(RESOURCES_ROOT, 'app-dist', 'index.html')
const RUNTIME_CONFIG_PATH = join(homedir(), '.yahalla', 'runtime', 'config.json')

let runtimeProcess = null
let mainWindow = null
let isQuitting = false
let restartAttempts = 0
let lastStartedAt = 0

function readRuntimeConfig() {
  if (!existsSync(RUNTIME_CONFIG_PATH)) return null
  try {
    return JSON.parse(readFileSync(RUNTIME_CONFIG_PATH, 'utf8'))
  } catch {
    return null
  }
}

// Best-effort notification to the renderer -- the window may not exist
// yet (very first startup) or may have been closed; both are fine to
// silently skip rather than throw.
function notifyRenderer(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

async function waitForRuntime(port, timeoutMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.ok) return true
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  return false
}

function startRuntime() {
  if (!existsSync(RUNTIME_ENTRY)) {
    console.error(
      `[desktop] local-runtime is not staged. In dev, run "node desktop/scripts/stage-resources.mjs" ` +
        `after building local-runtime/, packages/agent-tools/, and the frontend. Expected: ${RUNTIME_ENTRY}`,
    )
    notifyRenderer('yahalla:runtime-status', { status: 'failed', reason: 'not_staged' })
    return
  }
  const projectRoot = process.env.YAHALLA_PROJECT_ROOT || process.cwd()
  lastStartedAt = Date.now()
  notifyRenderer('yahalla:runtime-status', { status: restartAttempts > 0 ? 'restarting' : 'starting' })
  // process.execPath inside Electron's main process is the Electron binary
  // itself, not a plain Node binary -- spawning it directly on a script
  // path (with no other flag) launches ANOTHER full Electron/Chromium app
  // instance trying to run that script as its entry point, which fails
  // outright in a real packaged app (this was only ever verified by
  // TypeScript compiling cleanly before this audit, never by actually
  // running Electron: `electron_main_delegate.cc: Running as root without
  // --no-sandbox is not supported` / a silent crash-loop otherwise --
  // the real local-runtime process never started, so the whole desktop
  // app's AI would have been non-functional). ELECTRON_RUN_AS_NODE=1 is
  // Electron's own documented mechanism for exactly this case: the child
  // runs as plain Node (require(), no Chromium, no app lifecycle) instead.
  runtimeProcess = spawn(process.execPath, [RUNTIME_ENTRY, `--project=${projectRoot}`], {
    stdio: 'inherit',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  })
  runtimeProcess.on('exit', (code) => {
    console.log(`[desktop] local-runtime exited with code ${code}`)
    runtimeProcess = null
    if (isQuitting) return

    const decision = computeRestartDecision(Date.now() - lastStartedAt, restartAttempts)
    restartAttempts = decision.attempts

    if (!decision.shouldRestart) {
      console.error(`[desktop] local-runtime crashed ${decision.attempts - 1} times in a row -- giving up automatic restarts.`)
      notifyRenderer('yahalla:runtime-status', { status: 'failed', reason: 'crash_loop' })
      return
    }

    console.log(`[desktop] restarting local-runtime in ${decision.delayMs}ms (attempt ${decision.attempts})`)
    setTimeout(startRuntime, decision.delayMs)
  })
}

function stopRuntime() {
  if (runtimeProcess && !runtimeProcess.killed) {
    runtimeProcess.kill('SIGTERM')
  }
  runtimeProcess = null
}

async function createWindow() {
  const config = readRuntimeConfig()
  const port = config?.port ?? 8765
  const ready = await waitForRuntime(port)
  if (!ready) {
    console.error('[desktop] local-runtime did not become ready in time.')
  }

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })

  ipcMain.handle('yahalla:get-runtime-info', () => {
    const cfg = readRuntimeConfig()
    return cfg ? { baseUrl: `http://127.0.0.1:${cfg.port}`, authToken: cfg.authToken } : null
  })

  const devServerUrl = process.env.YAHALLA_DEV_SERVER_URL
  if (devServerUrl) {
    await mainWindow.loadURL(devServerUrl)
  } else {
    await mainWindow.loadFile(FRONTEND_INDEX)
  }

  // Never blocks the window from opening: the user can start using
  // whatever's already available (browser tier, general chat) immediately
  // while this runs in the background, exactly like the existing
  // background browser-model warm-up already does for the web tier.
  if (ready) {
    const cfg = readRuntimeConfig()
    if (cfg) {
      const runtimeBaseUrl = `http://127.0.0.1:${cfg.port}`
      // Grant project trust before model setup -- both are independent
      // background steps, but trust is what makes the project-scoped tools
      // (get_project_overview, read_project_file, ...) usable the moment
      // the model itself is ready, instead of leaving a second, invisible
      // "permission denied" surprise after model setup completes.
      void trustProjectRoot(runtimeBaseUrl, cfg.authToken)
      void ensureModelReady(runtimeBaseUrl, cfg.authToken, (payload) => notifyRenderer('yahalla:model-status', payload))
    }
  }
}

app.whenReady().then(() => {
  startRuntime()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  stopRuntime()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  isQuitting = true
  stopRuntime()
})
