#!/usr/bin/env node
import { loadOrCreateConfig, saveConfig } from './config.js'
import { openDb } from './db.js'
import { LocalModelProcess } from './llm.js'
import { getActiveModel } from './modelManager.js'
import { createHttpServer } from './server.js'

async function main() {
  const projectRootArg = process.argv.find((a) => a.startsWith('--project='))?.split('=')[1]

  const config = loadOrCreateConfig()
  if (projectRootArg) {
    config.projectRoot = projectRootArg
    saveConfig(config)
  }

  const db = openDb()
  const modelProcess = new LocalModelProcess(8766)

  const server = createHttpServer({ db, config, modelProcess })

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
      modelProcess.start(findLlamaServerBinary(), active.file_path!)
    } catch (error) {
      console.error('[yahalla-runtime] could not autostart local model:', error)
    }
  }

  const shutdown = () => {
    console.log('\n[yahalla-runtime] shutting down...')
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
