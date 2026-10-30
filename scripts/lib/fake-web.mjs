// The made-up web the screenshot scripts (urlbar-shots.mjs, readme-shots.mjs) browse: sites on
// made-up hosts, answered locally over https with a certificate made for the run, behind a proxy
// that turns everything else away, so nothing reaches the internet. Needs openssl.
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect } from 'node:net'
import path from 'node:path'

// ---------- the made-up web ----------

export const MIN = 60_000
export const HOUR = 60 * MIN
export const DAY = 24 * HOUR
export const now = Date.now()

/** A favicon: a rounded square in `bg` with `glyph` (SVG markup on a 32×32 grid) on it. */
export const icon = (bg, glyph) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${bg}"/>${glyph}</svg>`

/** Each site: the address it resolves to, its favicon and its pages by path, with their titles. */
export const SITES = {
  'skywatch.live': {
    ip: '198.51.100.24',
    icon: icon('#0f1d3a', '<path d="M5 22c4-9 9-12 22-13-8 3-12 7-14 14z" fill="#3ee0a1"/><path d="M9 25c3-5 7-8 15-9-5 2-8 5-9 9z" fill="#b48cff" opacity=".9"/><circle cx="24" cy="8" r="1.4" fill="#fff"/>'),
    pages: {
      '/': 'Skywatch — Space weather now',
      '/aurora': 'Aurora forecast for tonight · Skywatch',
      '/clouds': 'Cloud cover map · Skywatch',
      '/kp': 'Kp index, the next three days · Skywatch',
    },
  },
  'northwiki.org': {
    ip: '203.0.113.41',
    icon: icon('#f4f1ea', '<text x="16" y="23.5" font-family="Georgia,serif" font-size="20" font-weight="700" text-anchor="middle" fill="#1d1d1f">N</text>'),
    pages: {
      '/wiki/Aurora': 'Aurora — Northwiki',
      '/wiki/Aurora_australis': 'Aurora australis — Northwiki',
      '/wiki/Geomagnetic_storm': 'Geomagnetic storm — Northwiki',
    },
  },
  'reelbox.tv': {
    ip: '203.0.113.88',
    icon: icon('#e5383b', '<path d="M12 9.5v13l11-6.5z" fill="#fff"/>'),
    pages: {
      '/watch/aurora-tromso': 'Chasing the aurora over Tromsø, 4K timelapse — Reelbox',
      '/live/aurora-cam': 'Aurora borealis live cam, Abisko — Reelbox',
    },
  },
  'postline.app': {
    ip: '198.51.100.7',
    icon: icon('#2f6fed', '<rect x="7" y="10" width="18" height="13" rx="2.5" fill="#fff"/><path d="M8 11.5l8 6 8-6" fill="none" stroke="#2f6fed" stroke-width="2" stroke-linejoin="round"/>'),
    pages: {
      '/inbox': 'Inbox (3) · Postline',
      '/mail/aurora-trip': 'Re: Aurora trip, cabin dates · Postline',
    },
  },
  'docs.loomdesk.io': {
    ip: '203.0.113.130',
    icon: icon('#6d4aff', '<path d="M11 8h7l5 5v11a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 10 24V9.5A1.5 1.5 0 0 1 11 8z" fill="#fff"/><path d="M13 16h7M13 19.5h7M13 23h4" stroke="#6d4aff" stroke-width="1.6" stroke-linecap="round"/>'),
    pages: {
      '/aurora/release-notes': 'Aurora 2.4 release notes · Loomdesk Docs',
      '/aurora/getting-started': 'Getting started with Aurora · Loomdesk Docs',
    },
  },
  'lenscraft.blog': {
    ip: '198.51.100.150',
    icon: icon('#f08c2e', '<circle cx="16" cy="16" r="8" fill="none" stroke="#fff" stroke-width="2.4"/><circle cx="16" cy="16" r="3" fill="#fff"/>'),
    pages: {
      '/aurora-photography-settings': 'Aurora photography: camera settings that work · Lenscraft',
      '/night-sky-for-beginners': 'Night sky photography for beginners · Lenscraft',
    },
  },
}
/** The search engine's suggestions host: jbrow asks the listed engines only, so this stands in for Google's. */
export const SUGGEST_HOST = 'suggestqueries.google.com'
export const SUGGESTIONS = ['aurora borealis', 'aurora forecast', 'aurora borealis tonight', 'aurora australis', 'aurora map', 'aurora tromsø']

export const url = (host, p) => `https://${host}${p}`
export const titleOf = (host, p) => SITES[host].pages[p]
export const faviconOf = (host) => url(host, '/favicon.svg')

/** A page as its site shows it: its title, and a little to look at. */
export const page = (host, title) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>body{margin:0;font:15px/1.5 -apple-system,system-ui,sans-serif;color:#1d1d1f;background:#fafafa}
header{padding:14px 32px;border-bottom:1px solid #e5e5e5;background:#fff;font-weight:600}main{max-width:720px;margin:32px auto;padding:0 24px}
h1{font-size:28px;margin:0 0 12px}p{color:#555}</style></head>
<body><header>${host}</header><main><h1>${title.split(/ [·—] /)[0]}</h1><p>${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(6)}</p></main></body></html>`

export const tab = (id, profile, host, p, seenAgo, more = {}) => ({
  id,
  profile,
  url: url(host, p),
  title: titleOf(host, p),
  favicon: faviconOf(host),
  createdAt: now - seenAgo - 3 * HOUR,
  lastSeen: now - seenAgo,
  ...more,
})
export const visit = (host, p, visits, ago) => ({ url: url(host, p), title: titleOf(host, p), visits, last: now - ago })

// ---------- the certificate, the sites and the proxy ----------

/** A certificate authority and a certificate it signed for every host, valid for 90 days from now. */
export function makeCert(work) {
  const hosts = [...Object.keys(SITES), SUGGEST_HOST]
  const f = (name) => path.join(work, name)
  const ssl = (...args) => execFileSync('openssl', args, { cwd: work, stdio: ['ignore', 'ignore', 'pipe'] })
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('ca.key'), '-out', f('ca.crt'), '-days', '3650', '-subj', '/O=Kestrel Trust/CN=Kestrel Trust RSA CA')
  ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', f('site.key'), '-out', f('site.csr'), '-subj', `/CN=${hosts[0]}`)
  writeFileSync(f('site.ext'), `subjectAltName=${hosts.map((h) => `DNS:${h}`).join(',')}\nextendedKeyUsage=serverAuth\n`)
  ssl('x509', '-req', '-in', f('site.csr'), '-CA', f('ca.crt'), '-CAkey', f('ca.key'), '-CAcreateserial', '-out', f('site.crt'), '-days', '90', '-extfile', f('site.ext'))
  const cert = readFileSync(f('site.crt'))
  const spki = new X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })
  return {
    cert: Buffer.concat([cert, readFileSync(f('ca.crt'))]),
    key: readFileSync(f('site.key')),
    spki: createHash('sha256').update(spki).digest('base64'),
    validTo: Date.parse(new X509Certificate(cert).validTo),
    issuer: 'Kestrel Trust RSA CA',
  }
}

/** The sites and the suggestions, over https, by Host. */
export async function serveSites(tls) {
  const server = createHttpsServer({ cert: tls.cert, key: tls.key }, (req, res) => {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '')
    const p = new URL(req.url ?? '/', 'https://x')
    if (host === SUGGEST_HOST) {
      const q = (p.searchParams.get('q') ?? '').toLowerCase()
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
      return res.end(JSON.stringify([q, SUGGESTIONS.filter((s) => s.startsWith(q))]))
    }
    const site = SITES[host]
    if (site && p.pathname === '/favicon.svg') return res.writeHead(200, { 'content-type': 'image/svg+xml' }).end(site.icon)
    const title = site?.pages[p.pathname]
    if (!title) return res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(RICH[host + p.pathname] ?? page(host, title))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return server
}

/** An https proxy that takes the made-up hosts to `sitesPort` and turns everything else away. */
export async function serveProxy(sitesPort) {
  const known = new Set([...Object.keys(SITES), SUGGEST_HOST])
  const proxy = createServer((_req, res) => res.writeHead(502).end())
  proxy.on('connect', (req, sock, head) => {
    const [host, port] = (req.url ?? '').split(':')
    sock.on('error', () => {})
    if (!known.has(host) || port !== '443') return void sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    const up = connect(sitesPort, '127.0.0.1', () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      up.write(head)
      up.pipe(sock)
      sock.pipe(up)
    })
    up.on('error', () => sock.destroy())
    sock.on('close', () => up.destroy())
  })
  await new Promise((r) => proxy.listen(0, '127.0.0.1', r))
  return proxy
}

/**
 * Chromium takes the certificate on --ignore-certificate-errors-spki-list without asking jbrow,
 * so the preview's Site block would say "Not checked yet". This tells it what jbrow says of a
 * valid certificate, from the one the sites serve: the main process's inspector wraps the UI's
 * send() so a 'site-info' reply about a made-up host carries it.
 */
export async function vouchForCert(jb, tls, { waitFor, Cdp }) {
  const ws = await waitFor(() => /Debugger listening on (ws:\/\/\S+)/.exec(jb.output)?.[1], "the main process's inspector")
  const main = new Cdp({ id: 'main', type: 'node', url: '', title: '', webSocketDebuggerUrl: ws })
  const cert = { state: 'valid', issuer: tls.issuer, validTo: tls.validTo, daysLeft: Math.floor((tls.validTo - Date.now()) / DAY) }
  const hosts = Object.keys(SITES)
  const patched = await main.eval(`(() => {
    const { webContents } = process.mainModule.require('electron')
    const ui = webContents.getAllWebContents().find((wc) => /\\/dist\\/ui\\/index\\.html$/.test(wc.getURL()))
    if (!ui) return false
    const send = ui.send.bind(ui)
    ui.send = (channel, reply, ...rest) =>
      send(channel, channel === 'site-info' && reply?.cert?.state === 'unknown' && ${JSON.stringify(hosts)}.includes(reply.host) ? { ...reply, cert: ${JSON.stringify(cert)} } : reply, ...rest)
    return true
  })()`)
  main.close()
  if (!patched) throw new Error("can't find the UI's page in the main process")
}

/** Pages with more to look at than page() gives them, by host and path. */
export const RICH = {}

/**
 * Starts the sites and the proxy, and returns them with the arguments that point jbrow at them.
 * `close` stops both.
 */
export async function startFakeWeb(work) {
  const tls = makeCert(work)
  const sites = await serveSites(tls)
  const proxy = await serveProxy(sites.address().port)
  return {
    tls,
    args: [
      `--proxy-server=127.0.0.1:${proxy.address().port}`,
      `--host-resolver-rules=${Object.entries(SITES)
        .map(([h, s]) => `MAP ${h} ${s.ip}`)
        .join(', ')}`,
      `--ignore-certificate-errors-spki-list=${tls.spki}`,
    ],
    close() {
      for (const s of [sites, proxy]) s.closeAllConnections?.(), s.close()
    },
  }
}
