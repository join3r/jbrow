// New tabs, tabs opened by links and scripts, and closing tabs.
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { CMD, html, launch, serve, waitFor, type Jbrow, type TestServer } from './harness'
import { activate, activeTab, offline, openTab, realClick, shownPage, sidebarRows, tabById, waitLoaded, waitRows } from './tab-helpers'

let jb: Jbrow
let web: TestServer

before(async () => {
  web = await serve({
    '/one': html('One'),
    '/two': html('Two'),
    '/three': html('Three'),
    '/links': html(
      'Links',
      `<a id="blank" href="/child" target="_blank" style="display:block;width:200px;height:40px">child</a>
       <button id="open" onclick="window.open('/opened')">open</button>`,
    ),
    '/child': html('Child'),
    '/opened': html('Opened'),
  })
  jb = await launch({ settings: offline(web) })
})
after(async () => {
  await jb?.close()
  await web?.close()
})

/** Closes every tab, leaving the one empty tab jbrow keeps, so each test starts the same. */
async function closeAll() {
  const s = await jb.state()
  for (const t of s.tabs) await jb.send('close', { id: t.id })
  await jb.waitForState((s) => s.tabs.length === 1 && !s.tabs[0].url && s.activeId === s.tabs[0].id, 'one empty tab')
}
beforeEach(closeAll)

test('a new tab is reused while it is empty', async () => {
  const empty = (await jb.state()).activeId!
  await jb.send('new')
  await jb.send('new')
  let s = await jb.waitForState((s) => s.activeId === empty, 'the same tab')
  assert.equal(s.tabs.length, 1)
  // Once it has a page, New Tab makes another.
  await jb.navigate(`${web.url}/one`)
  s = await jb.state()
  assert.equal(s.activeId, empty)
  await jb.send('new')
  s = await jb.waitForState((s) => s.activeId !== empty && !activeTab(s)?.url, 'a second, empty tab')
  assert.equal(s.tabs.length, 2)
  const second = s.activeId!
  // Leaving an empty tab for another drops it.
  await activate(jb, empty)
  s = await jb.waitForState((s) => !tabById(s, second), 'the empty tab to go')
  assert.equal(s.tabs.length, 1)
})

test('typing into the empty new tab loads there, without another tab', async () => {
  const empty = (await jb.state()).activeId!
  const s = await jb.navigate(`${web.url}/two`)
  assert.equal(s.activeId, empty)
  assert.equal(s.tabs.length, 1)
})

test('the sidebar lists open tabs, newest first, with their titles', async () => {
  const one = await openTab(jb, `${web.url}/one`)
  const two = await openTab(jb, `${web.url}/two`)
  const three = await openTab(jb, `${web.url}/three`)
  const rows = await waitRows(jb, (rows) => rows.length === 3 && rows.every((r) => r.title), 'three titled rows')
  assert.deepEqual(
    rows.map((r) => [r.id, r.title]),
    [
      [three.id, 'Three'],
      [two.id, 'Two'],
      [one.id, 'One'],
    ],
  )
  assert.ok(rows[0].classes.includes('cur'))
  assert.ok(rows.every((r) => !r.kept))
  // Clicking a row makes its tab active.
  const ui = await jb.ui()
  await ui.clickOn(`#threads .row[data-id="${one.id}"] .t`)
  await jb.waitForState((s) => s.activeId === one.id, 'the clicked tab to be active')
  await waitRows(jb, (rows) => rows.find((r) => r.id === one.id)?.classes.includes('cur'), 'its row to be current')
})

test('a target=_blank link opens a tab with the page as its opener', async () => {
  const parent = await openTab(jb, `${web.url}/links`)
  const page = await jb.page(`${web.url}/links`)
  await page.eval('document.getElementById("blank").click()')
  const s = await jb.waitForState((s) => s.tabs.some((t) => t.opener === parent.id && t.title === 'Child'), 'the child tab')
  const child = s.tabs.find((t) => t.opener === parent.id)!
  assert.equal(child.url, `${web.url}/child`)
  assert.equal(s.activeId, child.id)
  assert.equal(child.profile, parent.profile)
  assert.ok(!child.kept)
  page.close()
})

test('window.open opens a tab too', async () => {
  const parent = await openTab(jb, `${web.url}/links`)
  const page = await jb.page(`${web.url}/links`)
  await page.eval('document.getElementById("open").click()')
  const s = await jb.waitForState((s) => s.tabs.some((t) => t.opener === parent.id && t.title === 'Opened'), 'the opened tab')
  assert.equal(s.activeId, s.tabs.find((t) => t.opener === parent.id)!.id)
  // The opened page can reach back to its opener, as window.open promises.
  const opened = await jb.page(`${web.url}/opened`)
  assert.equal(await opened.eval('!!window.opener'), true)
  page.close()
  opened.close()
})

test('a ⌘-click on a link opens it in the background, unread', async () => {
  const parent = await openTab(jb, `${web.url}/links`)
  // Chromium only opens background tabs for real clicks, so not a script's click().
  const page = await shownPage(jb, `${web.url}/links`)
  await realClick(page, '#blank', CMD)
  const s = await jb.waitForState((s) => s.tabs.some((t) => t.opener === parent.id && t.title === 'Child'), 'the background tab')
  const child = s.tabs.find((t) => t.opener === parent.id)!
  assert.equal(s.activeId, parent.id)
  assert.equal(child.unread, true)
  await waitRows(jb, (rows) => rows.find((r) => r.id === child.id)?.classes.includes('unread'), 'an unread row')
  // Looking at it clears unread.
  const after = await activate(jb, child.id)
  assert.ok(!tabById(after, child.id)!.unread)
  page.close()
})

test('a tab opened from a page goes beside it, and the sidebar scrolls to it', async () => {
  const parent = await openTab(jb, `${web.url}/links`)
  // Newer tabs above it, and a sidebar short enough that it sits below the fold.
  for (let i = 0; i < 12; i++) await jb.navigate(`${web.url}/one?${i}`, { newTab: true })
  await jb.waitForState((s) => s.tabs.length >= 13, 'the other tabs')
  await activate(jb, parent.id)
  const ui = await jb.ui()
  await ui.eval('Object.assign(document.getElementById("threads").style, { flex: "none", height: "200px" })')
  await ui.eval('document.getElementById("threads").scrollTop = 0')
  const page = await shownPage(jb, `${web.url}/links`)
  await realClick(page, '#blank', CMD)
  const s = await jb.waitForState((s) => s.tabs.some((t) => t.opener === parent.id && t.title === 'Child'), 'the background tab')
  const child = s.tabs.find((t) => t.opener === parent.id)!
  const rows = await waitRows(jb, (rows) => rows.some((r) => r.id === child.id), 'the child row')
  const at = rows.findIndex((r) => r.id === child.id)
  assert.equal(rows[at + 1]?.id, parent.id, 'right above its opener')
  await waitFor(
    () =>
      ui.call((id) => {
        const list = document.getElementById('threads')!.getBoundingClientRect()
        const row = document.querySelector(`#threads .row[data-id="${id}"]`)!.getBoundingClientRect()
        return row.top >= list.top && row.bottom <= list.bottom
      }, child.id),
    'the sidebar to scroll to the new tab',
  )
  await ui.eval('document.getElementById("threads").removeAttribute("style")')
  page.close()
})

test('closing the active tab moves to the tab above it, where new tabs go', async () => {
  const one = await openTab(jb, `${web.url}/one`)
  const two = await openTab(jb, `${web.url}/two`)
  const three = await openTab(jb, `${web.url}/three`)
  // The sidebar reads three, two, one.
  await activate(jb, one.id)
  await activate(jb, two.id)
  await jb.send('close', { id: two.id })
  let s = await jb.waitForState((s) => !tabById(s, two.id), 'the tab to close')
  assert.equal(s.activeId, three.id)
  // The top tab has none above, so the one below takes over.
  await jb.send('close', { id: three.id })
  s = await jb.waitForState((s) => !tabById(s, three.id), 'the top tab to close')
  assert.equal(s.activeId, one.id)
  await waitRows(jb, (rows) => rows.length === 1 && rows[0].id === one.id, 'one row left')
})

test('with new tabs at the bottom, closing the active tab moves to the tab below it', async () => {
  await jb.send('prefs', { newTabsAt: 'bottom' })
  await jb.waitForState((s) => s.prefs.newTabsAt === 'bottom', 'the setting')
  try {
    const one = await openTab(jb, `${web.url}/one`)
    const two = await openTab(jb, `${web.url}/two`)
    const three = await openTab(jb, `${web.url}/three`)
    await waitRows(jb, (rows) => rows.map((r) => r.id).join() === [one.id, two.id, three.id].join(), 'oldest first')
    await activate(jb, three.id)
    await activate(jb, two.id)
    await jb.send('close', { id: two.id })
    let s = await jb.waitForState((s) => !tabById(s, two.id), 'the tab to close')
    assert.equal(s.activeId, three.id)
    await jb.send('close', { id: three.id })
    s = await jb.waitForState((s) => !tabById(s, three.id), 'the bottom tab to close')
    assert.equal(s.activeId, one.id)
    // Closing one that isn't active leaves the active one alone.
    const four = await openTab(jb, `${web.url}/two`)
    await activate(jb, one.id)
    await jb.send('close', { id: four.id })
    s = await jb.waitForState((s) => !tabById(s, four.id), 'the other tab to close')
    assert.equal(s.activeId, one.id)
  } finally {
    await jb.send('prefs', { newTabsAt: 'top' })
  }
})

test('closing the last tab leaves an empty new tab', async () => {
  const one = await openTab(jb, `${web.url}/one`)
  await jb.send('close', { id: one.id })
  const s = await jb.waitForState((s) => !tabById(s, one.id) && s.tabs.length === 1, 'a fresh tab')
  assert.equal(activeTab(s)!.url, '')
  // The page is gone, not only hidden.
  await waitFor(async () => !(await jb.targets()).some((t) => t.url.startsWith(`${web.url}/one`)), 'its page to close')
})

test('closing an opener leaves the tab it opened', async () => {
  const parent = await openTab(jb, `${web.url}/links`)
  const page = await jb.page(`${web.url}/links`)
  await page.eval('document.getElementById("blank").click()')
  const s = await jb.waitForState((s) => s.tabs.some((t) => t.opener === parent.id && t.title === 'Child'), 'the child tab')
  const child = s.tabs.find((t) => t.opener === parent.id)!
  page.close()
  await jb.send('close', { id: parent.id })
  const after = await jb.waitForState((s) => !tabById(s, parent.id), 'the opener to close')
  assert.ok(tabById(after, child.id))
  assert.equal(after.activeId, child.id)
})

test('reopening a closed tab brings it back where it was, with its history', async () => {
  const t = await openTab(jb, `${web.url}/one`)
  await jb.send('navigate', { input: `${web.url}/two` })
  await waitLoaded(jb, t.id, `${web.url}/two`)
  const other = await openTab(jb, `${web.url}/three`)
  await jb.send('close', { id: t.id })
  await jb.waitForState((s) => !tabById(s, t.id), 'the tab to close')
  // ⇧⌘T, pressed in the UI.
  const ui = await jb.ui()
  await ui.press('t', { modifiers: CMD | 8 })
  const s = await jb.waitForState((s) => s.activeId === t.id && activeTab(s)?.url === `${web.url}/two`, 'the tab to come back')
  assert.ok(tabById(s, other.id))
  await waitLoaded(jb, t.id, `${web.url}/two`)
  await jb.waitForState((s) => s.nav.canGoBack, 'its back list')
  await jb.send('nav', { action: 'back' })
  await waitLoaded(jb, t.id, `${web.url}/one`)
  assert.ok((await sidebarRows(jb)).some((r) => r.id === t.id))
})
