import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { ACTIONS, actionKeys, canonical, FIXED, isGlobal, shortcutFromKey, shortcutLabel, type ActionId } from '../../src/shared/shortcuts'

const press = (key: string, code: string, mods: { command?: boolean; control?: boolean; alt?: boolean; shift?: boolean } = {}) =>
  shortcutFromKey({ key, code, ...mods })

describe('canonical', () => {
  test('modifiers in one order whatever order they were given', () => {
    assert.equal(canonical({ shift: true, command: true }, 'L'), 'Command+Shift+L')
    assert.equal(canonical({ alt: true, shift: true, control: true, command: true }, 'K'), 'Command+Control+Alt+Shift+K')
    assert.equal(canonical({ control: true }, 'Tab'), 'Control+Tab')
  })

  test('no modifiers is just the key; false ones are left out', () => {
    assert.equal(canonical({}, 'MediaPlayPause'), 'MediaPlayPause')
    assert.equal(canonical({ command: false, shift: false, alt: true }, 'Space'), 'Alt+Space')
  })
})

describe('shortcutFromKey', () => {
  test('a letter with ⌘', () => {
    assert.equal(press('t', 'KeyT', { command: true }), 'Command+T')
    assert.equal(press('L', 'KeyL', { command: true, shift: true }), 'Command+Shift+L')
  })

  test('letters follow the layout: Z on a Slovak keyboard is Z', () => {
    assert.equal(press('z', 'KeyY', { command: true }), 'Command+Z')
    assert.equal(press('y', 'KeyZ', { command: true }), 'Command+Y')
  })

  test('with ⌥ the Mac types a symbol, so the key’s position decides', () => {
    assert.equal(press('å', 'KeyA', { alt: true }), 'Alt+A')
    assert.equal(press('∂', 'KeyD', { alt: true, command: true }), 'Command+Alt+D')
    assert.equal(press('Dead', 'KeyN', { alt: true }), 'Alt+N')
  })

  test('a non-Latin letter takes the key’s position', () => {
    assert.equal(press('ф', 'KeyA', { command: true }), 'Command+A')
  })

  test('digits come from the key’s position, whatever shift types', () => {
    assert.equal(press('1', 'Digit1', { command: true }), 'Command+1')
    assert.equal(press('!', 'Digit1', { command: true, shift: true }), 'Command+Shift+1')
    assert.equal(press('+', 'Digit1', { command: true }), 'Command+1')
  })

  test('punctuation from the typed key where the layout has it, else the US key in its place', () => {
    assert.equal(press('[', 'BracketLeft', { command: true }), 'Command+[')
    assert.equal(press('[', 'Digit5', { command: true, alt: true }), 'Command+Alt+[')
    assert.equal(press('ú', 'BracketLeft', { command: true }), 'Command+[')
    assert.equal(press(',', 'Comma', { command: true }), 'Command+,')
    assert.equal(press('\\', 'Backslash', { control: true }), 'Control+\\')
    assert.equal(press('+', 'Equal', { command: true, shift: true }), 'Command+Shift+=')
    assert.equal(press('-', 'Minus', { command: true }), 'Command+-')
  })

  test('named keys', () => {
    assert.equal(press(' ', 'Space', { alt: true }), 'Alt+Space')
    assert.equal(press('Tab', 'Tab', { control: true }), 'Control+Tab')
    assert.equal(press('ArrowLeft', 'ArrowLeft', { command: true, control: true }), 'Command+Control+Left')
    assert.equal(press('Delete', 'Delete', { command: true }), 'Command+Delete')
  })

  test('needs ⌘, ⌃ or ⌥', () => {
    assert.equal(press('a', 'KeyA'), null)
    assert.equal(press('A', 'KeyA', { shift: true }), null)
    assert.equal(press(' ', 'Space'), null)
    assert.equal(press('[', 'BracketLeft'), null)
  })

  test('media keys work alone', () => {
    assert.equal(press('MediaPlayPause', 'MediaPlayPause'), 'MediaPlayPause')
    assert.equal(press('MediaTrackNext', 'MediaTrackNext'), 'MediaNextTrack')
    assert.equal(press('MediaTrackPrevious', 'MediaTrackPrevious'), 'MediaPreviousTrack')
    assert.equal(press('MediaStop', 'MediaStop', { shift: true }), 'Shift+MediaStop')
  })

  test('keys it can’t name, or a modifier on its own, make none', () => {
    assert.equal(press('F1', 'F1', { command: true }), null)
    assert.equal(press('Meta', 'MetaLeft', { command: true }), null)
    assert.equal(press('Shift', 'ShiftLeft', { command: true, shift: true }), null)
    assert.equal(press('Enter', 'Enter', { command: true }), null)
    assert.equal(press('', '', { command: true }), null)
  })
})

describe('shortcutLabel', () => {
  test('writes it as a Mac menu does, modifiers in ⌃⌥⇧⌘ order', () => {
    assert.equal(shortcutLabel('Command+Shift+L'), '⇧⌘L')
    assert.equal(shortcutLabel('Command+Control+Alt+Shift+K'), '⌃⌥⇧⌘K')
    assert.equal(shortcutLabel('Command+Alt+I'), '⌥⌘I')
    assert.equal(shortcutLabel('Alt+Space'), '⌥Space')
    assert.equal(shortcutLabel('Command+Control+Left'), '⌃⌘←')
    assert.equal(shortcutLabel('Command+,'), '⌘,')
    assert.equal(shortcutLabel('Command+['), '⌘[')
  })

  test('glyphs for named keys', () => {
    assert.equal(shortcutLabel('Alt+Up'), '⌥↑')
    assert.equal(shortcutLabel('Command+PageDown'), '⌘⇟')
    assert.equal(shortcutLabel('Command+Delete'), '⌘⌦')
    assert.equal(shortcutLabel('MediaPlayPause'), '⏯')
  })

  test('a lone key or nothing', () => {
    assert.equal(shortcutLabel('A'), 'A')
    assert.equal(shortcutLabel(''), '')
  })
})

describe('ACTIONS', () => {
  test('ids are unique', () => {
    assert.equal(new Set(ACTIONS.map((a) => a.id)).size, ACTIONS.length)
  })

  test('default keys are distinct', () => {
    assert.equal(new Set(ACTIONS.map((a) => a.key)).size, ACTIONS.length)
  })

  test('default keys are canonical, so they compare equal to a recorded press', () => {
    for (const { key } of ACTIONS) {
      const parts = key.split('+')
      const k = parts.pop()!
      const mods = { command: parts.includes('Command'), control: parts.includes('Control'), alt: parts.includes('Alt'), shift: parts.includes('Shift') }
      assert.equal(canonical(mods, k), key)
    }
  })

  test('no default takes a fixed key', () => {
    for (const { id, key } of ACTIONS) assert.ok(!FIXED.has(key), `${id} uses fixed ${key}`)
  })

  test('isGlobal: only show and showApp', () => {
    assert.equal(isGlobal('show'), true)
    assert.equal(isGlobal('showApp'), true)
    assert.equal(isGlobal('newTab'), false)
    assert.deepEqual(
      ACTIONS.filter((a) => isGlobal(a.id)).map((a) => a.id),
      ['show', 'showApp'],
    )
    assert.equal(isGlobal('nope' as ActionId), false)
  })
})

describe('actionKeys', () => {
  test('defaults for every action', () => {
    const keys = actionKeys({})
    assert.equal(Object.keys(keys).length, ACTIONS.length)
    for (const a of ACTIONS) assert.equal(keys[a.id], a.key)
  })

  test('yours where you set one, including none', () => {
    const keys = actionKeys({ newTab: 'Command+Shift+Y', show: '' })
    assert.equal(keys.newTab, 'Command+Shift+Y')
    assert.equal(keys.show, '')
    assert.equal(keys.closeTab, 'Command+W')
  })
})

describe('FIXED', () => {
  test('⌘1–9, zoom and the edit and app menus', () => {
    for (const k of '123456789') assert.ok(FIXED.has(`Command+${k}`))
    for (const k of ['Command+A', 'Command+C', 'Command+V', 'Command+X', 'Command+Z', 'Command+Shift+Z', 'Command+Q', 'Command+H'])
      assert.ok(FIXED.has(k), k)
    for (const k of ['Command+=', 'Command+-', 'Command+0', 'Command+Shift+=']) assert.ok(FIXED.has(k), k)
  })

  test('the zoom keys a press records are the fixed ones', () => {
    assert.ok(FIXED.has(press('=', 'Equal', { command: true })!))
    assert.ok(FIXED.has(press('+', 'Equal', { command: true, shift: true })!))
    assert.ok(FIXED.has(press('-', 'Minus', { command: true })!))
    assert.ok(FIXED.has(press('0', 'Digit0', { command: true })!))
  })

  test('other keys are free', () => {
    assert.ok(!FIXED.has('Command+T'))
    assert.ok(!FIXED.has('Command+Alt+1'))
    assert.ok(!FIXED.has('Command+Shift+1'))
  })
})
