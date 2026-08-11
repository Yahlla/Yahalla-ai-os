const EMBEDDING_DIMENSIONS = 384

// Storing/searching a vector is cheap linear algebra pgvector's index does
// -- this module never computes an embedding itself, only validates and
// serializes one the caller (browser/local-runtime) already computed on
// their own device. That split is what keeps this genuinely appropriate
// for a resource-modest coordination server: no model ever runs here.
export function validateEmbedding(value: unknown): number[] {
  if (!Array.isArray(value) || value.length !== EMBEDDING_DIMENSIONS) {
    throw new Error(`embedding must be an array of exactly ${EMBEDDING_DIMENSIONS} numbers.`)
  }
  for (const n of value) {
    if (typeof n !== 'number' || !Number.isFinite(n)) {
      throw new Error('embedding must contain only finite numbers.')
    }
  }
  return value as number[]
}

// node-pg has no built-in awareness of pgvector's `vector` type -- the
// documented way to pass one through the driver is this bracketed literal
// text format, cast to ::vector in the SQL itself.
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`
}
