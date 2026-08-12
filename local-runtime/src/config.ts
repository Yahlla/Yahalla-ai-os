import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { configPath } from './paths.js'

export type RuntimeConfig = {
  port: number
  authToken: string
  projectRoot: string | null
  allowedOrigins: string[]
  // Set once this machine is paired as a remote-command-capable device
  // (see devicePairing.ts) -- lets a task created from any browser/device
  // (chat, Cloud Boost, phone) reach this specific machine's real file/
  // git/tool access via platform-api's task queue. Both unset (the
  // default) means this device never polls for or executes remote tasks.
  platformApiUrl?: string
  deviceToken?: string
}

const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'tauri://localhost',
  'app://yahalla',
]

// A random local-only auth token, generated once and stored 0600. This is
// not about protecting against a network attacker (the server never binds
// to anything but 127.0.0.1) -- it is about stopping an arbitrary web page
// open in the same browser from silently calling this local API (a well
// known class of "attack localhost via the browser" issue with any
// unauthenticated localhost service). Only something that can read this
// file (the Electron main process, or the user themselves) can act as
// this device's AI runtime client.
export function loadOrCreateConfig(): RuntimeConfig {
  const path = configPath()
  if (existsSync(path)) {
    return JSON.parse(readFileSync(path, 'utf8')) as RuntimeConfig
  }

  const config: RuntimeConfig = {
    port: 8765,
    authToken: randomBytes(32).toString('hex'),
    projectRoot: null,
    allowedOrigins: DEFAULT_ALLOWED_ORIGINS,
  }
  saveConfig(config)
  return config
}

export function saveConfig(config: RuntimeConfig): void {
  const path = configPath()
  writeFileSync(path, JSON.stringify(config, null, 2), 'utf8')
  try {
    chmodSync(path, 0o600)
  } catch {
    // best-effort; harmless on platforms where chmod semantics differ
  }
}
