import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'

export type DeviceConfig = {
  supabase_url: string
  supabase_anon_key: string
  device_id: string
  device_name: string
  refresh_token: string
  project_root: string
}

const CONFIG_DIR = join(homedir(), '.yahalla')
const CONFIG_FILE = join(CONFIG_DIR, 'agent.json')

export function detectPlatform(): 'macos' | 'windows' | 'linux' | 'other' {
  const p = platform()
  if (p === 'darwin') return 'macos'
  if (p === 'win32') return 'windows'
  if (p === 'linux') return 'linux'
  return 'other'
}

export function loadConfig(): DeviceConfig | null {
  if (!existsSync(CONFIG_FILE)) return null
  const raw = readFileSync(CONFIG_FILE, 'utf8')
  return JSON.parse(raw) as DeviceConfig
}

export function saveConfig(config: DeviceConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true })
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8')
  // Best-effort: restrict to the owner only. No-op / harmless on platforms
  // where chmod semantics differ (e.g. Windows).
  try {
    chmodSync(CONFIG_FILE, 0o600)
  } catch {
    // ignore
  }
}

export function configPath(): string {
  return CONFIG_FILE
}
