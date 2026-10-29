import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test, type TestContext } from 'node:test'
import { app, globalShortcut, type WebContents } from 'electron'
import { ExtensionCommands } from '../../src/main/commands'
import type { ProfileRuntime } from '../../src/main/profiles'
import type { Settings } from '../../src/main/settings'

app.getLocale = () => 'sk-SK'

interface FakeExt {
  id: string
  name: string
  path: string
  manifest: Record<string, unknown>
}

function ext(id: string, name: string, commands: Record<string, unknown>, extra: Record<string, unknown> = {}): FakeExt {
  return { id, name, path: mkdtempSync(path.join(tmpdir(), 'jbrow-cmd-')), manifest: { commands, ...extra } }
}

function locales(e: FakeExt, messages: Record<string, Record<string, string>>) {
  for (const [lang, msgs] of Object.entries(messages)) {
    mkdirSync(path.join(e.path, '_locales', lang), { recursive: true })
    writeFileSync(
      path.join(e.path, '_locales', lang, 'messages.json'),
      JSON.stringify(Object.fromEntries(Object.entries(msgs).map(([k, v]) => [k, { message: v }]))),
    )
  }
}

function setup(profiles: Record<string, FakeExt[]>, over: Partial<Settings> = {}) {
  const settings = { shortcuts: {}, extensionShortcuts: {}, ...over } as Settings
  const events: unknown[][] = []
  const popups: string[][] = []
  let saves = 0
  const runtimes = new Map<string, ProfileRuntime>()
  const emitters = new Map<string, EventEmitter>()
  for (const [id, exts] of Object.entries(profiles)) {
    const emitter = Object.assign(new EventEmitter(), { getAllExtensions: () => exts })
    emitters.set(id, emitter)
    runtimes.set(id, {
      session: { extensions: emitter },
      extensions: { ctx: { router: { sendEvent: (...args: unknown[]) => events.push(args) }, store: { tabDetailsCache: new Map([[5, { id: 5, url: 'https://a/' }]]) } } },
    } as unknown as ProfileRuntime)
  }
  const tab = { id: 5, isDestroyed: () => false } as unknown as WebContents
  const commands = new ExtensionCommands(() => settings, () => runtimes, {
    save: () => void saves++,
    openPopup: (p, e) => void popups.push([p, e]),
    activeTab: () => tab,
  })
  return { commands, settings, events, popups, saves: () => saves, emitters, profiles }
}

const key = (k: string, mods: Partial<Electron.Input> = {}): Electron.Input =>
  ({ type: 'keyDown', key: k, code: /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : /^\d$/.test(k) ? `Digit${k}` : k, meta: false, control: false, alt: false, shift: false, ...mods }) as Electron.Input

function quiet(t: TestContext) {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
}

test('suggested keys become shortcuts, in Chrome’s Mac syntax', () => {
  const e = ext('a', 'Alpha', {
    'toggle': { description: 'Toggle', suggested_key: { default: 'Ctrl+Shift+Y', mac: 'Command+Shift+U' } },
    'other': { description: 'Other', suggested_key: { default: 'Alt+Comma' } },
    'ctrl': { description: 'Ctrl', suggested_key: { default: 'MacCtrl+Shift+K' } },
    'none': { description: 'No key' },
    '_execute_action': { suggested_key: { default: 'Ctrl+Shift+E' } },
  })
  const { commands } = setup({ p: [e] })
  assert.deepEqual(
    commands.list('p').map((c) => [c.name, c.shortcut, c.description]),
    [
      ['toggle', 'Command+Shift+U', 'Toggle'],
      ['other', 'Alt+,', 'Other'],
      ['ctrl', 'Control+Shift+K', 'Ctrl'],
      ['none', '', 'No key'],
      ['_execute_action', 'Command+Shift+E', 'Open the extension'],
    ],
  )
})

test('a suggestion gets no key that jbrow or someone else already holds', () => {
  const a = ext('a', 'A', { x: { suggested_key: { default: 'Ctrl+T' } }, y: { suggested_key: { default: 'Ctrl+1' } }, z: { suggested_key: { default: 'Ctrl+Shift+K' } } })
  const b = ext('b', 'B', { w: { suggested_key: { default: 'Ctrl+Shift+K' } }, v: { suggested_key: { default: 'Ctrl+Shift+J' } } })
  const c = ext('c', 'C', {})
  const { commands } = setup({ p: [a, b, c] }, { extensionShortcuts: { p: { c: { mine: 'Command+Shift+J' } } } } as Partial<Settings>)
  const byName = Object.fromEntries(commands.list('p').map((x) => [x.name, x.shortcut]))
  // ⌘T is jbrow's new tab, ⌘1 is fixed, ⇧⌘K went to the first to ask, ⇧⌘J is yours.
  assert.deepEqual(byName, { x: '', y: '', z: 'Command+Shift+K', w: '', v: '' })
})

test('a key jbrow no longer uses is free for suggestions after refresh', () => {
  const a = ext('a', 'A', { x: { suggested_key: { default: 'Ctrl+T' } } })
  const { commands, settings } = setup({ p: [a] })
  assert.equal(commands.list('p')[0].shortcut, '')
  settings.shortcuts = { newTab: 'Command+N' }
  assert.equal(commands.list('p')[0].shortcut, '')
  commands.refresh()
  assert.equal(commands.list('p')[0].shortcut, 'Command+T')
})

test('global commands may only suggest ⇧⌘0–9', () => {
  const a = ext('a', 'A', {
    ok: { global: true, suggested_key: { default: 'Ctrl+Shift+5' } },
    greedy: { global: true, suggested_key: { default: 'Ctrl+Shift+L' } },
  })
  const { commands } = setup({ p: [a] })
  assert.deepEqual(commands.list('p').map((c) => [c.name, c.shortcut, c.global]), [['ok', 'Command+Shift+5', true], ['greedy', '', true]])
})

test('names and descriptions are localized, falling back to the default language', () => {
  const sk = ext('a', '__MSG_appName__', { x: { description: '__MSG_cmdDesc__' }, y: { description: '__MSG_missing__' } }, { default_locale: 'en' })
  locales(sk, { sk: { appname: 'Rozšírenie' }, en: { appName: 'Extension', cmdDesc: 'Do it' } })
  const en = ext('b', '__MSG_name__', { x: { description: '__MSG_desc__' } }, { default_locale: 'en' })
  locales(en, { en: { name: 'English only', desc: 'Described' } })
  const { commands } = setup({ p: [sk, en] })
  assert.deepEqual(
    commands.list('p').map((c) => [c.extensionName, c.description]),
    [
      // Slovak has the name but not the description, which stays as written.
      ['Rozšírenie', '__MSG_cmdDesc__'],
      ['Rozšírenie', '__MSG_missing__'],
      ['English only', 'Described'],
    ],
  )
})

test('a key press runs the command in the active tab', (t) => {
  quiet(t)
  const a = ext('a', 'A', { go: { suggested_key: { default: 'Ctrl+Shift+Y' } }, _execute_action: { suggested_key: { default: 'Alt+P' } } })
  const { commands, events, popups } = setup({ p: [a] })
  assert.equal(commands.handleKey('p', key('y', { meta: true, shift: true })), true)
  assert.deepEqual(events, [['a', 'commands.onCommand', 'go', { id: 5, url: 'https://a/' }]])
  assert.equal(commands.handleKey('p', key('p', { alt: true })), true)
  assert.deepEqual(popups, [['p', 'a']])
  assert.equal(commands.handleKey('p', key('y', { meta: true })), false)
  assert.equal(commands.handleKey('p', key('y', { meta: true, shift: true, type: 'keyUp' })), false)
  assert.equal(commands.handleKey(undefined, key('y', { meta: true, shift: true })), false)
  assert.equal(commands.handleKey('nobody', key('y', { meta: true, shift: true })), false)
  assert.equal(events.length, 1)
})

test('global commands aren’t run by key presses in the panel', () => {
  const a = ext('a', 'A', { g: { global: true, suggested_key: { default: 'Ctrl+Shift+1' } } })
  const { commands, events } = setup({ p: [a] })
  assert.equal(commands.handleKey('p', key('1', { meta: true, shift: true })), false)
  assert.deepEqual(events, [])
})

test('a command runs with no tab details when the tab is gone', (t) => {
  quiet(t)
  const a = ext('a', 'A', { go: {} })
  const { commands, events } = setup({ p: [a] })
  commands.run(commands.list('p')[0], { id: 5, isDestroyed: () => true } as unknown as WebContents)
  assert.deepEqual(events, [['a', 'commands.onCommand', 'go', undefined]])
})

test('set refuses keys that are taken and says by whom', () => {
  const a = ext('a', 'Alpha', { x: { description: 'Do X', suggested_key: { default: 'Ctrl+Shift+X' } } })
  const b = ext('b', 'Beta', { y: { description: 'Do Y' } })
  const { commands, saves } = setup({ p: [a, b] })
  assert.equal(commands.set('p', 'b', 'y', 'Command+C'), 'jbrow uses that shortcut itself.')
  assert.equal(commands.set('p', 'b', 'y', 'Command+L'), 'jbrow uses that shortcut for "Address bar".')
  assert.equal(commands.set('p', 'b', 'y', 'Command+Shift+X'), 'Alpha already uses that shortcut for "Do X".')
  // A command may keep its own key.
  assert.equal(commands.set('p', 'a', 'x', 'Command+Shift+X'), null)
  assert.equal(saves(), 1)
})

test('set saves your key and takes it from suggestions', () => {
  const a = ext('a', 'Alpha', { x: { suggested_key: { default: 'Ctrl+Shift+X' } } })
  const b = ext('b', 'Beta', { y: {} })
  const { commands, settings } = setup({ p: [a, b] })
  assert.equal(commands.set('p', 'b', 'y', 'Command+Shift+Y'), null)
  assert.deepEqual(settings.extensionShortcuts, { p: { b: { y: 'Command+Shift+Y' } } })
  assert.equal(commands.list('p').find((c) => c.name === 'y')?.shortcut, 'Command+Shift+Y')
  // '' removes a key, including a suggested one.
  assert.equal(commands.set('p', 'a', 'x', ''), null)
  assert.equal(commands.list('p').find((c) => c.name === 'x')?.shortcut, '')
})

test('holder finds a shortcut in any profile', () => {
  const a = ext('a', 'A', { x: { suggested_key: { default: 'Ctrl+Shift+X' } } })
  const b = ext('b', 'B', { y: { suggested_key: { default: 'Ctrl+Shift+Y' } } })
  const { commands } = setup({ p: [a], q: [b] })
  assert.equal(commands.holder('Command+Shift+Y')?.profile, 'q')
  assert.equal(commands.holder('Command+Shift+Z'), undefined)
  assert.deepEqual(commands.list('gone'), [])
})

test('extensions coming and going clear the cache', () => {
  const list: FakeExt[] = []
  const { commands, emitters } = setup({ p: list })
  commands.watch()
  assert.deepEqual(commands.list('p'), [])
  list.push(ext('a', 'A', { x: {} }))
  assert.deepEqual(commands.list('p'), [])
  emitters.get('p')!.emit('extension-loaded')
  assert.equal(commands.list('p').length, 1)
  list.pop()
  emitters.get('p')!.emit('extension-unloaded')
  assert.deepEqual(commands.list('p'), [])
})

test('global commands register their keys once, and say when another app has one', (t) => {
  quiet(t)
  if (process.env.JBROW_BACKGROUND) return t.skip('global shortcuts are off in background mode')
  const registered: string[] = []
  const unregistered: string[] = []
  t.mock.method(globalShortcut, 'register', (accel: string) => {
    registered.push(accel)
    return accel !== 'Command+Shift+2'
  })
  t.mock.method(globalShortcut, 'unregister', (accel: string) => void unregistered.push(accel))
  const a = ext('a', 'A', { g: { global: true, suggested_key: { default: 'Ctrl+Shift+1' } }, h: { global: true, suggested_key: { default: 'Ctrl+Shift+2' } }, local: { suggested_key: { default: 'Ctrl+Shift+3' } } })
  const { commands } = setup({ p: [a] })
  commands.registerGlobal()
  assert.deepEqual(registered, ['Command+Shift+1', 'Command+Shift+2'])
  commands.unregisterGlobal()
  assert.deepEqual(unregistered, ['Command+Shift+1'])
})
