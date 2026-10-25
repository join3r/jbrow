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
    assert.equal(toUrl('localhost:3000', SEARCH), 'https://localhost:3000')
    assert.equal(toUrl('127.0.0.1:8080/x', SEARCH), 'https://127.0.0.1:8080/x')
  })

  test('hosts in any script get https:// too, rather than a search', () => {
    assert.equal(toUrl('münchen.de', SEARCH), 'https://münchen.de')
    assert.equal(toUrl('例え.jp', SEARCH), 'https://例え.jp')
    assert.equal(toUrl('пример.рф/путь', SEARCH), 'https://пример.рф/путь')
  })

  test('IPv6 addresses in brackets', () => {
    assert.equal(toUrl('[::1]:8080', SEARCH), 'https://[::1]:8080')
    assert.equal(toUrl('[2001:db8::1]/x', SEARCH), 'https://[2001:db8::1]/x')
  })

  test('words are a search, encoded', () => {
    assert.equal(toUrl('hello world', SEARCH), 'https://search.example/?q=hello%20world')
    assert.equal(toUrl('example.com is down', SEARCH), 'https://search.example/?q=example.com%20is%20down')
    assert.equal(toUrl('日本語', SEARCH), `https://search.example/?q=${encodeURIComponent('日本語')}`)
    assert.equal(toUrl('a&b=c', SEARCH), 'https://search.example/?q=a%26b%3Dc')
  })
})
