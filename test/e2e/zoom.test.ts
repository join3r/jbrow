// Page zoom: ⌘+, ⌘− and ⌘0 per site, the sites list in the state, 'zoom-reset', the default zoom
// and remembering zooms across a relaunch.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { CMD, html, launch, removeDir, serve, tempDir, waitFor, type Cdp, type Jbrow, type TestServer } from './harness'
import { activeTab, offline, openTab } from './ui-helpers'

let jb: Jbrow
let web: TestServer
let userData: string
/** The pages' devicePixelRatio at 100%, which is 2 on a Retina screen. */
let base = 1

before(async () => {
  web = await serve({ '/a': html('A'), '/b': html('B') })
  userData = tempDir()
  jb = await launch({ userData, settings: offline(web) })
})
after(async () => {
  await jb?.close()
  await web?.close()
  await removeDir(userData)
})

/** The zoom a page is shown at, in percent. */
const percentOf = async (page: Cdp) => Math.round(((await page.eval<number>('devicePixelRatio')) / base) * 100)
const waitPercent = (page: Cdp, percent: number, what: string) =>
  waitFor(async () => (await percentOf(page)) === percent, `${what} (${percent}%)`)
const sites = async () => (await jb.state()).zoomSites
const SITE = '127.0.0.1'

test('⌘+ and ⌘− in a page step through the zoom levels and remember the site', async () => {
  await openTab(jb, `${web.url}/a`)
  const page = await jb.page(`${web.url}/a`)
  base = await page.eval<number>('devicePixelRatio')
  await page.press('=', { modifiers: CMD })
  await jb.waitForState((s) => s.zoomSites.some((z) => z.site === SITE && z.percent === 110), 'the site at 110%')
  await waitPercent(page, 110, 'the page to zoom in')
  await waitFor(async () => (await jb.toasts()).includes('Zoom 110%'), 'the toast')
  await page.press('=', { modifiers: CMD })
  await jb.waitForState((s) => s.zoomSites.some((z) => z.site === SITE && z.percent === 125), '125%')
  await waitFor(() => jb.readJson('settings.json').zoom.sites[SITE] === 125, 'settings.json to have it')
  // 125 → 110 → 100 → 90.
  for (let i = 0; i < 3; i++) await page.press('-', { modifiers: CMD })
  await jb.waitForState((s) => s.zoomSites.some((z) => z.site === SITE && z.percent === 90), '90%')
  await waitPercent(page, 90, 'the page to zoom out')
  page.close()
})

test('another tab of the same site gets its zoom', async () => {
  await openTab(jb, `${web.url}/b`)
  const page = await jb.page(`${web.url}/b`)
  await waitPercent(page, 90, 'the second tab')
  page.close()
})

test('⌘0 in the UI puts the site back to the default', async () => {
  const ui = await jb.ui()
  await ui.press('0', { modifiers: CMD })
  await jb.waitForState((s) => !s.zoomSites.some((z) => z.site === SITE), 'the site to leave the list')
  const page = await jb.page(`${web.url}/b`)
  await waitPercent(page, 100, 'the page back at 100%')
  assert.equal(jb.readJson('settings.json').zoom.sites[SITE], undefined)
  page.close()
})

test("'zoom-reset' forgets a site's zoom", async () => {
  const page = await jb.page(`${web.url}/b`)
  await page.press('=', { modifiers: CMD })
  await jb.waitForState((s) => s.zoomSites.some((z) => z.site === SITE), 'a zoomed site')
  await jb.send('zoom-reset', { site: SITE })
  await jb.waitForState((s) => !s.zoomSites.length, 'no zoomed sites')
  await waitPercent(page, 100, 'the page back at 100%')
  page.close()
})

test('the default zoom applies to sites you have not zoomed', async () => {
  const page = await jb.page(`${web.url}/b`)
  await jb.send('prefs', { zoom: { defaultPercent: 125 } })
  await jb.waitForState((s) => s.prefs.zoom.defaultPercent === 125, 'the new default')
  await waitPercent(page, 125, 'the page at the new default')
  // ⌘0 goes back to the default, not to 100%.
  await page.press('=', { modifiers: CMD })
  await waitPercent(page, 150, 'one step up')
  await page.press('0', { modifiers: CMD })
  await waitPercent(page, 125, 'back to the default')
  await jb.waitForState((s) => !s.zoomSites.length, 'the default is not a zoom of its own')
  await jb.send('prefs', { zoom: { defaultPercent: 100 } })
  await waitPercent(page, 100, 'back at 100%')
  page.close()
})

test('a remembered zoom survives a relaunch; not remembering keeps it out of settings.json', async () => {
  let page = await jb.page(`${web.url}/b`)
  await page.press('=', { modifiers: CMD })
  await jb.waitForState((s) => s.zoomSites.some((z) => z.site === SITE && z.percent === 110), '110%')
  page.close()
  await jb.quit()

  jb = await launch({ userData })
  await jb.waitForState((s) => s.zoomSites.some((z) => z.site === SITE && z.percent === 110), 'the zoom after the relaunch')
  await jb.navigate(`${web.url}/a`, { newTab: true })
  page = await jb.page(`${web.url}/a`)
  await waitPercent(page, 110, 'a page of the site after the relaunch')

  // Turned off, the zoom lasts until quit but leaves settings.json.
  await jb.send('prefs', { zoom: { remember: false } })
  await jb.waitForState((s) => !s.prefs.zoom.remember, 'remember off')
  await waitFor(() => !Object.keys(jb.readJson('settings.json').zoom.sites).length, 'the zooms to leave settings.json')
  assert.deepEqual(await sites(), [{ site: SITE, percent: 110 }])
  await waitPercent(page, 110, 'the page keeps its zoom')
  await page.press('=', { modifiers: CMD })
  await jb.waitForState((s) => s.zoomSites.some((z) => z.percent === 125), '125% for now')
  assert.deepEqual(jb.readJson('settings.json').zoom.sites, {})
  assert.equal(activeTab(await jb.state())?.url, `${web.url}/a`)
  page.close()
})
