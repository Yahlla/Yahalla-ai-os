import assert from 'node:assert/strict'
import { test } from 'node:test'
import { computeTier } from '../src/lib/capabilities.ts'

test('low memory alone is enough to classify as weak', () => {
  assert.equal(computeTier(2, 8), 'weak')
})

test('low core count alone is enough to classify as weak', () => {
  assert.equal(computeTier(8, 2), 'weak')
})

test('high memory and high cores classify as strong', () => {
  assert.equal(computeTier(8, 8), 'strong')
})

test('mid-range values (above weak floor, below strong floor) classify as mid', () => {
  assert.equal(computeTier(4, 4), 'mid')
})

test('a device that just clears both strong thresholds is strong, not mid', () => {
  assert.equal(computeTier(8, 8), 'strong')
  assert.equal(computeTier(7.9, 8), 'mid')
  assert.equal(computeTier(8, 7), 'mid')
})

test('a device right at the weak boundary (2GB, 2 cores) is weak', () => {
  assert.equal(computeTier(2, 2), 'weak')
})

test('just above the weak boundary is not weak', () => {
  assert.equal(computeTier(3, 3), 'mid')
})
