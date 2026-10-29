// Profiles: which profile a tab is in, moving tabs between them, and keeping their cookies apart.
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { launch, serve, waitFor, type Jbrow, type TestServer } from './harness'
import { activeTab, cookieRoutes, offline, realClick, tabById, waitLoaded, waitRows } from './tab-helpers'

let jb: Jbrow
let web: TestServer

before(async () => {
  web = await serve(cookieRoutes)
  // The default two profiles, Work and Personal, with new tabs in Personal.
  jb = await launch({ settings: { ...offline(web), defaultProfile: 'personal' } })
})
after(async () => {
  await jb?.close()
  await web?.close()
})

beforeEach(async () => {
  await jb.send('filter', { filter: 'all' })
  const s = await jb.state()
  for (const t of s.tabs) await jb.send('close', { id: t.id })
  await jb.waitForState((s) => s.tabs.length === 1 && !s.tabs[0].url && s.filter === 'all', 'one empty tab')
})

/** Opens `url` in a new tab in `profile`, as picking the profile with Tab in the address bar does. */
async function openIn(profile: string, url: string) {
  await jb.send('new')
  const s0 = await jb.waitForState((s) => activeTab(s) && !activeTab(s)!.url, 'an empty tab')
  const id = s0.activeId!
  await jb.send('navigate', { input: url, profile })
  const s = await waitLoaded(jb, id, url)
  assert.equal(tabById(s, id)!.profile, profile)
  return id
}

const titleOf = (id: string) => jb.waitForState((s) => !tabById(s, id)?.loading && tabById(s, id)?.title, 'a title').then((s) => tabById(s, id)!.title)

test('new tabs open in the default profile', async () => {
  const s = await jb.state()
  assert.equal(activeTab(s)!.profile, 'personal')
  assert.deepEqual(
    s.profiles.map((p) => p.id),
    ['work', 'personal'],
  )
})

test('each profile has cookies of its own', async () => {
  const work = await openIn('work', `${web.url}/set?v=work`)
  const personal = await openIn('personal', `${web.url}/set?v=home`)
  await jb.send('activate', { id: work })
  await jb.send('navigate', { input: `${web.url}/get` })
  await waitLoaded(jb, work, `${web.url}/get`)
  assert.equal(await titleOf(work), 'cookie work')
  await jb.send('activate', { id: personal })
  await jb.waitForState((s) => s.activeId === personal, 'personal active')
  await jb.send('navigate', { input: `${web.url}/get` })
  await waitLoaded(jb, personal, `${web.url}/get`)
  assert.equal(await titleOf(personal), 'cookie home')
  // A fresh tab in a profile sees that profile's cookie.
  const another = await openIn('work', `${web.url}/get`)
  assert.equal(await titleOf(another), 'cookie work')
})

test('set-profile moves the tab itself, an empty one or a loaded page, which loads again there', async () => {
  const empty = (await jb.state()).activeId!
  await jb.send('set-profile', { profile: 'work' })
  let s = await jb.waitForState((s) => tabById(s, empty)?.profile === 'work', 'the empty tab in Work')
  assert.equal(s.tabs.length, 1)

  await openIn('work', `${web.url}/set?v=moved`)
  const id = await openIn('personal', `${web.url}/get`)
  const count = (await jb.state()).tabs.length
  await jb.send('set-profile', { profile: 'work' })
  s = await jb.waitForState((s) => tabById(s, id)?.profile === 'work', 'the tab in Work')
  assert.equal(s.activeId, id)
  assert.equal(s.tabs.length, count)
  // The page loaded again with Work's cookies.
  await jb.waitForState((s) => tabById(s, id)?.title === 'cookie moved', "the page with Work's cookie")
  // The sidebar marks it with its new profile's color.
  const ui = await jb.ui()
  const work = s.profiles.find((p) => p.id === 'work')!
  await waitFor(
    () => ui.call((id) => getComputedStyle(document.querySelector(`#threads .row[data-id="${id}"]`)!).getPropertyValue('--pc').trim(), id).then((c) => c === work.color),
    'the row in Work\'s color',
  )
})

test("clicking the profile in the address bar reloads the tab in the other one", async () => {
  await openIn('personal', `${web.url}/set?v=chip`)
  const id = await openIn('work', `${web.url}/get?before`)
  await jb.send('navigate', { input: `${web.url}/get` })
  await waitLoaded(jb, id, `${web.url}/get`)
  const ui = await jb.ui()
  // Not while typing in the address bar: there it picks where what's typed opens, as Tab does.
  await ui.eval('document.activeElement.blur()')
  await waitFor(async () => (await ui.eval('document.getElementById("profileName").textContent')) === 'Work', 'the Work chip')
  await realClick(ui, '#profileName')
  const s = await jb.waitForState((s) => tabById(s, id)?.profile === 'personal' && tabById(s, id)?.title === 'cookie chip', 'the tab in Personal')
  assert.equal(s.activeId, id)
  await waitFor(async () => (await ui.eval('document.getElementById("profileName").textContent')) === 'Personal', 'the Personal chip')
  // Back still goes where it went.
  await jb.waitForState((s) => s.nav.canGoBack, 'back to the page before')
  await jb.send('nav', { action: 'back' })
  await waitLoaded(jb, id, `${web.url}/get?before`)
})

test('typing an address with another profile picked opens it next to the loaded page', async () => {
  const personal = await openIn('personal', `${web.url}/get`)
  await jb.send('navigate', { input: `${web.url}/get?x`, profile: 'work' })
  const s = await jb.waitForState((s) => s.activeId !== personal && activeTab(s)?.profile === 'work', 'a new Work tab')
  assert.equal(tabById(s, personal)!.url, `${web.url}/get`)
  await waitLoaded(jb, s.activeId!, `${web.url}/get?x`)
  // An unknown profile is ignored: the address opens in the tab's own.
  await jb.send('navigate', { input: `${web.url}/get?y`, profile: 'nope' })
  await waitLoaded(jb, s.activeId!, `${web.url}/get?y`)
  assert.equal(activeTab(await jb.state())!.profile, 'work')
})

test('filtering to a profile shows only its tabs, and new tabs open in it', async () => {
  const work = await openIn('work', `${web.url}/get?w`)
  const personal = await openIn('personal', `${web.url}/get?p`)
  await jb.send('filter', { filter: 'work' })
  // The active tab isn't in Work, so the Work tab comes up.
  let s = await jb.waitForState((s) => s.filter === 'work' && s.activeId === work, 'the Work tab active')
  await waitRows(jb, (rows) => rows.some((r) => r.id === work) && !rows.some((r) => r.id === personal), 'only the Work row')
  await jb.send('new')
  s = await jb.waitForState((s) => !activeTab(s)?.url, 'a new tab')
  assert.equal(activeTab(s)!.profile, 'work')
  await jb.send('filter', { filter: 'all' })
  await waitRows(jb, (rows) => rows.some((r) => r.id === work) && rows.some((r) => r.id === personal), 'both rows')
})

test('with more than two profiles, clicking the profile in the address bar offers them all', async () => {
  await jb.send('add-profile', { rename: false })
  const third = (await jb.waitForState((s) => s.profiles.length === 3, 'a third profile')).profiles[2]
  const id = await openIn('work', `${web.url}/get?third`)
  const ui = await jb.ui()
  await ui.eval('document.activeElement.blur()')
  await realClick(ui, '#profileName')
  await waitFor(() => ui.eval('!document.getElementById("profilePop").hidden'), 'the profile menu')
  const items = await ui.eval<{ name: string; checked: string | null }[]>(
    '[...document.querySelectorAll("#profilePop [data-profile]")].map((b) => ({ name: b.textContent, checked: b.getAttribute("aria-checked") }))',
  )
  assert.deepEqual(items, [
    { name: 'Work', checked: 'true' },
    { name: 'Personal', checked: 'false' },
    { name: third.name, checked: 'false' },
  ])
  await realClick(ui, `#profilePop [data-profile="${third.id}"]`)
  await jb.waitForState((s) => tabById(s, id)?.profile === third.id, 'the tab in the third profile')
  await waitFor(() => ui.eval('document.getElementById("profilePop").hidden'), 'the menu closed')
  await waitLoaded(jb, id, `${web.url}/get?third`)
})
