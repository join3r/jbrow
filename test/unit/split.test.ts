import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { dragDivider, MAX_PANES, MIN_PANE, PANE_GAP, paneSpans, splitOf } from '../../src/shared/split'
import type { Split } from '../../src/shared/types'

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0)
const close = (a: number, b: number, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≈ ${b}`)

describe('paneSpans', () => {
  test('two equal panes split the room around one gap', () => {
    assert.deepEqual(paneSpans(1000, [1, 1]), [
      { x: 0, width: 496 },
      { x: 496 + PANE_GAP, width: 496 },
    ])
  })

  test('a single pane fills the width', () => {
    assert.deepEqual(paneSpans(777, [3]), [{ x: 0, width: 777 }])
  })

  test('panes and gaps fill the width exactly, with whole pixels', () => {
    for (const width of [300, 801, 1013, 1999]) {
      for (const sizes of [[1, 2], [1, 1, 1], [0.3, 0.3, 0.4], [5, 1, 1, 3], [1 / 3, 1 / 3, 1 / 3]]) {
        const spans = paneSpans(width, sizes)
        assert.equal(spans.length, sizes.length)
        for (const s of spans) {
          assert.ok(Number.isInteger(s.x) && Number.isInteger(s.width))
          assert.ok(s.width >= 0)
        }
        spans.forEach((s, i) => i && assert.equal(s.x, spans[i - 1].x + spans[i - 1].width + PANE_GAP))
        const last = spans.at(-1)!
        assert.equal(last.x + last.width, width)
      }
    }
  })

  test('widths follow the sizes’ proportions', () => {
    const [a, b] = paneSpans(PANE_GAP + 300, [1, 2])
    assert.equal(a.width, 100)
    assert.equal(b.width, 200)
  })

  test('only proportions matter', () => {
    assert.deepEqual(paneSpans(1000, [1, 3]), paneSpans(1000, [0.25, 0.75]))
  })

  test('all-zero sizes don’t divide by zero', () => {
    const spans = paneSpans(1000, [0, 0])
    for (const s of spans) assert.ok(Number.isFinite(s.x) && Number.isFinite(s.width))
  })

  test('narrower than the gaps leaves panes with no width', () => {
    const spans = paneSpans(4, [1, 1, 1])
    for (const s of spans) assert.equal(s.width, 0)
  })

  test('no panes, no spans', () => {
    assert.deepEqual(paneSpans(1000, []), [])
  })

  test('MAX_PANES panes fit', () => {
    assert.equal(MAX_PANES, 4)
    assert.equal(paneSpans(1200, Array(MAX_PANES).fill(1)).length, MAX_PANES)
  })
})

describe('dragDivider', () => {
  const W = 1208

  test('dropping the divider where it is changes nothing', () => {
    const sizes = [1, 1]
    const [a] = paneSpans(W, sizes)
    const next = dragDivider(W, sizes, 0, a.x + a.width + PANE_GAP / 2)
    close(next[0], 1)
    close(next[1], 1)
  })

  test('moves the divider to x, keeping the pair’s share', () => {
    const sizes = [0.5, 0.5]
    const next = dragDivider(W, sizes, 0, 400 + PANE_GAP / 2)
    close(sum(next), 1)
    assert.equal(paneSpans(W, next)[0].width, 400)
  })

  test('only the two panes beside the divider change', () => {
    const sizes = [1, 1, 1, 1]
    const next = dragDivider(W, sizes, 1, 500)
    assert.equal(next[0], 1)
    assert.equal(next[3], 1)
    close(next[1] + next[2], 2)
    assert.notEqual(next[1], 1)
  })

  test('neither pane goes below MIN_PANE', () => {
    const sizes = [1, 1]
    const left = paneSpans(W, dragDivider(W, sizes, 0, -500))
    const right = paneSpans(W, dragDivider(W, sizes, 0, 5000))
    assert.equal(left[0].width, MIN_PANE)
    assert.equal(right[1].width, MIN_PANE)
  })

  test('panes sharing less than twice MIN_PANE stop at half each', () => {
    const w = 300 + PANE_GAP
    const next = dragDivider(w, [1, 1], 0, 0)
    close(next[0], next[1])
  })

  test('a divider that doesn’t exist leaves the sizes alone', () => {
    const sizes = [1, 1]
    assert.equal(dragDivider(W, sizes, 1, 300), sizes)
    assert.equal(dragDivider(W, sizes, -1, 300), sizes)
    assert.equal(dragDivider(W, [1], 0, 300).length, 1)
  })

  test('doesn’t change the sizes it was given', () => {
    const sizes = [1, 2, 3]
    dragDivider(W, sizes, 0, 100)
    assert.deepEqual(sizes, [1, 2, 3])
  })
})

describe('splitOf', () => {
  const splits: Split[] = [
    { id: 's1', tabs: ['a', 'b'], sizes: [1, 1] },
    { id: 's2', tabs: ['c', 'd', 'e'], sizes: [1, 1, 1] },
  ]

  test('finds the split a tab is in', () => {
    assert.equal(splitOf(splits, 'a'), splits[0])
    assert.equal(splitOf(splits, 'e'), splits[1])
  })

  test('none for other tabs or no tab', () => {
    assert.equal(splitOf(splits, 'z'), undefined)
    assert.equal(splitOf(splits, null), undefined)
    assert.equal(splitOf(splits, undefined), undefined)
    assert.equal(splitOf(splits, ''), undefined)
    assert.equal(splitOf([], 'a'), undefined)
  })
})
