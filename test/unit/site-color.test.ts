import assert from 'node:assert/strict'
import { test } from 'node:test'
import { edgeColor, type Rgb } from '../../src/main/site-color'

const navy: Rgb = [20, 27, 48]

test('one color across the top is the bar color', () => {
  assert.equal(edgeColor([navy, navy, navy, navy, navy]), '#141b30')
})

test('slight differences, as from rounding or antialiasing, still count as one color', () => {
  assert.equal(edgeColor([navy, [24, 30, 52], navy, [18, 25, 46], navy]), '#141b30')
})

test('two colors across the top are none', () => {
  assert.equal(edgeColor([navy, navy, [255, 255, 255], navy, navy]), null)
})

test('a point where a picture or gradient shows means none', () => {
  assert.equal(edgeColor([navy, null, navy, navy, navy]), null)
})

test('a page that could not be looked at has none', () => {
  assert.equal(edgeColor(null), null)
  assert.equal(edgeColor([]), null)
})
