import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AuthInfo } from 'electron'
import { Logins } from '../../src/main/logins'

const info = (over: Partial<AuthInfo> = {}): AuthInfo => ({ isProxy: false, scheme: 'basic', host: 'intranet.example', port: 443, realm: 'Staff', ...over })

function setup() {
  const changed: string[] = []
  const logins = new Logins((tab) => void changed.push(tab))
  const answers: unknown[][] = []
  const cb = (...args: unknown[]) => void answers.push(args)
  return { logins, changed, answers, cb }
}

test('a question shows for its tab and the answer goes back', () => {
  const { logins, changed, answers, cb } = setup()
  logins.ask('t', info(), cb)
  assert.equal(logins.isAsking('t'), true)
  assert.deepEqual(logins.view('t'), { id: 1, host: 'intranet.example', realm: 'Staff', proxy: false, retry: false })
  logins.answer('t', 'me', 'secret')
  assert.deepEqual(answers, [['me', 'secret']])
  assert.equal(logins.isAsking('t'), false)
  assert.equal(logins.view('t'), null)
  assert.deepEqual(changed, ['t', 't'])
})

test('the host shows its port unless it is 80 or 443', () => {
  const { logins, cb } = setup()
  logins.ask('a', info({ port: 80 }), cb)
  logins.ask('b', info({ port: 8080 }), cb)
  logins.ask('c', info({ host: '[::1]', port: 3128, isProxy: true }), cb)
  assert.equal(logins.view('a')?.host, 'intranet.example')
  assert.equal(logins.view('b')?.host, 'intranet.example:8080')
  assert.deepEqual(logins.view('c'), { id: 3, host: '[::1]:3128', realm: 'Staff', proxy: true, retry: false })
})

test('requests for the same site and realm share one answer', () => {
  const { logins, answers, cb } = setup()
  logins.ask('t', info(), cb)
  logins.ask('t', info(), cb)
  logins.ask('t', info({ realm: 'Other' }), cb)
  logins.answer('t', 'me', '')
  assert.deepEqual(answers, [['me', ''], ['me', '']])
  // The other realm is next.
  assert.equal(logins.view('t')?.realm, 'Other')
})

test('a missing password is sent as empty, and cancelling sends nothing', () => {
  const { logins, answers, cb } = setup()
  logins.ask('t', info(), cb)
  logins.answer('t', 'me')
  logins.ask('u', info(), cb)
  logins.answer('u')
  assert.deepEqual(answers, [['me', ''], []])
})

test('being asked again right after answering means the password was wrong', () => {
  const { logins, cb } = setup()
  logins.ask('t', info(), cb)
  logins.answer('t', 'me', 'wrong')
  logins.ask('t', info(), cb)
  assert.equal(logins.view('t')?.retry, true)
  logins.answer('t', 'me', 'right')
  logins.loaded('t')
  logins.ask('t', info(), cb)
  assert.equal(logins.view('t')?.retry, false)
})

test('a cancel or another site is not a retry', () => {
  const { logins, cb } = setup()
  logins.ask('t', info(), cb)
  logins.answer('t')
  logins.ask('t', info(), cb)
  assert.equal(logins.view('t')?.retry, false)
  logins.answer('t', 'me', 'x')
  logins.ask('t', info({ host: 'other.example' }), cb)
  assert.equal(logins.view('t')?.retry, false)
})

test('clear cancels everything the tab was asked', () => {
  const { logins, answers, changed, cb } = setup()
  logins.ask('t', info(), cb)
  logins.ask('t', info({ realm: 'B' }), cb)
  logins.ask('other', info(), cb)
  changed.length = 0
  logins.clear('t')
  assert.deepEqual(answers, [[], []])
  assert.equal(logins.isAsking('t'), false)
  assert.equal(logins.isAsking('other'), true)
  assert.deepEqual(changed, ['t'])
  logins.clear('t')
  assert.deepEqual(changed, ['t'])
})

test('a callback that throws doesn’t stop the others', () => {
  const { logins, answers, cb } = setup()
  logins.ask('t', info(), () => {
    throw new Error('request gone')
  })
  logins.ask('t', info(), cb)
  logins.answer('t', 'me', 'pw')
  assert.deepEqual(answers, [['me', 'pw']])
  logins.ask('u', info(), () => {
    throw new Error('gone')
  })
  logins.clear('u')
})

test('answering a tab with no question does nothing', () => {
  const { logins, changed } = setup()
  logins.answer('t', 'me', 'pw')
  assert.deepEqual(changed, [])
})
