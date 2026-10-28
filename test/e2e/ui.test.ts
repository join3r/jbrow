// jbrow's UI page as a whole: it loads and runs without errors through a session, draws
// something, and follows the appearance, theme and profile style settings.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { CMD, html, launch, serve, sleep, waitFor, type Cdp, type Jbrow, type TestServer } from './harness'
import { activeTab, isShown, offline, openTab, pngSize, record, settle } from './ui-helpers'

let jb: Jbrow
let web: TestServer
/** Errors the UI page threw or logged. */
const errors: string[] = []

/**
 * Known noise, not jbrow's errors: <browser-action-list> (electron-chrome-extensions) asks the
 * UI's own session for its extensions as the page loads, before the first state tells it a
 * profile's partition, and logs that it couldn't.
 */
const KNOWN = [/^console\.error: browser-action-list failed to update \[tab: null, partition: 'null'\]$/]

before(async () => {
  web = await serve({
    '/': html('Page one', '<p>one apple</p>'),
    '/two': html('Page two', '<p>two apples</p>'),
    '/file': { headers: { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="f.txt"' }, body: 'f' },
  })
  jb = await launch({ settings: offline(web) })
  const ui = await jb.ui()
  ui.on('Runtime.exceptionThrown', (p) => add(`exception: ${p.exceptionDetails?.exception?.description ?? p.exceptionDetails?.text}`))
  const add = (e: string) => KNOWN.some((k) => k.test(e)) || errors.push(e)
  ui.on('Runtime.consoleAPICalled', (p) => {
    if (p.type === 'error' || p.type === 'assert') add(`console.${p.type}: ${p.args.map((a: { value?: unknown; description?: string }) => a.value ?? a.description).join(' ')}`)
  })
  // Failed loads are left out: a page without a favicon is a 404 for its icon in the sidebar.
  ui.on('Log.entryAdded', (p) => {
    if (p.entry.level === 'error' && p.entry.source !== 'network') add(`log: ${p.entry.text} ${p.entry.url ?? ''}`)
  })
  await ui.send('Runtime.enable')
  await ui.send('Log.enable')
})
after(async () => {
  await jb?.close()
  await web?.close()
})

const darkScheme = (ui: Cdp) => ui.eval<boolean>('matchMedia("(prefers-color-scheme: dark)").matches')

test('the UI loads again without errors', async () => {
  const ui = await jb.ui()
  await ui.send('Page.enable')
  await ui.send('Page.reload')
  await waitFor(() => ui.eval('document.readyState === "complete" && !!window.jbrow'), 'the UI to load again')
  // The reload took the harness's listeners with it.
  await ui.eval(`(() => {
    window.__toasts = []
    window.jbrow.on('state', (s) => { window.__state = s })
    window.jbrow.on('toast', (t) => window.__toasts.push(t))
  })()`)
  await waitFor(() => ui.eval('!!window.__state || (window.jbrow.send("ready"), false)'), 'a state after the reload')
  assert.deepEqual(errors, [])
})

test('a session of ordinary use logs no errors in the UI', async () => {
  const ui = await jb.ui()
  await openTab(jb, `${web.url}/`)
  await openTab(jb, `${web.url}/two`)
  // The address bar and its suggestions.
  await jb.send('focus-ui')
  await ui.eval('omnibox.focus()')
  await ui.type('page')
  await waitFor(() => isShown(ui, 'suggest'), 'the suggestions')
  await ui.press('Escape')
  // Find.
  await ui.press('f', { modifiers: CMD })
  await waitFor(() => isShown(ui, 'find'), 'the find bar')
  await ui.type('apple')
  await ui.press('Escape')
  // Settings, every section.
  await ui.press(',', { modifiers: CMD })
  await waitFor(() => isShown(ui, 'settings'), 'settings')
  const sections = await ui.eval<string[]>('[...document.querySelectorAll(".set-nav-item")].map((b) => b.dataset.section)')
  assert.ok(sections.length >= 5)
  for (const section of sections) {
    await ui.call((s) => document.querySelector<HTMLElement>(`.set-nav-item[data-section="${s}"]`)!.click(), section)
  }
  await jb.send('shortcuts')
  await jb.send('apps')
  await ui.press(',', { modifiers: CMD })
  await waitFor(async () => !(await isShown(ui, 'settings')), 'settings to close')
  // A download, and a toast.
  const downloads = await record(jb, 'downloads')
  await jb.send('new')
  await jb.waitForState((s) => !!activeTab(s) && !activeTab(s)!.url, 'an empty tab')
  await jb.send('navigate', { input: `${web.url}/file` })
  await downloads.waitFor((l: { state: string }[]) => l.some((d) => d.state === 'completed'), 'the download')
  await jb.send('set-action-key', { id: 'show', shortcut: '' })
  await waitFor(async () => (await jb.toasts()).length > 0, 'a toast')
  await settle(jb)
  assert.deepEqual(errors, [])
})

test('a screenshot of the UI is not blank', async () => {
  const ui = await jb.ui()
  const png = await ui.screenshot()
  const { width, height } = pngSize(png)
  assert.ok(width > 200 && height > 200, `${width}×${height}`)
  // A blank window compresses to almost nothing.
  assert.ok(png.length > 5000, `${png.length} bytes`)
})

test('appearance follows the setting, for the UI and for pages', async () => {
  const ui = await jb.ui()
  await openTab(jb, `${web.url}/?scheme`)
  const page = await jb.page(`${web.url}/?scheme`)
  for (const appearance of ['dark', 'light', 'dark'] as const) {
    await jb.send('prefs', { appearance })
    await jb.waitForState((s) => s.prefs.appearance === appearance, appearance)
    await waitFor(async () => (await darkScheme(ui)) === (appearance === 'dark'), `the UI to be ${appearance}`)
    await waitFor(async () => (await darkScheme(page)) === (appearance === 'dark'), `the page to be ${appearance}`)
  }
  page.close()
})

test('the theme and profile style show on the UI', async () => {
  const ui = await jb.ui()
  const accent = () => ui.eval<string>('getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()')
  await jb.send('prefs', { theme: 'teal', profileStyle: 'tint' })
  await waitFor(() => ui.eval('document.documentElement.dataset.theme === "teal"'), 'teal')
  const teal = await accent()
  await jb.send('prefs', { theme: 'ember', profileStyle: 'solid' })
  await waitFor(() => ui.eval('document.documentElement.dataset.theme === "ember"'), 'ember')
  assert.equal(await ui.eval('document.documentElement.dataset.profileStyle'), 'solid')
  assert.notEqual(await accent(), teal, 'the accent color changes with the theme')
})

test('the settings screen changes the theme and appearance', async () => {
  const ui = await jb.ui()
  await ui.press(',', { modifiers: CMD })
  await waitFor(() => isShown(ui, 'settings'), 'settings')
  await ui.call(() => document.querySelector<HTMLElement>('.set-nav-item[data-section="appearance"]')!.click())
  await ui.call(() => document.querySelector<HTMLElement>('#themes [data-value="violet"]')!.click())
  await jb.waitForState((s) => s.prefs.theme === 'violet', 'violet from settings')
  await waitFor(() => ui.eval('document.documentElement.dataset.theme === "violet"'), 'the UI in violet')
  await ui.call(() => document.querySelector<HTMLElement>('#appearance [data-value="light"]')!.click())
  await jb.waitForState((s) => s.prefs.appearance === 'light', 'light from settings')
  await waitFor(async () => !(await darkScheme(ui)), 'the UI to be light')
  assert.equal(jb.readJson('settings.json').theme, 'violet')
  await ui.press(',', { modifiers: CMD })
  await waitFor(async () => !(await isShown(ui, 'settings')), 'settings to close')
  assert.deepEqual(errors, [])
})

test('the UI page never navigates away or opens windows, as a dropped link would make it', async () => {
  const ui = await jb.ui()
  const page = await ui.eval<string>('location.href')
  await ui.eval(`window.open(${JSON.stringify(web.url)}); location.href = ${JSON.stringify(web.url)}`)
  await sleep(1000)
  await settle(jb)
  assert.equal(await ui.eval('location.href'), page)
  assert.equal(await ui.eval('typeof window.jbrow?.send'), 'function')
})
