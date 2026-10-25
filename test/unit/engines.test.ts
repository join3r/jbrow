import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { engineOf, isSearchUrl, looksLikeAddress, SEARCH_ENGINES, suggestUrlFor } from '../../src/shared/engines'

describe('SEARCH_ENGINES', () => {
  test('ids are unique and every address takes the query as %s', () => {
    assert.equal(new Set(SEARCH_ENGINES.map((e) => e.id)).size, SEARCH_ENGINES.length)
    for (const e of SEARCH_ENGINES) {
      assert.ok(isSearchUrl(e.url), e.url)
      assert.ok(e.suggest.includes('%s'), e.suggest)
      assert.ok(e.suggest.startsWith('https://'), e.suggest)
    }
  })

  test('Google asks for UTF-8 suggestions', () => {
    const g = SEARCH_ENGINES.find((e) => e.id === 'google')!
    assert.match(g.suggest, /ie=utf-8/)
    assert.match(g.suggest, /oe=utf-8/)
  })
})

describe('engineOf', () => {
  test('a listed engine by its exact address', () => {
    for (const e of SEARCH_ENGINES) assert.equal(engineOf(e.url), e)
  })

  test('a custom address is none', () => {
    assert.equal(engineOf('https://www.google.com/search?q=%s&hl=en'), undefined)
    assert.equal(engineOf(''), undefined)
  })
})

describe('suggestUrlFor', () => {
  test('a listed engine gets its own', () => {
    for (const e of SEARCH_ENGINES) assert.equal(suggestUrlFor(e.url), e.suggest)
  })

  test('a custom address on a listed engine’s site gets that engine’s', () => {
    const google = SEARCH_ENGINES.find((e) => e.id === 'google')!
    assert.equal(suggestUrlFor('https://www.google.com/search?q=%s&hl=en'), google.suggest)
    const ddg = SEARCH_ENGINES.find((e) => e.id === 'duckduckgo')!
    assert.equal(suggestUrlFor('https://duckduckgo.com/?q=%s&kl=de-de'), ddg.suggest)
  })

  test('any other address gets none', () => {
    assert.equal(suggestUrlFor('https://search.example/?q=%s'), undefined)
    assert.equal(suggestUrlFor('https://google.com.evil.example/?q=%s'), undefined)
  })

  test('garbage gets none rather than throwing', () => {
    assert.equal(suggestUrlFor(''), undefined)
    assert.equal(suggestUrlFor('not a url %s'), undefined)
    assert.equal(suggestUrlFor('%s'), undefined)
  })
})

describe('isSearchUrl', () => {
  test('a web address with %s', () => {
    assert.equal(isSearchUrl('https://search.example/?q=%s'), true)
    assert.equal(isSearchUrl('http://localhost:8080/search?q=%s'), true)
    assert.equal(isSearchUrl('HTTPS://SEARCH.EXAMPLE/%s'), true)
    assert.equal(isSearchUrl('https://[::1]:8888/?q=%s'), true)
  })

  test('without %s, it isn’t', () => {
    assert.equal(isSearchUrl('https://search.example/?q='), false)
  })

  test('not http(s), no host, or with spaces, it isn’t', () => {
    assert.equal(isSearchUrl('ftp://search.example/?q=%s'), false)
    assert.equal(isSearchUrl('javascript:alert(%s)'), false)
    assert.equal(isSearchUrl('file:///search?q=%s'), false)
    assert.equal(isSearchUrl('search.example/?q=%s'), false)
    assert.equal(isSearchUrl('https:///?q=%s'), false)
    assert.equal(isSearchUrl('https://search example/?q=%s'), false)
    assert.equal(isSearchUrl(' https://search.example/?q=%s'), false)
    assert.equal(isSearchUrl('https://search.example/?q=%s '), false)
    assert.equal(isSearchUrl(''), false)
  })
})

describe('looksLikeAddress', () => {
  const yes = (s: string) => assert.equal(looksLikeAddress(s), true, JSON.stringify(s))
  const no = (s: string) => assert.equal(looksLikeAddress(s), false, JSON.stringify(s))

  test('plain words are a search', () => {
    for (const s of ['', '   ', 'hello', 'what is pi', 'how to cook rice?', 'café crème', '日本語 検索', 'e.g.', 'Mr. Smith', 'hello.', '3.14', 'v1.2', '@bob', 'C++ or C#', '🎉'])
      no(s)
  })

  test('schemes', () => {
    for (const s of ['https://a.example', 'http://x', 'HTTP://X', 'ftp://files', 'git+ssh://host/repo', 'chrome-extension://abc/page.html', 'view-source:https://a'])
      yes(s)
    for (const s of ['about:blank', 'ABOUT:settings', 'file:///C:/Users/me/a.html', 'file:///home/me/a.html', 'data:text/plain,hi', 'javascript:void(0)', 'mailto:me@x', 'blob:https://a/1', 'chrome://gpu'])
      yes(s)
  })

  test('hosts with a dot, a port, localhost', () => {
    for (const s of ['example.com', 'Example.COM', 'sub.domain.co.uk', 'foo.bar', 'münchen.de', 'xn--r8jz45g.jp', 'example.com:8080', 'example.com/path', 'a-b.c-d'])
      yes(s)
    for (const s of ['localhost', 'LOCALHOST', 'localhost:3000', 'localhost/app', 'myhost:3000']) yes(s)
    no('localhostfoo')
  })

  test('IP addresses', () => {
    for (const s of ['127.0.0.1', '192.168.1.1:8080', '10.0.0.1/admin', '[::1]', '[::1]:8080', 'http://[2001:db8::1]/', '[2001:db8::1]']) yes(s)
  })

  test('paths and email addresses', () => {
    for (const s of ['/usr/local', '~/notes', '~', 'a/b', 'me@example.com', 'user@host']) yes(s)
  })

  test('every word is checked: a host next to words is still an address', () => {
    yes('intranet.corp.example login')
    yes('login intranet.corp.example')
    yes('foo.bar baz')
    yes('see localhost:3000 please')
    yes('  example.com  ')
    yes('ask bob@corp.example')
  })
})

describe('looksLikeAddress, hosts outside ASCII', () => {
  test('hosts in any script are addresses, so they never go to the search engine', () => {
    for (const s of ['münchen.de', '例え.jp', 'пример.рф', 'example.рф', 'xn--mnchen-3ya.de', '例え.jp/パス']) {
      assert.equal(looksLikeAddress(s), true, s)
    }
  })

  test('IPv6 addresses in brackets', () => {
    for (const s of ['[::1]', '[fe80::abcd]', '[2001:db8::1]:8080/x']) assert.equal(looksLikeAddress(s), true, s)
  })

  test('words in other scripts are still a search', () => {
    for (const s of ['привет мир', '日本語', 'café']) assert.equal(looksLikeAddress(s), false, s)
  })
})
