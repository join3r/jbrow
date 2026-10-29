import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Certificate, Session } from 'electron'
import { Certificates } from '../../src/main/certs'

function cert(fingerprint: string, over: Partial<Certificate> = {}): Certificate {
  return {
    data: 'not a PEM',
    fingerprint,
    issuer: { commonName: 'Test CA', organizations: ['Test Org'], organizationUnits: [], locality: '', state: '', country: '' },
    issuerName: 'Test CA',
    subject: { commonName: `cn-${fingerprint}`, organizations: ['Site Org'], organizationUnits: ['Web'], locality: '', state: '', country: '' },
    subjectName: `cn-${fingerprint}`,
    serialNumber: '01',
    validStart: 1_700_000_000,
    validExpiry: 1_800_000_000,
    ...over,
  } as Certificate
}

function setup() {
  let changes = 0
  const certs = new Certificates(() => void changes++)
  return { certs, changes: () => changes }
}

test('a main-frame certificate error blocks the tab', () => {
  const { certs, changes } = setup()
  assert.equal(certs.onError('t1', 'p', 'https://bad.example/x', 'net::ERR_CERT_DATE_INVALID', cert('AA'), true), false)
  assert.equal(certs.isBlocked('t1'), true)
  assert.equal(changes(), 1)
  const view = certs.view('t1', 'p', 'https://bad.example/x')
  assert.ok(view)
  assert.equal(view.host, 'bad.example')
  assert.equal(view.error, 'CERT_DATE_INVALID')
  assert.equal(view.blocked, true)
  assert.equal(view.fatal, false)
})

test('a subresource error is refused without blocking the tab', () => {
  const { certs, changes } = setup()
  assert.equal(certs.onError('t1', 'p', 'https://cdn.example/a.js', 'net::ERR_CERT_AUTHORITY_INVALID', cert('AA'), false), false)
  assert.equal(certs.isBlocked('t1'), false)
  assert.equal(changes(), 0)
})

test('proceed trusts that certificate for that host and profile only', () => {
  const { certs } = setup()
  const c = cert('AA')
  certs.onError('t1', 'p', 'https://bad.example:8443/x', 'net::ERR_CERT_AUTHORITY_INVALID', c, true)
  assert.equal(certs.proceed('t1', 'p'), 'https://bad.example:8443/x')
  assert.equal(certs.isBlocked('t1'), false)
  assert.equal(certs.onError('t2', 'p', 'https://bad.example/other', 'net::ERR_CERT_AUTHORITY_INVALID', c, true), true)
  // Another certificate, another profile or another host isn't trusted.
  assert.equal(certs.onError('t3', 'p', 'https://bad.example/', 'net::ERR_CERT_AUTHORITY_INVALID', cert('BB'), true), false)
  assert.equal(certs.onError('t4', 'q', 'https://bad.example/', 'net::ERR_CERT_AUTHORITY_INVALID', c, true), false)
  assert.equal(certs.onError('t5', 'p', 'https://evil.example/', 'net::ERR_CERT_AUTHORITY_INVALID', c, true), false)
})

test('revoked and pinning errors can’t be gone past', () => {
  const { certs } = setup()
  for (const error of ['net::ERR_CERT_REVOKED', 'net::ERR_SSL_PINNED_KEY_NOT_IN_CERT_CHAIN']) {
    certs.onError('t', 'p', 'https://bad.example/', error, cert('AA'), true)
    assert.equal(certs.view('t', 'p', 'https://bad.example/')?.fatal, true)
    assert.equal(certs.proceed('t', 'p'), null)
    assert.equal(certs.isBlocked('t'), true)
    certs.clear('t')
  }
})

test('proceed with nothing blocked does nothing', () => {
  const { certs, changes } = setup()
  assert.equal(certs.proceed('t', 'p'), null)
  certs.clear('t')
  assert.equal(changes(), 0)
})

test('distrust forgets the host’s trusted certificates in that profile', () => {
  const { certs } = setup()
  const c = cert('AA')
  for (const [tab, profile, url] of [['t1', 'p', 'https://a.example/'], ['t2', 'p', 'https://a.example.org/'], ['t3', 'q', 'https://a.example/']]) {
    certs.onError(tab, profile, url, 'CERT_AUTHORITY_INVALID', c, true)
    certs.proceed(tab, profile)
  }
  certs.distrust('p', 'a.example')
  assert.equal(certs.onError('x', 'p', 'https://a.example/', 'CERT_AUTHORITY_INVALID', c, false), false)
  // a.example.org shares the prefix but is another host.
  assert.equal(certs.onError('x', 'p', 'https://a.example.org/', 'CERT_AUTHORITY_INVALID', c, false), true)
  assert.equal(certs.onError('x', 'q', 'https://a.example/', 'CERT_AUTHORITY_INVALID', c, false), true)
})

test('IPv6 and unicode hosts', () => {
  const { certs } = setup()
  certs.onError('t', 'p', 'https://[::1]:8443/', 'CERT_COMMON_NAME_INVALID', cert('AA'), true)
  assert.equal(certs.view('t', 'p', 'https://[::1]:8443/')?.host, '[::1]')
  certs.proceed('t', 'p')
  assert.equal(certs.onError('t', 'p', 'https://[::1]/', 'CERT_COMMON_NAME_INVALID', cert('AA'), true), true)
  certs.onError('u', 'p', 'https://bücher.de/', 'CERT_COMMON_NAME_INVALID', cert('AA'), true)
  assert.equal(certs.view('u', 'p', 'https://bücher.de/')?.host, 'xn--bcher-kva.de')
})

test('attach records what each host showed, and view describes it', () => {
  const { certs } = setup()
  let proc: ((req: Record<string, unknown>, cb: (n: number) => void) => void) | undefined
  certs.attach({ setCertificateVerifyProc: (p: typeof proc) => void (proc = p) } as unknown as Session, 'p')
  const answers: number[] = []
  const issuer = cert('CA', { subject: { commonName: 'Root', organizations: ['Root Org'], organizationUnits: [] } as never })
  const leaf = cert('LEAF', { issuerCert: issuer })
  proc!({ hostname: 'good.example', certificate: leaf, validatedCertificate: leaf, verificationResult: 'net::OK', errorCode: 0 }, (n) => answers.push(n))
  // Chromium's own verdict stands.
  assert.deepEqual(answers, [-3])

  const view = certs.view('tab', 'p', 'https://good.example/page')
  assert.ok(view)
  assert.equal(view.error, '')
  assert.equal(view.blocked, false)
  assert.equal(view.trusted, false)
  assert.deepEqual(view.chain.map((c) => c.subject), ['cn-LEAF', 'Root'])
  assert.deepEqual(view.chain[0], {
    subject: 'cn-LEAF',
    subjectOrg: 'Site Org, Web',
    issuer: 'Test CA',
    issuerOrg: 'Test Org',
    validFrom: 1_700_000_000_000,
    validTo: 1_800_000_000_000,
    serial: '01',
    // The data isn't a real certificate, so there's nothing more to read from it.
    sha256: '',
    names: [],
  })

  assert.equal(certs.view('tab', 'q', 'https://good.example/'), null)
  assert.equal(certs.view('tab', 'p', 'http://good.example/'), null)
  assert.equal(certs.view('tab', 'p', 'https://unseen.example/'), null)
})

test('a certificate chain that loops ends', () => {
  const { certs } = setup()
  const a = cert('A')
  const b = cert('B', { issuerCert: a })
  a.issuerCert = b
  certs.onError('t', 'p', 'https://loop.example/', 'CERT_AUTHORITY_INVALID', b, true)
  assert.deepEqual(certs.view('t', 'p', 'https://loop.example/')?.chain.map((c) => c.subject), ['cn-B', 'cn-A'])
})

test('a subject without a common name uses its full name', () => {
  const { certs } = setup()
  const c = cert('A', { subject: { commonName: '', organizations: [], organizationUnits: [] } as never, subjectName: 'O=Thing' })
  certs.onError('t', 'p', 'https://x.example/', 'CERT_AUTHORITY_INVALID', c, true)
  assert.equal(certs.view('t', 'p', 'https://x.example/')?.chain[0].subject, 'O=Thing')
})

test('seenOn gives the certificate a host showed, its verdict and whether you trusted it', () => {
  const { certs } = setup()
  let proc: ((req: Record<string, unknown>, cb: (n: number) => void) => void) | undefined
  certs.attach({ setCertificateVerifyProc: (p: typeof proc) => void (proc = p) } as unknown as Session, 'p')
  const c = cert('AA')
  assert.equal(certs.seenOn('p', 'bad.example'), null)
  proc!({ hostname: 'bad.example', certificate: c, verificationResult: 'net::ERR_CERT_AUTHORITY_INVALID', errorCode: -202 }, () => {})
  assert.deepEqual(certs.seenOn('p', 'bad.example'), { cert: c, error: 'CERT_AUTHORITY_INVALID', trusted: false })
  certs.onError('t1', 'p', 'https://bad.example/', 'net::ERR_CERT_AUTHORITY_INVALID', c, true)
  certs.proceed('t1', 'p')
  assert.equal(certs.seenOn('p', 'bad.example')?.trusted, true)
  // Another profile hasn't been there.
  assert.equal(certs.seenOn('q', 'bad.example'), null)
})
