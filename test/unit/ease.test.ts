import assert from 'node:assert/strict'
import { test } from 'node:test'
import { bezier, cssEase, EASE } from '../../src/shared/ease'

test('bezier starts at 0 and ends at 1', () => {
  for (const curve of Object.values(EASE)) {
    assert.ok(Math.abs(bezier(curve, 0)) < 1e-6)
    assert.ok(Math.abs(bezier(curve, 1) - 1) < 1e-6)
  }
})

test('cssEase writes a cubic-bezier()', () => {
  assert.match(cssEase('smooth' as never), /^cubic-bezier\([-\d.]+,[-\d.]+,[-\d.]+,[-\d.]+\)$/)
})
