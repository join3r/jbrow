import assert from 'node:assert/strict'
import { test } from 'node:test'
import { originOf, Preconnector, REPEAT_MS } from '../../src/main/preconnect'

function setup(opts: { enabled?: boolean; private?: string[] } = {}) {
  const calls: string[] = []
  let now = 1_000_000
  let enabled = opts.enabled ?? true
  const p = new Preconnector(
    (profile, origin) => void calls.push(`${profile} ${origin}`),
    () => enabled,
    (url) => (opts.private ?? []).some((h) => url.includes(h)),
    () => now,
  )
  return { p, calls, tick: (ms: number) => void (now += ms), setEnabled: (on: boolean) => void (enabled = on) }
}

test('connects to the origin of an http(s) address, in its profile', () => {
  const { p, calls } = setup()
  assert.equal(p.to('work', 'https://github.com/join3r/jbrow?tab=1'), true)
  assert.equal(p.to('work', 'http://localhost:5173/x'), true)
  assert.deepEqual(calls, ['work https://github.com', 'work http://localhost:5173'])
})

test('leaves out anything not http(s), and what is not an address', () => {
  const { p, calls } = setup()
  for (const url of ['file:///etc/hosts', 'chrome-extension://abc/popup.html', 'about:blank', 'data:text/html,hi', 'not a url', ''])
    assert.equal(p.to('personal', url), false, url)
  assert.deepEqual(calls, [])
})

test('never connects to a private address', () => {
  const { p, calls } = setup({ private: ['intranet.corp'] })
  assert.equal(p.to('personal', 'https://intranet.corp/wiki'), false)
  assert.deepEqual(calls, [])
})

test('asks once per origin and profile within the repeat interval', () => {
  const { p, calls, tick } = setup()
  assert.equal(p.to('personal', 'https://github.com/a'), true)
  assert.equal(p.to('personal', 'https://github.com/b'), false)
  // Another profile has its own session and connections.
  assert.equal(p.to('work', 'https://github.com/a'), true)
  tick(REPEAT_MS)
  assert.equal(p.to('personal', 'https://github.com/c'), true)
  assert.equal(calls.length, 3)
})

test('does nothing with the setting off', () => {
  const { p, calls, setEnabled } = setup()
  setEnabled(false)
  assert.equal(p.to('personal', 'https://github.com/'), false)
  setEnabled(true)
  assert.equal(p.to('personal', 'https://github.com/'), true)
  assert.equal(calls.length, 1)
})

test('originOf', () => {
  assert.equal(originOf('https://www.google.com/search?q=%s'), 'https://www.google.com')
  assert.equal(originOf('ftp://x.org/'), null)
})
