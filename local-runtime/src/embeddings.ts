// A deterministic, dependency-free, fully local text embedding -- hashes
// character n-grams into a fixed-length vector (the "hashing trick", a
// real, well-established lightweight technique used by systems like
// Vowpal Wabbit and scikit-learn's HashingVectorizer). Chosen deliberately
// over a downloaded neural embedding model: it needs no model download and
// no network call of any kind, so it works identically on every device the
// instant local-runtime starts, with zero setup and zero external
// dependency -- consistent with this runtime's "local-first, nothing
// leaves the device unless explicitly configured" design.
//
// The real, disclosed trade-off: this captures lexical/vocabulary overlap
// well (good at "have I dealt with this file, error, or decision before"),
// not deep conceptual similarity between differently-worded text the way a
// trained neural embedding model would. platform-api's /memory endpoints
// only require *a* 384-number vector from the caller (see memory.ts's
// EMBEDDING_DIMENSIONS) -- swapping this for a real neural embedding later
// (e.g. a small ONNX model) is a drop-in replacement of embedText() alone,
// nothing else in the pipeline needs to change.
export const EMBEDDING_DIMENSIONS = 384

export function embedText(text: string): number[] {
  const vector = new Array(EMBEDDING_DIMENSIONS).fill(0)
  const normalized = text.toLowerCase().replace(/[^a-z0-9؀-ۿ\s]/g, ' ')
  const tokens = normalized.split(/\s+/).filter(Boolean)

  for (const token of tokens) {
    for (let n = 2; n <= 4; n++) {
      for (let i = 0; i + n <= token.length; i++) {
        const gram = token.slice(i, i + n)
        const h = hash32(gram)
        const idx = h % EMBEDDING_DIMENSIONS
        const sign = h & 1 ? 1 : -1
        vector[idx] += sign
      }
    }
    // Whole-token hash too, so short tokens (acronyms, IDs) still register.
    const h = hash32(token)
    vector[h % EMBEDDING_DIMENSIONS] += (h & 1 ? 1 : -1) * 2
  }

  return normalizeVector(vector)
}

// FNV-1a, a small, fast, well-known non-cryptographic hash -- deterministic
// across runs and platforms, which is all that matters here (no security
// property required, just a stable bucket assignment).
function hash32(s: string): number {
  let h = 2166136261
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function normalizeVector(v: number[]): number[] {
  const magnitude = Math.sqrt(v.reduce((sum, x) => sum + x * x, 0)) || 1
  return v.map((x) => x / magnitude)
}

export function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i]! * b[i]!
  return dot
}
