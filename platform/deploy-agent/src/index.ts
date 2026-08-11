import { closePool } from './db.js'
import { pollOnce } from './worker.js'

const databaseUrl = process.env.DATABASE_URL
const repoDir = process.env.REPO_DIR
const composeFile = process.env.COMPOSE_FILE ?? 'platform/docker-compose.yml'
const pollIntervalMs = Number(process.env.POLL_INTERVAL_MS ?? 15_000)

if (!databaseUrl) {
  console.error('DATABASE_URL is required.')
  process.exit(1)
}
if (!repoDir) {
  console.error('REPO_DIR is required (the local checkout deploy-agent redeploys from).')
  process.exit(1)
}
const resolvedRepoDir: string = repoDir

console.log(`[deploy-agent] watching for approved deployment_proposals every ${pollIntervalMs}ms`)

let stopping = false
let timer: NodeJS.Timeout | undefined

async function tick(): Promise<void> {
  if (stopping) return
  try {
    const deployedId = await pollOnce({ repoDir: resolvedRepoDir, composeFile })
    if (deployedId) console.log(`[deploy-agent] processed proposal ${deployedId}`)
  } catch (error) {
    console.error('[deploy-agent] poll cycle failed:', error instanceof Error ? error.message : error)
  }
  if (!stopping) timer = setTimeout(tick, pollIntervalMs)
}

void tick()

async function shutdown(): Promise<void> {
  stopping = true
  if (timer) clearTimeout(timer)
  await closePool()
  process.exit(0)
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
