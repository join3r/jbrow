import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { domainProfile, siteDomain, siteProfile, siteRule, urlMatcher, withDomain } from '../../src/shared/patterns'

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

  test('a port in the site is only that port; without one, any port', () => {
    const sites = { dev: ['localhost:3000'], other: ['intranet'] }
    assert.equal(siteProfile(sites, 'http://localhost:3000/app'), 'dev')
    assert.equal(siteProfile(sites, 'http://localhost:4000/app'), undefined)
    assert.equal(siteProfile(sites, 'https://intranet:8443/x'), 'other')
  })

  test('only web addresses', () => {
    assert.equal(siteProfile({ p: ['*'] }, 'about:blank'), undefined)
    assert.equal(siteProfile({ p: ['*'] }, 'not a url'), undefined)
    assert.equal(siteProfile({ p: ['', '  '] }, 'https://a.example/'), undefined)
  })
})

describe('domains saved from the URL bar', () => {
  test("a page's domain is its host without www, for web addresses only", () => {
    assert.equal(siteDomain('https://www.GitHub.com/acme/app'), 'github.com')
    assert.equal(siteDomain('https://gist.github.com/x'), 'gist.github.com')
    assert.equal(siteDomain('http://localhost:3000/'), 'localhost')
    assert.equal(siteDomain('about:blank'), '')
    assert.equal(siteDomain('file:///tmp/a.html'), '')
    assert.equal(siteDomain(''), '')
  })

  test('the profile with exactly this domain, however it was written', () => {
    const sites = { work: ['https://www.github.com/', 'github.com/acme'], personal: ['youtube.com'] }
    assert.equal(domainProfile(sites, 'github.com'), 'work')
    assert.equal(domainProfile(sites, 'youtube.com'), 'personal')
    assert.equal(domainProfile(sites, 'gist.github.com'), undefined)
  })

  test("saving a domain moves its line and keeps everyone else's", () => {
    const sites = { work: ['github.com', 'github.com/acme'], personal: ['youtube.com'] }
    assert.deepEqual(withDomain(sites, 'github.com', 'personal'), { work: ['github.com/acme'], personal: ['youtube.com', 'github.com'] })
    assert.deepEqual(withDomain(sites, 'youtube.com', null), { work: ['github.com', 'github.com/acme'] })
    assert.deepEqual(withDomain({}, 'a.example', 'work'), { work: ['a.example'] })
    assert.deepEqual(withDomain({ work: ['a.example'] }, 'a.example', 'work'), { work: ['a.example'] })
  })

  test('siteRule names the line that decided', () => {
    const sites = { work: ['github.com'], personal: ['github.com/acme'] }
    assert.deepEqual(siteRule(sites, 'https://github.com/acme/app'), { profile: 'personal', pattern: 'github.com/acme' })
    assert.deepEqual(siteRule(sites, 'https://github.com/other'), { profile: 'work', pattern: 'github.com' })
    assert.equal(siteRule(sites, 'https://gitlab.com/'), undefined)
  })
})
