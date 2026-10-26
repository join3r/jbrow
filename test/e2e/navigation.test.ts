// Typing addresses and searches, page titles and icons, back, forward, reload and stop.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { html, launch, serve, waitFor, type Jbrow, type TestServer } from './harness'
import { activeTab, offline, openTab, sidebarRows, waitLoaded, waitRows } from './tab-helpers'

let jb: Jbrow
let web: TestServer

// A 1×1 PNG.
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

before(async () => {
  web = await serve({
    '/a': html('Page A', '<a id="next" href="/b">to b</a>'),
    '/b': html('Page B'),
    '/c': html('Page C'),
    '/icon': html('With icon', '').replace('<title>', '<link rel="icon" href="/icon.png"><title>'),
    '/icon.png': { headers: { 'content-type': 'image/png' }, body: PNG },
    '/retitle': html('First title', '<script>setTimeout(() => (document.title = "Second title"), 50)</script>'),
    // localhost is another site than 127.0.0.1, so the frame gets its own process.
    '/framed': (req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' })
      res.end(html('Framed', `<iframe src="http://localhost:${req.socket.localPort}/ua"></iframe>`))
    },
    '/ua': html('UA', '<script>parent.postMessage(navigator.userAgent, "*")</script>'),
    '/count': { headers: { 'cache-control': 'no-store' }, body: html('Counted') },
    // Never answers; closing the server drops the connection.
    '/slow': () => {},
    '/search': (req, res) => {
      const q = new URL(req.url ?? '/', 'http://x').searchParams.get('q') ?? ''
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html(`Results for ${q}`))
    },
  })
  jb = await launch({ settings: offline(web) })
})
after(async () => {
  await jb?.close()
  await web?.close()
})

test('an address with a scheme opens as it is, with the page title', async () => {
  const t = await openTab(jb, `${web.url}/a`)
  assert.equal(t.url, `${web.url}/a`)
  const s = await jb.waitForState((s) => activeTab(s)?.title === 'Page A', 'the title')
  assert.equal(activeTab(s)!.loaded, true)
  // The sidebar shows it, by title, as the current row.
  await waitRows(jb, (rows) => rows.some((r) => r.id === t.id && r.title === 'Page A' && r.classes.includes('cur')), 'a current row titled Page A')
})

test('words go to the search engine', async () => {
  await jb.send('new')
  await jb.waitForState((s) => activeTab(s) && !activeTab(s)!.url, 'an empty tab')
  await jb.send('navigate', { input: 'hello jbrow tests' })
  const s = await jb.waitForState((s) => activeTab(s)?.title === 'Results for hello jbrow tests', 'the search results')
  assert.equal(activeTab(s)!.url, `${web.url}/search?q=hello%20jbrow%20tests`)
  assert.ok(web.hits.includes('/search'))
})

test('search: true searches even for something that looks like an address', async () => {
  await jb.send('new')
  await jb.waitForState((s) => activeTab(s) && !activeTab(s)!.url, 'an empty tab')
  await jb.send('navigate', { input: 'example.com', search: true })
  const s = await jb.waitForState((s) => activeTab(s)?.title === 'Results for example.com', 'the search results')
  assert.equal(activeTab(s)!.url, `${web.url}/search?q=example.com`)
})

test('a host name without a scheme goes to https', async () => {
  // .invalid never resolves, so nothing leaves the machine.
  for (const [input, url] of [
    ['jbrow-test.invalid', 'https://jbrow-test.invalid'],
    ['jbrow-test.invalid/some/path?x=1', 'https://jbrow-test.invalid/some/path?x=1'],
    ['localhost:9/x', 'https://localhost:9/x'],
  ]) {
    await jb.send('new')
    await jb.waitForState((s) => activeTab(s) && !activeTab(s)!.url, 'an empty tab')
    await jb.send('navigate', { input })
    await jb.waitForState((s) => activeTab(s)?.url.replace(/\/$/, '') === url, `${input} to become ${url}`)
  }
  // A word with a space in it is a search, dots or not.
  await jb.send('new')
  await jb.waitForState((s) => activeTab(s) && !activeTab(s)!.url, 'an empty tab')
  await jb.send('navigate', { input: 'node.js docs' })
  await jb.waitForState((s) => activeTab(s)?.title === 'Results for node.js docs', 'a search for node.js docs')
})

test('a title the page changes later updates the tab', async () => {
  const t = await openTab(jb, `${web.url}/retitle`)
  await jb.waitForState((s) => s.tabs.find((x) => x.id === t.id)?.title === 'Second title', 'the second title')
  await waitRows(jb, (rows) => rows.some((r) => r.id === t.id && r.title === 'Second title'), 'the row to show the second title')
})

test('the favicon comes through jbrow and shows in the sidebar', async () => {
  const t = await openTab(jb, `${web.url}/icon`)
  const s = await jb.waitForState((s) => s.tabs.find((x) => x.id === t.id)?.favicon, 'a favicon')
  const fav = s.tabs.find((x) => x.id === t.id)!.favicon!
  assert.match(fav, /^jbrow-icon:/)
  assert.equal(new URL(fav).searchParams.get('u'), `${web.url}/icon.png`)
  assert.equal(new URL(fav).searchParams.get('p'), activeTab(s)!.profile)
  const ui = await jb.ui()
  await waitFor(
    () =>
      ui.call((id) => {
        const img = document.querySelector<HTMLImageElement>(`#threads .row[data-id="${id}"] img.fav`)
        return !!img && img.complete && img.naturalWidth === 1
      }, t.id),
    'the icon to load in the sidebar',
  )
  assert.ok(web.hits.includes('/icon.png'))
})

test('back and forward move through the tab history', async () => {
  const t = await openTab(jb, `${web.url}/a`)
  let s = await jb.state()
  assert.equal(s.nav.canGoBack, false)
  // A link click, then a typed address.
  const page = await jb.page(`${web.url}/a`)
  await page.eval('document.getElementById("next").click()')
  await waitLoaded(jb, t.id, `${web.url}/b`)
  page.close()
  await jb.send('navigate', { input: `${web.url}/c` })
  s = await waitLoaded(jb, t.id, `${web.url}/c`)
  await jb.waitForState((s) => s.nav.canGoBack && !s.nav.canGoForward, 'back but not forward')

  await jb.send('nav', { action: 'back' })
  await waitLoaded(jb, t.id, `${web.url}/b`)
  s = await jb.waitForState((s) => s.nav.canGoForward && s.nav.canGoBack, 'back and forward both')
  await jb.send('nav', { action: 'back' })
  await waitLoaded(jb, t.id, `${web.url}/a`)
  s = await jb.waitForState((s) => s.nav.canGoForward && !s.nav.canGoBack, 'only forward')
  assert.equal(activeTab(s)!.title, 'Page A')

  await jb.send('nav', { action: 'forward' })
  await waitLoaded(jb, t.id, `${web.url}/b`)
  await jb.send('nav', { action: 'forward' })
  s = await waitLoaded(jb, t.id, `${web.url}/c`)
  await jb.waitForState((s) => !s.nav.canGoForward, 'no forward at the end')
  // Still one tab: none of this opened another.
  assert.equal(s.tabs.filter((x) => x.url.startsWith(web.url + '/') && x.id === t.id).length, 1)
})

test('reload loads the page again', async () => {
  const t = await openTab(jb, `${web.url}/count`)
  const hits = () => web.hits.filter((h) => h === '/count').length
  const before = hits()
  await jb.send('nav', { action: 'reload' })
  await waitFor(() => hits() > before, 'a second request')
  await waitLoaded(jb, t.id, `${web.url}/count`)
  await jb.send('nav', { action: 'reload', hard: true })
  await waitFor(() => hits() > before + 1, 'a third request')
  await waitLoaded(jb, t.id, `${web.url}/count`)
})

test('stop ends a load that takes too long', async () => {
  const t = await openTab(jb, `${web.url}/a`)
  await jb.send('navigate', { input: `${web.url}/slow` })
  await waitFor(() => web.hits.includes('/slow'), 'the slow request')
  await jb.waitForState((s) => s.tabs.find((x) => x.id === t.id)?.loading && s.nav.loading, 'the tab to be loading')
  await jb.send('nav', { action: 'stop' })
  const s = await jb.waitForState((s) => !s.tabs.find((x) => x.id === t.id)?.loading && !s.nav.loading, 'loading to stop')
  // It never got there: the page that was showing stays.
  assert.equal(s.tabs.find((x) => x.id === t.id)!.title, 'Page A')
  const rows = await sidebarRows(jb)
  assert.ok(!rows.find((r) => r.id === t.id)?.classes.includes('loading'))
})

test('a frame from another site sees the same user agent as the page', async () => {
  // Cloudflare's Turnstile runs in one, and fails a browser whose frame says Electron while its
  // requests say Chrome (bistro.sk's login).
  await openTab(jb, `${web.url}/framed`)
  const page = await jb.page(`${web.url}/framed`)
  const framed = await page.eval<string>(`new Promise((resolve) => {
    addEventListener('message', (e) => resolve(e.data))
    document.querySelector('iframe').src += '?again'
  })`)
  assert.equal(framed, await page.eval<string>('navigator.userAgent'))
  assert.doesNotMatch(framed, /Electron/)
})
