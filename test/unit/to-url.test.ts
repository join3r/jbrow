import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { toUrl } from '../../src/main/tabs'

const SEARCH = 'https://search.example/?q=%s'

describe('toUrl', () => {
  test('a search when asked for one, whatever was typed', () => {
    assert.equal(toUrl('example.com', SEARCH, true), 'https://search.example/?q=example.com')
  })

  test('addresses with a scheme are kept as they are', () => {
    for (const s of ['http://example.com', 'https://a.b/c?d#e', 'about:blank', 'file:///tmp/x.html', 'chrome-extension://abc/popup.html']) {
      assert.equal(toUrl(s, SEARCH), s)
    }
  })

  test('hosts get https://', () => {
    assert.equal(toUrl('example.com', SEARCH), 'https://example.com')
    assert.equal(toUrl('  example.com/path?x=1  ', SEARCH), 'https://example.com/path?x=1')
  })

  test('hosts on your own machine or network get http://', () => {
    assert.equal(toUrl('localhost:3000', SEARCH), 'http://localhost:3000')
    assert.equal(toUrl('app.localhost/x', SEARCH), 'http://app.localhost/x')
    assert.equal(toUrl('127.0.0.1:8080/x', SEARCH), 'http://127.0.0.1:8080/x')
    assert.equal(toUrl('192.168.1.1', SEARCH), 'http://192.168.1.1')
  })

  test('a bare name with a port or path is a host, not a search', () => {
    assert.equal(toUrl('nas:5000', SEARCH), 'http://nas:5000')
    assert.equal(toUrl('router/', SEARCH), 'http://router/')
    assert.equal(toUrl('intranet/wiki/Home', SEARCH), 'http://intranet/wiki/Home')
  })

  test('things that only look a little like hosts are a search', () => {
    assert.equal(toUrl('v1.2.3', SEARCH), 'https://search.example/?q=v1.2.3')
    assert.equal(toUrl('1.5', SEARCH), 'https://search.example/?q=1.5')
    assert.equal(toUrl('10:30', SEARCH), 'https://search.example/?q=10%3A30')
    assert.equal(toUrl('router', SEARCH), 'https://search.example/?q=router')
    assert.equal(toUrl('a..b', SEARCH), 'https://search.example/?q=a..b')
  })

  test('a leading ? searches for the rest, even an address', () => {
    assert.equal(toUrl('?node.js', SEARCH), 'https://search.example/?q=node.js')
    assert.equal(toUrl('  ? localhost:3000 ', SEARCH), 'https://search.example/?q=localhost%3A3000')
    assert.equal(toUrl('?', SEARCH), 'https://search.example/?q=%3F')
  })

  test('hosts in any script get https:// too, rather than a search', () => {
    assert.equal(toUrl('münchen.de', SEARCH), 'https://münchen.de')
    assert.equal(toUrl('例え.jp', SEARCH), 'https://例え.jp')
    assert.equal(toUrl('пример.рф/путь', SEARCH), 'https://пример.рф/путь')
  })

  test('IPv6 addresses in brackets', () => {
    assert.equal(toUrl('[::1]:8080', SEARCH), 'http://[::1]:8080')
    assert.equal(toUrl('[2001:db8::1]/x', SEARCH), 'http://[2001:db8::1]/x')
  })

  test('words are a search, encoded', () => {
    assert.equal(toUrl('hello world', SEARCH), 'https://search.example/?q=hello%20world')
    assert.equal(toUrl('example.com is down', SEARCH), 'https://search.example/?q=example.com%20is%20down')
    assert.equal(toUrl('日本語', SEARCH), `https://search.example/?q=${encodeURIComponent('日本語')}`)
    assert.equal(toUrl('a&b=c', SEARCH), 'https://search.example/?q=a%26b%3Dc')
  })
})
