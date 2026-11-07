import assert from 'node:assert/strict'
import { test } from 'node:test'
import { isClickAway } from '../../src/main/panel'

// The panel started to show 5 s ago.
const shownFor = 5

test('a click outside the panel is a click-away', () => {
  assert.equal(isClickAway({ click: 0.15, key: 30 }, shownFor, false), true)
})

test('a key press, such as ⌘Tab, is a click-away', () => {
  assert.equal(isClickAway({ click: 30, key: 0.15 }, shownFor, true), true)
})

test('an app that takes the focus with no click or key press is not', () => {
  assert.equal(isClickAway({ click: 12, key: 4 }, shownFor, false), false)
})

test('a click on the panel itself is not, when another app takes the focus right after it', () => {
  assert.equal(isClickAway({ click: 0.2, key: 30 }, shownFor, true), false)
})

test('the hotkey or the click that showed the panel is not', () => {
  // The panel started to show 0.3 s ago; the hotkey came just before that.
  assert.equal(isClickAway({ click: 30, key: 0.32 }, 0.3, false), false)
  assert.equal(isClickAway({ click: 0.32, key: 30 }, 0.3, false), false)
})
