import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Everything the local-first runtime owns lives under the user's own home
// directory -- never anywhere shared, never on a server. This is the same
// root the legacy device-agent already uses for its pairing config
// (~/.yahalla/agent.json), kept alongside it rather than replacing it.
const DATA_ROOT = join(homedir(), '.yahalla', 'runtime')

export function dataRoot(): string {
  mkdirSync(DATA_ROOT, { recursive: true })
  return DATA_ROOT
}

export function dbPath(): string {
  return join(dataRoot(), 'yahalla.db')
}

export function modelsDir(): string {
  const dir = join(dataRoot(), 'models')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function logsDir(): string {
  const dir = join(dataRoot(), 'logs')
  mkdirSync(dir, { recursive: true })
  return dir
}

export function configPath(): string {
  return join(dataRoot(), 'config.json')
}
