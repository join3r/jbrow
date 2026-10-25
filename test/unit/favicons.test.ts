import assert from 'node:assert/strict'
import { readdirSync, utimesSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { before, test } from 'node:test'
import type { Session } from 'electron'
import { userData } from '../mocks/electron'
import { faviconUrl, handleFavicons, ICON_SCHEME } from '../../src/main/favicons'

const dir = path.join(userData, 'favicons')
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])

test('faviconUrl wraps web icons in jbrow-icon: with the profile', () => {
  const url = faviconUrl('work', 'https://example.com/favicon.ico?v=2&x=ü')
  assert.equal(ICON_SCHEME, 'jbrow-icon')
  const u = new URL(url)
  assert.equal(u.protocol, 'jbrow-icon:')
  assert.equal(u.searchParams.get('p'), 'work')
  assert.equal(u.searchParams.get('u'), 'https://example.com/favicon.ico?v=2&x=ü')
  assert.match(faviconUrl('p', 'HTTP://example.com/a.png'), /^jbrow-icon:\/\/icon\/\?/)
})

test('faviconUrl leaves icons that are not on the web as they are', () => {
  for (const url of ['data:image/png;base64,AAAA', 'file:///C:/icons/a.png', 'chrome-extension://x/icon.png', '']) {
    assert.equal(faviconUrl('p', url), url)
  }
})

// ---------- the jbrow-icon: handler ----------

let handler: (req: Request) => Promise<Response>
const fetched: string[] = []
const sessions = new Map<string, Session>()
let answer: (url: string) => Response | Promise<Response> = () => new Response(PNG, { headers: { 'content-type': 'image/png; charset=binary' } })

before(() => {
  // A saved icon nobody has asked for in 100 days is cleaned up at launch.
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'stale'), 'image/png\nx')
  const old = (Date.now() - 100 * 24 * 60 * 60 * 1000) / 1000
  utimesSync(path.join(dir, 'stale'), old, old)
  writeFileSync(path.join(dir, 'recent'), 'image/png\nx')
  const fake = (name: string) =>
    ({
      fetch: async (url: string) => {
        fetched.push(`${name} ${url}`)
        return answer(url)
      },
    }) as unknown as Session
  sessions.set('p', fake('p'))
  sessions.set('q', fake('q'))
  const ui = { protocol: { handle: (scheme: string, h: typeof handler) => scheme === ICON_SCHEME && (handler = h) } }
  handleFavicons(ui as unknown as Session, (id) => sessions.get(id) ?? null)
})

const get = (profile: string, url: string) => handler(new Request(faviconUrl(profile, url)))

test('old saved icons are deleted at launch', () => {
  assert.equal(existsSync(path.join(dir, 'stale')), false)
  assert.equal(existsSync(path.join(dir, 'recent')), true)
})

test('an icon is fetched through the profile’s session and saved', async () => {
  const res = await get('p', 'https://a.example/favicon.png')
  assert.equal(res.status, 200)
  assert.equal(res.headers.get('content-type'), 'image/png')
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PNG)
  assert.deepEqual(fetched, ['p https://a.example/favicon.png'])
  // The second time it comes from disk.
  const again = await get('p', 'https://a.example/favicon.png')
  assert.deepEqual(new Uint8Array(await again.arrayBuffer()), PNG)
  assert.equal(fetched.length, 1)
  // Another profile has its own copy.
  await get('q', 'https://a.example/favicon.png')
  assert.deepEqual(fetched.slice(1), ['q https://a.example/favicon.png'])
})

test('requests at once share one fetch', async () => {
  fetched.length = 0
  const [a, b] = await Promise.all([get('p', 'https://b.example/i.png'), get('p', 'https://b.example/i.png')])
  assert.equal(a.status, 200)
  assert.equal(b.status, 200)
  assert.equal(fetched.length, 1)
})

test('a stale icon is fetched again, and kept when that fails', async () => {
  await get('p', 'https://c.example/i.png')
  const before = new Set(readdirSync(dir))
  for (const name of before) {
    const old = (Date.now() - 8 * 24 * 60 * 60 * 1000) / 1000
    utimesSync(path.join(dir, name), old, old)
  }
  fetched.length = 0
  const saved = answer
  answer = () => new Response('down', { status: 503, headers: { 'content-type': 'text/plain' } })
  try {
    const res = await get('p', 'https://c.example/i.png')
    assert.equal(fetched.length, 1)
    assert.equal(res.status, 200)
    assert.deepEqual(new Uint8Array(await res.arrayBuffer()), PNG)
  } finally {
    answer = saved
  }
})

test('answers that are not images, empty or over a megabyte are not icons', async () => {
  const saved = answer
  const bodies: Response[] = [
    new Response('<html>', { headers: { 'content-type': 'text/html' } }),
    new Response(new Uint8Array(0), { headers: { 'content-type': 'image/png' } }),
    new Response(new Uint8Array(1024 * 1024 + 1), { headers: { 'content-type': 'image/png' } }),
    new Response(PNG, { status: 404, headers: { 'content-type': 'image/png' } }),
    new Response(PNG),
  ]
  try {
    for (const [i, body] of bodies.entries()) {
      answer = () => body
      assert.equal((await get('p', `https://bad${i}.example/i.png`)).status, 404, String(i))
    }
    answer = () => {
      throw new TypeError('net::ERR_NAME_NOT_RESOLVED')
    }
    assert.equal((await get('p', 'https://offline.example/i.png')).status, 404)
  } finally {
    answer = saved
  }
})

test('a profile that is gone gets no icon', async () => {
  assert.equal((await get('deleted', 'https://d.example/i.png')).status, 404)
})

test('only web icons are served', async () => {
  for (const u of ['file:///C:/Windows/icon.ico', 'data:image/png;base64,AA', '']) {
    const res = await handler(new Request(`${ICON_SCHEME}://icon/?${new URLSearchParams({ p: 'p', u })}`))
    assert.equal(res.status, 400, u)
  }
  assert.equal((await handler(new Request(`${ICON_SCHEME}://icon/`))).status, 400)
})
