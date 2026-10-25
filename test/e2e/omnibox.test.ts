// The address bar: typing in it, the suggestions from history, the inline completion, and what
// Return opens. Search suggestions need one of the listed engines, which are on the internet, so
// they aren't covered here.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { SuggestReply } from '../../src/shared/types'
import { html, launch, serve, waitFor, type Cdp, type Jbrow, type TestServer } from './harness'
import { activeTab, focusedId, offline, openTab, record } from './ui-helpers'

let jb: Jbrow
let web: TestServer
/** The test server under a made-up host name, so it has a site of its own in the history. */
let alpha: string

before(async () => {
  web = await serve({
    '/': html('Alpha home'),
    '/notes': html('Zebra Notes'),
    '/other': html('Somewhere else'),
    '/search': (req, res) => {
      const q = new URL(req.url ?? '/', 'http://x').searchParams.get('q') ?? ''
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html(`Results for ${q}`))
    },
  })
  alpha = web.url.replace('127.0.0.1', 'alpha.test')
  jb = await launch({ settings: offline(web), args: ['--host-resolver-rules=MAP alpha.test 127.0.0.1'] })
  // Visit a page on alpha.test, then leave it, so it's in the history but not an open tab.
  const t = await openTab(jb, `${alpha}/notes`)
  await jb.waitForState((s) => activeTab(s)?.title === 'Zebra Notes', 'the notes page title')
  await jb.send('navigate', { input: `${web.url}/other` })
  await jb.waitForState((s) => activeTab(s)?.id === t.id && activeTab(s)?.url === `${web.url}/other` && !activeTab(s)!.loading, 'the other page')
})
after(async () => {
  await jb?.close()
  await web?.close()
})

/** alpha.test with the server's port, as the address bar shows it. */
const alphaHost = () => new URL(alpha).host

/** Puts the keyboard in the address bar, as ⌘L does, with its text selected. */
async function focusOmnibox(ui: Cdp) {
  await jb.send('focus-ui')
  await ui.eval('omnibox.focus()')
  await waitFor(async () => (await focusedId(ui)) === 'omnibox', 'the address bar to have focus')
  // Typing replaces what's selected; start from nothing.
  await ui.press('Backspace')
  await waitFor(() => ui.eval('omnibox.value === ""'), 'an empty address bar')
}

/** The suggestion rows on screen: kind and title. */
const rows = (ui: Cdp) =>
  ui.call(() =>
    document.getElementById('suggest')!.hidden
      ? []
      : [...document.querySelectorAll<HTMLElement>('#suggest .sg')].map((b) => ({
          kind: [...b.classList].find((c) => c.startsWith('sg-'))!.slice(3),
          title: b.querySelector('.sg-t')?.textContent ?? '',
        })),
  )

test("'suggest' answers with pages from the history", async () => {
  const replies = await record<SuggestReply>(jb, 'suggestions')
  await jb.send('suggest', { input: 'zebra', seq: 9001 })
  const r = await replies.waitFor((r) => r.seq === 9001, 'the reply')
  assert.equal(r.input, 'zebra')
  assert.deepEqual(r.visits, [{ url: `${alpha}/notes`, title: 'Zebra Notes' }])
  assert.equal(r.completion, null)

  // A host prefix completes to the site's front page.
  await jb.send('suggest', { input: 'alph', seq: 9002 })
  const c = await replies.waitFor((r) => r.seq === 9002, 'the reply')
  assert.deepEqual(c.completion, { text: alphaHost(), url: `${alpha}/` })

  // Nothing matches: nothing comes back.
  await jb.send('suggest', { input: 'qqqxxyz', seq: 9003 })
  const none = await replies.waitFor((r) => r.seq === 9003, 'the reply')
  assert.deepEqual(none.visits, [])
})

test('typing in the address bar shows history and completes the host', async () => {
  const ui = await jb.ui()
  await focusOmnibox(ui)
  await ui.type('alph')
  await waitFor(async () => (await ui.eval('omnibox.value')) === alphaHost(), 'the completion to alpha.test')
  // The added part is selected, so typing on replaces it.
  assert.equal(await ui.eval('omnibox.value.slice(omnibox.selectionStart, omnibox.selectionEnd)'), alphaHost().slice(4))
  const shown = await waitFor(async () => {
    const r = await rows(ui)
    return r.some((x) => x.kind === 'go') && r.some((x) => x.kind === 'visit') ? r : null
  }, 'the suggestion rows')
  assert.equal(shown[0].kind, 'go')
  assert.equal(shown[0].title, `Go to ${alphaHost()}`)
  assert.ok(shown.some((x) => x.kind === 'visit' && x.title === 'Zebra Notes'))

  // Return takes the completion.
  const before = (await jb.state()).activeId
  await ui.press('Enter')
  const s = await jb.waitForState((s) => activeTab(s)?.url === `${alpha}/` && !activeTab(s)!.loading, 'alpha.test to open')
  assert.equal(s.activeId, before)
  assert.equal(activeTab(s)!.title, 'Alpha home')
  // Go back to a page off alpha.test for the next tests.
  await jb.send('navigate', { input: `${web.url}/other` })
  await jb.waitForState((s) => activeTab(s)?.url === `${web.url}/other` && !activeTab(s)!.loading, 'the other page')
})

test('a word in a page title finds it, and Return on its row opens it', async () => {
  const ui = await jb.ui()
  await focusOmnibox(ui)
  await ui.type('zebra')
  await waitFor(async () => (await rows(ui)).some((x) => x.kind === 'visit' && x.title === 'Zebra Notes'), 'the history row')
  // A word isn't an address, so it doesn't complete.
  assert.equal(await ui.eval('omnibox.value'), 'zebra')
  const r = await rows(ui)
  const at = r.findIndex((x) => x.kind === 'visit')
  for (let i = 0; i < at; i++) await ui.press('ArrowDown')
  await ui.press('Enter')
  await jb.waitForState((s) => activeTab(s)?.url === `${alpha}/notes` && !activeTab(s)!.loading, 'the notes page')
  await jb.send('navigate', { input: `${web.url}/other` })
  await jb.waitForState((s) => activeTab(s)?.url === `${web.url}/other` && !activeTab(s)!.loading, 'the other page')
})

test('words and Return search with the search engine', async () => {
  const ui = await jb.ui()
  await focusOmnibox(ui)
  await ui.type('hello world')
  await waitFor(async () => (await rows(ui)).some((x) => x.kind === 'go' && x.title === 'Search for "hello world"'), 'the search row')
  await ui.press('Enter')
  const s = await jb.waitForState((s) => activeTab(s)?.title === 'Results for hello world', 'the search results')
  assert.equal(activeTab(s)!.url, `${web.url}/search?q=hello%20world`)
  // The address bar lets go of the keyboard.
  assert.notEqual(await focusedId(ui), 'omnibox')
})

test('Escape closes the suggestions and puts the address back', async () => {
  const ui = await jb.ui()
  const url = activeTab(await jb.state())!.url
  await focusOmnibox(ui)
  await ui.type('zeb')
  await waitFor(async () => (await rows(ui)).length > 0, 'suggestions')
  await ui.press('Escape')
  await waitFor(() => ui.eval('document.getElementById("suggest").hidden'), 'the suggestions to close')
  assert.equal(await ui.eval('omnibox.value'), url)
})

test('a private address is never completed', async () => {
  await jb.send('prefs', { privateUrls: ['alpha.test'] })
  await jb.waitForState((s) => s.prefs.privateUrls.includes('alpha.test'), 'the private pattern')
  const replies = await record<SuggestReply>(jb, 'suggestions')
  // Long enough that no popular site completes it either.
  await jb.send('suggest', { input: 'alpha.te', seq: 9100 })
  const r = await replies.waitFor((r) => r.seq === 9100, 'the reply')
  assert.equal(r.completion, null)
  await jb.send('prefs', { privateUrls: [] })
  await jb.waitForState((s) => !s.prefs.privateUrls.length, 'no private patterns')
})

test("'forget-visit' takes a page out of the history", async () => {
  const replies = await record<SuggestReply>(jb, 'suggestions')
  await jb.send('forget-visit', { url: `${alpha}/notes` })
  await jb.send('suggest', { input: 'zebra', seq: 9200 })
  const r = await replies.waitFor((r) => r.seq === 9200, 'the reply')
  assert.deepEqual(r.visits, [])
})
