// An extension's service worker that holds a native messaging host and crashes is started again,
// so the extension can reconnect its host. Stem's browser control lost jbrow three times this
// way (2026-11-02, -03, -05): the worker crashed, its host stayed open and swallowed every
// message, and nothing woke the worker for minutes.
import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { Cdp, launch, removeDir, SANDBOXED, tempDir, waitFor, type Jbrow } from './harness'

const HOST = 'com.jbrow.e2e_host'
let jb: Jbrow
let dir: string
let hostLog: string

/** A fixed extension ID: Chrome's, from the SHA-256 of the manifest key, in the letters a–p. */
function extensionKey() {
  const { publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
  const der = publicKey.export({ type: 'spki', format: 'der' })
  const id = [...createHash('sha256').update(der).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('')
  return { key: der.toString('base64'), id }
}

const connections = () => readFileSync(hostLog, 'utf8').split('\n').filter((l) => l.startsWith('connected')).length

before(async () => {
  dir = tempDir('jbrow-native-')
  hostLog = path.join(dir, 'host.log')
  writeFileSync(hostLog, '')
  const { key, id } = extensionKey()
  const ext = path.join(dir, 'ext')
  mkdirSync(ext)
  writeFileSync(
    path.join(ext, 'manifest.json'),
    JSON.stringify({ manifest_version: 3, name: 'Native e2e', version: '1.0', key, permissions: ['nativeMessaging'], background: { service_worker: 'sw.js' } }),
  )
  writeFileSync(path.join(ext, 'sw.js'), `const port = chrome.runtime.connectNative('${HOST}'); port.postMessage({ type: 'hello' });`)
  const hostJs = path.join(dir, 'host.js')
  writeFileSync(
    hostJs,
    `require('fs').appendFileSync(${JSON.stringify(hostLog)}, 'connected ' + process.pid + '\\n'); process.stdin.on('data', () => {}); process.stdin.on('end', () => process.exit(0));`,
  )
  const hostSh = path.join(dir, 'host.sh')
  writeFileSync(hostSh, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(hostJs)}\n`)
  chmodSync(hostSh, 0o755)
  const manifest = JSON.stringify({ name: HOST, description: 'e2e', path: hostSh, type: 'stdio', allowed_origins: [`chrome-extension://${id}/`] })
  jb = await launch({
    settings: { unpackedExtensions: { personal: [ext] } },
    files: { [`NativeMessagingHosts/${HOST}.json`]: manifest },
    // A small heap, so running the worker out of memory crashes it quickly.
    args: ['--js-flags=--max-old-space-size=48'],
  })
})
after(async () => {
  await jb?.close()
  if (dir) await removeDir(dir)
})

// Without the sandbox, workers get Chromium's connectNative, which turns native hosts away.
const skip = !SANDBOXED && 'no sandbox here (Linux as root, or without user namespaces), so no native messaging in service workers'

test('a service worker that crashed while holding a native host is started again and reconnects', { skip }, async () => {
  await waitFor(() => connections() === 1, 'the extension to open its host', 20_000)
  const worker = await waitFor(
    async () => (await jb.targets()).find((t) => t.type === 'service_worker' && t.url.endsWith('/sw.js')),
    'the service worker target',
  )
  const cdp = new Cdp(worker)
  await cdp.opened
  // It never answers: the worker's renderer runs out of memory and is gone.
  void cdp.send('Runtime.evaluate', { expression: 'const a = []; for (;;) a.push(new Array(1e6).fill(1))' }).catch(() => {})
  await waitFor(() => connections() === 2, `the restarted worker to open its host again\n${jb.log()}`, 30_000)
  cdp.close()
  assert.match(jb.output, /its service worker stopped while holding com\.jbrow\.e2e_host; starting it again/)
})
