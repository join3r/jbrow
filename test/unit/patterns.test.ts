import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { siteProfile, urlMatcher } from '../../src/shared/patterns'

describe('urlMatcher', () => {
  test('no patterns match nothing', () => {
    assert.equal(urlMatcher([])('https://a.example/'), false)
    assert.equal(urlMatcher(['', '   '])('https://a.example/'), false)
  })

  test('an empty address never matches', () => {
    assert.equal(urlMatcher(['*'])(''), false)
    assert.equal(urlMatcher(['a'])(''), false)
  })

  test('matches anywhere in the address, ignoring case', () => {
    const m = urlMatcher(['bank.example'])
    assert.equal(m('https://www.BANK.example/login'), true)
    assert.equal(m('https://other.example/?ref=bank.example'), true)
    assert.equal(m('https://bankxexample.com/'), false)
  })

  test('* stands for any run of characters', () => {
    const m = urlMatcher(['*.corp.example'])
    assert.equal(m('https://wiki.corp.example/page'), true)
    assert.equal(m('https://corp.example/'), false)
    assert.equal(urlMatcher(['https://*/admin'])('https://x.example/admin/users'), true)
    assert.equal(urlMatcher(['a*b*c'])('xxaYYbZZc'), true)
    assert.equal(urlMatcher(['*'])('about:blank'), true)
  })

  test('other regex characters are literal', () => {
    assert.equal(urlMatcher(['a.example/?q=(1)'])('https://a.example/?q=(1)'), true)
    assert.equal(urlMatcher(['a.example/?q=(1)'])('https://a.example/q=1'), false)
    assert.equal(urlMatcher(['a+b'])('https://x/a+b'), true)
    assert.equal(urlMatcher(['a+b'])('https://x/aab'), false)
    assert.equal(urlMatcher(['[x]'])('https://x/'), false)
    assert.equal(urlMatcher(['$^|\\{}'])('https://x/$^|\\{}'), true)
  })

  test('patterns are trimmed, any one can match', () => {
    const m = urlMatcher(['  mail.example  ', 'localhost:3000'])
    assert.equal(m('https://mail.example/'), true)
    assert.equal(m('http://localhost:3000/app'), true)
    assert.equal(m('http://localhost:3001/'), false)
  })

  test('odd addresses', () => {
    assert.equal(urlMatcher(['[::1]'])('http://[::1]:8080/'), true)
    assert.equal(urlMatcher(['file:///*/secret'])('file:///home/me/secret.txt'), true)
    assert.equal(urlMatcher(['münchen'])('https://MÜNCHEN.example/'), true)
    assert.equal(urlMatcher(['日本'])('https://example.jp/日本'), true)
  })

  test('a matcher can be called many times (no stateful regex)', () => {
    const m = urlMatcher(['a.example'])
    for (let i = 0; i < 5; i++) assert.equal(m('https://a.example/'), true)
  })
})

describe('siteProfile', () => {
  const sites = { personal: ['youtube.com', 'youtu.be', 'github.com'], work: ['*.corp.example', 'github.com/acme'] }

  test('a site covers itself and the sites under it', () => {
    assert.equal(siteProfile(sites, 'https://www.youtube.com/watch?v=1'), 'personal')
    assert.equal(siteProfile(sites, 'https://youtube.com/'), 'personal')
    assert.equal(siteProfile(sites, 'http://m.YouTube.com'), 'personal')
    assert.equal(siteProfile(sites, 'https://youtu.be/abc'), 'personal')
  })

  test("the site has to be the address's own, not just appear in it", () => {
    assert.equal(siteProfile(sites, 'https://www.google.com/search?q=youtube.com'), undefined)
    assert.equal(siteProfile(sites, 'https://notyoutube.com/'), undefined)
    assert.equal(siteProfile(sites, 'https://youtube.com.evil.example/'), undefined)
    assert.equal(siteProfile(sites, 'https://evil.example/youtube.com'), undefined)
  })

  test('* stays in the site name', () => {
    assert.equal(siteProfile(sites, 'https://wiki.corp.example/page'), 'work')
    assert.equal(siteProfile(sites, 'https://corp.example/'), undefined)
    assert.equal(siteProfile(sites, 'https://evil.example/x.corp.example'), undefined)
  })

  test('a path narrows it, and the longer match wins', () => {
    assert.equal(siteProfile(sites, 'https://github.com/acme/app/pulls'), 'work')
    assert.equal(siteProfile(sites, 'https://github.com/someone/app'), 'personal')
    assert.equal(siteProfile(sites, 'https://github.com/acme'), 'work')
    assert.equal(siteProfile(sites, 'https://github.com/acme-evil/app'), 'personal')
  })

  test('a scheme in the pattern is ignored', () => {
    assert.equal(siteProfile({ work: ['https://jira.example'] }, 'https://jira.example/browse/X-1'), 'work')
  })

  test('only web addresses', () => {
    assert.equal(siteProfile({ p: ['*'] }, 'about:blank'), undefined)
    assert.equal(siteProfile({ p: ['*'] }, 'not a url'), undefined)
    assert.equal(siteProfile({ p: ['', '  '] }, 'https://a.example/'), undefined)
  })
})
