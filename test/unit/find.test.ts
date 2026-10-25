import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import type { WebContents } from 'electron'
import { FindInPage, type FindUpdate } from '../../src/main/find'

class FakePage extends EventEmitter {
  destroyed = false
  calls: unknown[][] = []
  stops: string[] = []
  private requestId = 0
  isDestroyed() {
    return this.destroyed
  }
  findInPage(text: string, options: unknown) {
    this.calls.push([text, options])
    return ++this.requestId
  }
  stopFindInPage(action: string) {
    this.stops.push(action)
  }
  found(requestId: number, matches: number | undefined, active = 1) {
    this.emit('found-in-page', {}, { requestId, matches, activeMatchOrdinal: active, finalUpdate: true })
  }
  /** Sends a key press, returning whether it was kept from the page. */
  key(input: Partial<Electron.Input>) {
    let prevented = false
    this.emit('before-input-event', { preventDefault: () => (prevented = true) }, { type: 'keyDown', key: 'Escape', ...input })
    return prevented
  }
}

function setup() {
  const sent: FindUpdate[] = []
  const find = new FindInPage((u) => void sent.push(u))
  const page = new FakePage()
  return { find, sent, page, wc: page as unknown as WebContents }
}

test('the first search starts, the same text again steps through matches', () => {
  const { find, page, wc } = setup()
  find.find(wc, 'jbrow')
  find.find(wc, 'jbrow')
  find.find(wc, 'jbrow', false)
  find.find(wc, 'jbrowser')
  assert.deepEqual(page.calls, [
    ['jbrow', { forward: true, findNext: true }],
    ['jbrow', { forward: true, findNext: false }],
    ['jbrow', { forward: false, findNext: false }],
    ['jbrowser', { forward: true, findNext: true }],
  ])
  assert.equal(find.open, true)
})

test('results of the latest search are sent; older ones are ignored', () => {
  const { find, sent, page, wc } = setup()
  find.find(wc, 'a')
  find.find(wc, 'ab')
  page.found(1, 10)
  page.found(2, 3, 2)
  page.found(2, undefined)
  assert.deepEqual(sent, [{ matches: 3, active: 2 }])
})

test('an empty query clears the highlight and reports no matches', () => {
  const { find, sent, page, wc } = setup()
  find.find(wc, 'a')
  find.find(wc, '')
  assert.deepEqual(page.stops, ['clearSelection'])
  assert.deepEqual(sent, [{ matches: 0, active: 0 }])
  // Typing the same text again starts over.
  find.find(wc, 'a')
  assert.deepEqual(page.calls.at(-1), ['a', { forward: true, findNext: true }])
})

test('stop clears the highlight and closes', () => {
  const { find, page, wc } = setup()
  find.find(wc, 'a')
  find.stop()
  assert.equal(find.open, false)
  assert.deepEqual(page.stops, ['clearSelection'])
  page.found(1, 5)
  find.stop()
  assert.deepEqual(page.stops, ['clearSelection'])
})

test('searching another page leaves the first one', () => {
  const { find, sent, wc, page } = setup()
  const other = new FakePage()
  find.find(wc, 'a')
  find.find(other as unknown as WebContents, 'a')
  assert.deepEqual(page.stops, ['clearSelection'])
  // A new page means a new search, not the next match.
  assert.deepEqual(other.calls, [['a', { forward: true, findNext: true }]])
  page.found(1, 4)
  assert.deepEqual(sent, [])
})

test('leaving the page closes the bar, but not in-page or subframe navigations', () => {
  const { find, sent, page, wc } = setup()
  find.find(wc, 'a')
  page.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true })
  page.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false })
  assert.equal(find.open, true)
  page.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  assert.equal(find.open, false)
  assert.deepEqual(sent, [{ close: true }])
})

test('a destroyed page closes the bar without touching the page', () => {
  const { find, sent, page, wc } = setup()
  find.find(wc, 'a')
  page.destroyed = true
  page.emit('destroyed')
  assert.equal(find.open, false)
  assert.deepEqual(sent, [{ close: true }])
  assert.deepEqual(page.stops, [])
})

test('Esc in the page closes the bar and is kept from the page', () => {
  const { find, sent, page, wc } = setup()
  find.find(wc, 'a')
  assert.equal(page.key({ shift: true }), false)
  assert.equal(page.key({ meta: true }), false)
  assert.equal(page.key({ type: 'keyUp' }), false)
  assert.equal(page.key({ key: 'Enter' }), false)
  assert.equal(find.open, true)
  assert.equal(page.key({}), true)
  assert.equal(find.open, false)
  assert.deepEqual(sent, [{ close: true }])
  // With the bar closed, Esc reaches the page.
  assert.equal(page.key({}), false)
})

test('events from a page that is no longer searched are ignored', () => {
  const { find, sent, page, wc } = setup()
  const other = new FakePage()
  find.find(wc, 'a')
  find.find(other as unknown as WebContents, 'b')
  page.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false })
  page.emit('destroyed')
  assert.equal(page.key({}), false)
  assert.equal(find.open, true)
  assert.deepEqual(sent, [])
})

test('a page is listened to once however often it is searched', () => {
  const { find, page, wc } = setup()
  find.find(wc, 'a')
  find.stop()
  find.find(wc, 'b')
  assert.equal(page.listenerCount('found-in-page'), 1)
  assert.equal(page.listenerCount('before-input-event'), 1)
})
