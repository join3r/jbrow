import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NativeWatch, span, UNANSWERED_MS, type NativeHostEvent } from '../../src/main/native-watch'

function setup(running = true) {
  let now = 1_000_000
  const lines: string[] = []
  const state = { running }
  const watch = new NativeWatch('personal', {
    now: () => now,
    log: (l) => lines.push(l),
    name: () => 'Stem',
    workerRunning: () => state.running,
  })
  const base = { extensionId: 'x', connectionId: 'c1', application: 'com.stem.browser', opener: 'service-worker' as const, versionId: 7 }
  const ev = (kind: NativeHostEvent['kind'], data?: unknown) => watch.host({ ...base, kind, data })
  return { watch, lines, ev, state, tick: (ms: number) => void (now += ms) }
}

test('logs a host opening, its process and why it closed', () => {
  const { lines, ev, tick } = setup()
  ev('open')
  ev('spawn', { pid: 42 })
  tick(3 * 60_000)
  ev('close', { reason: 'its service worker stopped' })
  assert.deepEqual(lines, [
    '[native] personal: Stem (com.stem.browser): opened from its service worker',
    '[native] personal: Stem (com.stem.browser): host running, pid 42',
    '[native] personal: Stem (com.stem.browser): closed after 3 min: its service worker stopped',
  ])
})

test('a request with no answer is logged once, and so is its late answer', () => {
  const { watch, lines, ev, tick } = setup()
  ev('open')
  ev('out', { type: 'hello' })
  tick(12 * 60_000)
  ev('in', { type: 'request', id: 'req-1' })
  ev('in', { type: 'request', id: 'req-2' })
  ev('in', { type: 'profile', name: 'Personal' })
  tick(UNANSWERED_MS - 1)
  watch.sweep()
  assert.equal(lines.length, 1)
  tick(1)
  watch.sweep()
  watch.sweep()
  assert.equal(lines.length, 2)
  assert.match(lines[1], /no answer to "request" req-1 for 60 s \(and 1 more\); service worker running \(last status unknown\); last message from the extension 13 min ago/)
  tick(5_000)
  ev('out', { type: 'result', id: 'req-1' })
  assert.match(lines[2], /answered "request" req-1 after 65 s/)
  ev('close', { reason: 'the extension disconnected' })
  assert.match(lines[3], /closed after 13 min: the extension disconnected, 1 request\(s\) unanswered/)
})

test('answered requests are never logged', () => {
  const { watch, lines, ev, tick } = setup()
  ev('open')
  ev('in', { type: 'request', id: 'a' })
  tick(1_000)
  ev('out', { type: 'result', id: 'a' })
  tick(UNANSWERED_MS * 2)
  watch.sweep()
  assert.equal(lines.length, 1)
})

test('a message for a worker that is not running is logged once', () => {
  const { watch, lines, ev, state } = setup()
  ev('open')
  state.running = false
  watch.workerStatus(7, 'stopped')
  ev('in', { type: 'request', id: 'a' })
  ev('in', { type: 'request', id: 'b' })
  const lost = lines.filter((l) => l.includes("isn't running"))
  assert.equal(lost.length, 1)
  assert.match(lost[0], /last status stopped/)
})

test('status changes are logged only for workers holding a host', () => {
  const { watch, lines, ev } = setup()
  watch.workerStatus(7, 'stopping')
  assert.equal(lines.length, 0)
  ev('open')
  watch.workerStatus(8, 'stopping')
  watch.workerStatus(7, 'stopping')
  assert.deepEqual(lines.slice(1), ['[native] personal: Stem: its service worker is stopping, holding com.stem.browser'])
})

test('worker errors are capped at ten a minute, with a count of the rest', () => {
  const { watch, lines, tick } = setup()
  for (let i = 0; i < 13; i++) watch.workerError('x', `boom ${i}`, 'background.js:3')
  assert.equal(lines.length, 10)
  assert.equal(lines[0], '[native] personal: Stem: service worker error: boom 0 (background.js:3)')
  tick(60_000)
  watch.workerError('x', 'again', '')
  assert.deepEqual(lines.slice(10), [
    '[native] personal: Stem: 3 more error(s) from its service worker were left out',
    '[native] personal: Stem: service worker error: again',
  ])
})

test('span', () => {
  assert.equal(span(45_000), '45 s')
  assert.equal(span(12 * 60_000), '12 min')
  assert.equal(span(185 * 60_000), '3 h 5 min')
})

function restartable() {
  let now = 1_000_000
  const lines: string[] = []
  const restarted: string[] = []
  const watch = new NativeWatch('personal', {
    now: () => now,
    log: (l) => lines.push(l),
    name: () => 'Stem',
    workerRunning: () => false,
    restartWorker: async (id) => void restarted.push(id),
  })
  const base = { extensionId: 'x', application: 'com.stem.browser', opener: 'service-worker' as const, versionId: 7 }
  const cycle = (n: number, reason = 'its service worker stopped') => {
    watch.host({ ...base, connectionId: `c${n}`, kind: 'open' })
    watch.host({ ...base, connectionId: `c${n}`, kind: 'close', data: { reason } })
  }
  return { lines, restarted, cycle, tick: (ms: number) => void (now += ms) }
}

test('a worker that stopped while holding a host is started again', () => {
  const { lines, restarted, cycle } = restartable()
  cycle(1)
  assert.deepEqual(restarted, ['x'])
  assert.match(lines.at(-1)!, /stopped while holding com.stem.browser; starting it again/)
})

test('a host closed for any other reason starts nothing', () => {
  const { restarted, cycle } = restartable()
  cycle(1, 'the extension disconnected')
  cycle(2, 'the extension unloaded')
  assert.deepEqual(restarted, [])
})

test('a worker that keeps crashing is started at most three times in ten minutes', () => {
  const { lines, restarted, cycle, tick } = restartable()
  for (let i = 0; i < 4; i++) cycle(i)
  assert.equal(restarted.length, 3)
  assert.match(lines.at(-1)!, /stopped 4 times in 10 min; not starting it again/)
  tick(10 * 60_000)
  cycle(9)
  assert.equal(restarted.length, 4)
})
