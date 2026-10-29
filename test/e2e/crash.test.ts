// A tab whose page crashed: jbrow's crash screen, reloading from it, and closing such a tab.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { html, launch, serve, waitFor, type Jbrow, type TestServer } from './harness'
import { activate, activeTab, offline, openTab, tabById, waitLoaded, waitRows } from './tab-helpers'

let jb: Jbrow
let web: TestServer

before(async () => {
  web = await serve({ '/crashy': html('Crashy'), '/other': html('Other'), '/third': html('Third') })
  jb = await launch({ settings: offline(web) })
})
after(async () => {
  await jb?.close()
  await web?.close()
})

/** Crashes the renderer of the tab `id`, whose page is at `url`, as chrome://crash does, and waits for jbrow to notice. */
async function crash(id: string, url: string) {
  const page = await jb.page(url)
  // It never answers: the page is gone.
  void page.send('Page.crash').catch(() => {})
  await jb.waitForState((s) => tabById(s, id)?.crashed, 'the tab to be marked crashed')
  page.close()
}

test('a crashed page shows the crash screen, and Reload brings it back', async () => {
  const t = await openTab(jb, `${web.url}/crashy`)
  await crash(t.id, `${web.url}/crashy`)
  const s = await jb.waitForState((s) => s.crash, 'the crash')
  assert.deepEqual(s.crash, { reason: 'crashed', hung: false })
  assert.equal(tabById(s, t.id)!.crashed, true)
  assert.equal(tabById(s, t.id)!.loading, false)
  const ui = await jb.ui()
  await waitFor(() => ui.eval(`!document.getElementById('crashWarn').hidden`), 'the crash screen')
  assert.equal(await ui.eval(`document.getElementById('crashTitle').textContent`), 'This page crashed')
  // Only a stuck page can be waited on.
  assert.equal(await ui.eval(`document.getElementById('crashWait').hidden`), true)
  await waitRows(jb, (rows) => rows.find((r) => r.id === t.id)?.classes.includes('crashed'), 'the row marked crashed')

  const hits = web.hits.filter((h) => h === '/crashy').length
  await ui.clickOn('#crashReload')
  const back = await jb.waitForState((s) => !s.crash && !tabById(s, t.id)?.crashed, 'the crash to clear')
  assert.equal(back.activeId, t.id)
  await waitLoaded(jb, t.id, `${web.url}/crashy`)
  await waitFor(() => web.hits.filter((h) => h === '/crashy').length > hits, 'the page to load again')
  await waitFor(() => ui.eval(`document.getElementById('crashWarn').hidden`), 'the crash screen to go')
  const page = await jb.page(`${web.url}/crashy`)
  assert.equal(await page.eval('document.title'), 'Crashy')
  page.close()
  await waitRows(jb, (rows) => !rows.find((r) => r.id === t.id)?.classes.includes('crashed'), 'the row unmarked')
})

test('the crash action reloads from the IPC too, and a crash in the background waits until you look', async () => {
  const bg = await openTab(jb, `${web.url}/other`)
  const front = await openTab(jb, `${web.url}/third`)
  await crash(bg.id, `${web.url}/other`)
  let s = await jb.waitForState((s) => tabById(s, bg.id)?.crashed, 'the background tab crashed')
  // The tab in front is fine.
  assert.equal(s.crash, null)
  assert.equal(s.activeId, front.id)
  s = await activate(jb, bg.id)
  assert.deepEqual(s.crash, { reason: 'crashed', hung: false })
  await jb.send('crash', { action: 'reload' })
  await jb.waitForState((s) => !s.crash && !tabById(s, bg.id)?.crashed, 'the crash to clear')
  await waitLoaded(jb, bg.id, `${web.url}/other`)
})

test('a crashed tab closes without asking', async () => {
  const t = await openTab(jb, `${web.url}/crashy?close`)
  await crash(t.id, `${web.url}/crashy?close`)
  await jb.waitForState((s) => s.crash, 'the crash')
  await jb.send('close', { id: t.id })
  const s = await jb.waitForState((s) => !tabById(s, t.id), 'the tab to close')
  assert.equal(s.crash, null)
  assert.ok(activeTab(s))
})
