#!/usr/bin/env node
import { loadOrCreateConfig, saveConfig } from './config.js'
import { openDb } from './db.js'
import { EmbodimentStateMachine } from './embodiment/stateMachine.js'
import { LocalModelProcess } from './llm.js'
import { getActiveModel, recommendedContextSize } from './modelManager.js'
import { PerceptionManager } from './perception/manager.js'
import { grantPermission } from './permissions.js'
import { ctxFrom, createHttpServer } from './server.js'
import { startTaskPoller } from './taskPoller.js'

async function main() {
  const projectRootArg = process.argv.find((a) => a.startsWith('--project='))?.split('=')[1]

  const config = loadOrCreateConfig()
  const db = openDb()

  if (projectRootArg) {
    config.projectRoot = projectRootArg
    saveConfig(config)
    // Same audit fix as the Electron shell (runtimeSupervisor.cjs's
    // trustProjectRoot) and the browser-pairing flow
    // (localRuntime.ts's pairWithLocalRuntime): passing --project=
    // explicitly on the command line IS this device's real consent for
    // this specific runtime-only path -- nobody else grants it here, so
    // without this every project-scoped tool would stay permission-denied
    // forever on a CLI-only install, the same gap that existed for every
    // launch path before this audit.
    grantPermission(db, 'project', projectRootArg, 'write')
  }
  const modelProcess = new LocalModelProcess(8766)
  const embodiment = new EmbodimentStateMachine()
  const perception = new PerceptionManager(db)

  // Remote command dispatch (task #78-81): if this machine is already
  // paired against a platform-api deployment, start polling it for tasks
  // right away; otherwise this is a no-op until /device/pair is called.
  // restartPoller() is handed to the HTTP server so the pairing/unpairing
  // routes can swap the poller in place after config changes.
  let stopPoller = startTaskPoller(ctxFrom({ db, config, modelProcess, embodiment, perception }, embodiment, perception), config)
  const restartPoller = () => {
    stopPoller()
    stopPoller = startTaskPoller(ctxFrom({ db, config, modelProcess, embodiment, perception }, embodiment, perception), config)
  }

  const server = createHttpServer({ db, config, modelProcess, embodiment, perception, restartTaskPoller: restartPoller })

  server.listen(config.port, '127.0.0.1', () => {
    console.log(`[yahalla-runtime] listening on http://127.0.0.1:${config.port}`)
    console.log(`[yahalla-runtime] project root: ${config.projectRoot ?? '(not set -- grant one via /permissions/grant)'}`)
  })

  // Best-effort: if a model is already active from a previous run, start
  // it automatically so the user lands on "AI READY" without any manual
  // step. Failure here is non-fatal -- /runtime/start can be retried from
  // the UI once a local LLM server binary is available.
  const active = getActiveModel(db)
  if (active) {
    try {
      const { findLlamaServerBinary } = await import('./llm.js')
      modelProcess.start(findLlamaServerBinary(), active.file_path!, ['--ctx-size', String(recommendedContextSize(active.key))])
    } catch (error) {
      console.error('[yahalla-runtime] could not autostart local model:', error)
    }
  }

  const shutdown = () => {
    console.log('\n[yahalla-runtime] shutting down...')
    stopPoller()
    modelProcess.stop()
    server.close(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

main().catch((error) => {
  console.error('[yahalla-runtime] fatal error:', error)
  process.exit(1)
})
