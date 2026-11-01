// The history page (⌘Y): visits recorded with how you got there and their trail, found by the
// text that was on the page, the Searches view, opening a page from it and forgetting one.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { CMD, html, launch, serve, waitFor, type Cdp, type Jbrow, type TestServer } from './harness'
import { realClick, shownPage } from './tab-helpers'
import { activeTab, offline } from './ui-helpers'

let jb: Jbrow
let web: TestServer
let ui: Cdp

before(async () => {
  web = await serve({
    '/': html('Alpha home', '<a id="wal" href="/wal">Logging</a>'),
    '/wal': html('Write-Ahead Logging', '<p>By default a checkpoint runs when the WAL reaches 1000 pages.</p>'),
    '/search': (req, res) => {
      const q = new URL(req.url ?? '/', 'http://x').searchParams.get('q') ?? ''
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html(`Results for ${q}`))
    },
  })
  jb = await launch({ settings: offline(web) })
  ui = await jb.ui()
  // A search, then an address typed, then a link followed from it.
  await jb.send('navigate', { input: 'lentil soup' })
  await jb.waitForState((s) => activeTab(s)?.url.includes('/search?q=lentil') && !activeTab(s)!.loading, 'the search')
  await jb.navigate(`${web.url}/`)
  const page = await shownPage(jb, `${web.url}/`)
  // A real click, quick as it is: a page you clicked in is no redirect.
  await realClick(page, '#wal')
  await jb.waitForState((s) => activeTab(s)?.url === `${web.url}/wal` && activeTab(s)?.title === 'Write-Ahead Logging', 'the linked page')
  // Its text is kept a few seconds after it arrives.
  await new Promise((r) => setTimeout(r, 5000))
  await ui.press('y', { modifiers: CMD })
  await waitFor(() => ui.eval(`!document.getElementById('history').hidden && !!document.querySelector('[data-hist-results] .hist-trail')`), 'the history page')
})
after(async () => {
  await jb?.close()
  await web?.close()
})

const results = () => ui.eval<string>(`document.querySelector('[data-hist-results]').innerText`)
async function search(text: string) {
  await ui.eval(`(() => { const i = document.querySelector('[data-hist-text]'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input')) })()`)
}

test('trails start with how you got there and hold the pages that followed', async () => {
  const trails = await waitFor(
    async () => {
      const t = await ui.eval<{ name: string; pages: string[] }[]>(
        `[...document.querySelectorAll('.hist-trail')].map((t) => ({ name: t.dataset.name, pages: [...t.querySelectorAll('.hist-row .t')].map((x) => x.textContent) }))`,
      )
      return t.length === 2 && t
    },
    'two trails',
  )
  assert.deepEqual(trails, [
    { name: `Typed ${new URL(web.url).host}`, pages: ['Alpha home', 'Write-Ahead Logging'] },
    { name: 'Searched “lentil soup”', pages: ['Results for lentil soup'] },
  ])
})

test('finds a page by what it said, showing where', async () => {
  await search('checkpoint')
  try {
    assert.equal(await waitFor(() => ui.eval(`document.querySelector('.hist-row .snip mark')?.textContent`), 'where it matched'), 'checkpoint')
    assert.deepEqual(await ui.eval(`[...document.querySelectorAll('.hist-row .t')].map((x) => x.textContent)`), ['Write-Ahead Logging'])
  } finally {
    await search('')
  }
})

test('the Searches view lists what was searched', async () => {
  await ui.eval(`document.querySelector('[data-hist-view=searches]').click()`)
  await waitFor(async () => (await results()).includes('lentil soup'), 'the search')
})

test('forgetting a page takes it out of history', async () => {
  await ui.eval(`document.querySelector('[data-hist-view=pages]').click()`)
  await waitFor(async () => (await results()).includes('Alpha home'), 'the pages')
  await ui.eval(`[...document.querySelectorAll('.hist-row')].find((r) => r.innerText.includes('Alpha home')).querySelector('[data-hist-forget]').click()`)
  await waitFor(async () => !(await results()).includes('Alpha home'), 'the page to go')
})

test('a page opens in a new tab and history closes; Escape closes it too', async () => {
  const before = (await jb.state()).tabs.length
  await ui.eval(`[...document.querySelectorAll('.hist-row a.title')].find((a) => a.innerText.includes('Write-Ahead')).click()`)
  await jb.waitForState((s) => s.tabs.length === before + 1, 'a new tab')
  await waitFor(() => ui.eval(`document.getElementById('history').hidden`), 'history to close')
  await ui.press('y', { modifiers: CMD })
  await waitFor(() => ui.eval(`!document.getElementById('history').hidden`), 'history again')
  await ui.press('Escape')
  await waitFor(() => ui.eval(`document.getElementById('history').hidden`), 'Escape to close it')
})
