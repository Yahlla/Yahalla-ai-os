#!/usr/bin/env node
import { createInterface } from 'node:readline/promises'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { detectPlatform, loadConfig, saveConfig, configPath, type DeviceConfig } from './config.js'
import { exchangePairingCode, createDeviceClient } from './auth.js'
import { startHeartbeat } from './heartbeat.js'
import { startClaimLoop } from './claim.js'

async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question(question)).trim()
  } finally {
    rl.close()
  }
}

async function commandPair(args: string[]) {
  const codeArg = args.find((a) => !a.startsWith('--'))
  const code = codeArg ?? (await prompt('Pairing code (from the Devices page): '))

  const supabaseUrlArg = args.find((a) => a.startsWith('--supabase-url='))?.split('=')[1]
  const anonKeyArg = args.find((a) => a.startsWith('--anon-key='))?.split('=')[1]
  const projectArg = args.find((a) => a.startsWith('--project='))?.split('=')[1]

  const supabaseUrl = supabaseUrlArg ?? (await prompt('Supabase URL (VITE_SUPABASE_URL from the web app): '))
  const anonKey = anonKeyArg ?? (await prompt('Supabase anon key (VITE_SUPABASE_ANON_KEY from the web app): '))
  const projectRootInput = projectArg ?? (await prompt('Project directory to run tools against (absolute path): '))
  const projectRoot = resolve(projectRootInput)

  if (!existsSync(projectRoot)) {
    console.error(`Project directory does not exist: ${projectRoot}`)
    process.exit(1)
  }

  const deviceName = args.find((a) => a.startsWith('--name='))?.split('=')[1] ?? `${detectPlatform()}-${process.env.USER ?? process.env.USERNAME ?? 'device'}`

  console.log('Exchanging pairing code...')

  const result = await exchangePairingCode(supabaseUrl, anonKey, code, deviceName, detectPlatform())

  const config: DeviceConfig = {
    supabase_url: supabaseUrl,
    supabase_anon_key: anonKey,
    device_id: result.device_id,
    device_name: result.device_name,
    refresh_token: result.refresh_token,
    project_root: projectRoot,
  }

  saveConfig(config)

  console.log(`Paired as "${result.device_name}". Config saved to ${configPath()}.`)
  console.log('Run `yahalla-agent start` to begin (or set up autostart — see README.md).')
}

async function commandStart() {
  const config = loadConfig()

  if (!config) {
    console.error('No paired device found. Run `yahalla-agent pair <code>` first.')
    process.exit(1)
  }

  if (!existsSync(config.project_root)) {
    console.error(`Configured project directory no longer exists: ${config.project_root}`)
    process.exit(1)
  }

  console.log(`[yahalla-agent] starting — device "${config.device_name}", project ${config.project_root}`)

  const client = await createDeviceClient(config)

  const stopHeartbeat = startHeartbeat(client, {
    platform: detectPlatform(),
    node_version: process.version,
  })

  const stopClaimLoop = startClaimLoop(client, config)

  console.log('[yahalla-agent] running. Press Ctrl+C to stop.')

  const shutdown = () => {
    console.log('\n[yahalla-agent] shutting down...')
    stopHeartbeat()
    stopClaimLoop()
    process.exit(0)
  }

  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}

async function main() {
  const [, , command, ...rest] = process.argv

  switch (command) {
    case 'pair':
      await commandPair(rest)
      break
    case 'start':
      await commandStart()
      break
    default:
      console.log('Usage: yahalla-agent <pair|start>')
      console.log('  yahalla-agent pair <code>   Redeem a pairing code from the Devices page.')
      console.log('  yahalla-agent start         Run the agent (heartbeat + tool execution).')
      process.exit(command ? 1 : 0)
  }
}

main().catch((error) => {
  console.error('[yahalla-agent] fatal error:', error instanceof Error ? error.message : error)
  process.exit(1)
})
