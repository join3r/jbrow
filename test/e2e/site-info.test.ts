// The address bar's "Site" details: the address the system's DNS gives a host, and the certificate
// it showed this run. Nothing is looked up for a private address.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer as createHttpsServer } from 'node:https'
import type { AddressInfo, Server } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import type { SiteInfoReply } from '../../src/shared/types'
import { html, launch, serve, type Jbrow, type TestServer } from './harness'
import { activeTab, offline, openTab, record } from './ui-helpers'

let jb: Jbrow
let web: TestServer
let tls: Server
let tlsPort = 0
let seq = 0

before(async () => {
  web = await serve({ '/': html('Plain page') })
  const dir = mkdtempSync(path.join(tmpdir(), 'jbrow-cert-'))
  const key = path.join(dir, 'key.pem')
  const cert = path.join(dir, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' })
  tls = createHttpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, (_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html('Secure'))
  })
  await new Promise<void>((resolve) => tls.listen(0, '127.0.0.1', resolve))
  tlsPort = (tls.address() as AddressInfo).port
  jb = await launch({
    settings: { ...offline(web), privateUrls: ['secret.test'] },
    args: ['--host-resolver-rules=MAP plain.test 127.0.0.1, MAP secure.test 127.0.0.1, MAP untouched.test 127.0.0.1, MAP secret.test 127.0.0.1'],
  })
})
after(async () => {
  await jb?.close()
  await web?.close()
  await new Promise((resolve) => tls?.close(resolve))
})

/** Asks about `url` as the address bar does and waits for the answer. */
async function ask(url: string): Promise<SiteInfoReply> {
  const replies = await record<SiteInfoReply>(jb, 'site-info')
  const n = ++seq
  await jb.send('site-info', { url, seq: n })
  return replies.waitFor((r) => r.seq === n, `the answer about ${url}`)
}

test('a plain http site gets its address and no certificate', async () => {
  const port = new URL(web.url).port
  await openTab(jb, `http://plain.test:${port}/`)
  await jb.waitForState((s) => activeTab(s)?.title === 'Plain page', 'the plain page')
  const r = await ask(`http://plain.test:${port}/`)
  assert.equal(r.host, 'plain.test')
  assert.equal(r.scheme, 'http')
  assert.equal(r.private, false)
  assert.equal(r.ip, '127.0.0.1')
  assert.equal(r.local, true)
  assert.deepEqual(r.cert, { state: 'none' })
})

test('an https site not visited this run has an unknown certificate', async () => {
  const r = await ask('https://untouched.test/')
  assert.equal(r.ip, '127.0.0.1')
  assert.deepEqual(r.cert, { state: 'unknown' })
})

test('a certificate Chromium refused says why, and whether you went ahead', async () => {
  await jb.send('new')
  await jb.waitForState((s) => activeTab(s) && !activeTab(s)!.url, 'an empty tab')
  await jb.send('navigate', { input: `https://secure.test:${tlsPort}/` })
  await jb.waitForState((s) => !!s.cert?.blocked, 'the certificate warning')
  const r = await ask(`https://secure.test:${tlsPort}/other`)
  assert.equal(r.cert?.state, 'error')
  assert.equal(r.cert?.error, 'CERT_AUTHORITY_INVALID')
  assert.equal(r.cert?.trusted, false)
  assert.equal(r.cert?.issuer, 'localhost')
  assert.ok(r.cert?.daysLeft === 0 || r.cert?.daysLeft === 1, `daysLeft ${r.cert?.daysLeft}`)

  await jb.send('cert', { action: 'proceed' })
  await jb.waitForState((s) => activeTab(s)?.title === 'Secure', 'the page past the warning')
  assert.equal((await ask(`https://secure.test:${tlsPort}/`)).cert?.trusted, true)
})

test('a private address is not looked up', async () => {
  const r = await ask('https://secret.test/wiki')
  assert.deepEqual(r, { seq, url: 'https://secret.test/wiki', host: 'secret.test', scheme: 'https', private: true })
})
