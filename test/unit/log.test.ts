import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { after, before, mock, test } from 'node:test'
import { Notification } from 'electron'
import { userData } from '../mocks/electron'
import { logPath, setupLogging } from '../../src/main/log'

const logs = path.join(userData, 'logs')
const file = path.join(logs, 'main.log')
const shown: { title: string; body: string }[] = []
const original = { log: console.log, info: console.info, warn: console.warn, error: console.error }
const printed: unknown[][] = []
/** jbrow's own handlers; emitting the real events would fail the test under the test runner. */
const handlers: Record<string, (error: unknown) => void> = {}

before(() => {
  // An old log over 5 MB is kept as main.log.1 and a new one started.
  mkdirSync(logs, { recursive: true })
  writeFileSync(file, Buffer.alloc(5 * 1024 * 1024 + 1, 'x'))
  ;(Notification.prototype as unknown as { show: () => void }).show = function (this: { options: [{ title: string; body: string }] }) {
    shown.push(this.options[0])
  }
  // Keep the test output clean: what jbrow prints goes here instead of the terminal.
  for (const level of ['log', 'info', 'warn', 'error'] as const) console[level] = (...args: unknown[]) => void printed.push(args)
  assert.equal(logPath(), null)
  const existing = new Set<unknown>([...process.listeners('uncaughtException'), ...process.listeners('unhandledRejection')])
  setupLogging()
  for (const event of ['uncaughtException', 'unhandledRejection'] as const) {
    const listeners = process.listeners(event as 'uncaughtException') as ((error: unknown) => void)[]
    handlers[event] = listeners.find((l) => !existing.has(l))!
    process.removeListener(event as 'uncaughtException', handlers[event] as never)
  }
})
after(() => Object.assign(console, original))

test('a log over 5 MB is rotated at launch', () => {
  assert.equal(logPath(), file)
  assert.equal(statSync(`${file}.1`).size, 5 * 1024 * 1024 + 1)
  assert.ok(statSync(file).size < 1024)
  assert.match(readFileSync(file, 'utf8'), /^\S+Z info  ---- jbrow 0\.0\.0-test started, pid \d+\n/)
})

test('console output still prints and is mirrored to the log', () => {
  printed.length = 0
  console.log('[tabs] opened', { id: 3 }, 42)
  console.warn('careful %s', 'now')
  console.error(new Error('boom'))
  assert.equal(printed.length, 3)
  const text = readFileSync(file, 'utf8')
  assert.match(text, /Z log   \[tabs\] opened \{ id: 3 \} 42\n/)
  assert.match(text, /Z warn  careful now\n/)
  assert.match(text, /Z error Error: boom\n\s+at /)
})

test('unicode is written as is', () => {
  console.info('Práca 💼 пример.рф')
  assert.match(readFileSync(file, 'utf8'), /info  Práca 💼 пример\.рф\n/)
})

test('an uncaught error is logged and notified at most once a minute', () => {
  mock.timers.enable({ apis: ['Date'], now: Date.now() })
  try {
    shown.length = 0
    handlers.uncaughtException(new Error('first'))
    handlers.unhandledRejection('second')
    const text = readFileSync(file, 'utf8')
    assert.match(text, /error \[uncaught exception\] Error: first/)
    assert.match(text, /error \[unhandled rejection\] second/)
    if (process.env.JBROW_BACKGROUND) return assert.deepEqual(shown, [])
    assert.equal(shown.length, 1)
    assert.equal(shown[0].title, 'jbrow hit an error')
    assert.match(shown[0].body, /^first\n/)
    mock.timers.tick(61_000)
    handlers.unhandledRejection('third')
    assert.equal(shown.length, 2)
    assert.match(shown[1].body, /^third\n/)
  } finally {
    mock.timers.reset()
  }
})

test('the log folder is created when missing', () => {
  assert.ok(existsSync(logs))
})
