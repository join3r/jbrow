import assert from 'node:assert/strict'
import { test } from 'node:test'
import { explain, isLocalHost, showsErrorPage } from '../../src/main/load-error'

test('hosts on the local network', () => {
  for (const h of ['homeassistant.local', 'printer.lan', '192.168.1.25', '10.0.0.1', '172.20.1.1', '169.254.3.4', 'fdf2:ed89::1', 'fe80::1']) assert.ok(isLocalHost(h), h)
  for (const h of ['example.com', '8.8.8.8', '172.32.0.1', '127.0.0.1', 'localhost']) assert.ok(!isLocalHost(h), h)
})

test('only real failures of web pages get a page', () => {
  assert.ok(showsErrorPage('http://example.com/', -105))
  assert.ok(!showsErrorPage('http://example.com/', -3), 'stopped')
  assert.ok(!showsErrorPage('https://example.com/', -202), 'certificate')
  assert.ok(!showsErrorPage('chrome-extension://x/y.html', -6))
})

test('a .local host that does not resolve points to the Local Network setting on macOS', () => {
  const { text } = explain('http://homeassistant.local:8123/', -105)
  if (process.platform === 'darwin') assert.match(text, /Local Network/)
  assert.match(explain('http://example.com/', -102).title, /refused/)
})
