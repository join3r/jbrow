// Loading ahead (src/main/prerender.ts): the site the address bar completes to from your history
// loads in a hidden page while you type, and Return puts that page in the tab, back list and all.
// The hidden page shows up as a page target over CDP; the site's server counts what it serves.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { html, launch, serve, sleep, waitFor, type Cdp, type Jbrow, type TestServer } from './harness'
import { activeTab, focusedId, offline } from './ui-helpers'

let jb: Jbrow
let web: TestServer
let alpha: TestServer
/** alpha.test with its server's port: what the address bar completes "alph" to. */
let alphaUrl: string

before(async () => {
  web = await serve({
    '/': html('Home'),
    '/form': html('Form', '<input id="field" autofocus>'),
    '/other': html('Other'),
  })
  alpha = await serve({ '/': html('Alpha', '<p>alpha front page</p>') })
  alphaUrl = alpha.url.replace('127.0.0.1', 'alpha.test')
  jb = await launch({
    settings: { ...offline(web), prerender: true },
    args: ['--host-resolver-rules=MAP alpha.test 127.0.0.1'],
  })
  // alpha.test in the history, then away from it.
  await jb.navigate(`${alphaUrl}/`, { newTab: true })
  await jb.navigate(`${web.url}/`)
})
after(async () => {
  await jb?.close()
  await web?.close()
  await alpha?.close()
})

/** Hits for alpha.test's front page so far. */
const alphaLoads = () => alpha.hits.filter((p) => p === '/').length
/** Whether a page for alpha.test exists that no tab shows: the one loaded ahead. */
async function hiddenAlpha(): Promise<boolean> {
  const shown = activeTab(await jb.state())?.url
  return (await jb.targets()).some((t) => t.type === 'page' && t.url === `${alphaUrl}/` && shown !== t.url)
}

async function focusOmnibox(ui: Cdp) {
  const page = activeTab(await jb.state())?.url
  if (page) await jb.pageFocused(page)
  await jb.send('focus-ui')
  await ui.eval('omnibox.focus()')
  await waitFor(async () => (await focusedId(ui)) === 'omnibox', 'the address bar to have focus')
  await ui.press('Backspace')
  await waitFor(() => ui.eval('omnibox.value === ""'), 'an empty address bar')
}

async function backHome(ui: Cdp) {
  await ui.eval('omnibox.blur()')
  await jb.navigate(`${web.url}/`)
  // Whatever was loaded ahead goes a few seconds after the address bar closes.
  await waitFor(async () => !(await hiddenAlpha()), 'no page loaded ahead', 6000)
}

test('typing a site from your history loads it ahead, and Return shows that page with Back intact', async () => {
  const ui = await jb.ui()
  const tab = activeTab(await jb.state())!
  const before = alphaLoads()
  await focusOmnibox(ui)
  await ui.type('alph')
  await waitFor(async () => (await ui.eval('omnibox.value')) === new URL(alphaUrl).host, 'the completion')
  await waitFor(hiddenAlpha, 'a hidden page for alpha.test')
  await waitFor(() => alphaLoads() === before + 1, 'alpha.test to serve its front page')
  // Still where it was, and nothing in the tab changed.
  let s = await jb.state()
  assert.equal(activeTab(s)!.url, `${web.url}/`)
  assert.equal(activeTab(s)!.id, tab.id)

  await ui.press('Enter')
  s = await jb.waitForState((s) => activeTab(s)?.url === `${alphaUrl}/` && activeTab(s)?.title === 'Alpha', 'the tab on alpha.test')
  assert.equal(activeTab(s)!.id, tab.id)
  // The page loaded ahead, not a new load.
  await sleep(300)
  assert.equal(alphaLoads(), before + 1)
  assert.equal(s.nav.canGoBack, true)
  // It's the page on screen, and it can play sound now.
  const page = await jb.page((t) => t.url === `${alphaUrl}/`)
  await waitFor(() => page.eval(`document.visibilityState === 'visible' && innerWidth > 0`), 'the page on screen', 5000)
  page.close()

  // Back goes to the page the tab was on before.
  await jb.send('nav', { action: 'back' })
  await jb.waitForState((s) => activeTab(s)?.url === `${web.url}/` && !activeTab(s)!.loading, 'back on the home page')
  await jb.waitForState((s) => s.nav.canGoForward, 'forward to alpha.test')
})

test('closing the address bar without Return drops the page loaded ahead', async () => {
  const ui = await jb.ui()
  await focusOmnibox(ui)
  await ui.type('alph')
  await waitFor(hiddenAlpha, 'a hidden page for alpha.test')
  await ui.eval('omnibox.blur()')
  await waitFor(async () => !(await hiddenAlpha()), 'the hidden page gone', 6000)
  assert.equal(activeTab(await jb.state())!.url, `${web.url}/`)
})

test('a page you typed into is never replaced by one loaded ahead', async () => {
  await jb.navigate(`${web.url}/form`)
  const form = await jb.page((t) => t.url === `${web.url}/form`)
  await jb.pageFocused(`${web.url}/form`)
  // The page may get the keyboard a moment after it loads; press until the letter lands.
  await waitFor(async () => {
    await form.eval(`document.getElementById('field').focus()`)
    await form.press('a')
    return form.eval<boolean>(`document.getElementById('field').value.includes('a')`)
  }, 'the letter in the field', 15_000, 300)
  form.close()
  const before = alphaLoads()
  const ui = await jb.ui()
  await focusOmnibox(ui)
  await ui.type('alph')
  await waitFor(async () => (await ui.eval('omnibox.value')) === new URL(alphaUrl).host, 'the completion')
  await sleep(1000)
  assert.equal(await hiddenAlpha(), false)
  assert.equal(alphaLoads(), before)
  await backHome(ui)
})

test('nothing loads ahead for a private address, or with the setting off', async () => {
  const ui = await jb.ui()
  for (const prefs of [{ privateUrls: ['alpha.test'] }, { privateUrls: [], prerender: false }]) {
    await jb.send('prefs', prefs)
    await jb.waitForState((s) => JSON.stringify(s.prefs.privateUrls) === JSON.stringify(prefs.privateUrls) && s.prefs.prerender === (prefs.prerender ?? true), 'the prefs')
    const before = alphaLoads()
    await focusOmnibox(ui)
    await ui.type('alph')
    await sleep(1000)
    assert.equal(await hiddenAlpha(), false, JSON.stringify(prefs))
    assert.equal(alphaLoads(), before)
    await ui.eval('omnibox.blur()')
  }
  await jb.send('prefs', { prerender: true })
})
