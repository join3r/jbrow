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
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { DAY, HOUR, MIN, now, startFakeWeb, tab, url, visit, vouchForCert } from './lib/fake-web.mjs'

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

// ---------- what jbrow has open ----------

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
    const a = document.getElementById('bar').getBoundingClientRect()
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
    document.getElementById('bar').dataset.shot = ''
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
let web
try {
  web = await startFakeWeb(work)

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
      ...web.args,
      // The main process's inspector, for vouchForCert.
      '--inspect=0',
    ],
  })
  const ui = await jb.ui()
  await jb.waitForState((s) => s.tabs.length === TABS.tabs.length, 'the seeded tabs')
  // The active tab's page takes the keyboard once it loads, which would blur the address bar mid-way.
  await jb.pageFocused(url('postline.app', '/inbox'), 10_000)

  await vouchForCert(jb, web.tls, { waitFor, Cdp })
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
  web?.close()
  rmSync(work, { recursive: true, force: true })
}
