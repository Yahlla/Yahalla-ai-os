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

function readRuntimeConfig() {
  if (!existsSync(RUNTIME_CONFIG_PATH)) return null
  try {
    return JSON.parse(readFileSync(RUNTIME_CONFIG_PATH, 'utf8'))
  } catch {
    return null
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
    return
  }
  const projectRoot = process.env.YAHALLA_PROJECT_ROOT || process.cwd()
  runtimeProcess = spawn(process.execPath, [RUNTIME_ENTRY, `--project=${projectRoot}`], {
    stdio: 'inherit',
    env: process.env,
  })
  runtimeProcess.on('exit', (code) => {
    console.log(`[desktop] local-runtime exited with code ${code}`)
    runtimeProcess = null
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

app.on('before-quit', stopRuntime)
