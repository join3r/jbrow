// The settings screen's changes ('prefs'): what the state says, what settings.json keeps, and
// what a relaunch reads back. Also settings.json files that are broken or from older versions.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, test } from 'node:test'
import { CMD, launch, removeDir, tempDir, waitFor, type Jbrow } from './harness'
import { offline } from './ui-helpers'

const running: Jbrow[] = []
const dirs: string[] = []
after(async () => {
  for (const jb of running) await jb.close()
  for (const dir of dirs) await removeDir(dir)
})

async function start(opts: Parameters<typeof launch>[0] = {}) {
  const jb = await launch(opts)
  running.push(jb)
  return jb
}

const saved = (jb: Jbrow) => JSON.parse(readFileSync(jb.file('settings.json'), 'utf8'))

test('prefs change the state and settings.json, and survive a relaunch', async () => {
  const userData = tempDir()
  dirs.push(userData)
  // Codex can only be picked once jbrow finds its command, and CI machines don't have one: any
  // file that exists will do, since nothing restyles here.
  let jb = await start({ userData, settings: { ...offline(), restyle: { codexPath: process.execPath } } })
  await jb.waitForState((s) => s.restyleAgents.codex, 'jbrow to find codex')
  await jb.send('prefs', {
    appearance: 'dark',
    theme: 'ocean',
    profileStyle: 'solid',
    animation: { style: 'fade', durationMs: 250, ease: 'smooth' },
    privateUrls: ['  intranet.example  ', '', '*.corp.example'],
    quietLinks: false,
    blockThirdPartyCookies: false,
    archiveAfterDays: 14,
    summarizeAfterDays: 0,
    earlierAfterHours: 6,
    pinnedRows: 2,
    numberFrom: 'kept',
    restyleAgent: 'codex',
    restyleCodexModel: '  o4  ',
    keepLoaded: { kept: true },
    miniPlayer: { onHide: false, sites: 'except', exceptSites: [' music.example ', ''] },
    searchUrl: 'http://127.0.0.1:9/find?q=%s',
    zoom: { defaultPercent: 125 },
  })
  const s = await jb.waitForState((s) => s.prefs.theme === 'ocean', 'the new prefs')
  const p = s.prefs
  assert.equal(p.appearance, 'dark')
  assert.equal(p.profileStyle, 'solid')
  assert.deepEqual(p.animation, { style: 'fade', durationMs: 250, ease: 'smooth' })
  // Patterns are trimmed and empty lines dropped.
  assert.deepEqual(p.privateUrls, ['intranet.example', '*.corp.example'])
  assert.equal(p.quietLinks, false)
  assert.equal(p.blockThirdPartyCookies, false)
  assert.equal(p.archiveAfterDays, 14)
  assert.equal(p.summarizeAfterDays, 0)
  assert.equal(p.earlierAfterHours, 6)
  assert.equal(p.pinnedRows, 2)
  assert.equal(p.numberFrom, 'kept')
  assert.equal(p.restyleAgent, 'codex')
  assert.equal(p.restyleCodexModel, 'o4')
  assert.deepEqual(p.keepLoaded, { kept: true, pinned: true })
  assert.equal(p.miniPlayer.onHide, false)
  assert.equal(p.miniPlayer.sites, 'except')
  assert.deepEqual(p.miniPlayer.exceptSites, ['music.example'])
  assert.equal(p.searchUrl, 'http://127.0.0.1:9/find?q=%s')
  assert.equal(p.zoom.defaultPercent, 125)
  // Blocking third-party cookies changes at the next launch; this run keeps what it started with.
  assert.equal(s.thirdPartyCookiesBlocked, true)

  const file = saved(jb)
  assert.equal(file.theme, 'ocean')
  assert.equal(file.appearance, 'dark')
  assert.deepEqual(file.privateUrls, ['intranet.example', '*.corp.example'])
  assert.equal(file.restyle.agent, 'codex')
  assert.equal(file.restyle.codexModel, 'o4')
  assert.equal(file.zoom.defaultPercent, 125)
  assert.equal(file.searchUrl, 'http://127.0.0.1:9/find?q=%s')

  await jb.quit()
  jb = await start({ userData })
  const again = (await jb.state()).prefs
  assert.deepEqual(again, p)
  assert.equal((await jb.state()).thirdPartyCookiesBlocked, false)
})

test('prefs that make no sense are ignored, the rest still apply', async () => {
  const jb = await start({ settings: offline() })
  const before = (await jb.state()).prefs
  await jb.send('prefs', {
    appearance: 'purple',
    theme: 'nope',
    profileStyle: 'stripes',
    numberFrom: 'middle',
    searchUrl: 'not a search address',
    zoom: { defaultPercent: 123 },
    pinnedRows: 0,
    earlierAfterHours: -5,
    archiveAfterDays: -1,
    // The one change that is fine.
    quietLinks: !before.quietLinks,
  })
  const p = (await jb.waitForState((s) => s.prefs.quietLinks !== before.quietLinks, 'the valid change')).prefs
  assert.equal(p.appearance, before.appearance)
  assert.equal(p.theme, before.theme)
  assert.equal(p.profileStyle, before.profileStyle)
  assert.equal(p.numberFrom, before.numberFrom)
  assert.equal(p.searchUrl, before.searchUrl)
  assert.equal(p.zoom.defaultPercent, before.zoom.defaultPercent)
  // Numbers out of range are clamped rather than refused.
  assert.equal(p.pinnedRows, 1)
  assert.equal(p.earlierAfterHours, 1)
  assert.equal(p.archiveAfterDays, 0)
  assert.equal(saved(jb).theme, before.theme)
})

test('a settings.json that is not JSON starts jbrow with the defaults', async () => {
  const userData = tempDir()
  dirs.push(userData)
  const jb = await start({ userData, files: { 'settings.json': '{ "theme": "ocean", oops' } })
  const s = await jb.state()
  assert.equal(s.prefs.theme, 'teal')
  assert.ok(s.profiles.length >= 1)
  assert.ok(s.profiles.some((p) => p.id === s.prefs.defaultProfile))
  // The first change writes a good file again.
  await jb.send('prefs', { theme: 'moss' })
  await waitFor(() => {
    try {
      return saved(jb).theme === 'moss'
    } catch {
      return false
    }
  }, 'a valid settings.json')
})

test('an older settings.json is brought up to date', async () => {
  const userData = tempDir()
  dirs.push(userData)
  const old = {
    // From before the welcome, the summon keys under "hotkeys", only the window fractions, fewer
    // restyle keys, and values no longer allowed.
    hotkeys: { all: 'Alt+Shift+J', app: 'Alt+Shift+K' },
    panel: { widthFraction: 0.5, heightFraction: 0.6 },
    restyle: { model: 'opus' },
    zoom: { defaultPercent: 110 },
    theme: 'neon',
    appearance: 'sepia',
    profileStyle: 'zigzag',
    numberFrom: 7,
    pinnedRows: -3,
    openApps: 'nope',
    sidePanelWidth: 'wide',
    ...offline(),
  }
  const jb = await start({ userData, files: { 'settings.json': JSON.stringify(old) } })
  const s = await jb.state()
  assert.equal(s.keys.show, 'Alt+Shift+J')
  assert.equal(s.keys.showApp, 'Alt+Shift+K')
  assert.equal(s.prefs.theme, 'teal')
  assert.equal(s.prefs.appearance, 'system')
  assert.equal(s.prefs.profileStyle, 'tint')
  assert.equal(s.prefs.numberFrom, 'today')
  assert.equal(s.prefs.pinnedRows, 1)
  assert.deepEqual(s.prefs.openApps, [])
  assert.equal(s.prefs.restyleModel, 'opus')
  assert.equal(s.prefs.restyleAgent, 'claude')
  assert.deepEqual(s.prefs.zoom, { defaultPercent: 110, remember: true })
  // Someone with settings from before the welcome knows jbrow already.
  const ui = await jb.ui()
  assert.equal(await ui.eval('document.getElementById("welcome").hidden'), true)

  // The next save writes it all out in the current shape.
  await jb.send('prefs', { quietLinks: false })
  await waitFor(() => saved(jb).quietLinks === false, 'settings.json to be saved')
  const file = saved(jb)
  assert.equal(file.welcomed, true)
  assert.equal(file.shortcuts.show, 'Alt+Shift+J')
  assert.equal(file.panel.widthFraction, 0.5)
  assert.deepEqual(file.panel.displays, {})
  assert.equal(file.panel.pinned, null)
  assert.equal(file.sidePanelWidth, 360)
  assert.deepEqual(file.zoom.sites, {})
})

test('a first launch writes the default settings.json', async () => {
  const userData = tempDir()
  dirs.push(userData)
  // No settings.json at all; launch() only adds one when asked for settings.
  const jb = await start({ userData })
  const file = saved(jb)
  assert.ok(Array.isArray(file.profiles) && file.profiles.length >= 1)
  assert.equal(typeof file.welcomed, 'boolean')
  const s = await jb.state()
  assert.equal(s.prefs.theme, file.theme)
  assert.equal(s.prefs.defaultProfile, file.defaultProfile)
})

test('the address bar layout is picked from its pictures, and open suggestions follow at once', async () => {
  const jb = await start({ settings: offline() })
  const ui = await jb.ui()
  await jb.send('focus-ui')
  await ui.eval('omnibox.focus()')
  await ui.type('a')
  const layout = () => ui.eval<string>('document.getElementById("suggest").hidden ? "" : document.getElementById("suggest").dataset.layout')
  await waitFor(async () => (await layout()) === 'columns', 'the columns layout')
  await jb.send('prefs', { urlBarStyle: 'preview' })
  await waitFor(async () => (await layout()) === 'preview', 'the open suggestions in the preview layout')
  await ui.press('Escape')

  await ui.press(',', { modifiers: CMD })
  await waitFor(() => ui.eval('document.querySelector("#urlBarStyle [data-value=preview]")?.getAttribute("aria-pressed") === "true"'), 'preview pressed in settings')
  assert.equal(await ui.eval('document.querySelectorAll("#urlBarStyle img").length'), 2)
  await ui.eval('document.querySelector("#urlBarStyle [data-value=columns]").click()')
  await jb.waitForState((s) => s.prefs.urlBarStyle === 'columns', 'the columns layout again')
  await waitFor(() => saved(jb).urlBarStyle === 'columns', 'settings.json to have it')
})
