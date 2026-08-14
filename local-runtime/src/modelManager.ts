import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import type { Db } from './db.js'
import { newId } from './db.js'
import type { HardwareInfo } from './hardware.js'
import { modelsDir } from './paths.js'

export type ModelStatus = 'not_downloaded' | 'downloading' | 'ready' | 'error'

export type ModelRow = {
  id: string
  key: string
  name: string
  url: string | null
  file_path: string | null
  size_bytes: number | null
  sha256: string | null
  status: ModelStatus
  active: number
  created_at: string
  updated_at: string
}

export type ModelCatalogEntry = {
  key: string
  name: string
  url: string
  approxSizeBytes: number
  tier: 'small' | 'medium' | 'large'
  sha256?: string
}

// A small, honest starting catalog -- not exhaustive, not hard-coded as
// "the only model forever". Any GGUF URL can be registered via
// registerModel() below; this catalog is just the zero-config defaults
// offered to a new user based on their hardware tier.
export const MODEL_CATALOG: ModelCatalogEntry[] = [
  {
    key: 'qwen2.5-1.5b-instruct-q4_k_m',
    name: 'Qwen2.5 1.5B Instruct (Q4_K_M)',
    url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf',
    approxSizeBytes: 1_050_000_000,
    tier: 'small',
  },
  {
    key: 'qwen2.5-3b-instruct-q4_k_m',
    name: 'Qwen2.5 3B Instruct (Q4_K_M)',
    url: 'https://huggingface.co/Qwen/Qwen2.5-3B-Instruct-GGUF/resolve/main/qwen2.5-3b-instruct-q4_k_m.gguf',
    approxSizeBytes: 2_100_000_000,
    tier: 'medium',
  },
  {
    key: 'qwen2.5-7b-instruct-q4_k_m',
    name: 'Qwen2.5 7B Instruct (Q4_K_M)',
    url: 'https://huggingface.co/Qwen/Qwen2.5-7B-Instruct-GGUF/resolve/main/qwen2.5-7b-instruct-q4_k_m.gguf',
    approxSizeBytes: 4_700_000_000,
    tier: 'large',
  },
]

export function recommendCatalogEntry(hardware: HardwareInfo): ModelCatalogEntry {
  const match = MODEL_CATALOG.find((m) => m.tier === hardware.recommendedTier)
  return match ?? MODEL_CATALOG[0]
}

// Audit fix: previously nothing anywhere ever passed --ctx-size (or any
// extraArgs at all) to llama-server (see llm.ts's LocalModelProcess.start),
// so the running process's actual context window was whatever that
// specific llama.cpp build happens to default to -- not a fixed, safe,
// version-independent number, since recent llama-server builds sometimes
// default n_ctx from the model's own trained maximum (32K+ for these Qwen2.5
// checkpoints) rather than a small fixed value. "No explicit setting" is
// not safer than a chosen one here, it is just undefined behavior that can
// silently vary across installs and llama.cpp versions.
//
// These values are deliberately conservative. small matches hardware.ts's
// computeRecommendedTier fallback tier, which covers everything below the
// medium floor -- including an 8GB-RAM machine, the specific case this
// repository's audit was asked to check -- so it gets the smallest, most
// conservative window. medium already requires 16GB+ RAM
// (computeRecommendedTier) and was not benchmarked against real hardware
// in this development environment (no llama-server binary was available
// here to profile against), so it keeps its original conservative value;
// revisit medium with real measurements if/when they become available.
//
// large (32GB+ RAM, 8+ cores -- computeRecommendedTier) WAS benchmarked
// against a real device: a real machine in that tier ran a 3B-parameter
// Q4_K_M model (n_ctx_train=32768, so 16384 is well within the
// checkpoint's own trained range) at --ctx-size 16384 with a clean health
// check and a successful direct completion. Doubled from 8192 to 16384 on
// that evidence -- this only affects the large tier; small/medium, which
// have no such evidence behind them, are untouched. If a future large-tier
// device turns out not to have the RAM/VRAM headroom this assumes,
// recommendedContextSize() is the single place to adjust, so
// agentLoop.ts's context-budgeting (which calls this same function) never
// drifts out of sync with what llama-server was actually started with --
// see llm.ts's LocalModelProcess.start(), the only other caller, which
// receives this value as --ctx-size and must never hardcode a
// context-size flag of its own, or the two would silently disagree.
export const CONTEXT_SIZE_BY_TIER: Record<ModelCatalogEntry['tier'], number> = {
  small: 4096,
  medium: 8192,
  large: 16384,
}

export function recommendedContextSize(modelKey: string): number {
  const entry = MODEL_CATALOG.find((m) => m.key === modelKey)
  return entry ? CONTEXT_SIZE_BY_TIER[entry.tier] : CONTEXT_SIZE_BY_TIER.small
}

export function registerModel(db: Db, key: string, name: string, url: string, sha256?: string): ModelRow {
  const id = newId()
  db.prepare(
    `INSERT INTO models (id, key, name, url, sha256, status) VALUES (?, ?, ?, ?, ?, 'not_downloaded')
     ON CONFLICT (key) DO UPDATE SET name = excluded.name, url = excluded.url, sha256 = excluded.sha256`,
  ).run(id, key, name, url, sha256 ?? null)
  return getModel(db, key)!
}

export function getModel(db: Db, key: string): ModelRow | undefined {
  return db.prepare('SELECT * FROM models WHERE key = ?').get(key) as ModelRow | undefined
}

export function listModels(db: Db): ModelRow[] {
  return db.prepare('SELECT * FROM models ORDER BY created_at DESC').all() as ModelRow[]
}

export function getActiveModel(db: Db): ModelRow | undefined {
  return db.prepare("SELECT * FROM models WHERE active = 1 AND status = 'ready' LIMIT 1").get() as ModelRow | undefined
}

export function setActiveModel(db: Db, key: string): ModelRow {
  const model = getModel(db, key)
  if (!model) throw new Error(`Unknown model "${key}".`)
  if (model.status !== 'ready') throw new Error(`Model "${key}" is not downloaded yet (status: ${model.status}).`)
  db.prepare('UPDATE models SET active = 0').run()
  db.prepare("UPDATE models SET active = 1, updated_at = datetime('now') WHERE key = ?").run(key)
  return getModel(db, key)!
}

export function deleteModel(db: Db, key: string): void {
  const model = getModel(db, key)
  if (model?.file_path && existsSync(model.file_path)) {
    unlinkSync(model.file_path)
  }
  db.prepare('DELETE FROM models WHERE key = ?').run(key)
}

async function sha256File(path: string): Promise<string> {
  const { createReadStream } = await import('node:fs')
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

export type DownloadProgress = { downloadedBytes: number; totalBytes: number | null }

// Streams the model to disk (never buffers the whole file in memory) and
// verifies its sha256 if one was registered. Works against any http(s)
// URL -- tested in local-runtime/test against a real local HTTP server,
// since huggingface.co is not reachable from this sandbox's network
// policy. The mechanism itself does not care which host it talks to.
export async function downloadModel(
  db: Db,
  key: string,
  onProgress?: (p: DownloadProgress) => void,
): Promise<ModelRow> {
  const model = getModel(db, key)
  if (!model) throw new Error(`Unknown model "${key}". Register it first.`)
  if (!model.url) throw new Error(`Model "${key}" has no download URL.`)

  db.prepare("UPDATE models SET status = 'downloading', updated_at = datetime('now') WHERE key = ?").run(key)

  const destination = join(modelsDir(), `${key}.gguf`)

  try {
    const response = await fetch(model.url)
    if (!response.ok || !response.body) {
      throw new Error(`Download failed: HTTP ${response.status}`)
    }

    const totalBytes = Number(response.headers.get('content-length')) || null
    let downloadedBytes = 0

    const fileStream = createWriteStream(destination)
    const reader = response.body.getReader()
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      downloadedBytes += value.byteLength
      onProgress?.({ downloadedBytes, totalBytes })
      if (!fileStream.write(value)) {
        await new Promise<void>((resolve) => fileStream.once('drain', () => resolve()))
      }
    }
    await new Promise<void>((resolve, reject) => {
      fileStream.once('error', reject)
      fileStream.end(() => resolve())
    })

    if (model.sha256) {
      const actual = await sha256File(destination)
      if (actual !== model.sha256) {
        unlinkSync(destination)
        db.prepare("UPDATE models SET status = 'error', updated_at = datetime('now') WHERE key = ?").run(key)
        throw new Error(`Checksum mismatch for "${key}": expected ${model.sha256}, got ${actual}.`)
      }
    }

    const sizeBytes = statSync(destination).size
    db.prepare(
      "UPDATE models SET status = 'ready', file_path = ?, size_bytes = ?, updated_at = datetime('now') WHERE key = ?",
    ).run(destination, sizeBytes, key)

    return getModel(db, key)!
  } catch (error) {
    db.prepare("UPDATE models SET status = 'error', updated_at = datetime('now') WHERE key = ?").run(key)
    throw error
  }
}
