// A host typed without a scheme goes to https first, and to http when the site doesn't manage
// https: it fails, shows a bad certificate, or doesn't answer in time.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, createServer as createNetServer, type AddressInfo, type Server, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { html, launch, type Jbrow } from './harness'
import { activeTab, offline } from './ui-helpers'

let jb: Jbrow
const servers: Server[] = []
/** Ports of servers that answer http, and https with: nothing (plain), a self-signed certificate (bad), silence (slow). */
const ports = { plain: 0, bad: 0, slow: 0 }

/** A self-signed certificate for localhost, made with openssl. */
function selfSigned(): { key: Buffer; cert: Buffer } {
  const dir = mkdtempSync(path.join(tmpdir(), 'jbrow-cert-'))
  const key = path.join(dir, 'key.pem')
  const cert = path.join(dir, 'cert.pem')
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore' })
  return { key: readFileSync(key), cert: readFileSync(cert) }
}

/** Serves http on a port, and hands a TLS handshake (it starts with 0x16) to `onTls`. */
async function listen(onTls: (socket: Socket) => void): Promise<number> {
  const web = createHttpServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html(`Plain ${req.url}`))
  })
  const server = createNetServer((socket) => {
    socket.once('data', (first) => {
      socket.pause()
      socket.unshift(first)
      if (first[0] === 0x16) onTls(socket)
      else web.emit('connection', socket)
      socket.resume()
    })
  })
  servers.push(server)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return (server.address() as AddressInfo).port
}

before(async () => {
  // A TLS socket reads from the connection directly, past what was unshifted, so the handshake
  // goes over to a TLS server of its own.
  const tls = createHttpsServer(selfSigned(), (req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html(`Secure ${req.url}`))
  })
  servers.push(tls)
  await new Promise<void>((resolve) => tls.listen(0, '127.0.0.1', resolve))
  const tlsPort = (tls.address() as AddressInfo).port
  ports.plain = await listen((socket) => socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'))
  ports.bad = await listen((socket) => {
    const upstream = connect(tlsPort, '127.0.0.1')
    socket.pipe(upstream).pipe(socket)
    socket.on('error', () => upstream.destroy())
    upstream.on('error', () => socket.destroy())
  })
  ports.slow = await listen(() => {})
  jb = await launch({ settings: offline(), args: ['--host-resolver-rules=MAP site.test 127.0.0.1'] })
})
after(async () => {
  await jb?.close()
  for (const server of servers) await new Promise((resolve) => server.close(resolve))
})

/** Types `input` into a new tab and waits for it to settle on `url`. */
async function typeIn(input: string, url: string, timeout?: number) {
  await jb.send('new')
  await jb.waitForState((s) => activeTab(s) && !activeTab(s)!.url, 'an empty tab')
  await jb.send('navigate', { input })
  return jb.waitForState((s) => activeTab(s)?.url === url && !activeTab(s)!.loading, `${input} to end up on ${url}`, timeout)
}

test('a site without https falls back to http, with no error page to go back to', async () => {
  const s = await typeIn(`site.test:${ports.plain}/a`, `http://site.test:${ports.plain}/a`)
  assert.equal(activeTab(s)!.title, 'Plain /a')
  assert.equal(s.nav.canGoBack, false)
})

test('a bad certificate falls back to http instead of warning', async () => {
  const started = Date.now()
  const s = await typeIn(`site.test:${ports.bad}/b`, `http://site.test:${ports.bad}/b`)
  assert.equal(activeTab(s)!.title, 'Plain /b')
  assert.ok(Date.now() - started < 2500, 'right away, not after the wait')
  assert.ok(!s.cert?.blocked, 'no certificate warning')
  assert.equal(s.nav.canGoBack, false)
})

test('a site that never answers over https gets http after a few seconds', async () => {
  const started = Date.now()
  const s = await typeIn(`site.test:${ports.slow}/c`, `http://site.test:${ports.slow}/c`)
  assert.equal(activeTab(s)!.title, 'Plain /c')
  assert.ok(Date.now() - started >= 2500, 'it waited for https first')
})

test('https:// typed out stays https, certificate warning and all', async () => {
  await jb.send('new')
  await jb.waitForState((s) => activeTab(s) && !activeTab(s)!.url, 'an empty tab')
  await jb.send('navigate', { input: `https://site.test:${ports.bad}/d` })
  const s = await jb.waitForState((s) => !!s.cert?.blocked, 'the certificate warning')
  assert.equal(activeTab(s)!.url, `https://site.test:${ports.bad}/d`)
})

test('a site that works over https stays there', async () => {
  // Going ahead past the warning above trusts the certificate, so the site works over https now.
  await jb.send('cert', { action: 'proceed' })
  await jb.waitForState((s) => activeTab(s)?.title === 'Secure /d', 'the page past the warning')
  await typeIn(`site.test:${ports.bad}/e`, `https://site.test:${ports.bad}/e`)
  // Past the wait for an answer, it's still the https page.
  await new Promise((resolve) => setTimeout(resolve, 3500))
  const s = await jb.state()
  assert.equal(activeTab(s)!.url, `https://site.test:${ports.bad}/e`)
  assert.equal(activeTab(s)!.title, 'Secure /e')
})
