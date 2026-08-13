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

// The known, official Yahalla app origins -- the Electron/Tauri shell
// schemes, the local dev server, and the production static Control Center
// deployment (a plain browser page with no server-side secret of its own;
// see server.ts's /pair + /pair/token for how it can still reach a real
// local-runtime on the same machine without that token ever being baked
// into the public build). Not a general-purpose CORS wildcard -- still an
// exact-match allowlist, just one that includes the real production origin
// this app is actually deployed to.
export const DEFAULT_ALLOWED_ORIGINS = [
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  'tauri://localhost',
  'app://yahalla',
  'https://yahalla-ai.yahalla.de',
]

// Pure, dependency-free merge step, factored out of loadOrCreateConfig so
// it can be unit-tested directly without going through the real
// filesystem/homedir-coupled config path.
export function mergeAllowedOrigins(existing: string[]): string[] {
  return Array.from(new Set([...existing, ...DEFAULT_ALLOWED_ORIGINS]))
}

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
    const config = JSON.parse(readFileSync(path, 'utf8')) as RuntimeConfig
    // Self-healing merge: a config written by an older version of this
    // runtime won't have a newer official origin (e.g. the production
    // Control Center domain added later) in its persisted allowedOrigins
    // -- without this, upgrading the app would silently keep the new
    // origin blocked forever, since allowedOrigins is only ever *set* on
    // first run. Existing user customizations (an origin they added, or
    // one of the defaults they deliberately removed by editing the file)
    // are preserved; this only ever adds an official origin, never
    // removes one the user didn't request removed.
    const merged = mergeAllowedOrigins(config.allowedOrigins)
    if (merged.length !== config.allowedOrigins.length) {
      config.allowedOrigins = merged
      saveConfig(config)
    }
    return config
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
