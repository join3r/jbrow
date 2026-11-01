import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, test } from 'node:test'
import { HistoryLog, pageKey, searchOf, whenCutoff } from '../../src/main/history-log'
import type { HistoryQuery } from '../../src/shared/types'

const dir = mkdtempSync(path.join(os.tmpdir(), 'jbrow-history-test-'))
after(() => rmSync(dir, { recursive: true, force: true }))

const ENGINES = [{ name: 'Google', url: 'https://www.google.com/search?q=%s' }]
const NOW = new Date(2026, 10, 1, 15, 0).getTime()
const MIN = 60 * 1000
const DAY = 24 * 60 * MIN

let n = 0
function makeLog(openers: Record<string, string> = {}) {
  const log = new HistoryLog({ openerOf: (id) => openers[id], searchOf: (url) => searchOf(url, ENGINES) })
  log.open(path.join(dir, `h${n++}.sqlite`))
  return log
}

const Q = (over: Partial<HistoryQuery> = {}): HistoryQuery => ({
  seq: 1, text: '', view: 'pages', when: 'all', profile: 'all', how: [], sites: [], read: false, hideRedirects: true, state: 'any', limit: 100, ...over,
})
const ctx = (over = {}) => ({ open: new Set<string>(), kept: new Set<string>(), profiles: [{ id: 'p', name: 'Personal', color: '' }, { id: 'w', name: 'Work', color: '' }], now: NOW, ...over })

test('searchOf finds the query on a listed engine, with or without www', () => {
  assert.deepEqual(searchOf('https://google.com/search?q=sqlite+wal&hl=en', ENGINES), { query: 'sqlite wal', engine: 'Google' })
  assert.equal(searchOf('https://www.google.com/maps?q=x', ENGINES), undefined)
  assert.equal(searchOf('https://bing.com/search?q=x', ENGINES), undefined)
})

test('a typed search starts a trail; links in the tab and tabs it opens follow it; reloads are no visits', () => {
  const log = makeLog({ t2: 't1' })
  log.intend('t1', 'typed')
  const s = log.visit('t1', 'p', 'https://www.google.com/search?q=wal', NOW - 30 * MIN)!
  const a = log.visit('t1', 'p', 'https://sqlite.org/wal.html', NOW - 29 * MIN)!
  assert.equal(log.visit('t1', 'p', 'https://sqlite.org/wal.html', NOW - 28 * MIN), null)
  const b = log.visit('t2', 'p', 'https://stackoverflow.com/q/1', NOW - 20 * MIN)!
  log.intend('t3', 'app', 'Slack')
  const c = log.visit('t3', 'w', 'https://github.com/acme/api/pull/482', NOW - 10 * MIN)!
  const r = log.query(Q({ view: 'trails' }), ctx())
  assert.equal(r.total, 4)
  assert.equal(r.trailCount, 2)
  assert.deepEqual(r.trails!.map((t) => [t.id, t.start.how, t.start.query ?? t.start.app, t.visits.map((v) => v.id)]), [
    [c, 'app', 'Slack', [c]],
    [s, 'search', 'wal', [s, a, b]],
  ])
  assert.deepEqual(r.facets.how, { search: 1, link: 2, app: 1 })
  log.close()
})

test('a page left within seconds for another on its own is a redirect, hidden unless asked for', () => {
  const log = makeLog()
  log.intend('t', 'typed')
  log.visit('t', 'w', 'https://portal.example/', NOW - 60_000)
  log.visit('t', 'w', 'https://login.example/sso', NOW - 9_000)
  log.visit('t', 'w', 'https://portal.example/home', NOW - 8_000)
  assert.deepEqual(log.query(Q(), ctx()).pages!.map((v) => v.url), ['https://portal.example/home', 'https://portal.example/'])
  assert.equal(log.query(Q({ hideRedirects: false }), ctx()).total, 3)
  // The page the sign-in redirected to takes its place: reached by a link from the portal.
  assert.deepEqual(log.query(Q(), ctx()).pages!.map((v) => v.how), ['link', 'typed'])
  log.close()
})

test('a page you clicked or typed in is no redirect, however soon you leave it', () => {
  const log = makeLog()
  log.intend('t', 'typed')
  log.visit('t', 'p', 'https://a.example/', NOW - 2000)
  log.touched('t')
  log.visit('t', 'p', 'https://a.example/next', NOW - 1000)
  assert.equal(log.query(Q(), ctx()).total, 2)
  log.close()
})

test('filters: when, profile, read, sites, state and operators, each facet counted without its own filter', () => {
  const log = makeLog()
  const add = (tab: string, profile: string, url: string, at: number, secs = 0) => {
    log.intend(tab, 'typed')
    log.visit(tab, profile, url, at)
    log.addTime([tab], secs)
  }
  add('a', 'p', 'https://news.example/1', NOW - MIN, 120)
  add('b', 'w', 'https://github.com/acme', NOW - DAY, 30)
  add('c', 'w', 'https://github.com/acme/api', NOW - 3 * DAY, 300)
  add('d', 'p', 'https://old.example/', NOW - 200 * DAY, 10)
  assert.equal(log.query(Q({ when: 'today' }), ctx()).total, 1)
  assert.equal(log.query(Q({ when: 'yesterday' }), ctx()).total, 2)
  const week = log.query(Q({ when: 'week' }), ctx())
  assert.equal(week.total, 3)
  assert.deepEqual(week.facets.when, { today: 1, yesterday: 2, week: 3, month: 3, all: 4 })
  assert.deepEqual(week.facets.profile, { p: 1, w: 2 })
  assert.deepEqual(log.query(Q({ read: true }), ctx()).pages!.map((v) => v.url), ['https://news.example/1', 'https://github.com/acme/api'])
  assert.deepEqual(log.query(Q({ sites: ['github.com'] }), ctx()).facets.sites[0], { host: 'github.com', count: 2 })
  assert.equal(log.query(Q({ text: 'site:github in:work' }), ctx()).total, 2)
  assert.equal(log.query(Q({ text: 'in:personal' }), ctx()).total, 2)
  const open = ctx({ open: new Set([pageKey('w', 'https://github.com/acme')]) })
  const r = log.query(Q({ state: 'open' }), open)
  assert.deepEqual(r.pages!.map((v) => [v.url, v.state]), [['https://github.com/acme', 'open']])
  assert.equal(r.facets.open, 1)
  log.close()
})

test("finds pages by their text, with where it matched; forgetting a page takes its text too", () => {
  const log = makeLog()
  log.intend('t', 'typed')
  log.visit('t', 'p', 'https://sqlite.org/wal.html', NOW - MIN)
  log.setTitle('p', 'https://sqlite.org/wal.html', 'Write-Ahead Logging')
  log.saveText('p', 'https://sqlite.org/wal.html', 'Write-Ahead Logging', 'By default a checkpoint runs automatically when the WAL file reaches 1000 pages.')
  const r = log.query(Q({ text: 'checkpoint' }), ctx())
  assert.equal(r.total, 1)
  assert.equal(r.pages![0].title, 'Write-Ahead Logging')
  assert.match(r.pages![0].snippet!, /\u0001checkpoint\u0002 runs/)
  assert.equal(log.query(Q({ text: 'logging' }), ctx()).pages![0].snippet, undefined)
  assert.equal(log.query(Q({ text: 'checkpoint nowhere' }), ctx()).total, 0)
  log.forgetPage('p', 'https://sqlite.org/wal.html')
  assert.equal(log.query(Q({ text: 'checkpoint' }), ctx()).total, 0)
  // Text read from the page after it was forgotten isn't kept, and the tab adds no time to it.
  log.saveText('p', 'https://sqlite.org/wal.html', 'Write-Ahead Logging', 'checkpoint again')
  log.addTime(['t'], 30)
  assert.equal(log.query(Q({ text: 'checkpoint', hideRedirects: false }), ctx()).total, 0)
  assert.equal(log.currentVisit('t'), undefined)
  log.close()
})

test('sites by time spent with visits per day; searches with the pages they led to', () => {
  const log = makeLog()
  log.intend('t', 'typed')
  log.visit('t', 'p', 'https://www.google.com/search?q=lentil+soup', NOW - 2 * DAY)
  log.visit('t', 'p', 'https://www.google.com/search?q=lentil+soup&start=10', NOW - 2 * DAY + 5000)
  log.visit('t', 'p', 'https://www.google.com/search?q=lentil+soup&start=10&sei=x', NOW - 2 * DAY + 6000)
  log.visit('t', 'p', 'https://recipes.example/lentil', NOW - 2 * DAY + MIN)
  log.addTime(['t'], 600)
  const sites = log.query(Q({ view: 'sites' }), ctx()).sites!
  assert.deepEqual(sites.map((s) => [s.host, s.visits, s.secs, s.days]), [
    ['recipes.example', 1, 600, [0, 0, 0, 0, 1, 0, 0]],
    ['google.com', 2, 0, [0, 0, 0, 0, 2, 0, 0]],
  ])
  const searches = log.query(Q({ view: 'searches' }), ctx()).searches!
  assert.deepEqual(searches.map((s) => [s.query, s.led.map((l) => l.url)]), [['lentil soup', []]])
  log.close()
})

test('imported pages show once each, and old visits go after a year', () => {
  const log = makeLog()
  const pages = [{ url: 'https://a.example/', title: 'A', last: NOW - DAY }, { url: 'https://b.example/', title: 'B', last: NOW - 400 * DAY }]
  log.importPages('p', pages, 'Arc')
  log.importPages('p', pages, 'Arc')
  const r = log.query(Q({ when: 'all' }), ctx({ now: NOW }))
  assert.deepEqual(r.pages!.map((v) => [v.url, v.how, v.app]), [['https://a.example/', 'imported', 'Arc']])
  assert.ok(whenCutoff('all', NOW) < NOW - 364 * DAY)
  log.close()
})
