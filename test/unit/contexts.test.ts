import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { windowContext } from '../../src/shared/contexts'

/** The context's parts after the bundle ID, or null. */
const parts = (bundleId: string, title: string, appName = 'App', document = '') => {
  const c = windowContext(bundleId, appName, { title, document })
  return c && { parts: c.key.split('\u001f').slice(1), name: c.name }
}

const SLACK = 'com.tinyspeck.slackmacgap'

describe('windowContext', () => {
  test('Slack: the conversation and its workspace', () => {
    assert.deepEqual(parts(SLACK, 'Jane Doe (DM) - Acme - Slack'), { parts: ['Acme', 'Jane Doe'], name: 'Jane Doe' })
    assert.deepEqual(parts(SLACK, 'general (Channel) - Acme - Slack'), { parts: ['Acme', '#general'], name: '#general' })
    assert.deepEqual(parts(SLACK, '#design - Acme - Slack'), { parts: ['Acme', '#design'], name: '#design' })
    assert.deepEqual(parts(SLACK, 'Slack | design | Acme'), { parts: ['Acme', 'design'], name: 'design' })
  })

  test('Slack: unread counts keep the same key', () => {
    assert.equal(windowContext(SLACK, 'Slack', { title: '(3) #design - Acme - Slack' })!.key, windowContext(SLACK, 'Slack', { title: '#design - Acme - Slack' })!.key)
    assert.equal(windowContext(SLACK, 'Slack', { title: '* Jane Doe (DM) - Acme - Slack' })!.key, windowContext(SLACK, 'Slack', { title: 'Jane Doe (DM) - Acme - Slack' })!.key)
  })

  test('Slack: the same channel in two workspaces differs', () => {
    assert.notEqual(windowContext(SLACK, 'Slack', { title: '#general - Acme - Slack' })!.key, windowContext(SLACK, 'Slack', { title: '#general - Globex - Slack' })!.key)
  })

  test("Slack: its own views aren't conversations", () => {
    assert.equal(parts(SLACK, 'Activity - Acme - Slack'), null)
    assert.equal(parts(SLACK, 'Later - Acme - Slack'), null)
    assert.equal(parts(SLACK, 'Slack'), null)
  })

  test('Discord: channel and server, or a DM', () => {
    assert.deepEqual(parts('com.hnc.Discord', '#💻│joinit | joinit.online - Discord'), { parts: ['joinit.online', '#💻│joinit'], name: '#💻│joinit' })
    assert.deepEqual(parts('com.hnc.Discord', '@jane - Discord'), { parts: ['@jane'], name: '@jane' })
    assert.equal(parts('com.hnc.Discord', 'Friends - Discord'), null)
  })

  test('Mail: the subject without Re: and Fwd:, and not the mailbox alone', () => {
    const a = parts('com.apple.mail', 'Inbox – Re: Fwd: Q4 invoice from Northwind')
    const b = parts('com.apple.mail', 'Sent – Q4 invoice from Northwind')
    assert.deepEqual(a, { parts: ['Q4 invoice from Northwind'], name: 'Q4 invoice from Northwind' })
    assert.deepEqual(a, b)
    assert.equal(parts('com.apple.mail', 'Inbox'), null)
  })

  test('VS Code: the project, not the file', () => {
    assert.deepEqual(parts('com.microsoft.VSCode', 'charges.ts — invoice-service'), { parts: ['invoice-service'], name: 'invoice-service' })
    assert.deepEqual(parts('com.microsoft.VSCode', '● index.ts — invoice-service (Workspace)'), { parts: ['invoice-service'], name: 'invoice-service' })
    assert.equal(parts('com.microsoft.VSCode', 'Welcome — invoice-service')!.name, 'invoice-service')
    assert.equal(parts('com.microsoft.VSCode', 'Visual Studio Code'), null)
  })

  test('Xcode and JetBrains: the project before the file', () => {
    assert.equal(parts('com.apple.dt.Xcode', 'Stem — ContentView.swift')!.name, 'Stem')
    assert.equal(parts('com.jetbrains.intellij', 'billing – Charges.kt')!.name, 'billing')
  })

  test('terminals and other browsers give nothing', () => {
    assert.equal(parts('com.googlecode.iterm2', '~/code — zsh'), null)
    assert.equal(parts('com.google.Chrome', 'Hacker News - Google Chrome'), null)
  })

  test("other apps: the document's file name, else the title without the app's name", () => {
    assert.equal(parts('com.apple.Preview', 'whatever', 'Preview', 'file:///Users/me/Q4%20report.pdf')!.name, 'Q4 report.pdf')
    assert.equal(parts('com.example.notes', 'Groceries - Notes', 'Notes')!.name, 'Groceries')
    assert.equal(parts('com.example.notes', 'Notes', 'Notes'), null)
    assert.equal(parts('com.example.notes', '', 'Notes'), null)
  })

  test('keys start with the bundle ID', () => {
    assert.ok(windowContext(SLACK, 'Slack', { title: '#design - Acme - Slack' })!.key.startsWith(`${SLACK}\u001f`))
  })
})
