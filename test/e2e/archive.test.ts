// Archiving tabs nobody looked at for a while, Undo, the Archived list, and sleeping tabs.
// jbrow archives when it sweeps (at launch, when it comes up, when these settings change), going
// by when each tab was last seen, so the tests start it with tabs.json saying they're old.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { TabRecord } from '../../src/shared/types'
import { html, launch, serve, waitFor, type Jbrow, type TestServer } from './harness'
import { activeTab, offline, tabById, waitLoaded, waitRows } from './tab-helpers'

const DAY = 24 * 60 * 60 * 1000
const now = Date.now()

let web: TestServer
before(async () => {
  web = await serve({ '/fresh': html('Fresh'), '/old': html('Old'), '/docs/page': html('Docs'), '/gone': html('Gone'), '/pinned': html('Pinned') })
})
after(() => web?.close())

const tab = (id: string, path: string, ageDays: number, more: Partial<TabRecord> = {}): TabRecord => ({
  id,
  profile: 'personal',
  url: `${web.url}${path}`,
  title: path.slice(1),
  createdAt: now - ageDays * DAY - 1000,
  lastSeen: now - ageDays * DAY,
  ...more,
})

const settings = () => ({ ...offline(web), archiveAfterDays: 7, summarizeAfterDays: 3 })

test('stale tabs archive at launch; Undo brings them back where they were', async () => {
  const jb = await launch({
    settings: settings(),
    tabs: {
      activeId: 'fresh',
      tabs: [tab('fresh', '/fresh', 0), tab('old', '/old', 30), tab('docs', '/docs/page', 30), tab('kept', '/old', 30, { kept: true })],
      folders: [{ id: 'docs-folder', name: 'Docs', rules: ['/docs/'], createdAt: now - 60 * DAY }],
      archived: [],
    },
  })
  try {
    const s = await jb.waitForState((s) => s.archiveNotice?.length, 'the archive notice')
    assert.deepEqual(s.archiveNotice, ['old'])
    assert.ok(!tabById(s, 'old'))
    assert.ok(tabById(s, 'fresh'))
    // Kept tabs never archive.
    assert.ok(tabById(s, 'kept'))
    // One matching a folder's rules moves into it instead, kept.
    assert.equal(tabById(s, 'docs')!.folder, 'docs-folder')
    assert.equal(tabById(s, 'docs')!.kept, true)
    assert.equal(tabById(s, 'docs')!.home?.url, `${web.url}/docs/page`)

    const ui = await jb.ui()
    await waitFor(() => ui.eval(`!document.getElementById('archiveNotice').hidden && document.getElementById('archiveNoticeText').textContent === 'Archived 1 tab'`), 'the notice in the sidebar')
    await waitFor(async () => /1 archived/.test(await ui.eval(`document.querySelector('.archived-link')?.textContent ?? ''`)), 'the archived link')

    await ui.clickOn('#undoArchive')
    const back = await jb.waitForState((s) => tabById(s, 'old') && !s.archiveNotice, 'the tab back')
    const old = tabById(back, 'old')!
    assert.equal(old.archivedAt, undefined)
    // Back in place: still last seen when it was, so it shows asleep, and it gets its full time
    // before archiving again.
    assert.equal(old.lastSeen, now - 30 * DAY)
    assert.ok(old.restoredAt && old.restoredAt >= now)
    await waitRows(jb, (rows) => rows.find((r) => r.id === 'old')?.classes.includes('asleep'), 'an asleep row')
    // A sweep (changing the setting runs one) leaves it alone now.
    await jb.send('prefs', { archiveAfterDays: 7 })
    await jb.send('rename', { id: 'fresh', name: 'marker' })
    const after = await jb.waitForState((s) => tabById(s, 'fresh')?.name === 'marker', 'the marker')
    assert.ok(tabById(after, 'old'))
    assert.equal(after.archiveNotice, null)
  } finally {
    await jb.close()
  }
})

test('unarchive, restore and forget-archived work on the Archived list', async () => {
  const jb = await launch({
    settings: settings(),
    tabs: {
      activeId: 'fresh',
      tabs: [tab('fresh', '/fresh', 0)],
      folders: [],
      archived: [
        tab('a1', '/old', 10, { archivedAt: now - DAY }),
        tab('a2', '/gone', 10, { archivedAt: now - DAY }),
        tab('a3', '/docs/page', 10, { archivedAt: now - DAY }),
        // Archived more than 90 days ago: forgotten at launch.
        tab('ancient', '/old', 200, { archivedAt: now - 100 * DAY }),
      ],
    },
  })
  try {
    const ui = await jb.ui()
    await waitFor(async () => /3 archived/.test(await ui.eval(`document.querySelector('.archived-link')?.textContent ?? ''`)), 'three archived')
    // Unarchive: back in the sidebar, as seen now, not active.
    await jb.send('unarchive', { ids: ['a1'] })
    let s = await jb.waitForState((s) => tabById(s, 'a1'), 'a1 back')
    assert.equal(s.activeId, 'fresh')
    assert.ok(tabById(s, 'a1')!.lastSeen >= now)
    assert.equal(tabById(s, 'a1')!.archivedAt, undefined)
    await waitRows(jb, (rows) => rows.some((r) => r.id === 'a1' && !r.classes.includes('asleep')), 'a1 in the sidebar, awake')
    // Restore: back and opened.
    await jb.send('restore', { id: 'a2' })
    s = await jb.waitForState((s) => s.activeId === 'a2', 'a2 active')
    await waitLoaded(jb, 'a2', `${web.url}/gone`)
    // Forget one: gone for good, no question asked for one.
    await jb.send('forget-archived', { ids: ['a3'] })
    await waitFor(async () => !(await ui.eval(`document.querySelector('.archived-link')`)), 'nothing archived')
    // Restoring a forgotten one does nothing.
    await jb.send('restore', { id: 'a3' })
    await jb.send('restore', { id: 'ancient' })
    await jb.send('rename', { id: 'fresh', name: 'marker' })
    s = await jb.waitForState((s) => tabById(s, 'fresh')?.name === 'marker', 'the marker')
    assert.ok(!tabById(s, 'a3') && !tabById(s, 'ancient'))
    assert.equal(s.activeId, 'a2')
    // What's saved agrees, once jbrow writes it.
    await waitFor(() => {
      const saved = jb.readJson<{ tabs: TabRecord[]; archived: TabRecord[] }>('tabs.json')
      return saved.archived.length === 0 && ['a1', 'a2'].every((id) => saved.tabs.some((t) => t.id === id))
    }, 'tabs.json to match')
  } finally {
    await jb.close()
  }
})

test('pinned tabs load at launch while kept ones wait, and sleep once not kept loaded', async () => {
  const jb = await launch({
    settings: { ...settings(), keepLoaded: { kept: false, pinned: true } },
    tabs: {
      activeId: 'fresh',
      tabs: [
        tab('fresh', '/fresh', 0),
        tab('pin', '/pinned', 5, { kept: true, pinned: true, order: 0, home: { url: `${web.url}/pinned`, title: 'pinned' } }),
        tab('kept', '/old', 5, { kept: true, order: 0, home: { url: `${web.url}/old`, title: 'old' } }),
      ],
      folders: [],
      archived: [],
    },
  })
  try {
    // The pinned page loads in the background; the kept one has no page until it's opened.
    let s = await waitLoaded(jb, 'pin', `${web.url}/pinned`, 'the pinned page to load')
    assert.equal(tabById(s, 'kept')!.loaded, false)
    assert.equal(activeTab(s)!.id, 'fresh')
    // Unseen for longer than summarizeAfterDays, the pinned page unloads once it's no longer kept loaded.
    await jb.send('prefs', { keepLoaded: { pinned: false } })
    s = await jb.waitForState((s) => !tabById(s, 'pin')?.loaded, 'the pinned page to unload')
    assert.equal(s.prefs.keepLoaded.pinned, false)
    // Still there, as an icon.
    assert.ok(tabById(s, 'pin')!.pinned)
    // Opening it loads it again.
    await jb.send('activate', { id: 'pin' })
    await waitLoaded(jb, 'pin', `${web.url}/pinned`)
  } finally {
    await jb.close()
  }
})

test('tabs unseen for days sleep: their page unloads and the sidebar shows a summary', async () => {
  const jb = await launch({
    settings: { ...settings(), archiveAfterDays: 0 },
    tabs: { activeId: 'fresh', tabs: [tab('fresh', '/fresh', 0), tab('old', '/old', 5)], folders: [], archived: [] },
  })
  try {
    // Nothing archives with archiving off.
    assert.ok(tabById(await jb.state(), 'old'))
    const rows = await waitRows(jb, (rows) => rows.find((r) => r.id === 'old')?.classes.includes('asleep'), 'an asleep row')
    assert.ok(!rows.find((r) => r.id === 'fresh')!.classes.includes('asleep'))
    const ui = await jb.ui()
    assert.ok(await ui.eval(`document.querySelector('#threads .row[data-id="old"] .sum')?.textContent`))
    // Opening it wakes it.
    await jb.send('activate', { id: 'old' })
    await waitLoaded(jb, 'old', `${web.url}/old`)
    await waitRows(jb, (rows) => !rows.find((r) => r.id === 'old')?.classes.includes('asleep'), 'an awake row')
  } finally {
    await jb.close()
  }
})
