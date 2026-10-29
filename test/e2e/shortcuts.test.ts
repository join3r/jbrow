// jbrow's own keys, pressed in its UI and in a page: ⌘ on macOS, Ctrl on Windows and Linux.
// Also changing a key in settings ('set-action-key') and the errors for keys that can't be had.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { CMD, CTRL, html, launch, serve, SHIFT, waitFor, type Cdp, type Jbrow, type TestServer } from './harness'
import { activeTab, focusedId, isShown, offline, openTab } from './ui-helpers'

let jb: Jbrow
let web: TestServer
let loads = 0

before(async () => {
  web = await serve({
    '/a': html('Page A', '<p>alpha</p>'),
    '/b': html('Page B', '<p>beta</p>'),
    '/c': html('Page C', '<p>gamma</p>'),
    '/count': (_req, res) => {
      loads++
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
      res.end(html(`Load ${loads}`))
    },
  })
  jb = await launch({ settings: offline(web) })
})
after(async () => {
  await jb?.close()
  await web?.close()
})

const press = (target: Cdp, key: string, modifiers = CMD) => target.press(key, { modifiers })
const tabCount = async () => (await jb.state()).tabs.length

/** The active tab's page, once it's loaded `url`. */
async function activePage(url: string) {
  return jb.page((t) => t.url === url)
}

test('⌘T in the UI opens a new tab and puts the keyboard in the address bar', async () => {
  const ui = await jb.ui()
  await openTab(jb, `${web.url}/a`)
  const before = await tabCount()
  await press(ui, 't')
  const s = await jb.waitForState((s) => s.tabs.length === before + 1 && !activeTab(s)?.url, 'a new empty tab')
  assert.equal(activeTab(s)!.url, '')
  await waitFor(async () => (await focusedId(ui)) === 'omnibox', 'the address bar to have focus')
})

test('⌘W in the UI closes the active tab', async () => {
  const ui = await jb.ui()
  const t = await openTab(jb, `${web.url}/b`)
  await press(ui, 'w')
  await jb.waitForState((s) => !s.tabs.some((x) => x.id === t.id), 'the tab to close')
})

test('⌘T and ⌘W pressed in a page work as in the UI', async () => {
  const t = await openTab(jb, `${web.url}/c`)
  const page = await activePage(`${web.url}/c`)
  const before = await tabCount()
  await press(page, 't')
  await jb.waitForState((s) => s.tabs.length === before + 1 && !activeTab(s)?.url, 'a new tab from the page')
  // Back to the page, and close it from there.
  await jb.send('activate', { id: t.id })
  await jb.waitForState((s) => s.activeId === t.id, 'the page tab to be active again')
  page.close()
  const again = await activePage(`${web.url}/c`)
  // The page goes on the key going down, so its key going up has nowhere to go.
  await press(again, 'w').catch(() => {})
  await jb.waitForState((s) => !s.tabs.some((x) => x.id === t.id), 'the page to close')
})

test('⌘L in a page focuses the address bar', async () => {
  const ui = await jb.ui()
  await openTab(jb, `${web.url}/a`)
  const page = await activePage(`${web.url}/a`)
  await ui.eval('document.activeElement?.blur()')
  await press(page, 'l')
  await waitFor(async () => (await focusedId(ui)) === 'omnibox', 'the address bar to have focus')
  // It shows the page's address, selected, ready to type over.
  const { value, selected } = await ui.eval<{ value: string; selected: string }>(
    '({ value: omnibox.value, selected: omnibox.value.slice(omnibox.selectionStart, omnibox.selectionEnd) })',
  )
  assert.equal(value, `${web.url}/a`)
  assert.equal(selected, value)
  await ui.press('Escape')
  page.close()
})

test('⌘1–9 switch to the threads in sidebar order', async () => {
  const ui = await jb.ui()
  // Fresh threads: the newest is at the top of Today, so ⌘1 is the last one opened.
  const c = await openTab(jb, `${web.url}/c?n`)
  const b = await openTab(jb, `${web.url}/b?n`)
  const a = await openTab(jb, `${web.url}/a?n`)
  const order = await ui.call(() => [...document.querySelectorAll<HTMLElement>('#threads .row[data-id]')].map((r) => r.dataset.id!))
  for (const [i, id] of order.slice(0, 3).entries()) {
    await press(ui, String(i + 1))
    await jb.waitForState((s) => s.activeId === id, `⌘${i + 1} to pick row ${i + 1}`)
  }
  assert.deepEqual(order.slice(0, 3), [a.id, b.id, c.id])
})

test('⌘R reloads the page', async () => {
  const ui = await jb.ui()
  await openTab(jb, `${web.url}/count`)
  const first = loads
  await jb.waitForState((s) => activeTab(s)?.title === `Load ${first}`, 'the first load')
  await press(ui, 'r')
  await jb.waitForState((s) => activeTab(s)?.title === `Load ${first + 1}` && !activeTab(s)!.loading, 'a reload from the UI')
  const page = await activePage(`${web.url}/count`)
  await press(page, 'r')
  await jb.waitForState((s) => activeTab(s)?.title === `Load ${first + 2}` && !activeTab(s)!.loading, 'a reload from the page')
  page.close()
})

test('⌘[ and ⌘] go back and forward', async () => {
  const ui = await jb.ui()
  const t = await openTab(jb, `${web.url}/a?hist`)
  await jb.send('navigate', { input: `${web.url}/b?hist` })
  await jb.waitForState((s) => activeTab(s)?.url === `${web.url}/b?hist` && !activeTab(s)!.loading && s.nav.canGoBack, 'the second page')
  await press(ui, '[')
  await jb.waitForState((s) => s.activeId === t.id && activeTab(s)?.url === `${web.url}/a?hist` && !activeTab(s)!.loading, 'back to the first page')
  const page = await activePage(`${web.url}/a?hist`)
  await press(page, ']')
  await jb.waitForState((s) => activeTab(s)?.url === `${web.url}/b?hist` && !activeTab(s)!.loading, 'forward again')
  page.close()
})

test('⌘F opens the find bar for a page, Escape closes it', async () => {
  const ui = await jb.ui()
  await openTab(jb, `${web.url}/a?find`)
  const page = await activePage(`${web.url}/a?find`)
  await press(page, 'f')
  await waitFor(() => isShown(ui, 'find'), 'the find bar')
  await waitFor(async () => (await focusedId(ui)) === 'findInput', 'the find field to have focus')
  await ui.press('Escape')
  await waitFor(async () => !(await isShown(ui, 'find')), 'the find bar to close')
  page.close()
})

test('⌃Tab goes back to the previous tab', async () => {
  const ui = await jb.ui()
  const a = await openTab(jb, `${web.url}/a?prev`)
  const b = await openTab(jb, `${web.url}/b?prev`)
  await jb.waitForState((s) => s.activeId === b.id, 'the second tab')
  await ui.press('Tab', { modifiers: CTRL })
  await jb.waitForState((s) => s.activeId === a.id, '⌃Tab to go to the previous tab')
})

test('a key set in settings works and the old one stops working', async () => {
  const ui = await jb.ui()
  await jb.send('set-action-key', { id: 'newTab', shortcut: 'Command+Shift+Y' })
  await jb.waitForState((s) => s.keys.newTab === 'Command+Shift+Y', 'the new key in the state')
  assert.equal(jb.readJson('settings.json').shortcuts.newTab, 'Command+Shift+Y')

  await openTab(jb, `${web.url}/a?keys`)
  const before = await tabCount()
  await press(ui, 't')
  await press(ui, 'y', CMD | SHIFT)
  await jb.waitForState((s) => s.tabs.length === before + 1 && !activeTab(s)?.url, 'a new tab from the new key')
  // ⌘T made none: one tab more, not two.
  assert.equal(await tabCount(), before + 1)

  // Setting the default again leaves settings.json without an entry.
  await jb.send('set-action-key', { id: 'newTab', shortcut: 'Command+T' })
  await jb.waitForState((s) => s.keys.newTab === 'Command+T', 'the default key back')
  await waitFor(() => jb.readJson('settings.json').shortcuts.newTab === undefined, 'the key to leave settings.json')
})

test('a key you take off a command does nothing', async () => {
  const ui = await jb.ui()
  await jb.send('set-action-key', { id: 'reload', shortcut: '' })
  await jb.waitForState((s) => s.keys.reload === '', 'reload without a key')
  await openTab(jb, `${web.url}/count`)
  const s = await jb.waitForState((s) => /^Load \d+$/.test(activeTab(s)?.title ?? ''), 'the page')
  const title = activeTab(s)!.title
  const before = loads
  await press(ui, 'r')
  // Something that does happen, to be sure the key before it was handled.
  await press(ui, 't')
  await jb.waitForState((x) => !activeTab(x)?.url, 'the new tab')
  assert.equal(loads, before)
  assert.ok((await jb.state()).tabs.some((t) => t.title === title))
  await jb.send('set-action-key', { id: 'reload', shortcut: 'Command+R' })
  await jb.waitForState((s) => s.keys.reload === 'Command+R', 'reload back on ⌘R')
})

test("keys that can't be had are refused with a toast", async () => {
  const cases: [string, string, RegExp][] = [
    ['newTab', 'Command+L', /"Address bar" already uses that shortcut/],
    ['newTab', 'Command+1', /jbrow keeps that shortcut/],
    ['reload', 'Command+=', /jbrow keeps that shortcut/],
    ['show', '', /Show jbrow needs a shortcut/],
  ]
  for (const [id, shortcut, message] of cases) {
    const seen = (await jb.toasts()).length
    await jb.send('set-action-key', { id, shortcut })
    const toast = await waitFor(async () => (await jb.toasts()).slice(seen).find((t) => message.test(String(t))), `the toast for ${id} = ${shortcut}`)
    assert.match(String(toast), message)
  }
  const s = await jb.state()
  assert.equal(s.keys.newTab, 'Command+T')
  assert.equal(s.keys.reload, 'Command+R')
  assert.equal(s.keys.show, 'Alt+Space')
  assert.deepEqual(jb.readJson('settings.json').shortcuts, {})
  // The UI shows the toast too.
  const ui = await jb.ui()
  await waitFor(async () => /Show jbrow needs a shortcut/.test(await ui.eval('document.getElementById("toast").textContent')), 'the toast on screen')
})

test('a key of yours with Control is matched as it is, before Ctrl counts as ⌘', async () => {
  const ui = await jb.ui()
  // Off macOS, Ctrl+Shift+T would otherwise be ⌘⇧T, reopen closed tab.
  await jb.send('set-action-key', { id: 'newTab', shortcut: 'Control+Shift+T' })
  await jb.waitForState((s) => s.keys.newTab === 'Control+Shift+T', 'the Control key')
  await openTab(jb, `${web.url}/a?ctrl`)
  const before = await tabCount()
  await ui.press('t', { modifiers: CTRL | SHIFT })
  await jb.waitForState((s) => s.tabs.length === before + 1 && !activeTab(s)?.url, 'a new tab from ⌃⇧T')
  await jb.send('set-action-key', { id: 'newTab', shortcut: 'Command+T' })
  await jb.waitForState((s) => s.keys.newTab === 'Command+T', 'the default key back')
})
