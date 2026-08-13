import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeRecommendedTier, detectHardware } from '../src/hardware.js'
import { MODEL_CATALOG, recommendCatalogEntry } from '../src/modelManager.js'

// Weak-hardware capability selection (Phase 8): the tiering rule itself,
// pure and unit-tested -- and proof that a weak device is never handed a
// large-model recommendation, so it can never end up pretending to run a
// model it cannot actually load.

test('computeRecommendedTier requires BOTH memory and cores to clear a tier -- neither alone is enough', () => {
  assert.equal(computeRecommendedTier(64, 2), 'small', 'huge RAM but only 2 cores must not recommend large')
  assert.equal(computeRecommendedTier(4, 16), 'small', 'many cores but only 4GB RAM must not recommend large')
})

test('computeRecommendedTier: large requires >=32GB and >=8 cores', () => {
  assert.equal(computeRecommendedTier(32, 8), 'large')
  assert.equal(computeRecommendedTier(31.9, 8), 'medium', 'just under the RAM floor falls back to medium')
  assert.equal(computeRecommendedTier(32, 7), 'medium', 'just under the core floor falls back to medium')
})

test('computeRecommendedTier: medium requires >=16GB and >=4 cores', () => {
  assert.equal(computeRecommendedTier(16, 4), 'medium')
  assert.equal(computeRecommendedTier(15.9, 4), 'small')
  assert.equal(computeRecommendedTier(16, 3), 'small')
})

test('computeRecommendedTier: a genuinely weak device (2GB, 2 cores) gets small, never anything larger', () => {
  assert.equal(computeRecommendedTier(2, 2), 'small')
})

test('detectHardware returns a real, self-consistent reading for whatever machine actually runs this test', () => {
  const hardware = detectHardware()
  assert.ok(hardware.cpuCores >= 1)
  assert.ok(hardware.totalMemoryBytes > 0)
  assert.equal(hardware.recommendedTier, computeRecommendedTier(hardware.totalMemoryBytes / 1024 ** 3, hardware.cpuCores))
  // Perception (camera/mic/GPU) is honestly reported as undetectable from
  // this Node process, never guessed -- see hardware.ts's own comment.
  assert.equal(hardware.perception.gpuDetectable, false)
  assert.equal(hardware.perception.cameraDetectable, false)
})

test('recommendCatalogEntry maps every tier to a real catalog entry of that exact tier', () => {
  for (const tier of ['small', 'medium', 'large'] as const) {
    const entry = recommendCatalogEntry({
      platform: 'test',
      arch: 'test',
      cpuModel: 'test',
      cpuCores: 1,
      totalMemoryBytes: 0,
      freeMemoryBytes: 0,
      recommendedTier: tier,
      perception: { cameraDetectable: false, microphoneDetectable: false, gpuDetectable: false, npuDetectable: false, detectVia: 'frontend (navigator.mediaDevices / navigator.gpu) or a future native platform module' },
    })
    assert.equal(entry.tier, tier)
    assert.ok(MODEL_CATALOG.includes(entry))
  }
})

test('recommendCatalogEntry never recommends a model bigger than the detected tier -- a weak device never silently gets a huge model', () => {
  const weakHardware = {
    platform: 'test',
    arch: 'test',
    cpuModel: 'test',
    cpuCores: 2,
    totalMemoryBytes: 4 * 1024 ** 3,
    freeMemoryBytes: 0,
    recommendedTier: computeRecommendedTier(4, 2),
    perception: { cameraDetectable: false, microphoneDetectable: false, gpuDetectable: false, npuDetectable: false, detectVia: 'frontend (navigator.mediaDevices / navigator.gpu) or a future native platform module' },
  } as const
  assert.equal(weakHardware.recommendedTier, 'small')
  const entry = recommendCatalogEntry(weakHardware)
  assert.equal(entry.tier, 'small')
  assert.ok(entry.approxSizeBytes < MODEL_CATALOG.find((m) => m.tier === 'large')!.approxSizeBytes)
})
