import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, mock, test } from 'node:test'
import { net } from 'electron'
import { userData } from '../mocks/electron'
import { BrowsingHistory, fetchSearchSuggestions } from '../../src/main/visits'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.UTC(2026, 5, 1)
const file = path.join(userData, 'visits.json')
const never = () => false
const saved = () => JSON.parse(readFileSync(file, 'utf8')) as Record<string, { url: string; title: string; visits: number; last: number }[]>

beforeEach(() => {
  rmSync(file, { force: true })
  mock.timers.enable({ apis: ['Date', 'setTimeout'], now: NOW })
})
afterEach(() => mock.timers.reset())

/** Visits `url` `times` times, each far enough apart to count. */
function visit(h: BrowsingHistory, url: string, times = 1, title = '', profile = 'p') {
  for (let i = 0; i < times; i++) {
    h.record(profile, url, title)
    mock.timers.tick(2 * 60 * 1000)
  }
}

test('records only web pages', () => {
  const h = new BrowsingHistory()
  for (const url of ['file:///C:/a.html', 'about:blank', 'chrome-extension://x/y', 'data:text/html,x', 'jbrow://settings']) h.record('p', url, 't')
  h.record('p', 'HTTPS://Example.com/', 'Example')
  h.flush()
  assert.deepEqual(saved().p.map((v) => v.url), ['HTTPS://Example.com/'])
})

test('a reload within a minute is not another visit, but updates the time and title', () => {
  const h = new BrowsingHistory()
  h.record('p', 'https://a.com/', 'A')
  mock.timers.tick(30_000)
  h.record('p', 'https://a.com/', '')
  h.flush()
  assert.deepEqual(saved().p[0], { url: 'https://a.com/', title: 'A', visits: 1, last: NOW + 30_000 })
  mock.timers.tick(61_000)
  h.record('p', 'https://a.com/', 'A again')
  h.flush()
  assert.equal(saved().p[0].visits, 2)
  assert.equal(saved().p[0].title, 'A again')
})

test('writes are batched five seconds later', () => {
  const h = new BrowsingHistory()
  h.record('p', 'https://a.com/', 'A')
  h.record('p', 'https://b.com/', 'B')
  assert.equal(existsSync(file), false)
  mock.timers.tick(5000)
  assert.equal(saved().p.length, 2)
})

test('setTitle updates a known page only', () => {
  const h = new BrowsingHistory()
  h.record('p', 'https://a.com/', '')
  h.setTitle('p', 'https://a.com/', 'Title')
  h.setTitle('p', 'https://b.com/', 'Nope')
  h.setTitle('q', 'https://a.com/', 'Other profile')
  h.setTitle('p', 'https://a.com/', '')
  h.flush()
  assert.deepEqual(saved(), { p: [{ url: 'https://a.com/', title: 'Title', visits: 1, last: NOW }] })
})

test('profiles are kept apart', () => {
  const h = new BrowsingHistory()
  visit(h, 'https://work.example.com/', 1, 'Work', 'work')
  visit(h, 'https://home.example.com/', 1, 'Home', 'personal')
  assert.deepEqual(h.search('work', 'example', 10).map((v) => v.url), ['https://work.example.com/'])
  assert.deepEqual(h.search('personal', 'example', 10).map((v) => v.url), ['https://home.example.com/'])
  assert.deepEqual(h.search('nobody', 'example', 10), [])
})

test('search needs every word, in the address or title', () => {
  const h = new BrowsingHistory()
  visit(h, 'https://github.com/join3r/jbrow', 1, 'jbrow: an ethereal browser')
  visit(h, 'https://news.ycombinator.com/', 1, 'Hacker News')
  assert.deepEqual(h.search('p', 'github browser', 10).map((v) => v.title), ['jbrow: an ethereal browser'])
  assert.deepEqual(h.search('p', '  HACKER   news ', 10).map((v) => v.url), ['https://news.ycombinator.com/'])
  assert.deepEqual(h.search('p', 'github safari', 10), [])
  assert.deepEqual(h.search('p', '   ', 10), [])
  assert.deepEqual(h.search('p', '', 10), [])
})

test('search ranks host matches, then title words, then the rest, each by frecency', () => {
  const h = new BrowsingHistory()
  visit(h, 'https://example.com/docs', 1, 'Docs')
  visit(h, 'https://blog.example.com/', 5, 'The docs blog')
  visit(h, 'https://docs.rs/', 1, 'Rust crates')
  visit(h, 'https://www.docs.google.com/', 3, 'Google')
  const urls = h.search('p', 'docs', 10).map((v) => v.url)
  // Host starts with it (www. ignored), more visits first; then a title word; then just the path.
  assert.deepEqual(urls, ['https://www.docs.google.com/', 'https://docs.rs/', 'https://blog.example.com/', 'https://example.com/docs'])
  assert.equal(h.search('p', 'docs', 2).length, 2)
})

test('recent visits outrank more visits long ago', () => {
  const h = new BrowsingHistory()
  visit(h, 'https://old.example/', 10, 'Example old')
  mock.timers.tick(60 * DAY)
  visit(h, 'https://new.example/', 4, 'Example new')
  // old: 10 visits × 30 (60 days), new: 4 × 100 (today).
  assert.deepEqual(h.search('p', 'example', 10).map((v) => v.url), ['https://new.example/', 'https://old.example/'])
})

test('equal rank prefers the shorter address', () => {
  const h = new BrowsingHistory()
  h.record('p', 'https://a.com/longer/path', 'x')
  h.record('p', 'https://a.com/', 'x')
  assert.deepEqual(h.search('p', 'a.com', 10).map((v) => v.url), ['https://a.com/', 'https://a.com/longer/path'])
})

test('completion picks the most visited host starting with what was typed', () => {
  const h = new BrowsingHistory()
  visit(h, 'https://github.com/a', 2)
  visit(h, 'https://github.com/b', 2)
  visit(h, 'https://gist.github.com/x', 3)
  assert.deepEqual(h.completion('p', 'gi', never), { text: 'github.com', url: 'https://github.com/' })
  assert.deepEqual(h.completion('p', 'GIS', never), { text: 'gist.github.com', url: 'https://gist.github.com/' })
})

test('completion breaks ties with the shorter host', () => {
  const h = new BrowsingHistory()
  visit(h, 'https://gist.github.com/')
  visit(h, 'https://github.com/')
  assert.equal(h.completion('p', 'gi', never)?.text, 'github.com')
})

test('completion keeps www when typed and the scheme visited', () => {
  const h = new BrowsingHistory()
  visit(h, 'http://www.example.com/page')
  assert.deepEqual(h.completion('p', 'exa', never), { text: 'example.com', url: 'http://www.example.com/' })
  assert.deepEqual(h.completion('p', 'www.ex', never), { text: 'www.example.com', url: 'http://www.example.com/' })
  assert.deepEqual(h.completion('p', 'www.', never), { text: 'www.example.com', url: 'http://www.example.com/' })
})

test('completion includes ports and IP hosts', () => {
  const h = new BrowsingHistory()
  visit(h, 'http://localhost:3000/app')
  visit(h, 'http://192.168.1.10:8080/')
  visit(h, 'http://[::1]:5173/')
  assert.deepEqual(h.completion('p', 'local', never), { text: 'localhost:3000', url: 'http://localhost:3000/' })
  assert.deepEqual(h.completion('p', 'localhost:3', never), { text: 'localhost:3000', url: 'http://localhost:3000/' })
  assert.deepEqual(h.completion('p', '192.168', never), { text: '192.168.1.10:8080', url: 'http://192.168.1.10:8080/' })
  assert.deepEqual(h.completion('p', '[::1', never), { text: '[::1]:5173', url: 'http://[::1]:5173/' })
})

test('completion of unicode hosts goes by their punycode', () => {
  const h = new BrowsingHistory()
  visit(h, 'https://bücher.de/')
  assert.deepEqual(h.completion('p', 'xn--b', never), { text: 'xn--bcher-kva.de', url: 'https://xn--bcher-kva.de/' })
})

test('completion only for a bare host prefix that is not already complete', () => {
  const h = new BrowsingHistory()
  visit(h, 'https://github.com/')
  for (const typed of ['', 'github.com', 'git hub', 'github.com/', 'gi?', 'gi#', 'nothing']) assert.equal(h.completion('p', typed, never), null, typed)
  assert.equal(h.completion('other', 'gi', never), null)
})

test('completion never offers a private address', () => {
  const h = new BrowsingHistory()
  visit(h, 'https://secret.example.com/', 9)
  visit(h, 'https://search.example.com/', 1)
  const isPrivate = (url: string) => url.includes('secret')
  assert.equal(h.completion('p', 's', isPrivate)?.text, 'search.example.com')
  assert.equal(h.completion('p', 'sec', isPrivate), null)
})

test('forget and clear', () => {
  const h = new BrowsingHistory()
  visit(h, 'https://a.com/', 1, 'A', 'x')
  visit(h, 'https://b.com/', 1, 'B', 'x')
  visit(h, 'https://c.com/', 1, 'C', 'y')
  h.forget('x', 'https://a.com/')
  assert.deepEqual(saved().x.map((v) => v.url), ['https://b.com/'])
  h.forget('x', 'https://nope.com/')
  h.clear('x')
  assert.deepEqual(Object.keys(saved()), ['y'])
  visit(h, 'https://d.com/', 1, 'D', 'z')
  h.clear('all')
  assert.deepEqual(saved(), {})
})

test('load reads what flush wrote', () => {
  const a = new BrowsingHistory()
  visit(a, 'https://a.com/', 3, 'A')
  a.flush()
  const b = new BrowsingHistory()
  b.load()
  assert.deepEqual(b.search('p', 'a.com', 5), [{ url: 'https://a.com/', title: 'A' }])
})

test('load forgets pages unvisited for 90 days and entries without an address', () => {
  writeFileSync(
    file,
    JSON.stringify({
      p: [
        { url: 'https://fresh.com/', title: 'fresh', visits: 1, last: NOW - 89 * DAY },
        { url: 'https://stale.com/', title: 'stale', visits: 99, last: NOW - 91 * DAY },
        { url: '', title: 'empty', visits: 1, last: NOW },
      ],
      gone: [{ url: 'https://stale.com/', title: 'stale', visits: 1, last: NOW - 100 * DAY }],
    }),
  )
  const h = new BrowsingHistory()
  h.load()
  h.flush()
  assert.deepEqual(saved(), { p: [{ url: 'https://fresh.com/', title: 'fresh', visits: 1, last: NOW - 89 * DAY }] })
})

test('load survives a missing or corrupt file', () => {
  const h = new BrowsingHistory()
  h.load()
  writeFileSync(file, '{"p": [')
  const error = console.error
  console.error = () => {}
  try {
    h.load()
  } finally {
    console.error = error
  }
  assert.deepEqual(h.search('p', 'a', 5), [])
  visit(h, 'https://a.com/')
  assert.equal(h.search('p', 'a', 5).length, 1)
})

test('at most 5000 pages per profile, the lowest ranked go first', () => {
  const data = {
    p: Array.from({ length: 5003 }, (_, i) => ({ url: `https://s${i}.com/`, title: '', visits: i < 3 ? 1 : 2, last: NOW })),
  }
  writeFileSync(file, JSON.stringify(data))
  const h = new BrowsingHistory()
  h.load()
  h.flush()
  const urls = new Set(saved().p.map((v) => v.url))
  assert.equal(urls.size, 5000)
  for (const i of [0, 1, 2]) assert.equal(urls.has(`https://s${i}.com/`), false)
})

test('fetchSearchSuggestions asks without cookies and returns the strings', async (t) => {
  const calls: [string, RequestInit][] = []
  t.mock.method(net, 'fetch', async (url: string, init: RequestInit) => {
    calls.push([url, init])
    return Response.json(['caf', ['café', '', '  ', 42, null, 'cafe near me']])
  })
  const signal = new AbortController().signal
  const got = await fetchSearchSuggestions('https://suggest.example/?q=%s&client=x', 'café & co/?', signal)
  assert.deepEqual(got, ['café', 'cafe near me'])
  assert.equal(calls[0][0], `https://suggest.example/?q=${encodeURIComponent('café & co/?')}&client=x`)
  assert.equal(calls[0][1].credentials, 'omit')
  assert.equal(calls[0][1].cache, 'no-store')
  assert.equal(calls[0][1].signal, signal)
})

test('fetchSearchSuggestions is empty for an error or an unexpected answer', async (t) => {
  const answers = [
    new Response('nope', { status: 500 }),
    Response.json({ suggestions: ['a'] }),
    Response.json(['q']),
    Response.json(['q', 'not a list']),
    Response.json(null),
  ]
  t.mock.method(net, 'fetch', async () => answers.shift()!)
  for (let i = 0; i < 5; i++) assert.deepEqual(await fetchSearchSuggestions('https://s/?q=%s', 'q', new AbortController().signal), [], String(i))
})

test('fetchSearchSuggestions lets an aborted request reject, for the caller to ignore', async (t) => {
  t.mock.method(net, 'fetch', async (_url: string, init: RequestInit) => {
    init.signal?.throwIfAborted()
    return Response.json(['q', ['x']])
  })
  const ctrl = new AbortController()
  ctrl.abort()
  await assert.rejects(fetchSearchSuggestions('https://s/?q=%s', 'q', ctrl.signal))
})
