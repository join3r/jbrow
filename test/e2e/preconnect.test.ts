// Connecting ahead (src/main/preconnect.ts): the address bar's completion and highlighted
// suggestion, the search engine as the bar opens, a tab without its page under the pointer. Each
// site is a server of its own that counts the connections it gets, so a connection that brought
// no request is one jbrow opened ahead. The tab ends up on a server of its own, as the sidebar
// keeps asking the current page's site for its favicon.
import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { after, before, test } from 'node:test'
import type { SuggestReply } from '../../src/shared/types'
import { html, launch, sleep, waitFor, type Cdp, type Jbrow } from './harness'
import { activeTab, focusedId, offline, record } from './ui-helpers'

interface Site {
  url: string
  connections: () => number
  requests: () => number
  /** Drops every connection, so the next one jbrow wants is a new one. */
  drop: () => void
  close: () => Promise<void>
}

async function site(title: string): Promise<Site> {
  let connections = 0
  let requests = 0
  const server: Server = createServer((_req, res) => {
    requests++
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(html(title))
  })
  server.on('connection', () => void connections++)
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    connections: () => connections,
    requests: () => requests,
    drop: () => server.closeAllConnections(),
    close: () => new Promise<void>((r) => (server.closeAllConnections(), server.close(() => r()))),
  }
}

let jb: Jbrow
let search: Site
let alpha: Site
let secret: Site
let sleepy: Site
let home: Site
/** A page whose title, not its host, matches what's typed: it shows as a history row. */
let zebra: Site
/** alpha.test and secret.test with their servers' ports. */
let alphaUrl: string
let secretUrl: string

before(async () => {
  ;[search, alpha, secret, sleepy, home, zebra] = await Promise.all([site('Results'), site('Alpha'), site('Secret'), site('Sleepy'), site('Home'), site('Zebra Notes')])
  alphaUrl = alpha.url.replace('127.0.0.1', 'alpha.test')
  secretUrl = secret.url.replace('127.0.0.1', 'secret.test')
  jb = await launch({
    settings: { ...offline(), searchUrl: `${search.url}/search?q=%s`, preconnect: true, prerender: false, privateUrls: ['secret.test'] },
    args: ['--host-resolver-rules=MAP alpha.test 127.0.0.1, MAP secret.test 127.0.0.1'],
    tabs: {
      activeId: 'here',
      tabs: [
        { id: 'here', profile: 'personal', url: `${home.url}/`, title: 'Home', createdAt: Date.now(), lastSeen: Date.now() },
        // Kept with no page: it loads only when opened.
        { id: 'sleepy', profile: 'personal', url: `${sleepy.url}/`, title: 'Sleepy', createdAt: Date.now(), lastSeen: Date.now(), kept: true, order: 0, home: { url: `${sleepy.url}/`, title: 'Sleepy' } },
      ],
      folders: [],
      archived: [],
    },
  })
  // alpha.test and secret.test in the history, so typing their start completes to them.
  // The search engine and the home page, so neither is new to it either.
  for (const url of [`${alphaUrl}/`, `${secretUrl}/`, `${zebra.url}/notes`, `${search.url}/search?q=x`, `${home.url}/back`]) {
    await jb.navigate(url)
    await jb.waitForState((s) => activeTab(s)?.url === url && !activeTab(s)!.loading, `${url} to load`)
  }
})
after(async () => {
  await jb?.close()
  await Promise.all([search, alpha, secret, sleepy, home, zebra].map((s) => s?.close()))
})

/** Waits for a connection to `s` that no request came over. */
async function waitPreconnected(s: Site, from: { connections: number; requests: number }, what: string) {
  await waitFor(() => s.connections() > from.connections, what)
  assert.equal(s.requests(), from.requests, 'nothing was loaded')
}
const counts = (s: Site) => ({ connections: s.connections(), requests: s.requests() })

/** Waits long enough that a connection jbrow was going to open would have come. */
async function assertNoConnection(s: Site, from: { connections: number }) {
  await sleep(600)
  assert.equal(s.connections(), from.connections)
}

async function focusOmnibox(ui: Cdp) {
  await jb.send('focus-ui')
  await ui.eval('omnibox.blur(); omnibox.focus()')
  await waitFor(async () => (await focusedId(ui)) === 'omnibox', 'the address bar to have focus')
}

test('the completion of what is typed gets a connection ahead', async () => {
  // Waits out the repeat interval from loading it above.
  await sleep(5100)
  alpha.drop()
  const from = counts(alpha)
  const replies = await record<SuggestReply>(jb, 'suggestions')
  await jb.send('suggest', { input: 'alph', seq: 7001 })
  const r = await replies.waitFor((r) => r.seq === 7001, 'the reply')
  assert.equal(r.completion?.url, `${alphaUrl}/`)
  await waitPreconnected(alpha, from, 'a connection to alpha.test')
})

test('a private address gets none', async () => {
  secret.drop()
  const from = counts(secret)
  const replies = await record<SuggestReply>(jb, 'suggestions')
  await jb.send('suggest', { input: 'secr', seq: 7002 })
  await replies.waitFor((r) => r.seq === 7002, 'the reply')
  // Nor when the UI asks for it, as for a highlighted suggestion.
  await jb.send('preconnect', { url: `${secretUrl}/` })
  await assertNoConnection(secret, from)
})

test('the search engine gets a connection as the address bar opens', async () => {
  search.drop()
  const from = counts(search)
  const ui = await jb.ui()
  await focusOmnibox(ui)
  await waitPreconnected(search, from, 'a connection to the search engine')
  await ui.eval('omnibox.blur()')
})

test('a suggestion highlighted with the arrow keys gets a connection', async () => {
  zebra.drop()
  const from = counts(zebra)
  const ui = await jb.ui()
  await focusOmnibox(ui)
  await ui.type('zebra')
  const historyRow = () => ui.eval<boolean>(`!!document.querySelector('#suggest .sg[data-kind="visit"]')`)
  await waitFor(historyRow, 'the history row')
  // Shown but not highlighted: nothing yet.
  await assertNoConnection(zebra, from)
  // ↓ to the card (a search), ↓ again to the history row.
  await ui.press('ArrowDown')
  await ui.press('ArrowDown')
  await waitFor(() => ui.eval<boolean>(`!!document.querySelector('#suggest .sg.hi[data-kind="visit"]')`), 'the history row highlighted')
  await waitPreconnected(zebra, from, 'a connection to the highlighted page')
  await ui.eval('omnibox.blur()')
})

test('a tab without its page gets a connection once the pointer rests on it', async () => {
  const from = counts(sleepy)
  assert.equal(from.connections, 0)
  const ui = await jb.ui()
  const box = await waitFor(
    () =>
      ui.call(() => {
        const r = document.querySelector('#threads .row[data-id="sleepy"]')?.getBoundingClientRect()
        return r?.width ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null
      }),
    'the sleepy row',
  )
  await ui.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y })
  await waitPreconnected(sleepy, from, 'a connection to the sleepy tab')
  assert.equal((await jb.state()).tabs.find((t) => t.id === 'sleepy')?.loaded, false)
})

test('nothing connects ahead with the setting off', async () => {
  await jb.send('prefs', { preconnect: false })
  await jb.waitForState((s) => s.prefs.preconnect === false, 'the setting off')
  await sleep(5100)
  search.drop()
  const from = counts(search)
  const ui = await jb.ui()
  await focusOmnibox(ui)
  await assertNoConnection(search, from)
})
