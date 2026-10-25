// Split view: tabs side by side, their sizes, and taking them apart.
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { CMD, CTRL, META, html, launch, serve, waitFor, type Jbrow, type TestServer } from './harness'
import { activate, activeTab, offline, openTab, realClick, shownPage, tabById, waitLoaded, waitRows } from './tab-helpers'
import type { UiState } from '../../src/shared/types'

let jb: Jbrow
let web: TestServer

before(async () => {
  web = await serve({
    '/left': html('Left', '<p style="height:200px">left</p>'),
    '/right': html('Right'),
    '/third': html('Third'),
    '/other': html('Other'),
  })
  jb = await launch({ settings: offline(web) })
})
after(async () => {
  await jb?.close()
  await web?.close()
})

beforeEach(async () => {
  let s = await jb.state()
  for (const t of s.tabs) if (t.kept) await jb.send('move', { id: t.id, kept: false })
  s = await jb.waitForState((s) => s.tabs.every((t) => !t.kept), 'nothing kept')
  for (const t of s.tabs) await jb.send('close', { id: t.id })
  await jb.waitForState((s) => s.tabs.length === 1 && !s.tabs[0].url && !s.splits.length, 'one empty tab')
})

const splitOf = (s: UiState, id: string) => s.splits.find((x) => x.tabs.includes(id))

/** ⌘D: a new empty pane right of the active tab. Returns the new pane's tab. */
async function splitNew(from: string) {
  const before = (await jb.state()).tabs.map((t) => t.id)
  const ui = await jb.ui()
  await ui.press('d', { modifiers: CMD })
  const s = await jb.waitForState((s) => s.activeId && !before.includes(s.activeId) && splitOf(s, from)?.tabs.includes(s.activeId), 'a new pane')
  return activeTab(s)!
}

/** Width of a tab's page, as laid out. */
const widthOf = async (url: string) => (await shownPage(jb, url)).eval<number>('innerWidth')

test('⌘D splits the tab: a new pane beside it, where the next address goes', async () => {
  const left = await openTab(jb, `${web.url}/left`)
  const pane = await splitNew(left.id)
  let s = await jb.state()
  assert.equal(pane.url, '')
  assert.equal(pane.opener, left.id)
  assert.equal(pane.profile, left.profile)
  assert.deepEqual(splitOf(s, left.id), { id: splitOf(s, left.id)!.id, tabs: [left.id, pane.id], sizes: [1, 1] })
  // The empty pane shows jbrow's new tab screen in its place.
  const ui = await jb.ui()
  await waitFor(() => ui.call((id) => !!document.querySelector(`.pane[data-pane="${id}"]`), pane.id), 'the empty pane')
  await jb.send('navigate', { input: `${web.url}/right` })
  s = await waitLoaded(jb, pane.id, `${web.url}/right`)
  assert.equal(s.activeId, pane.id)
  assert.equal(tabById(s, left.id)!.url, `${web.url}/left`)
  // Both pages are on screen, each about half as wide as the page area.
  const [lw, rw] = [await widthOf(`${web.url}/left`), await widthOf(`${web.url}/right`)]
  assert.ok(Math.abs(lw - rw) <= 1, `${lw} vs ${rw}`)
  // The sidebar shows the split as one row of two.
  await waitRows(jb, (rows) => rows.some((r) => r.id === left.id) && rows.some((r) => r.id === pane.id), 'both rows')
  assert.equal(await ui.eval(`!!document.querySelector('#threads .split-row .row[data-id="${left.id}"] ~ .row[data-id="${pane.id}"]')`), true)
  // A new tab from inside a split doesn't take over the pane.
  await jb.send('new')
  s = await jb.waitForState((s) => s.activeId !== pane.id && !activeTab(s)?.url, 'a separate new tab')
  assert.ok(!splitOf(s, s.activeId!))
  assert.deepEqual(splitOf(s, left.id)!.tabs, [left.id, pane.id])
})

test('split-sizes resizes the panes; nonsense sizes are ignored', async () => {
  const left = await openTab(jb, `${web.url}/left`)
  const pane = await splitNew(left.id)
  await jb.send('navigate', { input: `${web.url}/right` })
  await waitLoaded(jb, pane.id, `${web.url}/right`)
  const id = splitOf(await jb.state(), left.id)!.id
  await jb.send('split-sizes', { id, sizes: [3, 1], done: true })
  await jb.waitForState((s) => JSON.stringify(splitOf(s, left.id)?.sizes) === '[3,1]', 'sizes 3:1')
  await waitFor(async () => {
    const [lw, rw] = [await widthOf(`${web.url}/left`), await widthOf(`${web.url}/right`)]
    return lw > rw * 2.5 && lw < rw * 3.5
  }, 'the left page three times as wide')
  for (const sizes of [[1], [1, 0], [1, -2], [1, 2, 3]]) await jb.send('split-sizes', { id, sizes, done: true })
  // While a divider is dragged (no `done`), the pages follow.
  await jb.send('split-sizes', { id, sizes: [1, 1] })
  await waitFor(async () => Math.abs((await widthOf(`${web.url}/left`)) - (await widthOf(`${web.url}/right`))) <= 1, 'even panes again')
  await jb.send('split-sizes', { id, sizes: [1, 1], done: true })
  await jb.waitForState((s) => JSON.stringify(splitOf(s, left.id)?.sizes) === '[1,1]', 'sizes 1:1 in the state')
})

// Off macOS, Command in this shortcut is the Windows or Super key, which jbrow's own key handling
// (onKey) sees through Electron; CDP's meta modifier may not reach it the same way.
test('⌘⌃← and ⌘⌃→ move between panes', { skip: process.platform !== 'darwin' && 'macOS shortcut' }, async () => {
  const left = await openTab(jb, `${web.url}/left`)
  const pane = await splitNew(left.id)
  await jb.send('navigate', { input: `${web.url}/right` })
  await waitLoaded(jb, pane.id, `${web.url}/right`)
  const ui = await jb.ui()
  await ui.press('ArrowLeft', { modifiers: META | CTRL })
  await jb.waitForState((s) => s.activeId === left.id, 'the left pane to be active')
  // Nothing further left.
  await ui.press('ArrowLeft', { modifiers: META | CTRL })
  await ui.press('ArrowRight', { modifiers: META | CTRL })
  await jb.waitForState((s) => s.activeId === pane.id, 'the right pane to be active')
  assert.equal((await jb.state()).splits.length, 1)
})

test('close-pane takes a tab out of the split; the one beside it takes over', async () => {
  const left = await openTab(jb, `${web.url}/left`)
  const pane = await splitNew(left.id)
  await jb.send('navigate', { input: `${web.url}/right` })
  await waitLoaded(jb, pane.id, `${web.url}/right`)
  await jb.send('close-pane', { id: pane.id })
  const s = await jb.waitForState((s) => !s.splits.length, 'the split to end')
  // Two panes down to one is no split; the tab stays a tab of its own.
  assert.equal(s.activeId, left.id)
  assert.ok(tabById(s, pane.id))
  await waitFor(async () => (await widthOf(`${web.url}/left`)) > 0, 'the left page')
  await waitRows(jb, (rows) => rows.length === 2, 'two rows')
  const ui = await jb.ui()
  assert.equal(await ui.eval('document.querySelectorAll("#threads .split-row").length'), 0)
})

test('a split holds four tabs at most', async () => {
  const first = await openTab(jb, `${web.url}/left`)
  const panes = [first.id]
  for (let i = 0; i < 3; i++) {
    const pane = await splitNew(first.id)
    panes.push(pane.id)
    await jb.send('navigate', { input: `${web.url}/third?${i}` })
    await waitLoaded(jb, pane.id, `${web.url}/third?${i}`)
  }
  const s = await jb.state()
  assert.equal(splitOf(s, first.id)!.tabs.length, 4)
  assert.deepEqual(splitOf(s, first.id)!.sizes, [1, 1, 1, 1])
  const toasts = (await jb.toasts()).length
  const ui = await jb.ui()
  await ui.press('d', { modifiers: CMD })
  await waitFor(async () => (await jb.toasts()).slice(toasts).includes('Split view holds up to 4 tabs.'), 'the toast')
  assert.equal(splitOf(await jb.state(), first.id)!.tabs.length, 4)
  // Closing one of the four leaves three.
  await jb.send('close', { id: panes[1] })
  const after = await jb.waitForState((s) => !tabById(s, panes[1]), 'the tab to close')
  assert.deepEqual(splitOf(after, first.id)!.tabs, [panes[0], panes[2], panes[3]])
})

test('closing the active pane focuses the pane beside it', async () => {
  const left = await openTab(jb, `${web.url}/left`)
  const pane = await splitNew(left.id)
  await jb.send('navigate', { input: `${web.url}/right` })
  await waitLoaded(jb, pane.id, `${web.url}/right`)
  const other = await openTab(jb, `${web.url}/other`)
  // Back to the right pane, after another tab: closing it goes to its neighbour, not to the other tab.
  await activate(jb, pane.id)
  await jb.send('close', { id: pane.id })
  const s = await jb.waitForState((s) => !tabById(s, pane.id), 'the pane to close')
  assert.equal(s.activeId, left.id)
  assert.equal(s.splits.length, 0)
  assert.ok(tabById(s, other.id))
})

test('switching to a tab outside the split hides it; switching back shows both', async () => {
  const left = await openTab(jb, `${web.url}/left`)
  const pane = await splitNew(left.id)
  await jb.send('navigate', { input: `${web.url}/right` })
  await waitLoaded(jb, pane.id, `${web.url}/right`)
  const leftPage = await shownPage(jb, `${web.url}/left`)
  await openTab(jb, `${web.url}/other`)
  await waitFor(() => leftPage.eval('document.visibilityState === "hidden"'), 'the split to be hidden')
  await activate(jb, pane.id)
  await waitFor(() => leftPage.eval('document.visibilityState === "visible"'), 'the left pane to show again')
  leftPage.close()
})

test('an empty pane goes away when you leave the split', async () => {
  const left = await openTab(jb, `${web.url}/left`)
  const pane = await splitNew(left.id)
  const other = await openTab(jb, `${web.url}/other`)
  const s = await jb.waitForState((s) => !tabById(s, pane.id), 'the empty pane to go')
  assert.equal(s.splits.length, 0)
  assert.equal(s.activeId, other.id)
})

test('splitting a kept tab keeps the new pane right after it', async () => {
  const left = await openTab(jb, `${web.url}/left`)
  await jb.send('move', { id: left.id, kept: true })
  await jb.waitForState((s) => tabById(s, left.id)?.kept, 'kept')
  const pane = await splitNew(left.id)
  await jb.send('navigate', { input: `${web.url}/right` })
  const s = await waitLoaded(jb, pane.id, `${web.url}/right`)
  const p = tabById(s, pane.id)!
  assert.equal(p.kept, true)
  assert.ok(p.order! > tabById(s, left.id)!.order!)
  // Kept on the first page it loaded.
  await jb.waitForState((s) => tabById(s, pane.id)?.home?.url === `${web.url}/right`, 'its pinned page')
})

test('a click into the other pane makes it the active tab; a pane loading does not', async () => {
  const left = await openTab(jb, `${web.url}/left`)
  const right = await splitNew(left.id)
  await jb.send('navigate', { input: `${web.url}/right` })
  await waitLoaded(jb, right.id, `${web.url}/right`)
  // The right pane loading took the keyboard, and it stays the active one.
  await jb.pageFocused(`${web.url}/right`)
  assert.equal((await jb.state()).activeId, right.id)
  await realClick(await shownPage(jb, `${web.url}/left`), 'p')
  await jb.waitForState((s) => s.activeId === left.id, 'the clicked pane to be active')
  await realClick(await shownPage(jb, `${web.url}/right`), 'body')
  await jb.waitForState((s) => s.activeId === right.id, 'the other pane to be active again')
})
