import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, test } from 'node:test'
import { userData } from '../mocks/electron'
import { loadSettings, saveSettings, scopeForApp, settingsPath, type Settings } from '../../src/main/settings'

const write = (data: unknown) => writeFileSync(settingsPath(), typeof data === 'string' ? data : JSON.stringify(data))
const quiet = <T>(fn: () => T): T => {
  const error = console.error
  console.error = () => {}
  try {
    return fn()
  } finally {
    console.error = error
  }
}

beforeEach(() => rmSync(settingsPath(), { force: true }))

test('settings.json lives in userData', () => {
  assert.equal(settingsPath(), path.join(userData, 'settings.json'))
})

test('first run writes the defaults and returns them', () => {
  const s = loadSettings()
  assert.ok(existsSync(settingsPath()))
  assert.deepEqual(JSON.parse(readFileSync(settingsPath(), 'utf8')), s)
  assert.equal(s.welcomed, false)
  assert.equal(s.searchUrl, 'https://www.google.com/search?q=%s')
  assert.ok(s.profiles.some((p) => p.id === s.defaultProfile))
})

test('a fresh install after the first run is still unwelcomed', () => {
  loadSettings()
  // index.ts reads settings twice at launch: once for the cookie switch, then for real.
  assert.equal(loadSettings().welcomed, false)
})

test('corrupt JSON falls back to defaults without touching the file', () => {
  write('{"theme": "ocean",')
  const s = quiet(() => loadSettings())
  assert.equal(s.theme, 'teal')
  assert.equal(readFileSync(settingsPath(), 'utf8'), '{"theme": "ocean",')
})

test('JSON that is not an object falls back to defaults', () => {
  for (const text of ['null', '42', '"settings"']) {
    write(text)
    const s = quiet(() => loadSettings())
    assert.equal(s.theme, 'teal', text)
    assert.ok(Array.isArray(s.profiles), text)
  }
})

test('missing keys take their defaults and old settings count as welcomed', () => {
  write({ theme: 'ocean' })
  const s = loadSettings()
  assert.equal(s.theme, 'ocean')
  assert.equal(s.appearance, 'system')
  assert.equal(s.welcomed, true)
  assert.deepEqual(s.zoom, { defaultPercent: 100, remember: true, sites: {} })
  assert.equal(s.restyle.agent, 'claude')
})

test('an explicit welcomed is kept', () => {
  write({ welcomed: false })
  assert.equal(loadSettings().welcomed, false)
  write({ welcomed: true })
  assert.equal(loadSettings().welcomed, true)
})

test('nested objects from older versions gain their new keys', () => {
  write({
    restyle: { model: 'opus' },
    miniPlayer: { onHide: false },
    zoom: { defaultPercent: 125 },
    keepLoaded: { kept: true },
  })
  const s = loadSettings()
  assert.deepEqual(s.restyle, { enabled: false, agent: 'claude', model: 'opus', codexModel: '', claudePath: '', codexPath: '' })
  assert.equal(s.miniPlayer.onHide, false)
  assert.equal(s.miniPlayer.sites, 'all')
  assert.deepEqual(s.miniPlayer.onlySites, [])
  assert.deepEqual(s.zoom, { defaultPercent: 125, remember: true, sites: {} })
  assert.deepEqual(s.keepLoaded, { kept: true, pinned: true })
})

test('loaded settings never share objects with the defaults', () => {
  // Old settings without these keys; mutating what one load returns must not leak into the next.
  write({ theme: 'ocean' })
  const a = loadSettings()
  a.zoom.sites['example.com'] = 150
  a.miniPlayer.onlySites.push('youtube.com')
  a.miniPlayer.exceptSites.push('vimeo.com')
  a.panel.displays['1'] = { x: 0, y: 0, width: 10, height: 10 }
  a.restyle.model = 'opus'
  a.profiles.push({ id: 'x', name: 'X', color: '#000' })
  a.linkedApps[0].push('com.example')
  a.appProfiles['com.example'] = 'work'
  const b = loadSettings()
  assert.deepEqual(b.zoom.sites, {})
  assert.deepEqual(b.miniPlayer.onlySites, [])
  assert.deepEqual(b.miniPlayer.exceptSites, [])
  assert.deepEqual(b.panel.displays, {})
  assert.equal(b.restyle.model, 'sonnet')
  assert.equal(b.profiles.length, 2)
  assert.equal(b.linkedApps[0].length, 2)
  assert.equal(b.appProfiles['com.example'], undefined)
  rmSync(settingsPath())
  // And the first-run file still holds the real defaults.
  const c = loadSettings()
  assert.deepEqual(c.zoom.sites, {})
  assert.deepEqual(JSON.parse(readFileSync(settingsPath(), 'utf8')).zoom.sites, {})
})

test('old panel settings with only fractions get empty places', () => {
  write({ panel: { widthFraction: 0.5, heightFraction: 0.6 } })
  const s = loadSettings()
  assert.deepEqual(s.panel, { widthFraction: 0.5, heightFraction: 0.6, displays: {}, pinned: null })
})

test('panel places that are not rectangles are dropped', () => {
  const good = { x: -1440, y: 25, width: 800, height: 600 }
  write({
    panel: {
      widthFraction: 0.7,
      heightFraction: 0.7,
      displays: { '1': good, '2': { x: 1, y: 2, width: 3 }, '3': null, '4': 'left', '5': { x: '1', y: 2, width: 3, height: 4 }, '6': { x: 0, y: 0, width: null, height: 1 } },
      pinned: { x: 0, y: 0, width: 100, height: Infinity },
    },
  })
  const s = loadSettings()
  assert.deepEqual(s.panel.displays, { '1': good })
  assert.equal(s.panel.pinned, null)
})

test('panel displays that are not an object are dropped', () => {
  for (const displays of [null, 'abc', 5, []]) {
    write({ panel: { widthFraction: 0.7, heightFraction: 0.7, displays, pinned: good() } })
    const s = loadSettings()
    assert.deepEqual(s.panel.displays, {}, JSON.stringify(displays))
    assert.deepEqual(s.panel.pinned, good())
  }
  function good() {
    return { x: 10, y: 20, width: 300, height: 400 }
  }
})

test('invalid enum and number values fall back to defaults', () => {
  write({
    pinnedRows: 0,
    numberFrom: 'everything',
    newTabsAt: 'middle',
    openApps: 'com.apple.Terminal',
    sidePanelWidth: 'wide',
    appearance: 'sepia',
    theme: 'neon',
    profileStyle: 'stripes',
  })
  const s = loadSettings()
  assert.equal(s.pinnedRows, 1)
  assert.equal(s.numberFrom, 'today')
  assert.equal(s.newTabsAt, 'top')
  assert.deepEqual(s.openApps, [])
  assert.equal(s.sidePanelWidth, 360)
  assert.equal(s.appearance, 'system')
  assert.equal(s.theme, 'teal')
  assert.equal(s.profileStyle, 'tint')
})

test('pinnedRows must be a positive integer', () => {
  for (const [value, expected] of [[2, 2], [1.5, 1], [-3, 1], ['2', 1], [null, 1]] as const) {
    write({ pinnedRows: value })
    assert.equal(loadSettings().pinnedRows, expected, String(value))
  }
})

test('valid enum values are kept', () => {
  write({ numberFrom: 'kept', appearance: 'dark', theme: 'ocean', profileStyle: 'solid', sidePanelWidth: 420, openApps: ['a'] })
  const s = loadSettings()
  assert.equal(s.numberFrom, 'kept')
  assert.equal(s.appearance, 'dark')
  assert.equal(s.theme, 'ocean')
  assert.equal(s.profileStyle, 'solid')
  assert.equal(s.sidePanelWidth, 420)
  assert.deepEqual(s.openApps, ['a'])
})

test('old hotkeys become the show and showApp shortcuts', () => {
  write({ hotkeys: { all: 'Alt+J', app: 'Alt+Shift+J' } })
  const s = loadSettings()
  assert.deepEqual(s.shortcuts, { show: 'Alt+J', showApp: 'Alt+Shift+J' })
  assert.equal('hotkeys' in s, false)
})

test('shortcuts already set win over old hotkeys', () => {
  write({ hotkeys: { all: 'Alt+J', app: 'Alt+Shift+J' }, shortcuts: { show: '', newTab: 'Command+N' } })
  const s = loadSettings()
  assert.deepEqual(s.shortcuts, { show: '', showApp: 'Alt+Shift+J', newTab: 'Command+N' })
})

test('unicode survives a save and load', () => {
  const s = loadSettings()
  s.profiles[0].name = 'Práca 💼'
  s.privateUrls = ['*.bücher.de', 'пример.рф']
  saveSettings(s)
  const again = loadSettings()
  assert.equal(again.profiles[0].name, 'Práca 💼')
  assert.deepEqual(again.privateUrls, ['*.bücher.de', 'пример.рф'])
})

test('saveSettings writes what loadSettings reads back', () => {
  const s = loadSettings()
  s.theme = 'graphite' as Settings['theme']
  s.zoom.sites['localhost:3000'] = 150
  s.panel.pinned = { x: 1, y: 2, width: 3, height: 4 }
  s.welcomed = true
  saveSettings(s)
  assert.deepEqual(loadSettings(), s)
})

test('scopeForApp is the app itself unless it is in a linked group', () => {
  const s = loadSettings()
  s.linkedApps = [['com.microsoft.VSCode', 'com.apple.Terminal'], ['b.app', 'a.app', 'c.app']]
  assert.equal(scopeForApp(s, 'com.tinyspeck.slackmacgap'), 'com.tinyspeck.slackmacgap')
  assert.equal(scopeForApp(s, 'com.apple.Terminal'), 'com.apple.Terminal+com.microsoft.VSCode')
  assert.equal(scopeForApp(s, 'com.microsoft.VSCode'), 'com.apple.Terminal+com.microsoft.VSCode')
  // Every app in a group gets the same key, whatever order the group was saved in.
  assert.equal(scopeForApp(s, 'c.app'), 'a.app+b.app+c.app')
  assert.deepEqual(s.linkedApps[1], ['b.app', 'a.app', 'c.app'])
})

test('scopeForApp with no linked groups', () => {
  const s = loadSettings()
  s.linkedApps = []
  assert.equal(scopeForApp(s, 'com.apple.Safari'), 'com.apple.Safari')
  assert.equal(scopeForApp(s, ''), '')
})

test('restyling is off by default, and stays on for older settings with restyled sites', () => {
  const styles = path.join(path.dirname(settingsPath()), 'styles.json')
  rmSync(styles, { force: true })
  write({ restyle: { model: 'opus' } })
  assert.equal(loadSettings().restyle.enabled, false)
  writeFileSync(styles, JSON.stringify({ 'a.com': { enabled: true, changes: [{ prompt: 'x', css: 'a{}', note: '', at: 1 }] } }))
  assert.equal(loadSettings().restyle.enabled, true)
  // An explicit choice wins.
  write({ restyle: { enabled: false } })
  assert.equal(loadSettings().restyle.enabled, false)
  rmSync(styles)
  rmSync(settingsPath())
})
