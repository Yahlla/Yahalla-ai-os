import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CONTEXT_SIZE_BY_TIER, MODEL_CATALOG, recommendCatalogEntry, recommendedContextSize } from '../src/modelManager.js'
import type { HardwareInfo } from '../src/hardware.js'

function withTier(recommendedTier: HardwareInfo['recommendedTier']): HardwareInfo {
  return { recommendedTier } as HardwareInfo
}

test('recommendCatalogEntry picks the catalog entry matching the hardware tier', () => {
  assert.equal(recommendCatalogEntry(withTier('small')).tier, 'small')
  assert.equal(recommendCatalogEntry(withTier('medium')).tier, 'medium')
  assert.equal(recommendCatalogEntry(withTier('large')).tier, 'large')
})

// Audit fix (Phase 3, ctx-size investigation): previously nothing ever set
// --ctx-size for llama-server, leaving the actual running context window
// undefined/version-dependent. recommendedContextSize is what closes that
// gap -- these tests are the "context budgeting" verification the audit
// asked for: the weakest hardware tier (the one that includes an 8GB-RAM
// machine, computeRecommendedTier's fallback) must get the smallest,
// safest window, and every real catalog entry must resolve to a real,
// positive number, never undefined/NaN.
test('recommendedContextSize gives every real catalog model a positive, tier-appropriate context size', () => {
  for (const entry of MODEL_CATALOG) {
    const ctx = recommendedContextSize(entry.key)
    assert.ok(Number.isInteger(ctx) && ctx > 0, `expected a positive integer ctx size for ${entry.key}, got ${ctx}`)
    assert.equal(ctx, CONTEXT_SIZE_BY_TIER[entry.tier])
  }
})

test('recommendedContextSize: the weakest (small) tier gets the smallest window -- the 8GB-RAM case', () => {
  assert.ok(CONTEXT_SIZE_BY_TIER.small <= CONTEXT_SIZE_BY_TIER.medium)
  assert.ok(CONTEXT_SIZE_BY_TIER.medium <= CONTEXT_SIZE_BY_TIER.large)
  const smallModel = MODEL_CATALOG.find((m) => m.tier === 'small')!
  assert.equal(recommendedContextSize(smallModel.key), CONTEXT_SIZE_BY_TIER.small)
})

test('recommendedContextSize falls back to the safest (small) value for an unknown/custom-registered model key', () => {
  assert.equal(recommendedContextSize('some-custom-model-a-user-registered-manually'), CONTEXT_SIZE_BY_TIER.small)
})
