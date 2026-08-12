import { embedText } from './embeddings.js'

export type MemorySearchResult = {
  id: string
  content: string
  source: string
  similarity: number
  created_at: string
}

export type MemoryEndpoint = { platformApiUrl?: string; deviceToken?: string }

// Cross-device project memory (task: "Vector DB Integration"): the
// embedding is computed locally (embeddings.js), platform-api only ever
// stores/searches vectors, never sees raw model weights or runs one
// itself. Fails soft (empty results / no-op) whenever this device isn't
// paired -- see devicePairing.ts -- so a message never blocks on this.
export async function searchMemory(config: MemoryEndpoint, query: string, limit = 5): Promise<MemorySearchResult[]> {
  if (!config.platformApiUrl || !config.deviceToken || !query.trim()) return []
  try {
    const response = await fetch(`${trimTrailingSlash(config.platformApiUrl)}/memory/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.deviceToken}` },
      body: JSON.stringify({ embedding: embedText(query), limit }),
    })
    if (!response.ok) return []
    const data = (await response.json()) as { results?: MemorySearchResult[] }
    return data.results ?? []
  } catch {
    return []
  }
}

export async function storeMemory(config: MemoryEndpoint, content: string, source: string): Promise<void> {
  if (!config.platformApiUrl || !config.deviceToken || !content.trim()) return
  try {
    await fetch(`${trimTrailingSlash(config.platformApiUrl)}/memory`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.deviceToken}` },
      body: JSON.stringify({ content, source, embedding: embedText(content) }),
    }).catch(() => {})
  } catch {
    // best-effort -- a missed memory write never fails the chat it came from
  }
}

function trimTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}
