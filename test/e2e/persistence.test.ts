// Quitting and starting again: tabs, Kept, folders, pins, splits, history and cookies come back.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { TabRecord } from '../../src/shared/types'
import { CMD, html, launch, removeDir, serve, tempDir, waitFor, type Jbrow, type TestServer } from './harness'
import { activate, activeTab, makeFolder, offline, openTab, pinIcons, tabById, waitLoaded, waitRows } from './tab-helpers'

let web: TestServer
let userData: string
let jb: Jbrow | undefined

before(async () => {
  web = await serve({
    '/one': html('One'),
    '/two': html('Two'),
    '/three': html('Three'),
    '/four': html('Four'),
    '/pin': html('Pin'),
    '/left': html('Left'),
    '/right': html('Right'),
    '/cookie/set': { headers: { 'set-cookie': 'kept=yes; Path=/; Max-Age=86400' }, body: html('Set') },
    '/cookie/get': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
      res.end(html(/kept=yes/.test(req.headers.cookie ?? '') ? 'Has cookie' : 'No cookie'))
    },
  })
  userData = tempDir()
})
after(async () => {
  await jb?.close()
  await web?.close()
  await removeDir(userData)
})

// Filled in by the first test, checked by the second.
const ids: Record<string, string> = {}
let folderId = ''

test('a session with tabs of every kind', async () => {
  jb = await launch({ userData, settings: offline(web) })
  try {
    await session(jb)
  } finally {
    // The next launch on the same folder needs this one gone.
    await jb.quit()
  }
})

async function session(jb: Jbrow) {
  // A tab with history, renamed.
  const one = await openTab(jb, `${web.url}/one`)
  await jb.send('navigate', { input: `${web.url}/two` })
  await waitLoaded(jb, one.id, `${web.url}/two`)
  await jb.send('rename', { id: one.id, name: 'Named' })
  ids.history = one.id
  // A kept tab in a folder, and a folder inside that one.
  const three = await openTab(jb, `${web.url}/three`)
  ids.kept = three.id
  folderId = await makeFolder(jb, 'Saved')
  await jb.send('folder', { id: folderId, rules: ['four'] })
  await jb.send('move', { id: three.id, kept: true, folder: folderId })
  // A pinned tab.
  const pin = await openTab(jb, `${web.url}/pin`)
  await jb.send('pin-tab', { id: pin.id, target: null })
  ids.pin = pin.id
  // A split.
  const left = await openTab(jb, `${web.url}/left`)
  const ui = await jb.ui()
  await ui.press('d', { modifiers: CMD })
  const s1 = await jb.waitForState((s) => s.splits.some((x) => x.tabs[0] === left.id && x.tabs.length === 2), 'a split')
  ids.left = left.id
  ids.right = s1.splits[0].tabs[1]
  await jb.send('navigate', { input: `${web.url}/right` })
  await waitLoaded(jb, ids.right, `${web.url}/right`)
  // A persistent cookie.
  const c = await openTab(jb, `${web.url}/cookie/set`)
  ids.cookie = c.id
  await jb.waitForState((s) => tabById(s, c.id)?.title === 'Set', 'the cookie page')
  // Back on the history tab, then a new tab that's still empty: that one isn't worth keeping.
  await activate(jb, one.id)
  await jb.send('new')
  await jb.waitForState((s) => !activeTab(s)?.url, 'an empty tab')
  await jb.send('activate', { id: one.id })
  await jb.waitForState(
    (s) => s.activeId === one.id && tabById(s, three.id)?.folder === folderId && tabById(s, pin.id)?.pinned && s.folders[0].name === 'Saved',
    'everything in place',
  )
  await jb.quit()
  // Quitting writes tabs.json right away.
  const saved = jb.readJson<{ tabs: TabRecord[]; activeId: string }>('tabs.json')
  assert.equal(saved.activeId, one.id)
  assert.equal(saved.tabs.length, 6)
}

test('everything comes back after a restart', async () => {
  assert.ok(ids.history, 'the first test ran')
  jb = await launch({ userData })
  const s = await jb.waitForState((s) => s.activeId === ids.history, 'the same active tab')
  // The empty tab didn't come back.
  assert.equal(s.tabs.length, 6)
  assert.ok(s.tabs.every((t) => t.url))
  const h = tabById(s, ids.history)!
  assert.equal(h.name, 'Named')
  assert.equal(h.url, `${web.url}/two`)
  assert.equal(tabById(s, ids.kept)!.folder, folderId)
  assert.equal(tabById(s, ids.kept)!.home?.url, `${web.url}/three`)
  assert.deepEqual(
    s.folders.map((f) => [f.id, f.name, f.rules]),
    [[folderId, 'Saved', ['four']]],
  )
  assert.equal(tabById(s, ids.pin)!.pinned, true)
  assert.deepEqual(s.splits.map((x) => x.tabs), [[ids.left, ids.right]])
  // Only the active tab and pinned pages load at launch.
  await waitLoaded(jb, ids.history, `${web.url}/two`)
  await waitLoaded(jb, ids.pin, `${web.url}/pin`)
  assert.equal(tabById(await jb.state(), ids.kept)!.loaded, false)
  // The sidebar draws it all.
  await waitRows(
    jb,
    (rows) => rows.find((r) => r.id === ids.history)?.title === 'Named' && rows.find((r) => r.id === ids.kept)?.folder === folderId,
    'the rows as they were',
  )
  assert.deepEqual(await pinIcons(jb), [ids.pin])
  // Back and forward come back too.
  await jb.waitForState((s) => s.nav.canGoBack, 'a back list')
  await jb.send('nav', { action: 'back' })
  await waitLoaded(jb, ids.history, `${web.url}/one`)
  // Opening one side of the split opens both.
  await activate(jb, ids.left)
  await waitLoaded(jb, ids.left, `${web.url}/left`)
  await waitLoaded(jb, ids.right, `${web.url}/right`)
  // The cookie is still there.
  await activate(jb, ids.cookie)
  await waitLoaded(jb, ids.cookie, `${web.url}/cookie/set`)
  await jb.send('navigate', { input: `${web.url}/cookie/get` })
  await jb.waitForState((s) => tabById(s, ids.cookie)?.title === 'Has cookie', 'the cookie')
})

test('a folder rule from the last session still files tabs', async () => {
  assert.ok(jb?.running, 'the second test ran')
  // A tab whose address matches the rule, archived because it's old, goes into the folder.
  await jb!.quit()
  const saved = jb!.readJson<{ tabs: TabRecord[]; activeId: string; folders: unknown[] }>('tabs.json')
  const old = Date.now() - 30 * 24 * 60 * 60 * 1000
  saved.tabs.push({ id: 'four', profile: 'personal', url: `${web.url}/four`, title: 'Four', createdAt: old, lastSeen: old })
  jb = await launch({ userData, tabs: saved, settings: { archiveAfterDays: 7 } })
  const s = await jb.waitForState((s) => tabById(s, 'four')?.kept, 'the tab filed')
  assert.equal(tabById(s, 'four')!.folder, folderId)
})

test('a broken tabs.json starts empty rather than not at all', async () => {
  const dir = tempDir()
  const broken = await launch({ userData: dir, files: { 'tabs.json': '{ not json' }, settings: offline(web) })
  try {
    const s = await broken.state()
    assert.equal(s.tabs.length, 1)
    assert.equal(activeTab(s)!.url, '')
    // It works as usual.
    await broken.navigate(`${web.url}/one`)
    await waitFor(() => broken.running, 'jbrow to keep running')
  } finally {
    await broken.close()
    await removeDir(dir)
  }
})

test('an address typed while a tab is getting its history back is where it ends up', async () => {
  const dir = tempDir()
  const now = Date.now()
  const rec = (id: string, path: string) => ({ id, profile: 'personal', url: `${web.url}${path}`, title: path, createdAt: now, lastSeen: now })
  const restored = await launch({
    userData: dir,
    settings: offline(web),
    tabs: { activeId: 'a', tabs: [rec('a', '/one'), rec('b', '/three')], folders: [], archived: [] },
    // Tab b was on /three, after /two.
    files: { 'history.json': JSON.stringify({ b: { index: 1, entries: [{ url: `${web.url}/two`, title: 'Two' }, { url: `${web.url}/three`, title: 'Three' }] } }) },
  })
  try {
    await restored.waitForState((s) => s.activeId === 'a', 'tab a active')
    // Opening b starts bringing its history back; the address goes in before that's done.
    await restored.send('activate', { id: 'b' })
    await restored.send('navigate', { input: `${web.url}/four` })
    await waitLoaded(restored, 'b', `${web.url}/four`)
    // One step further than where it was, with what came before still there.
    await restored.send('nav', { action: 'back' })
    await waitLoaded(restored, 'b', `${web.url}/three`)
    await restored.send('nav', { action: 'back' })
    await waitLoaded(restored, 'b', `${web.url}/two`)
  } finally {
    await restored.close()
    await removeDir(dir)
  }
})
