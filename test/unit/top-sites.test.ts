import assert from 'node:assert/strict'
import { test } from 'node:test'
import list from '../../src/main/top-sites.json'
import { topSiteCompletion } from '../../src/main/top-sites'

const never = () => false

test('the list is hosts with a CrUX bucket', () => {
  assert.ok(list.length > 1000)
  for (const [host, bucket] of list as [string, number][]) {
    assert.match(host, /^[a-z0-9.-]+$/, host)
    assert.ok(bucket === 1000 || bucket === 5000, host)
  }
})

test('completes to the most popular site starting with what was typed', () => {
  assert.deepEqual(topSiteCompletion('youtu', never), { text: 'youtube.com', url: 'https://www.youtube.com/' })
  assert.deepEqual(topSiteCompletion('GOOG', never)?.text.startsWith('goog'), true)
})

test('keeps www when typed', () => {
  assert.deepEqual(topSiteCompletion('www.youtu', never), { text: 'www.youtube.com', url: 'https://www.youtube.com/' })
})

test('fewer than three letters never complete', () => {
  for (const typed of ['', 'y', 'yo', 'www.', 'www.y', 'www.yo']) assert.equal(topSiteCompletion(typed, never), null, typed)
})

test('three letters complete only to a top 1k site, four to any', () => {
  const five = (list as [string, number][]).find(([host, bucket]) => bucket === 5000 && host.replace(/^www\./, '').length > 5)!
  const bare = five[0].replace(/^www\./, '')
  const hit = (typed: string) => topSiteCompletion(typed, never)
  // Four or more letters of a 5k site complete to it, or to a more popular one with the same start.
  const four = hit(bare.slice(0, 4))
  assert.ok(four && four.text.startsWith(bare.slice(0, 4)))
  const three = hit(bare.slice(0, 3))
  if (three) {
    const host = three.url.replace(/^https:\/\//, '').replace(/\/$/, '')
    assert.equal((list as [string, number][]).find(([h]) => h === host)?.[1], 1000)
  }
})

test('a complete host or anything with a scheme, path, port or space does not complete', () => {
  for (const typed of ['youtube.com', 'youtube.com/', 'https://youtu', 'youtu be', 'youtu?', 'youtu#', 'localhost:3']) {
    assert.equal(topSiteCompletion(typed, never), null, typed)
  }
})

test('private sites are skipped for the next match', () => {
  const first = topSiteCompletion('goog', never)!
  const next = topSiteCompletion('goog', (url) => url === first.url)
  assert.ok(next)
  assert.notEqual(next.url, first.url)
  assert.equal(topSiteCompletion('goog', () => true), null)
})

test('nothing for letters no site starts with', () => {
  assert.equal(topSiteCompletion('zzzqqq', never), null)
})
