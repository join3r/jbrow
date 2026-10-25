import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, mock, test } from 'node:test'
import { net } from 'electron'
import { userData } from '../mocks/electron'
import { DangerousSites } from '../../src/main/dangerous'

const dir = path.join(userData, 'blocklists')
const HOUR = 60 * 60 * 1000
const PHISHING = 'https://malware-filter.gitlab.io/malware-filter/phishing-filter-hosts.txt'
const MALWARE = 'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-hosts.txt'

/** A hosts file with these hosts plus enough filler to pass the size check. */
const hostsFile = (hosts: string[], filler = 120, tag = 'x') =>
  ['# Title: test list', '# Expires: 12 hours', '', ...hosts.map((h) => `0.0.0.0 ${h}`), ...Array.from({ length: filler }, (_, i) => `0.0.0.0 ${tag}${i}.filler.example`)].join('\n')

let fetches: string[] = []
let answers: Record<string, () => Response> = {}
const realFetch = net.fetch

function setup(enabled = () => true) {
  let changes = 0
  let waiting: (() => void) | null = null
  const d = new DangerousSites({
    enabled,
    onChange: () => {
      changes++
      waiting?.()
    },
  })
  /** Runs the timer that's due in `ms` and waits for the download it starts. */
  const refreshAfter = async (ms: number) => {
    const done = new Promise<void>((resolve) => (waiting = resolve))
    mock.timers.tick(ms)
    await done
  }
  return { d, changes: () => changes, refreshAfter }
}

const quiet = () => {
  const [log, error] = [console.log, console.error]
  console.log = console.error = () => {}
  return () => {
    console.log = log
    console.error = error
  }
}
let restore = () => {}

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true })
  fetches = []
  answers = {
    [PHISHING]: () => new Response(hostsFile(['phish.example', 'login-paypa1.com'], 120, 'p')),
    [MALWARE]: () => new Response(hostsFile(['malware.example', '203.0.113.7'], 120, 'm')),
  }
  net.fetch = (async (url: string) => {
    fetches.push(url)
    const answer = answers[url]
    if (!answer) throw new Error(`unexpected fetch ${url}`)
    return answer()
  }) as typeof net.fetch
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  restore = quiet()
})
afterEach(() => {
  restore()
  mock.timers.reset()
  net.fetch = realFetch
})

test('without saved lists, they are downloaded five seconds after start', async () => {
  const { d, refreshAfter } = setup()
  d.start()
  assert.equal(d.status().hosts, 0)
  assert.equal(d.status().updated, null)
  await refreshAfter(5000)
  assert.deepEqual(fetches, [PHISHING, MALWARE])
  assert.equal(d.status().hosts, 244)
  assert.equal(d.status().updated, Date.now())
  assert.match(readFileSync(path.join(dir, 'phishing.txt'), 'utf8'), /phish\.example/)
  assert.equal(existsSync(path.join(dir, 'phishing.txt.tmp')), false)
  assert.equal(d.listed('p', 'https://phish.example/login'), 'phishing')
  assert.equal(d.listed('p', 'http://203.0.113.7/payload.exe'), 'malware')
})

test('nothing is downloaded while the setting is off', async () => {
  let on = false
  const { d, changes } = setup(() => on)
  d.start()
  mock.timers.tick(5000)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(fetches, [])
  assert.equal(changes(), 0)
  // Nor later: a refresh while it's off doesn't schedule another.
  mock.timers.tick(24 * HOUR)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(fetches, [])
  // Turned back on, start() downloads again.
  on = true
  const again = setup(() => on)
  again.d.start()
  await again.refreshAfter(5000)
  assert.equal(fetches.length, 2)
})

test('fresh saved lists are used without downloading until they are 12 hours old', async () => {
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'phishing.txt'), hostsFile(['saved-phish.example'], 0))
  writeFileSync(path.join(dir, 'malware.txt'), hostsFile(['saved-malware.example'], 0))
  const twoHoursAgo = (Date.now() - 2 * HOUR) / 1000
  utimesSync(path.join(dir, 'phishing.txt'), twoHoursAgo, twoHoursAgo)
  const { d, refreshAfter } = setup()
  d.start()
  assert.equal(d.status().hosts, 2)
  assert.ok(Math.abs(d.status().updated! - (Date.now() - 2 * HOUR)) < 1000)
  assert.equal(d.listed('p', 'https://saved-phish.example/'), 'phishing')
  mock.timers.tick(9 * HOUR)
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(fetches, [])
  await refreshAfter(1 * HOUR)
  assert.equal(fetches.length, 2)
  // The new lists replace the saved ones.
  assert.equal(d.listed('p', 'https://saved-phish.example/'), null)
})

test('a short or failed download keeps the old list and retries in an hour', async () => {
  answers[PHISHING] = () => new Response(hostsFile(['phish.example'], 10))
  answers[MALWARE] = () => new Response('Service Unavailable', { status: 503 })
  mkdirSync(dir, { recursive: true })
  writeFileSync(path.join(dir, 'phishing.txt'), hostsFile(['old-phish.example'], 0))
  const { d, refreshAfter } = setup()
  d.start()
  await refreshAfter(5000)
  assert.equal(d.listed('p', 'https://old-phish.example/'), 'phishing')
  assert.equal(d.listed('p', 'https://phish.example/'), null)
  assert.equal(d.status().updated, null)
  assert.match(readFileSync(path.join(dir, 'phishing.txt'), 'utf8'), /old-phish/)

  answers[PHISHING] = () => new Response(hostsFile(['phish.example']))
  answers[MALWARE] = () => new Response(hostsFile(['malware.example']))
  fetches = []
  await refreshAfter(HOUR)
  assert.equal(fetches.length, 2)
  assert.equal(d.listed('p', 'https://phish.example/'), 'phishing')
  assert.equal(d.status().updated, Date.now())
})

test('a network error is survived', async () => {
  answers[PHISHING] = () => {
    throw new TypeError('net::ERR_INTERNET_DISCONNECTED')
  }
  const { d, refreshAfter } = setup()
  d.start()
  await refreshAfter(5000)
  assert.equal(d.listed('p', 'https://malware.example/'), 'malware')
  assert.equal(d.status().updated, null)
})

async function loaded() {
  const s = setup()
  s.d.start()
  await s.refreshAfter(5000)
  return s
}

test('lookups match the host and the domains it is under, case and trailing dot aside', async () => {
  const { d } = await loaded()
  assert.equal(d.listed('p', 'https://phish.example/'), 'phishing')
  assert.equal(d.listed('p', 'https://deep.sub.PHISH.example./x?y#z'), 'phishing')
  assert.equal(d.listed('p', 'http://phish.example:8080/'), 'phishing')
  assert.equal(d.listed('p', 'https://notphish.example/'), null)
  assert.equal(d.listed('p', 'https://example/'), null)
  assert.equal(d.listed('p', 'https://phish.example.org/'), null)
})

test('only web addresses are checked', async () => {
  const { d } = await loaded()
  for (const url of ['file:///C:/phish.example/index.html', 'ftp://phish.example/', 'about:blank', 'not a url', 'http://[::1]/', '']) {
    assert.equal(d.listed('p', url), null, url)
  }
})

test('the setting turns warnings off', async () => {
  let on = true
  const s = setup(() => on)
  s.d.start()
  await s.refreshAfter(5000)
  on = false
  assert.equal(s.d.listed('p', 'https://phish.example/'), null)
  assert.equal(s.d.check('t', 'p', 'https://phish.example/'), false)
})

test('check blocks the tab, proceed lets the profile through to that host', async () => {
  const { d, changes } = await loaded()
  const before = changes()
  assert.equal(d.check('t', 'p', 'https://www.phish.example/a'), true)
  assert.equal(d.isBlocked('t'), true)
  assert.deepEqual(d.view('t'), { url: 'https://www.phish.example/a', host: 'www.phish.example', kind: 'phishing' })
  assert.equal(changes(), before + 1)
  assert.equal(d.check('safe', 'p', 'https://example.org/'), false)
  assert.equal(d.isBlocked('safe'), false)

  assert.equal(d.proceed('t', 'p'), 'https://www.phish.example/a')
  assert.equal(d.isBlocked('t'), false)
  assert.equal(d.view('t'), null)
  assert.equal(d.listed('p', 'https://www.phish.example/b'), null)
  // Only that host, only that profile.
  assert.equal(d.listed('p', 'https://phish.example/'), 'phishing')
  assert.equal(d.listed('q', 'https://www.phish.example/'), 'phishing')
  assert.equal(d.proceed('t', 'p'), null)
})

test('clear removes the warning', async () => {
  const { d, changes } = await loaded()
  d.check('t', 'p', 'https://malware.example/')
  const before = changes()
  d.clear('t')
  assert.equal(d.isBlocked('t'), false)
  assert.equal(changes(), before + 1)
  d.clear('t')
  assert.equal(changes(), before + 1)
})

test('list parsing skips comments, blank lines and CRLF endings', async () => {
  const lines = ['# comment', '', '0.0.0.0 crlf.example\r', '  0.0.0.0   spaced.example  ', '0.0.0.0 commented.example # why', '0.0.0.0', 'loner']
  answers[PHISHING] = () => new Response(lines.join('\n') + '\n' + hostsFile([], 120))
  const { d } = await loaded()
  assert.equal(d.listed('p', 'https://crlf.example/'), 'phishing')
  assert.equal(d.listed('p', 'https://spaced.example/'), 'phishing')
  assert.equal(d.listed('p', 'https://commented.example/'), 'phishing')
  assert.equal(d.listed('p', 'https://loner/'), null)
})
