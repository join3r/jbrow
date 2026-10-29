// The address bar: typing in it, the suggestions from history, the inline completion, and what
// Return opens, in the columns layout and then the preview layout. Both are in one file, one jbrow:
// two of them typing into their address bars at once take the keyboard from each other. Search suggestions need one of the listed engines, which are on the internet, so
// they aren't covered here.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import type { SuggestReply } from '../../src/shared/types'
import { html, launch, serve, SHIFT, waitFor, type Cdp, type Jbrow, type TestServer } from './harness'
import { activeTab, focusedId, offline, openTab, record } from './ui-helpers'

let jb: Jbrow
let web: TestServer
/** The test server under made-up host names: alpha.test has a history of its own, secret.test is private. */
let alpha: string
let secret: string

before(async () => {
  web = await serve({
    '/': html('Alpha home'),
    '/notes': html('Zebra Notes'),
    '/other': html('Somewhere else'),
    '/hidden': html('Alphabet secrets'),
    '/search': (req, res) => {
      const q = new URL(req.url ?? '/', 'http://x').searchParams.get('q') ?? ''
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html(`Results for ${q}`))
    },
  })
  alpha = web.url.replace('127.0.0.1', 'alpha.test')
  secret = web.url.replace('127.0.0.1', 'secret.test')
  jb = await launch({ settings: offline(web), args: ['--host-resolver-rules=MAP alpha.test 127.0.0.1, MAP secret.test 127.0.0.1'] })
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
  // A page the last test opened gets the keyboard a moment after it loads; that would blur the
  // address bar mid-test.
  const page = activeTab(await jb.state())?.url
  if (page) await jb.pageFocused(page)
  await jb.send('focus-ui')
  await ui.eval('omnibox.focus()')
  await waitFor(async () => (await focusedId(ui)) === 'omnibox', 'the address bar to have focus')
  // Typing replaces what's selected; start from nothing.
  await ui.press('Backspace')
  await waitFor(() => ui.eval('omnibox.value === ""'), 'an empty address bar')
}

/** The suggestions on screen, in order: kind, the section they're in, title, and whether selected. */
const rows = (ui: Cdp) =>
  ui.call(() =>
    document.getElementById('suggest')!.hidden
      ? []
      : [...document.querySelectorAll<HTMLElement>('#suggest .sg')].map((b) => ({
          kind: b.dataset.kind ?? '',
          zone: b.dataset.zone ?? '',
          title: b.querySelector('.sg-t')?.textContent ?? '',
          hi: b.classList.contains('hi'),
        })),
  )
/** The card on top: what Return does with the caret still in the text. */
const card = async (ui: Cdp) => (await rows(ui)).find((x) => x.zone === 'card')
/** The selected suggestion, if any. */
const selected = async (ui: Cdp) => (await rows(ui)).find((x) => x.hi)

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
    return r.some((x) => x.kind === 'site') && r.some((x) => x.kind === 'visit') ? r : null
  }, 'the suggestion rows')
  assert.equal(shown[0].zone, 'card')
  assert.equal(shown[0].kind, 'site')
  assert.equal(shown[0].title, alphaHost())
  // Nothing is selected yet: the caret is still in the text.
  assert.equal(await selected(ui), undefined)
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

test('a site completes even with a tab on it open; a name you gave a tab beats it', async () => {
  const ui = await jb.ui()
  const back = (await jb.state()).activeId
  const t = await openTab(jb, `${alpha}/notes`)
  await jb.waitForState((s) => activeTab(s)?.title === 'Zebra Notes', 'the notes tab')
  await focusOmnibox(ui)
  await ui.type('alph')
  await waitFor(async () => (await ui.eval('omnibox.value')) === alphaHost(), 'the completion to alpha.test')
  const shown = await waitFor(async () => {
    const r = await rows(ui)
    return r.some((x) => x.kind === 'tab' && x.title === 'Zebra Notes') ? r : null
  }, 'the open tab among the rows')
  assert.equal((await card(ui))?.title, alphaHost())
  await ui.press('Escape')

  await jb.send('rename', { id: t.id, name: 'Alphabet soup' })
  await jb.waitForState((s) => s.tabs.find((x) => x.id === t.id)?.name === 'Alphabet soup', 'the new name')
  await focusOmnibox(ui)
  await ui.type('alph')
  await waitFor(async () => (await card(ui))?.title === 'Alphabet soup', 'the named tab in the card')
  assert.equal((await card(ui))?.kind, 'tab')
  assert.equal(await ui.eval('omnibox.value'), 'alph')
  await ui.press('Escape')
  await jb.send('close', { id: t.id })
  await jb.waitForState((s) => s.activeId === back, 'the earlier tab in front again')
})

test('a word in a page title finds it, and Return on its row opens it', async () => {
  const ui = await jb.ui()
  await focusOmnibox(ui)
  await ui.type('zebra')
  await waitFor(async () => (await rows(ui)).some((x) => x.kind === 'visit' && x.title === 'Zebra Notes'), 'the history row')
  // A word isn't an address, so it doesn't complete.
  assert.equal(await ui.eval('omnibox.value'), 'zebra')
  // A word searches by default; the card already is that search and there are no suggestions, so
  // ↓ goes from the card straight to History.
  assert.equal((await card(ui))?.kind, 'search')
  assert.ok(!(await rows(ui)).some((x) => x.zone === 'search'))
  await ui.press('ArrowDown')
  await waitFor(async () => (await selected(ui))?.zone === 'card', 'the card selected')
  await ui.press('ArrowDown')
  await waitFor(async () => (await selected(ui))?.title === 'Zebra Notes', 'the history row selected')
  await ui.press('Enter')
  await jb.waitForState((s) => activeTab(s)?.url === `${alpha}/notes` && !activeTab(s)!.loading, 'the notes page')
  await jb.send('navigate', { input: `${web.url}/other` })
  await jb.waitForState((s) => activeTab(s)?.url === `${web.url}/other` && !activeTab(s)!.loading, 'the other page')
})

test('words and Return search with the search engine', async () => {
  const ui = await jb.ui()
  await focusOmnibox(ui)
  await ui.type('hello world')
  await waitFor(async () => /for "hello world"$/.test((await card(ui))?.title ?? ''), 'the search card')
  await ui.press('Enter')
  const s = await jb.waitForState((s) => activeTab(s)?.title === 'Results for hello world', 'the search results')
  assert.equal(activeTab(s)!.url, `${web.url}/search?q=hello%20world`)
  // The address bar lets go of the keyboard.
  assert.notEqual(await focusedId(ui), 'omnibox')
})

test('localhost with a port says Go to, comes first, and opens over http', async () => {
  const ui = await jb.ui()
  await focusOmnibox(ui)
  const typed = `localhost:${new URL(web.url).port}/other`
  await ui.type(typed)
  await waitFor(async () => (await card(ui))?.title === `Go to ${typed}`, 'the Go to card')
  assert.equal((await card(ui))?.kind, 'address')
  await ui.press('Enter')
  await jb.waitForState((s) => activeTab(s)?.url === `http://${typed}` && !activeTab(s)!.loading, 'the page over http')
})

test('a leading ? searches for an address instead of going there', async () => {
  const ui = await jb.ui()
  await focusOmnibox(ui)
  await ui.type('?node.js')
  await waitFor(async () => /for "node.js"$/.test((await card(ui))?.title ?? ''), 'the search card')
  await ui.press('Enter')
  await jb.waitForState((s) => activeTab(s)?.title === 'Results for node.js', 'the search results')
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

test('the keys walk the card, the searches, History and Your tabs; Return opens what is selected', async () => {
  const ui = await jb.ui()
  const back = (await jb.state()).activeId
  // A tab on alpha.test, so typing its name brings the site, a search, History and Your tabs.
  const t = await openTab(jb, `${alpha}/other`)
  await jb.waitForState((s) => activeTab(s)?.title === 'Somewhere else' && !activeTab(s)!.loading, 'the tab on alpha.test')
  await jb.send('activate', { id: back })
  await jb.waitForState((s) => s.activeId === back, 'the earlier tab in front')
  await focusOmnibox(ui)
  await ui.type('alph')
  await waitFor(async () => {
    const r = await rows(ui)
    return r.some((x) => x.zone === 'card') && r.some((x) => x.zone === 'history') && r.some((x) => x.zone === 'tabs')
  }, 'every section')
  const switchHints = () => ui.eval<number>('[...document.querySelectorAll("#suggest .sx-switch")].filter((e) => e.offsetParent).length')
  assert.equal(await switchHints(), 0)

  const walk: [string, string, string][] = [
    ['ArrowDown', 'card', alphaHost()],
    ['ArrowDown', 'search', 'alph'],
    ['ArrowDown', 'history', 'Zebra Notes'],
    ['ArrowRight', 'tabs', 'Somewhere else'],
    ['ArrowLeft', 'history', 'Zebra Notes'],
    ['ArrowUp', 'search', 'alph'],
    ['ArrowUp', 'card', alphaHost()],
  ]
  for (const [key, zone, title] of walk) {
    await ui.press(key)
    const s = await waitFor(async () => {
      const s = await selected(ui)
      return s?.zone === zone ? s : null
    }, `${key} to reach ${zone}`)
    assert.equal(s.title, title)
  }
  // In the menu, every section says Tab moves on, and Tab does.
  assert.ok((await switchHints()) >= 4)
  for (const zone of ['search', 'history', 'tabs', 'card']) {
    await ui.press('Tab')
    await waitFor(async () => (await selected(ui))?.zone === zone, `Tab to reach ${zone}`)
  }
  await ui.press('Tab', { modifiers: SHIFT })
  await waitFor(async () => (await selected(ui))?.zone === 'tabs', '⇧Tab back to Your tabs')
  // Return on a tab switches to it.
  await ui.press('Enter')
  await jb.waitForState((s) => s.activeId === t.id, 'the tab in front')

  // Return on a search searches for exactly that.
  await focusOmnibox(ui)
  await ui.type('alph')
  await waitFor(async () => (await rows(ui)).some((x) => x.zone === 'search'), 'the searches')
  await ui.press('ArrowDown')
  await ui.press('ArrowDown')
  await waitFor(async () => (await selected(ui))?.zone === 'search', 'the search selected')
  await ui.press('Enter')
  await jb.waitForState((s) => activeTab(s)?.title === 'Results for alph', 'the search results')
  await jb.send('close', { id: t.id })
  await jb.waitForState((s) => !s.tabs.some((x) => x.id === t.id), 'the tab closed')
})

test('with more than one profile, Tab in the text switches the profile; in the menu it moves between sections', async () => {
  const ui = await jb.ui()
  const s = await jb.state()
  assert.ok(s.profiles.length > 1)
  const ids = s.profiles.map((p) => p.id)
  const other = s.profiles[(ids.indexOf(activeTab(s)!.profile) + 1) % ids.length]
  await focusOmnibox(ui)
  await ui.type('alph')
  await waitFor(async () => (await rows(ui)).some((x) => x.zone === 'history'), 'the history')
  const hint = () => ui.eval<string>('document.querySelector("#suggest .sx-foot")?.textContent ?? ""')
  assert.match(await hint(), new RegExp(`Tab\\s*to open in\\s*${other.name}`))
  await ui.press('Tab')
  await waitFor(async () => (await ui.eval('document.getElementById("profileName").textContent')) === other.name, 'the other profile picked')
  assert.equal(await selected(ui), undefined)
  await ui.press('ArrowDown')
  await waitFor(async () => (await selected(ui))?.zone === 'card', 'the card selected')
  await ui.press('Tab')
  await waitFor(async () => (await selected(ui))?.zone === 'search', 'Tab to the searches')
  assert.equal(await ui.eval('document.getElementById("profileName").textContent'), other.name)
  await ui.press('Escape')
})

test("'forget-visit' takes a page out of the history", async () => {
  const replies = await record<SuggestReply>(jb, 'suggestions')
  await jb.send('forget-visit', { url: `${alpha}/notes` })
  await jb.send('suggest', { input: 'zebra', seq: 9200 })
  const r = await replies.waitFor((r) => r.seq === 9200, 'the reply')
  assert.deepEqual(r.visits, [])
})

// ---------- the preview layout ----------
// One list of everything, and a panel beside it with tools and what jbrow knows about the
// highlighted row's site.

/** The tab open on alpha.test, and the one the preview tests start from. */
let alphaTab = ''
let home = ''

async function backHome() {
  await jb.send('activate', { id: home })
  await jb.waitForState((s) => s.activeId === home && activeTab(s)?.url === `${web.url}/other` && !activeTab(s)!.loading, 'the first tab in front')
  await jb.pageFocused(`${web.url}/other`)
}

/** The highlighted tool: 'search' for the field, else the button's data-tool. */
const tool = (ui: Cdp) => ui.eval<string>(`document.querySelector('#suggest .sp-find.hi') ? 'search' : (document.querySelector('#suggest .sp-tool.hi')?.dataset.tool ?? '')`)
const panel = (ui: Cdp) => ui.eval<string>(`document.querySelector('#suggest .sp-about')?.textContent.replace(/\\s+/g, ' ') ?? ''`)
const inField = (ui: Cdp) => ui.eval<boolean>(`document.activeElement?.classList.contains('sp-field') ?? false`)

/** Types `text` and waits for every kind of row in `kinds`. */
async function typeFor(ui: Cdp, text: string, kinds: string[]) {
  await focusOmnibox(ui)
  await ui.type(text)
  return waitFor(async () => {
    const r = await rows(ui)
    return kinds.every((k) => r.some((x) => x.kind === k)) ? r : null
  }, `rows of ${kinds.join(', ')}`)
}

/** Types 'alph' and walks down to the first history row, once the rows above it are all in. */
async function toVisit(ui: Cdp) {
  const shown = await typeFor(ui, 'alph', ['site', 'tab', 'visit'])
  const i = shown.findIndex((x) => x.kind === 'visit')
  for (let n = 0; n <= i; n++) await ui.press('ArrowDown')
  await waitFor(async () => (await selected(ui))?.kind === 'visit', 'the history row')
}

test('the preview layout, with alpha.test/notes in the history and a tab on alpha.test/other', async () => {
  await jb.send('prefs', { urlBarStyle: 'preview', privateUrls: ['secret.test'] })
  await jb.waitForState((s) => s.prefs.urlBarStyle === 'preview' && s.prefs.privateUrls.includes('secret.test'), 'the preview layout')
  // The last columns test took alpha.test/notes out of the history.
  const t = await openTab(jb, `${alpha}/notes`)
  await jb.waitForState((s) => activeTab(s)?.title === 'Zebra Notes', 'the notes page title')
  await jb.send('navigate', { input: `${web.url}/other` })
  await jb.waitForState((s) => activeTab(s)?.id === t.id && activeTab(s)?.url === `${web.url}/other` && !activeTab(s)!.loading, 'the other page')
  home = t.id
  for (const x of (await jb.state()).tabs) if (x.id !== home) await jb.send('close', { id: x.id })
  alphaTab = (await openTab(jb, `${alpha}/other`)).id
  await jb.waitForState((s) => activeTab(s)?.title === 'Somewhere else' && !activeTab(s)!.loading, 'the tab on alpha.test')
  await backHome()
})

test('one list: the site, Open tabs, History, then the searches; ↓ and ↑ walk all of it', async () => {
  const ui = await jb.ui()
  const shown = await typeFor(ui, 'alph', ['site', 'tab', 'visit', 'search'])
  assert.deepEqual(
    shown.map((x) => x.kind).filter((k, i, all) => k !== all[i - 1]),
    ['site', 'tab', 'visit', 'search'],
  )
  const heads = await ui.eval<string[]>(`[...document.querySelectorAll('#suggest .sp-head')].map((h) => h.textContent)`)
  assert.deepEqual(heads, ['Open tabs', 'History', `Search ${new URL(web.url).host}`])
  assert.equal(await selected(ui), undefined)
  // With the caret in the text the panel is about what Return does.
  assert.match(await panel(ui), /Homepage/)

  for (const [i, row] of shown.entries()) {
    await ui.press('ArrowDown')
    await waitFor(async () => (await rows(ui)).findIndex((x) => x.hi) === i, `↓ to ${row.title}`)
  }
  for (let i = shown.length - 2; i >= 0; i--) {
    await ui.press('ArrowUp')
    await waitFor(async () => (await rows(ui)).findIndex((x) => x.hi) === i, `↑ to ${shown[i].title}`)
  }
  await ui.press('ArrowUp')
  await waitFor(async () => (await selected(ui)) === undefined, '↑ back into the text')
  await ui.press('Escape')
})

test('→ goes into the tools and ← comes back; Tab moves nothing', async () => {
  const ui = await jb.ui()
  await typeFor(ui, 'alph', ['site', 'tab', 'visit'])
  await ui.press('ArrowDown')
  await ui.press('ArrowDown')
  await waitFor(async () => (await selected(ui))?.kind === 'tab', 'the tab row')
  assert.match(await panel(ui), /Open tab/)

  // Tab in the list stays on the row, and the keyboard stays in the address bar.
  await ui.press('Tab')
  assert.equal((await selected(ui))?.kind, 'tab')
  assert.equal(await focusedId(ui), 'omnibox')

  // → moves the keyboard into the search field, → again to the buttons and back into the text.
  await ui.press('ArrowRight')
  await waitFor(async () => (await tool(ui)) === 'search' && (await inField(ui)), 'the search field')
  await ui.press('Tab')
  assert.ok(await inField(ui))
  await ui.press('ArrowRight')
  await waitFor(async () => (await tool(ui)) === 'tab' && (await focusedId(ui)) === 'omnibox', 'the new tab button')
  await ui.press('ArrowRight')
  await waitFor(async () => (await tool(ui)) === 'profile', 'the profile button')
  await ui.press('ArrowLeft')
  await ui.press('ArrowLeft')
  await waitFor(async () => (await tool(ui)) === 'search' && (await inField(ui)), 'back in the search field')
  await ui.press('ArrowLeft')
  await waitFor(async () => (await tool(ui)) === '' && (await focusedId(ui)) === 'omnibox', 'back in the list')
  assert.equal((await selected(ui))?.kind, 'tab')
  // The text is as it was.
  assert.equal(await ui.eval('omnibox.value.slice(0, 4)'), 'alph')

  // Return on the tab switches to it.
  await ui.press('Enter')
  await jb.waitForState((s) => s.activeId === alphaTab, 'the tab in front')
  await backHome()
})

test('Return on a search row searches, and the search field searches for what is in it', async () => {
  const ui = await jb.ui()
  await typeFor(ui, 'alph', ['search'])
  const n = (await rows(ui)).length
  for (let i = 0; i < n; i++) await ui.press('ArrowDown')
  await waitFor(async () => (await selected(ui))?.kind === 'search', 'the search row')
  assert.match(await panel(ui), /Sent to/)
  await ui.press('Enter')
  await jb.waitForState((s) => activeTab(s)?.title === 'Results for alph', 'the search results')

  await typeFor(ui, 'alph', ['visit'])
  await ui.press('ArrowDown')
  await ui.press('ArrowRight')
  await waitFor(() => inField(ui), 'the search field')
  await ui.type('kiwi')
  await ui.press('Enter')
  await jb.waitForState((s) => activeTab(s)?.title === 'Results for kiwi', 'the search for the field')
  await jb.send('navigate', { input: `${web.url}/other` })
  await jb.waitForState((s) => activeTab(s)?.url === `${web.url}/other` && !activeTab(s)!.loading, 'the other page')
})

test('the Site block says plain http and the IP address', async () => {
  const ui = await jb.ui()
  await toVisit(ui)
  const text = await waitFor(async () => {
    const t = await panel(ui)
    return /IP address/.test(t) ? t : null
  }, 'the site details')
  assert.match(text, /Plain http, no certificate/)
  assert.match(text, /127\.0\.0\.1 this Mac/)
  await ui.press('Escape')
})

test('a private row shows its address masked and is not looked up', async () => {
  const ui = await jb.ui()
  const t = await openTab(jb, `${secret}/hidden`)
  await jb.waitForState((s) => activeTab(s)?.title === 'Alphabet secrets' && !activeTab(s)!.loading, 'the private tab')
  await backHome()
  await typeFor(ui, 'secrets', ['tab'])
  const i = (await rows(ui)).findIndex((x) => x.kind === 'tab')
  for (let n = 0; n <= i; n++) await ui.press('ArrowDown')
  await waitFor(async () => (await selected(ui))?.kind === 'tab', 'the private tab row')
  const text = await panel(ui)
  assert.match(text, /Private address — not looked up/)
  assert.ok(!text.includes('secret.test'), text)
  await ui.press('Escape')
  await jb.send('close', { id: t.id })
  await jb.waitForState((s) => !s.tabs.some((x) => x.id === t.id), 'the private tab closed')
  // The page in front gets the keyboard back, which mustn't happen in the middle of the next test.
  await jb.pageFocused(`${web.url}/other`)
})

test('the tools open the row in a new tab and in split view', async () => {
  const ui = await jb.ui()
  const before = (await jb.state()).tabs.length
  await toVisit(ui)
  await ui.press('ArrowRight')
  await ui.press('ArrowRight')
  await waitFor(async () => (await tool(ui)) === 'tab', 'the new tab button')
  await ui.press('Enter')
  const s = await jb.waitForState((s) => activeTab(s)?.url === `${alpha}/notes` && !activeTab(s)!.loading, 'the page in a new tab')
  assert.equal(s.tabs.length, before + 1)
  const opened = s.activeId!

  await typeFor(ui, 'alph', ['site'])
  await ui.press('ArrowDown')
  await ui.press('ArrowRight')
  for (let i = 0; i < 4; i++) await ui.press('ArrowRight')
  await waitFor(async () => (await tool(ui)) === 'split', 'the split view button')
  await ui.press('Enter')
  const split = await jb.waitForState((s) => s.splits.some((x) => x.tabs.includes(opened) && x.tabs.includes(s.activeId!)) && activeTab(s)?.url === `${alpha}/`, 'the site beside it')
  const pane = split.activeId!
  await jb.send('close', { id: pane })
  await jb.send('close', { id: opened })
  await jb.waitForState((s) => !s.tabs.some((t) => t.id === opened || t.id === pane), 'both closed')
  await backHome()
})
