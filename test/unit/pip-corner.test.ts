import assert from 'node:assert/strict'
import { test } from 'node:test'
import { freeCorner } from '../../src/main/pip-corner'

// A 1440×900 work area under a 30 pt menu bar, and a mini player 20 pt from its bottom right.
const area = { x: 0, y: 30, width: 1440, height: 870 }
const pip = { x: 1100, y: 680, width: 320, height: 200 }

test('the mini player stays put when the window in front is clear of it', () => {
  assert.equal(freeCorner(pip, { x: 0, y: 30, width: 800, height: 870 }, area), null)
})

test('it crosses to the other side, keeping its gaps to the edges', () => {
  // The right half of the screen.
  assert.deepEqual(freeCorner(pip, { x: 720, y: 30, width: 720, height: 870 }, area), { x: 20, y: 680 })
})

test('it goes up when the window covers the bottom of the screen', () => {
  assert.deepEqual(freeCorner(pip, { x: 0, y: 500, width: 1440, height: 400 }, area), { x: 1100, y: 50 })
})

test('it goes to the far corner when that one covers least of the window', () => {
  // Below and right of (200, 200): the top left corner only clips its top left.
  assert.deepEqual(freeCorner(pip, { x: 200, y: 200, width: 1240, height: 700 }, area), { x: 20, y: 50 })
})

test('a window covering every corner leaves it where it is', () => {
  assert.equal(freeCorner(pip, area, area), null)
})

test('of corners covering as much, it takes the one across', () => {
  // The bottom left and top left both cover a 40 pt strip of it.
  assert.deepEqual(freeCorner(pip, { x: 300, y: 30, width: 1140, height: 870 }, area), { x: 20, y: 680 })
})
