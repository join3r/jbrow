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

test('cssEase writes each curve’s own control points', () => {
  for (const [name, points] of Object.entries(EASE)) {
    assert.equal(cssEase(name as keyof typeof EASE), `cubic-bezier(${points.join(',')})`)
  }
})

test('bezier clamps outside 0..1', () => {
  for (const curve of Object.values(EASE)) {
    assert.equal(bezier(curve, -1), 0)
    assert.equal(bezier(curve, 0), 0)
    assert.equal(bezier(curve, 1), 1)
    assert.equal(bezier(curve, 2), 1)
  }
})

test('bezier on a straight curve is linear', () => {
  for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) assert.ok(Math.abs(bezier([0, 0, 1, 1], t) - t) < 1e-6)
})

test('bezier matches CSS ease', () => {
  // cubic-bezier(.25,.1,.25,1) at t = 0.5, as browsers compute it.
  assert.ok(Math.abs(bezier([0.25, 0.1, 0.25, 1], 0.5) - 0.8024033877) < 1e-5)
})

test('smooth and snappy only grow and stay within 0..1', () => {
  for (const curve of [EASE.smooth, EASE.snappy]) {
    let prev = 0
    for (let i = 1; i <= 100; i++) {
      const y = bezier(curve, i / 100)
      assert.ok(y >= prev - 1e-9 && y <= 1 + 1e-9)
      prev = y
    }
  }
})

test('spring overshoots past 1 before settling', () => {
  const ys = Array.from({ length: 99 }, (_, i) => bezier(EASE.spring, (i + 1) / 100))
  assert.ok(Math.max(...ys) > 1)
  assert.equal(bezier(EASE.spring, 1), 1)
})
