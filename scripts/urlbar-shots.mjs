// Takes the pictures of the address bar's layouts that settings and the welcome show
// (src/ui/img/urlbar-<layout>.png and urlbar-<layout>-dark.png), from the built app, so they can
// be taken again after a design change. It builds nothing itself:
//
//   npm run build && npm run urlbar-shots
//
// jbrow runs in the background (JBROW_BACKGROUND, as CLAUDE.md says) with its own user data
// folder, seeded with tabs in two profiles, an archived tab and some history on made-up sites.
// Every request goes through a proxy here, so nothing reaches the internet: the sites and the
// search engine's suggestions are answered locally over https with a certificate made for the
// run, which jbrow is told to accept (--ignore-certificate-errors-spki-list), and each host
// resolves to an address from the documentation ranges, as the preview's Site block shows it.
// Accepted that way, jbrow never gets to judge the certificate, so vouchForCert tells the address
// bar what it would say of a valid one. Needs openssl to make the certificate.
//
// Look at each picture after a run. They should stay under about 250 KB; the script warns if not.
import { execFileSync } from 'node:child_process'
import { createHash, X509Certificate } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT = path.join(root, 'src/ui/img')
/** The window, in CSS pixels, and the pictures' pixels per CSS pixel. */
const WINDOW = { width: 1180, height: 800 }
const SCALE = 2
/** The pictures are this wide by tall, as the picture cards in settings and the welcome show them. */
const ASPECT = 8 / 5
/** Space around the address bar and its suggestions, in CSS pixels. */
const MARGIN = 14

if (!existsSync(path.join(root, 'dist/main.js'))) {
  console.error('urlbar-shots: dist/main.js is missing, run `npm run build` first')
  process.exit(1)
}

const work = path.join(tmpdir(), `jbrow-urlbar-shots-${process.pid}`)
mkdirSync(work, { recursive: true })

// The tests' harness launches and drives jbrow; it's TypeScript, so bundle it as test/run.mjs does.
process.env.JBROW_TEST_ROOT = root
await build({
  entryPoints: [path.join(root, 'test/e2e/harness.ts')],
  outfile: path.join(work, 'harness.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  logLevel: 'warning',
  external: ['electron'],
})
const { launch, waitFor, sleep, Cdp } = await import(pathToFileURL(path.join(work, 'harness.mjs')).href)

// ---------- the made-up web ----------

const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const now = Date.now()

/** A favicon: a rounded square in `bg` with `glyph` (SVG markup on a 32×32 grid) on it. */
const icon = (bg, glyph) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="${bg}"/>${glyph}</svg>`

/** Each site: the address it resolves to, its favicon and its pages by path, with their titles. */
const SITES = {
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
const SUGGEST_HOST = 'suggestqueries.google.com'
const SUGGESTIONS = ['aurora borealis', 'aurora forecast', 'aurora borealis tonight', 'aurora australis', 'aurora map', 'aurora tromsø']

const url = (host, p) => `https://${host}${p}`
const titleOf = (host, p) => SITES[host].pages[p]
const faviconOf = (host) => url(host, '/favicon.svg')

/** A page as its site shows it: its title, and a little to look at. */
const page = (host, title) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>body{margin:0;font:15px/1.5 -apple-system,system-ui,sans-serif;color:#1d1d1f;background:#fafafa}
header{padding:14px 32px;border-bottom:1px solid #e5e5e5;background:#fff;font-weight:600}main{max-width:720px;margin:32px auto;padding:0 24px}
h1{font-size:28px;margin:0 0 12px}p{color:#555}</style></head>
<body><header>${host}</header><main><h1>${title.split(/ [·—] /)[0]}</h1><p>${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(6)}</p></main></body></html>`

const tab = (id, profile, host, p, seenAgo, more = {}) => ({
  id,
  profile,
  url: url(host, p),
  title: titleOf(host, p),
  favicon: faviconOf(host),
  createdAt: now - seenAgo - 3 * HOUR,
  lastSeen: now - seenAgo,
  ...more,
})
const visit = (host, p, visits, ago) => ({ url: url(host, p), title: titleOf(host, p), visits, last: now - ago })

const TABS = {
  activeId: 'inbox',
  tabs: [
    tab('inbox', 'personal', 'postline.app', '/inbox', 0),
    tab('aurora', 'personal', 'skywatch.live', '/aurora', 4 * MIN),
    tab('timelapse', 'personal', 'reelbox.tv', '/watch/aurora-tromso', 26 * MIN),
    tab('notes', 'work', 'docs.loomdesk.io', '/aurora/release-notes', 2 * HOUR),
    tab('start', 'work', 'docs.loomdesk.io', '/aurora/getting-started', 20 * HOUR),
  ],
  folders: [],
  archived: [tab('settings', 'personal', 'lenscraft.blog', '/aurora-photography-settings', 4 * DAY, { archivedAt: now - 3 * DAY })],
}
const VISITS = {
  personal: [
    visit('skywatch.live', '/', 9, 2 * HOUR),
    visit('skywatch.live', '/clouds', 4, 5 * HOUR),
    visit('skywatch.live', '/kp', 3, DAY),
    visit('skywatch.live', '/aurora', 6, 4 * MIN),
    visit('northwiki.org', '/wiki/Aurora', 3, 3 * HOUR),
    visit('northwiki.org', '/wiki/Aurora_australis', 1, 3 * HOUR),
    visit('northwiki.org', '/wiki/Geomagnetic_storm', 1, 2 * DAY),
    visit('reelbox.tv', '/live/aurora-cam', 2, DAY),
    visit('reelbox.tv', '/watch/aurora-tromso', 1, 26 * MIN),
    visit('postline.app', '/inbox', 30, 0),
    visit('postline.app', '/mail/aurora-trip', 2, 6 * HOUR),
    visit('lenscraft.blog', '/night-sky-for-beginners', 2, 3 * DAY),
  ],
  work: [visit('docs.loomdesk.io', '/aurora/release-notes', 5, 2 * HOUR), visit('docs.loomdesk.io', '/aurora/getting-started', 3, 20 * HOUR)],
}

/** What each layout's picture shows: what's typed, then the keys that move the selection. */
const SCENES = {
  // A search: an open tab on top, the engine's suggestions, then History and Your tabs. ↓↓→ is
  // on the second suggestion, so the Tab hints show.
  columns: { type: 'auro', keys: ['ArrowDown', 'ArrowDown', 'ArrowRight'], ready: '#suggest [data-kind="search"]:nth-of-type(n+3)' },
  // A site the history completes to, and ↓↓ on the open tab on it, with its certificate and address beside.
  preview: { type: 'sky', keys: ['ArrowDown', 'ArrowDown'], ready: '.sp-site .sp-ip' },
}

// ---------- the certificate, the sites and the proxy ----------

/** A certificate authority and a certificate it signed for every host, valid for 90 days from now. */
function makeCert() {
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
async function serveSites(tls) {
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
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page(host, title))
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  return server
}

/** An https proxy that takes the made-up hosts to `sitesPort` and turns everything else away. */
async function serveProxy(sitesPort) {
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
async function vouchForCert(jb, tls) {
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

// ---------- the pictures ----------

/** Puts the keyboard in the address bar with nothing in it, as ⌘L and Backspace do. */
async function focusOmnibox(jb, ui) {
  await jb.send('focus-ui')
  await ui.eval('omnibox.focus()')
  await waitFor(() => ui.eval('document.activeElement?.id === "omnibox"'), 'the address bar to have focus')
  await ui.press('Backspace')
  await waitFor(() => ui.eval('omnibox.value === ""'), 'an empty address bar')
}

/** Paints twice, so what changed last is on screen. */
const painted = (ui) => ui.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')

/** The address bar and its suggestions, with a margin, widened or deepened to the cards' shape. */
async function clipRect(ui) {
  const r = await ui.call(() => {
    const a = document.querySelector('.omni-field')?.parentElement?.getBoundingClientRect()
    const b = document.getElementById('suggest').getBoundingClientRect()
    return { left: Math.min(a.left, b.left), top: a.top, right: Math.max(a.right, b.right), bottom: b.bottom, vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio }
  })
  let x = r.left - MARGIN
  let y = r.top - MARGIN
  let width = r.right - r.left + 2 * MARGIN
  let height = r.bottom - r.top + 2 * MARGIN
  if (width / height > ASPECT) height = width / ASPECT
  else {
    const w = height * ASPECT
    x -= (w - width) / 2
    width = w
  }
  x = Math.max(0, Math.min(x, r.vw - width))
  y = Math.max(0, Math.min(y, r.vh - height))
  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height), scale: SCALE / r.dpr }
}

async function shoot(jb, ui, layout, file) {
  const scene = SCENES[layout]
  await focusOmnibox(jb, ui)
  await ui.type(scene.type)
  await waitFor(() => ui.eval(`!document.getElementById('suggest').hidden && document.getElementById('suggest').dataset.layout === ${JSON.stringify(layout)}`), `the ${layout} suggestions`)
  // Let the history and the engine's suggestions arrive before moving, so the selection stays put.
  await sleep(600)
  for (const key of scene.keys) {
    await ui.press(key)
    await sleep(120)
  }
  try {
    await waitFor(() => ui.eval(`!!document.querySelector(${JSON.stringify(scene.ready)})`), `${scene.ready} in the ${layout} suggestions`, 8000)
  } catch (error) {
    console.error(`urlbar-shots: ${error.message}, trying again`)
    await ui.press('Escape')
    return false
  }
  // Favicons load as their rows show.
  await waitFor(
    () => ui.eval(`[...document.querySelectorAll('#suggest img')].every((i) => i.complete && i.naturalWidth > 0)`),
    'the favicons to load',
  )
  // Only the address bar and its suggestions, on the theme's plain background: the sidebar, the
  // buttons beside it and the window's see-through backdrop would show at the edges.
  await ui.eval(`(() => {
    document.querySelector('.omni-field').parentElement.dataset.shot = ''
    const style = document.createElement('style')
    style.id = 'shotStyle'
    style.textContent = 'html { background: var(--solid) } body *:not([data-shot], [data-shot] *) { visibility: hidden } [data-shot] { visibility: visible }'
    document.head.append(style)
  })()`)
  await painted(ui)
  // A state arriving just after a pref changed can put the page's address back in the bar.
  if (!(await ui.eval(`!document.getElementById('suggest').hidden && omnibox.value.startsWith(${JSON.stringify(scene.type)})`))) {
    console.error(`urlbar-shots: the ${layout} suggestions went away, trying again`)
    await ui.eval(`document.getElementById('shotStyle').remove(), delete document.querySelector('[data-shot]').dataset.shot`)
    await ui.press('Escape')
    return false
  }
  const clip = await clipRect(ui)
  const { data } = await ui.send('Page.captureScreenshot', { format: 'png', clip })
  writeFileSync(file, Buffer.from(data, 'base64'))
  await ui.eval(`document.getElementById('shotStyle').remove(), delete document.querySelector('[data-shot]').dataset.shot`)
  await ui.press('Escape')
  const kb = Math.round(statSync(file).size / 1024)
  console.log(`urlbar-shots: ${path.relative(root, file)} (${clip.width}×${clip.height} at ${SCALE}x, ${kb} KB)`)
  if (kb > 250) console.warn(`urlbar-shots: ${path.basename(file)} is over 250 KB; a smaller WINDOW or fewer rows would help`)
  return true
}

let jb
const servers = []
try {
  const tls = makeCert()
  const sites = await serveSites(tls)
  servers.push(sites)
  const proxy = await serveProxy(sites.address().port)
  servers.push(proxy)

  const userData = path.join(work, 'user-data')
  jb = await launch({
    userData,
    settings: {
      welcomed: true,
      appearance: 'light',
      urlBarStyle: 'columns',
      searchSuggestions: true,
      dangerousSites: false,
      autoUpdate: false,
      pinned: true,
      panel: { widthFraction: 0.72, heightFraction: 0.78, displays: {}, pinned: { x: 0, y: 0, ...WINDOW } },
    },
    tabs: TABS,
    files: { 'visits.json': JSON.stringify(VISITS) },
    args: [
      `--user-data-dir=${userData}`,
      `--proxy-server=127.0.0.1:${proxy.address().port}`,
      `--host-resolver-rules=${Object.entries(SITES)
        .map(([h, s]) => `MAP ${h} ${s.ip}`)
        .join(', ')}`,
      `--ignore-certificate-errors-spki-list=${tls.spki}`,
      // The main process's inspector, for vouchForCert.
      '--inspect=0',
    ],
  })
  const ui = await jb.ui()
  await jb.waitForState((s) => s.tabs.length === TABS.tabs.length, 'the seeded tabs')
  // The active tab's page takes the keyboard once it loads, which would blur the address bar mid-way.
  await jb.pageFocused(url('postline.app', '/inbox'), 10_000)

  await vouchForCert(jb, tls)
  for (const appearance of ['light', 'dark']) {
    await jb.send('prefs', { appearance })
    await waitFor(() => ui.eval(`matchMedia('(prefers-color-scheme: dark)').matches === ${appearance === 'dark'}`), `the ${appearance} appearance`)
    await sleep(1000)
    for (const layout of Object.keys(SCENES)) {
      await jb.send('prefs', { urlBarStyle: layout })
      await jb.waitForState((s) => s.prefs.urlBarStyle === layout, `the ${layout} layout`)
      const file = path.join(OUT, `urlbar-${layout}${appearance === 'dark' ? '-dark' : ''}.png`)
      for (let tries = 1; !(await shoot(jb, ui, layout, file)); tries++) {
        if (tries === 3) throw new Error(`the ${layout} suggestions didn't stay up for the picture`)
      }
    }
  }
} catch (error) {
  console.error(`urlbar-shots: ${error instanceof Error ? error.message : error}`)
  if (jb) {
    console.error(`--- jbrow output ---\n${jb.log(40)}`)
    // What the window showed when it went wrong.
    const failed = path.join(tmpdir(), 'jbrow-urlbar-shots-failed.png')
    await jb
      .ui()
      .then((ui) => ui.screenshot())
      .then((png) => (writeFileSync(failed, png), console.error(`urlbar-shots: the window as it was: ${failed}`)))
      .catch(() => {})
  }
  process.exitCode = 1
} finally {
  await jb?.quit().catch(() => {})
  for (const s of servers) s.closeAllConnections?.(), s.close()
  rmSync(work, { recursive: true, force: true })
}
