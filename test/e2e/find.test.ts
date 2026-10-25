// Find in page: 'find' and 'find-stop' from the UI, the match counts main sends back, and the
// find bar itself.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { CMD, html, launch, serve, SHIFT, waitFor, type Jbrow, type TestServer } from './harness'
import { activeTab, focusedId, isShown, offline, openPainted, record } from './ui-helpers'

type FindMsg = { open?: true; step?: 1 | -1; close?: true; matches?: number; active?: number }

let jb: Jbrow
let web: TestServer

before(async () => {
  web = await serve({
    '/words': html('Words', '<p>apple banana apple cherry apple</p><p>Apple pie</p><p>banana</p>'),
    '/other': html('Other', '<p>apple</p>'),
  })
  jb = await launch({ settings: offline(web) })
})
after(async () => {
  await jb?.close()
  await web?.close()
})

/** Counts main reported, from now on. */
async function counts() {
  const msgs = await record<FindMsg>(jb, 'find')
  await msgs.clear()
  return msgs
}

test("'find' counts the matches, and the same text again steps through them", async () => {
  await openPainted(jb, `${web.url}/words`)
  const msgs = await counts()
  await jb.send('find', { text: 'apple' })
  // Case doesn't matter: four apples.
  await msgs.waitFor((m) => m.matches === 4 && m.active === 1, '4 matches, the first active')
  await msgs.clear()
  await jb.send('find', { text: 'apple' })
  await msgs.waitFor((m) => m.matches === 4 && m.active === 2, 'the second match')
  await msgs.clear()
  await jb.send('find', { text: 'apple', forward: false })
  await msgs.waitFor((m) => m.matches === 4 && m.active === 1, 'back to the first')

  await msgs.clear()
  await jb.send('find', { text: 'banana' })
  await msgs.waitFor((m) => m.matches === 2 && m.active === 1, 'a new search: 2 bananas')
  await msgs.clear()
  await jb.send('find', { text: 'durian' })
  await msgs.waitFor((m) => m.matches === 0, 'no durian')
  // Empty text clears the search and says so at once.
  await msgs.clear()
  await jb.send('find', { text: '' })
  await msgs.waitFor((m) => m.matches === 0 && m.active === 0, 'nothing for empty text')
  await jb.send('find-stop')
})

test('the find bar: ⌘F opens it, typing searches, Return steps, Escape closes', async () => {
  const ui = await jb.ui()
  await openPainted(jb, `${web.url}/words?bar`)
  await jb.send('focus-ui')
  await ui.press('f', { modifiers: CMD })
  await waitFor(() => isShown(ui, 'find'), 'the find bar')
  await waitFor(async () => (await focusedId(ui)) === 'findInput', 'the find field to have focus')
  await ui.type('apple')
  await waitFor(async () => /1\D+4/.test(await ui.eval('findCount.textContent')), 'the count "1 of 4"', 15_000)
  await ui.press('Enter')
  await waitFor(async () => /2\D+4/.test(await ui.eval('findCount.textContent')), '"2 of 4"')
  await ui.press('Enter', { modifiers: SHIFT })
  await waitFor(async () => /1\D+4/.test(await ui.eval('findCount.textContent')), 'back to "1 of 4"')
  // ⌘G steps too while the bar is open.
  await ui.press('g', { modifiers: CMD })
  await waitFor(async () => /2\D+4/.test(await ui.eval('findCount.textContent')), '"2 of 4" from ⌘G')
  await ui.press('Escape')
  await waitFor(async () => !(await isShown(ui, 'find')), 'the find bar to close')
})

test('the find bar closes when the page navigates', async () => {
  const ui = await jb.ui()
  await openPainted(jb, `${web.url}/words?nav`)
  await jb.send('focus-ui')
  await ui.press('f', { modifiers: CMD })
  await waitFor(() => isShown(ui, 'find'), 'the find bar')
  await ui.type('apple')
  await waitFor(async () => /4/.test(await ui.eval('findCount.textContent')), 'a count')
  await jb.send('navigate', { input: `${web.url}/other` })
  await jb.waitForState((s) => activeTab(s)?.url === `${web.url}/other` && !activeTab(s)!.loading, 'the other page')
  await waitFor(async () => !(await isShown(ui, 'find')), 'the find bar to close')
})

test('⌘F does nothing on a new tab with no page', async () => {
  const ui = await jb.ui()
  await jb.send('new')
  await jb.waitForState((s) => !!activeTab(s) && !activeTab(s)!.url, 'an empty tab')
  await ui.press('f', { modifiers: CMD })
  // Keys are handled in order, and main's messages arrive in order: once ⌘L's is here, ⌘F's has been
  // handled. (Main may ask the UI to open the bar while the suggestions cover the page; the UI
  // doesn't, for a tab with no page.)
  const focus = await record(jb, 'focus-omnibox')
  await focus.clear()
  await ui.press('l', { modifiers: CMD })
  await waitFor(async () => (await focus.all()).length, '⌘L to focus the address bar')
  assert.equal(await isShown(ui, 'find'), false)
})
