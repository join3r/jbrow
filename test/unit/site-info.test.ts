import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Certificate } from 'electron'
import { certSummary, isLocalAddress, isSearchPage, SiteInfo, type SeenCert } from '../../src/main/site-info'
import type { SiteInfoReply } from '../../src/shared/types'

const DAY = 86_400_000
const NOW = 1_750_000_000_000

function cert(over: Partial<Certificate> = {}): Certificate {
  return {
    data: 'not a PEM',
    fingerprint: 'AA',
    issuer: { commonName: 'Test CA', organizations: ['Test Org'], organizationUnits: [], locality: '', state: '', country: '' },
    issuerName: 'Test CA',
    subject: { commonName: 'site.example', organizations: [], organizationUnits: [], locality: '', state: '', country: '' },
    subjectName: 'site.example',
    serialNumber: '01',
    validStart: (NOW - 30 * DAY) / 1000,
    validExpiry: (NOW + 45.5 * DAY) / 1000,
    ...over,
  } as Certificate
}

test('a certificate Chromium accepted is valid, with its issuer and days left', () => {
  assert.deepEqual(certSummary({ cert: cert(), error: '', trusted: false }, NOW), {
    state: 'valid',
    issuer: 'Test CA',
    validTo: NOW + 45.5 * DAY,
    daysLeft: 45,
  })
})

test('a refused certificate says why and whether you went ahead anyway', () => {
  const expired = cert({ validExpiry: (NOW - 2.5 * DAY) / 1000 })
  const s = certSummary({ cert: expired, error: 'CERT_DATE_INVALID', trusted: true }, NOW)
  assert.equal(s.state, 'error')
  assert.equal(s.error, 'CERT_DATE_INVALID')
  assert.equal(s.trusted, true)
  assert.equal(s.daysLeft, -3)
})

test('an issuer without a common name goes by its organization', () => {
  const c = cert({ issuer: { commonName: '', organizations: ['Org CA'], organizationUnits: [], locality: '', state: '', country: '' } })
  assert.equal(certSummary({ cert: c, error: '', trusted: false }, NOW).issuer, 'Org CA')
})

test('a host not contacted this run is unknown', () => {
  assert.deepEqual(certSummary(null, NOW), { state: 'unknown' })
})

test('loopback, private ranges and link-local are local; the internet is not', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.20.0.1', '192.168.1.1', '169.254.1.1', '::1', 'fd00::1', 'fe80::1']) assert.equal(isLocalAddress(ip), true, ip)
  for (const ip of ['8.8.8.8', '172.32.0.1', '2606:4700::1111', 'not an ip']) assert.equal(isLocalAddress(ip), false, ip)
})

test('a search results page is recognised by the search address', () => {
  assert.equal(isSearchPage('https://www.google.com/search?q=cats', 'https://www.google.com/search?q=%s'), true)
  assert.equal(isSearchPage('https://www.google.com/maps', 'https://www.google.com/search?q=%s'), false)
})

function setup(opts: { seen?: SeenCert | null; ip?: string; fail?: boolean } = {}) {
  const sent: SiteInfoReply[] = []
  const lookups: string[] = []
  const certs: string[] = []
  const info = new SiteInfo({
    resolve: async (profile, host) => {
      lookups.push(`${profile} ${host}`)
      if (opts.fail) throw new Error('ERR_NAME_NOT_RESOLVED')
      return opts.ip ?? '93.184.216.34'
    },
    cert: (profile, host) => {
      certs.push(`${profile} ${host}`)
      return opts.seen ?? null
    },
    isPrivate: (url) => url.includes('intranet'),
    isSearch: (url) => url.startsWith('https://search.example/?q='),
    send: (r) => sent.push(r),
    now: () => NOW,
  })
  return { info, sent, lookups, certs }
}

test('an https site gets its address and certificate', async () => {
  const { info, sent, lookups } = setup({ seen: { cert: cert(), error: '', trusted: false } })
  await info.ask('https://site.example/page', 'p', 1)
  assert.deepEqual(lookups, ['p site.example'])
  assert.equal(sent.length, 1)
  const r = sent[0]
  assert.equal(r.seq, 1)
  assert.equal(r.host, 'site.example')
  assert.equal(r.scheme, 'https')
  assert.equal(r.private, false)
  assert.equal(r.ip, '93.184.216.34')
  assert.equal(r.local, false)
  assert.equal(r.cert?.state, 'valid')
})

test('plain http has no certificate, and a local address says so', async () => {
  const { info, sent, certs } = setup({ ip: '192.168.1.10' })
  await info.ask('http://nas.example:5000/', 'p', 1)
  assert.deepEqual(sent[0].cert, { state: 'none' })
  assert.deepEqual(certs, [])
  assert.equal(sent[0].ip, '192.168.1.10')
  assert.equal(sent[0].local, true)
})

test('an IP address host is its own address, without a lookup', async () => {
  const { info, sent, lookups } = setup()
  await info.ask('http://[::1]:8080/', 'p', 1)
  assert.deepEqual(lookups, [])
  assert.equal(sent[0].host, '::1')
  assert.equal(sent[0].ip, '::1')
  assert.equal(sent[0].local, true)
})

test('private addresses, other schemes, searches and nonsense are never looked up', async () => {
  const { info, sent, lookups, certs } = setup({ seen: { cert: cert(), error: '', trusted: false } })
  await info.ask('https://intranet.corp/wiki', 'p', 1)
  await info.ask('about:blank', 'p', 2)
  await info.ask('file:///Users/me/a.html', 'p', 3)
  await info.ask('https://search.example/?q=cats', 'p', 4)
  await info.ask('cats and dogs', 'p', 5)
  assert.deepEqual(lookups, [])
  assert.deepEqual(certs, [])
  assert.deepEqual(sent[0], { seq: 1, url: 'https://intranet.corp/wiki', host: 'intranet.corp', scheme: 'https', private: true })
  assert.deepEqual(sent[1], { seq: 2, url: 'about:blank', host: '', scheme: 'about', private: false })
  assert.equal(sent[2].scheme, 'file')
  assert.equal(sent[3].cert, undefined)
  assert.equal(sent[4].scheme, '')
  assert.equal(sent.every((r) => r.ip === undefined), true)
})

test('a failed lookup answers without an address', async () => {
  const { info, sent } = setup({ fail: true })
  await info.ask('https://nowhere.example/', 'p', 1)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].ip, undefined)
  assert.equal(sent[0].cert?.state, 'unknown')
})

test('lookups are reused per profile and host', async () => {
  const { info, lookups } = setup()
  await info.ask('https://site.example/a', 'p', 1)
  await info.ask('https://site.example/b', 'p', 2)
  await info.ask('https://site.example/', 'q', 3)
  assert.deepEqual(lookups, ['p site.example', 'q site.example'])
})

test('an answer that comes after a newer request is dropped', async () => {
  const { info, sent } = setup()
  const first = info.ask('https://one.example/', 'p', 1)
  const second = info.ask('https://two.example/', 'p', 2)
  await Promise.all([first, second])
  assert.deepEqual(
    sent.map((r) => r.seq),
    [2],
  )
})
