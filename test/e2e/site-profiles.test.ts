// Sites with a profile of their own (profileSites): typed in the address bar, clicked in a page of
// another profile, opened in a new tab from one, and what stays put: a profile picked with Tab, a
// popup and a redirect.
import assert from 'node:assert/strict'
import { after, before, beforeEach, test } from 'node:test'
import { html, launch, serve, type Jbrow, type TestServer } from './harness'
import { activeTab, offline, realClick, shownPage, tabById, waitLoaded } from './tab-helpers'

let jb: Jbrow
let web: TestServer
/** The same server under the name that belongs to Personal. */
let home: string

before(async () => {
  web = await serve({})
  home = web.url.replace('127.0.0.1', 'localhost')
  web.route('/home', html('Home'))
  web.route('/redirect', { status: 302, headers: { location: `${home}/home` } })
  web.route(
    '/links',
    html(
      'Links',
      `<a id="here" href="${home}/home">here</a>
       <a id="blank" href="${home}/home" target="_blank">blank</a>
       <button id="popup" onclick="window.open('${home}/home', 'p', 'width=400,height=300')">popup</button>`,
    ),
  )
  jb = await launch({ settings: { ...offline(web), defaultProfile: 'work', profileSites: { personal: ['localhost'] } } })
})
after(async () => {
  await jb?.close()
  await web?.close()
})

beforeEach(async () => {
  const s = await jb.state()
  for (const t of s.tabs) await jb.send('close', { id: t.id })
  await jb.waitForState((s) => s.tabs.length === 1 && !s.tabs[0].url, 'one empty tab')
})

/** Opens the page of links in Work. */
async function workLinks() {
  const id = (await jb.state()).activeId!
  await jb.send('navigate', { input: `${web.url}/links` })
  const s = await waitLoaded(jb, id, `${web.url}/links`)
  assert.equal(tabById(s, id)!.profile, 'work')
  return { id, page: await shownPage(jb, `${web.url}/links`) }
}

const homeTab = (jb: Jbrow) => jb.waitForState((s) => s.tabs.find((t) => t.url.startsWith(`${home}/home`) && t.loaded), 'the site to open')

test('typed in an empty tab, the site takes the tab to its profile', async () => {
  const id = (await jb.state()).activeId!
  await jb.send('navigate', { input: `${home}/home` })
  const s = await waitLoaded(jb, id, `${home}/home`)
  assert.equal(tabById(s, id)!.profile, 'personal')
})

test('typed over a page of another profile, it opens next to it and the page stays', async () => {
  const { id, page } = await workLinks()
  page.close()
  await jb.send('navigate', { input: `${home}/home` })
  const s = await homeTab(jb)
  const opened = s.tabs.find((t) => t.url.startsWith(`${home}/home`))!
  assert.equal(opened.profile, 'personal')
  assert.equal(activeTab(s)!.id, opened.id)
  assert.ok(tabById(s, id)!.url.startsWith(`${web.url}/links`))
})

test('a profile picked with Tab wins', async () => {
  const id = (await jb.state()).activeId!
  await jb.send('navigate', { input: `${home}/home`, profile: 'work' })
  const s = await waitLoaded(jb, id, `${home}/home`)
  assert.equal(tabById(s, id)!.profile, 'work')
})

test('a link clicked in a Work page opens in Personal, and the Work page stays', async () => {
  const { id, page } = await workLinks()
  await realClick(page, '#here')
  page.close()
  const s = await homeTab(jb)
  assert.equal(s.tabs.find((t) => t.url.startsWith(`${home}/home`))!.profile, 'personal')
  assert.ok(tabById(s, id)!.url.startsWith(`${web.url}/links`))
})

test('a link to a new tab opens in Personal', async () => {
  const { page } = await workLinks()
  await realClick(page, '#blank')
  page.close()
  const s = await homeTab(jb)
  assert.equal(s.tabs.find((t) => t.url.startsWith(`${home}/home`))!.profile, 'personal')
})

test('a popup stays with its opener', async () => {
  const { id, page } = await workLinks()
  await realClick(page, '#popup')
  page.close()
  const s = await homeTab(jb)
  const popup = s.tabs.find((t) => t.url.startsWith(`${home}/home`))!
  assert.equal(popup.profile, 'work')
  assert.equal(popup.opener, id)
})

test('a redirect stays in the tab', async () => {
  const id = (await jb.state()).activeId!
  await jb.send('navigate', { input: `${web.url}/redirect` })
  const s = await waitLoaded(jb, id, `${home}/home`)
  assert.equal(tabById(s, id)!.profile, 'work')
  assert.equal(s.tabs.length, 1)
})
