// Keeping, pinning, folders and names: the Kept part of the sidebar.
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { html, launch, serve, waitFor, type Jbrow, type TestServer } from './harness'
import { activate, activeTab, makeFolder, offline, openTab, pinIcons, tabById, waitLoaded, waitRows } from './tab-helpers'

let jb: Jbrow
let web: TestServer

before(async () => {
  web = await serve({
    '/one': html('One'),
    '/two': html('Two'),
    '/three': html('Three'),
    '/elsewhere': html('Elsewhere'),
  })
  jb = await launch({ settings: offline(web) })
})
after(async () => {
  await jb?.close()
  await web?.close()
})

/** Unkeeps and closes every tab and drops every folder (there's no IPC for deleting one, so they're left but emptied). */
beforeEach(async () => {
  let s = await jb.state()
  for (const t of s.tabs) if (t.kept) await jb.send('move', { id: t.id, kept: false })
  s = await jb.waitForState((s) => s.tabs.every((t) => !t.kept), 'nothing kept')
  for (const t of s.tabs) await jb.send('close', { id: t.id })
  await jb.waitForState((s) => s.tabs.length === 1 && !s.tabs[0].url, 'one empty tab')
})

const newFolder = (name: string) => makeFolder(jb, name)

test('keeping a tab moves it to Kept, on the page it was kept on', async () => {
  const t = await openTab(jb, `${web.url}/one`)
  await jb.send('move', { id: t.id, kept: true })
  const s = await jb.waitForState((s) => tabById(s, t.id)?.kept, 'the tab to be kept')
  const kept = tabById(s, t.id)!
  assert.equal(kept.home?.url, `${web.url}/one`)
  assert.equal(kept.home?.title, 'One')
  await waitRows(jb, (rows) => rows.find((r) => r.id === t.id)?.kept, 'its row in Kept')
  // Unkeeping takes it back out, without a pinned page.
  await jb.send('move', { id: t.id, kept: false })
  const out = await jb.waitForState((s) => !tabById(s, t.id)?.kept, 'the tab to be out of Kept')
  assert.equal(tabById(out, t.id)!.home, undefined)
  await waitRows(jb, (rows) => rows.find((r) => r.id === t.id && !r.kept), 'its row back in Today')
})

test('closing a kept tab closes its page but keeps it, back on its pinned page', async () => {
  const t = await openTab(jb, `${web.url}/one`)
  await jb.send('move', { id: t.id, kept: true })
  await jb.waitForState((s) => tabById(s, t.id)?.kept, 'kept')
  // It wanders off, then closes.
  await jb.send('navigate', { input: `${web.url}/elsewhere` })
  await waitLoaded(jb, t.id, `${web.url}/elsewhere`)
  // The row marks it with a slash, as Arc does.
  await waitRows(jb, (rows) => rows.find((r) => r.id === t.id)?.title === '/Elsewhere', 'the row to show where it is')
  await jb.send('close', { id: t.id })
  const s = await jb.waitForState((s) => tabById(s, t.id) && !tabById(s, t.id)!.loaded && activeTab(s), 'its page to close')
  const kept = tabById(s, t.id)!
  assert.equal(kept.url, `${web.url}/one`)
  assert.equal(kept.title, 'One')
  // jbrow moves on to a new tab rather than another kept one.
  assert.notEqual(s.activeId, t.id)
  assert.equal(activeTab(s)!.url, '')
  // Opening it again loads its pinned page.
  await activate(jb, t.id)
  await waitLoaded(jb, t.id, `${web.url}/one`)
})

test('go-home takes a kept tab back to its pinned page', async () => {
  const t = await openTab(jb, `${web.url}/one`)
  await jb.send('move', { id: t.id, kept: true })
  await jb.waitForState((s) => tabById(s, t.id)?.kept, 'kept')
  await jb.send('navigate', { input: `${web.url}/two` })
  await waitLoaded(jb, t.id, `${web.url}/two`)
  await jb.send('go-home', { id: t.id })
  await waitLoaded(jb, t.id, `${web.url}/one`)
})

test('rename gives a tab a name of its own; an empty name goes back to the title', async () => {
  const t = await openTab(jb, `${web.url}/one`)
  await jb.send('rename', { id: t.id, name: '  My page  ' })
  let s = await jb.waitForState((s) => tabById(s, t.id)?.name === 'My page', 'the name')
  await waitRows(jb, (rows) => rows.find((r) => r.id === t.id)?.title === 'My page', 'the row to show the name')
  // The page's own title still updates underneath.
  assert.equal(tabById(s, t.id)!.title, 'One')
  await jb.send('rename', { id: t.id, name: '' })
  s = await jb.waitForState((s) => !tabById(s, t.id)?.name, 'no name')
  await waitRows(jb, (rows) => rows.find((r) => r.id === t.id)?.title === 'One', 'the row to show the title')
  // Naming it its own title is no name at all.
  await jb.send('rename', { id: t.id, name: 'One' })
  await jb.send('rename', { id: t.id, name: 'One' })
  s = await jb.state()
  assert.equal(tabById(s, t.id)!.name, undefined)
})

test('a name being typed survives the sidebar redrawing, and leaving the field saves it', async () => {
  const other = await openTab(jb, `${web.url}/two`)
  const t = await openTab(jb, `${web.url}/one`)
  // F2 on a row opens a name field on it, as Rename in its menu does.
  const ui = await jb.ui()
  await ui.call((id) => document.querySelector<HTMLElement>(`#threads .row[data-id="${id}"]`)!.focus(), t.id)
  await ui.press('F2')
  const typing = () => ui.call((id) => document.activeElement?.id === 'ren' && !!document.activeElement.closest(`[data-id="${id}"]`), t.id)
  await waitFor(typing, 'the name field')
  await ui.eval('document.getElementById("ren").select()')
  await ui.type('Half typ')
  // Something else changes meanwhile, and the sidebar redraws.
  await jb.send('rename', { id: other.id, name: 'Other' })
  await waitRows(jb, (rows) => rows.find((r) => r.id === other.id)?.title === 'Other', 'the other row renamed')
  assert.equal(await typing(), true)
  assert.equal(tabById(await jb.state(), t.id)!.name, undefined)
  await ui.type('ed')
  assert.equal(await ui.eval('document.getElementById("ren").value'), 'Half typed')
  // Leaving the field saves what's there.
  await ui.eval('document.activeElement.blur()')
  await jb.waitForState((s) => tabById(s, t.id)?.name === 'Half typed', 'the typed name')
  await waitRows(jb, (rows) => rows.find((r) => r.id === t.id)?.title === 'Half typed', 'the row to show it')
})

test('folders hold kept tabs, and can be renamed and collapsed', async () => {
  const one = await openTab(jb, `${web.url}/one`)
  const two = await openTab(jb, `${web.url}/two`)
  const folder = await newFolder('Reading')
  // Moving a tab that isn't kept into a folder keeps it.
  await jb.send('move', { id: one.id, kept: true, folder })
  let s = await jb.waitForState((s) => tabById(s, one.id)?.folder === folder, 'one in the folder')
  assert.equal(tabById(s, one.id)!.kept, true)
  await jb.send('move', { id: two.id, kept: true })
  s = await jb.waitForState((s) => tabById(s, two.id)?.kept, 'two kept')
  assert.equal(tabById(s, two.id)!.folder, undefined)
  await waitRows(
    jb,
    (rows) => rows.find((r) => r.id === one.id)?.folder === folder && rows.find((r) => r.id === two.id)?.folder === null && rows.find((r) => r.id === two.id)?.kept,
    'one in the folder, two in Kept outside it',
  )
  const ui = await jb.ui()
  assert.match(await ui.eval(`document.querySelector('#threads .frow[data-folder="${folder}"]').textContent`), /Reading/)

  await jb.send('folder', { id: folder, name: 'Later' })
  await jb.waitForState((s) => s.folders.find((f) => f.id === folder)?.name === 'Later', 'the new name')
  // A blank name is ignored.
  await jb.send('folder', { id: folder, name: '   ' })
  await jb.send('folder', { id: folder, collapsed: true })
  s = await jb.waitForState((s) => s.folders.find((f) => f.id === folder)?.collapsed, 'collapsed')
  assert.equal(s.folders.find((f) => f.id === folder)!.name, 'Later')
  await waitRows(jb, (rows) => !rows.some((r) => r.id === one.id), 'its tabs hidden while collapsed')
  await jb.send('folder', { id: folder, collapsed: false })
  await waitRows(jb, (rows) => rows.some((r) => r.id === one.id), 'its tabs back')

  // Out of the folder, still kept.
  await jb.send('move', { id: one.id, kept: true })
  s = await jb.waitForState((s) => tabById(s, one.id)?.kept && !tabById(s, one.id)?.folder, 'one out of the folder')
})

test('place orders kept tabs and folders', async () => {
  const a = await openTab(jb, `${web.url}/one`)
  const b = await openTab(jb, `${web.url}/two`)
  const c = await openTab(jb, `${web.url}/three`)
  for (const t of [a, b, c]) await jb.send('move', { id: t.id, kept: true })
  await jb.waitForState((s) => [a, b, c].every((t) => tabById(s, t.id)?.kept), 'all kept')
  const keptOrder = async () =>
    (await waitRows(jb, (rows) => rows.filter((r) => r.kept && [a.id, b.id, c.id].includes(r.id)).length === 3, 'three kept rows'))
      .filter((r) => r.kept && [a.id, b.id, c.id].includes(r.id))
      .map((r) => r.id)
  // Kept in the order they were kept in.
  assert.deepEqual(await keptOrder(), [a.id, b.id, c.id])
  // c before a.
  await jb.send('place', { id: c.id, target: a.id })
  await jb.waitForState((s) => tabById(s, c.id)!.order! < tabById(s, a.id)!.order!, 'c before a')
  await waitFor(async () => JSON.stringify(await keptOrder()) === JSON.stringify([c.id, a.id, b.id]), 'rows c, a, b')
  // a after b.
  await jb.send('place', { id: a.id, target: b.id, after: true })
  await waitFor(async () => JSON.stringify(await keptOrder()) === JSON.stringify([c.id, b.id, a.id]), 'rows c, b, a')
  // Placing a tab that isn't kept keeps it; with no target it goes to the bottom.
  const d = await openTab(jb, `${web.url}/elsewhere`)
  await jb.send('place', { id: d.id, target: null })
  const s = await jb.waitForState((s) => tabById(s, d.id)?.kept, 'd kept')
  const orders = [c, b, a, d].map((t) => tabById(s, t.id)!.order!)
  assert.deepEqual([...orders].sort((x, y) => x - y), orders)
  // Placed next to a tab in a folder, it goes into that folder.
  const folder = await newFolder('Placed')
  await jb.send('move', { id: c.id, kept: true, folder })
  await jb.waitForState((s) => tabById(s, c.id)?.folder === folder, 'c in the folder')
  await jb.send('place', { id: b.id, target: c.id, after: true })
  await jb.waitForState((s) => tabById(s, b.id)?.folder === folder && tabById(s, b.id)!.order! > tabById(s, c.id)!.order!, 'b after c in the folder')
})

test('folders nest with move-folder, but never inside themselves', async () => {
  const outer = await newFolder('Outer')
  const inner = await newFolder('Inner')
  await jb.send('move-folder', { id: inner, parent: outer })
  let s = await jb.waitForState((s) => s.folders.find((f) => f.id === inner)?.parent === outer, 'inner inside outer')
  // Outer into inner would put it inside itself.
  await jb.send('move-folder', { id: outer, parent: inner })
  await jb.send('move-folder', { id: outer, parent: outer })
  // A change jbrow does make, to know the two above went through first.
  const t = await openTab(jb, `${web.url}/one`)
  await jb.send('move', { id: t.id, kept: true, folder: inner })
  s = await jb.waitForState((s) => tabById(s, t.id)?.folder === inner, 'the tab in inner')
  assert.equal(s.folders.find((f) => f.id === outer)!.parent, undefined)
  // The sidebar draws inner inside outer's body, and the tab inside inner's.
  await waitRows(jb, (rows) => rows.find((r) => r.id === t.id)?.folder === inner, 'the row inside inner')
  const ui = await jb.ui()
  assert.equal(
    await ui.eval(`!!document.querySelector('#threads .frow[data-folder="${outer}"] + .folder-body .frow[data-folder="${inner}"]')`),
    true,
  )
  // Back to the top of Kept.
  await jb.send('move-folder', { id: inner, parent: null })
  await jb.waitForState((s) => !s.folders.find((f) => f.id === inner)?.parent, 'inner at the top')
})

test('pinning makes a tab an icon at the top; pin-tab orders them', async () => {
  const a = await openTab(jb, `${web.url}/one`)
  const b = await openTab(jb, `${web.url}/two`)
  const c = await openTab(jb, `${web.url}/three`)
  await jb.send('pin-tab', { id: a.id, target: null })
  let s = await jb.waitForState((s) => tabById(s, a.id)?.pinned, 'a pinned')
  // Pinning keeps it, on the page it's on.
  assert.equal(tabById(s, a.id)!.kept, true)
  assert.equal(tabById(s, a.id)!.home?.url, `${web.url}/one`)
  await waitFor(async () => (await pinIcons(jb)).includes(a.id), 'its icon')
  await waitRows(jb, (rows) => !rows.some((r) => r.id === a.id), 'no row for it')
  await jb.send('pin-tab', { id: b.id, target: null })
  await jb.send('pin-tab', { id: c.id, target: a.id })
  s = await jb.waitForState((s) => tabById(s, b.id)?.pinned && tabById(s, c.id)?.pinned, 'b and c pinned')
  await waitFor(async () => JSON.stringify(await pinIcons(jb)) === JSON.stringify([c.id, a.id, b.id]), 'icons c, a, b')
  await jb.send('pin-tab', { id: c.id, target: b.id, after: true })
  await waitFor(async () => JSON.stringify(await pinIcons(jb)) === JSON.stringify([a.id, b.id, c.id]), 'icons a, b, c')
  // Pinning next to a tab that isn't pinned does nothing.
  const d = await openTab(jb, `${web.url}/elsewhere`)
  await jb.send('pin-tab', { id: d.id, target: d.id })
  // Unpinning (Unpin in its menu) leaves it kept, as a row.
  await jb.send('move', { id: a.id, kept: true })
  s = await jb.waitForState((s) => !tabById(s, a.id)?.pinned && tabById(s, a.id)?.kept, 'a unpinned, kept')
  assert.ok(!tabById(s, d.id)!.pinned)
  await waitRows(jb, (rows) => rows.find((r) => r.id === a.id)?.kept, 'a row in Kept')
  assert.deepEqual(await pinIcons(jb), [b.id, c.id])
  // Clicking an icon opens its tab.
  const ui = await jb.ui()
  await ui.clickOn(`#pins .pin-tile[data-id="${b.id}"]`)
  await jb.waitForState((s) => s.activeId === b.id, 'b active')
})

test('closing a pinned tab keeps its icon', async () => {
  const t = await openTab(jb, `${web.url}/one`)
  await jb.send('pin-tab', { id: t.id, target: null })
  await jb.waitForState((s) => tabById(s, t.id)?.pinned, 'pinned')
  await jb.send('close', { id: t.id })
  const s = await jb.waitForState((s) => tabById(s, t.id) && s.activeId !== t.id, 'its page to close')
  assert.equal(tabById(s, t.id)!.pinned, true)
  assert.ok((await pinIcons(jb)).includes(t.id))
})
