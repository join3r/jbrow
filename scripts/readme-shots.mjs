// Takes the README's pictures (docs/img/), from the built app, so they can be taken again after a
// design change. It builds nothing itself:
//
//   npm run build && npm run readme-shots
//
// For each appearance, light and dark, jbrow runs in the background (JBROW_BACKGROUND, as CLAUDE.md
// says) with a fresh user data folder, as at first launch, with tabs on the made-up sites of
// lib/fake-web.mjs, so nothing reaches the internet. It goes through the welcome, taking the steps in
// WELCOME_STEPS (welcome-<step>.png), skips it, and takes the window with its tabs (jbrow.png). The welcome
// covers the whole window, so the UI page has all of it. For the window, the pages are views of
// their own on top of the UI, so the main process's inspector captures each one and the UI page
// draws them where they sit, with the window's corners and shadow around.
//
// Look at each picture after a run.
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { HOUR, MIN, RICH, startFakeWeb, tab, visit, vouchForCert } from './lib/fake-web.mjs'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const OUT = path.join(root, 'docs/img')
/** The window, in CSS pixels, and the window picture's pixels per CSS pixel (the welcome's are 1x). */
const WINDOW = { width: 1280, height: 800 }
const SCALE = 2
/** Room around the window picture for its shadow, in CSS pixels. */
const PAD = 36
/** The welcome's steps the README shows. */
const WELCOME_STEPS = ['mode', 'keys', 'profiles', 'tabs']

if (!existsSync(path.join(root, 'dist/main.js'))) {
  console.error('readme-shots: dist/main.js is missing, run `npm run build` first')
  process.exit(1)
}

const work = path.join(tmpdir(), `jbrow-readme-shots-${process.pid}`)
mkdirSync(work, { recursive: true })
mkdirSync(OUT, { recursive: true })

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

// The page on screen: tonight's aurora forecast, with something to look at.
RICH['skywatch.live/aurora'] = `<!doctype html><html><head><meta charset="utf-8"><title>Aurora forecast for tonight · Skywatch</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
body{margin:0;font:15px/1.5 -apple-system,system-ui,sans-serif;color:#e8ecf6;background:#0b1428}
nav{display:flex;gap:28px;align-items:center;padding:16px 40px;font-size:14px;color:#9fb0d0}
nav b{color:#fff;font-size:16px;margin-right:auto;letter-spacing:-.01em}
.sky{position:relative;height:330px;overflow:hidden;background:linear-gradient(#0b1428,#14234a 70%,#1b2d55)}
.sky i{position:absolute;inset:-40% -10% auto;height:120%;filter:blur(38px);opacity:.75;border-radius:50%}
.sky .a{background:radial-gradient(closest-side,#3ee0a1,transparent);left:-5%;width:70%;top:-10%;transform:rotate(-12deg)}
.sky .b{background:radial-gradient(closest-side,#7c5cff,transparent);left:40%;width:60%;top:-30%;transform:rotate(10deg);opacity:.6}
.sky .c{background:radial-gradient(closest-side,#2bd9c9,transparent);left:20%;width:50%;top:5%;opacity:.5}
.sky svg{position:absolute;bottom:0;left:0;width:100%;height:90px}
.sky h1{position:absolute;left:40px;bottom:96px;margin:0;font-size:44px;letter-spacing:-.02em;color:#fff}
.sky p{position:absolute;left:40px;bottom:66px;margin:0;color:#c7d3ee}
main{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;padding:24px 40px}
.card{background:#132042;border:1px solid #20305a;border-radius:14px;padding:18px 20px}
.card small{color:#8ea0c4;text-transform:uppercase;letter-spacing:.08em;font-size:11px}
.card b{display:block;font-size:30px;color:#fff;margin:4px 0 2px}
.card span{color:#9fb0d0;font-size:13px}
.bars{display:flex;gap:6px;align-items:flex-end;height:46px;margin-top:10px}
.bars i{flex:1;border-radius:4px 4px 0 0;background:linear-gradient(#3ee0a1,#1c8f6a)}
</style></head><body>
<nav><b>Skywatch</b><span>Forecast</span><span>Kp index</span><span>Clouds</span><span>Alerts</span></nav>
<div class="sky"><i class="a"></i><i class="b"></i><i class="c"></i>
<svg viewBox="0 0 1200 90" preserveAspectRatio="none"><path d="M0 70 L120 40 L210 62 L330 22 L450 58 L560 34 L700 66 L820 30 L960 60 L1080 38 L1200 64 L1200 90 L0 90Z" fill="#070d1c"/></svg>
<h1>Aurora likely tonight</h1><p>Tromsø · best between 22:00 and 01:00 · clear skies from 21:00</p></div>
<main>
<div class="card"><small>Kp index</small><b>6.3</b><span>Strong storm, G2</span><div class="bars"><i style="height:30%"></i><i style="height:45%"></i><i style="height:70%"></i><i style="height:100%"></i><i style="height:85%"></i><i style="height:60%"></i><i style="height:40%"></i></div></div>
<div class="card"><small>Cloud cover</small><b>12%</b><span>Clearing after sunset</span><div class="bars"><i style="height:90%;background:#4a5b84"></i><i style="height:70%;background:#4a5b84"></i><i style="height:40%;background:#4a5b84"></i><i style="height:15%;background:#4a5b84"></i><i style="height:10%;background:#4a5b84"></i><i style="height:12%;background:#4a5b84"></i><i style="height:20%;background:#4a5b84"></i></div></div>
<div class="card"><small>Chance to see it</small><b>84%</b><span>Look north, away from town lights</span><div class="bars"><i style="height:20%"></i><i style="height:50%"></i><i style="height:84%"></i><i style="height:84%"></i><i style="height:70%"></i><i style="height:45%"></i><i style="height:25%"></i></div></div>
</main></body></html>`

const kept = (order, more = {}) => ({ kept: true, order, ...more })
const TABS = {
  activeId: 'aurora',
  tabs: [
    tab('inbox', 'personal', 'postline.app', '/inbox', 20 * MIN, kept(0, { pinned: true })),
    tab('reel', 'personal', 'reelbox.tv', '/live/aurora-cam', 3 * HOUR, kept(1, { pinned: true })),
    tab('wiki', 'personal', 'northwiki.org', '/wiki/Aurora', 2 * HOUR, kept(2, { pinned: true })),
    tab('notes', 'work', 'docs.loomdesk.io', '/aurora/release-notes', 2 * HOUR, kept(3)),
    tab('start', 'work', 'docs.loomdesk.io', '/aurora/getting-started', 20 * HOUR, kept(4)),
    tab('aurora', 'personal', 'skywatch.live', '/aurora', 0),
    tab('kp', 'personal', 'skywatch.live', '/kp', 4 * MIN),
    tab('photo', 'personal', 'lenscraft.blog', '/aurora-photography-settings', 26 * MIN),
    tab('timelapse', 'personal', 'reelbox.tv', '/watch/aurora-tromso', 50 * MIN),
    tab('storm', 'personal', 'northwiki.org', '/wiki/Geomagnetic_storm', 3 * HOUR),
    tab('trip', 'personal', 'postline.app', '/mail/aurora-trip', 6 * HOUR),
  ],
  folders: [],
  archived: [],
}
for (const t of TABS.tabs) if (t.kept) t.home = { url: t.url, title: t.title, favicon: t.favicon }
const VISITS = {
  personal: [visit('skywatch.live', '/aurora', 6, 0), visit('postline.app', '/inbox', 30, 20 * MIN)],
  work: [visit('docs.loomdesk.io', '/aurora/release-notes', 5, 2 * HOUR)],
}

// ---------- the pictures ----------

/** Paints twice, so what changed last is on screen. */
const painted = (ui) => ui.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')

function save(file, base64) {
  writeFileSync(file, Buffer.from(base64, 'base64'))
  console.log(`readme-shots: ${path.relative(root, file)} (${Math.round(statSync(file).size / 1024)} KB)`)
}

/** The steps of the welcome in WELCOME_STEPS, as they show at first launch. */
async function shootWelcome(ui, suffix) {
  await waitFor(() => ui.eval('!document.getElementById("welcome").hidden && !!document.querySelector(".wl-steps")'), 'the welcome')
  // The harness says the UI is ready once more and main answers with the welcome again, which starts it over.
  await sleep(1500)
  const steps = await ui.eval('[...document.querySelectorAll(".wl-steps button")].length')
  for (let i = 0; i < steps; i++) {
    const id = await ui.eval('[...document.querySelector(".wl-step").classList].find((c) => c.startsWith("wl-step-")).slice(8)')
    if (!WELCOME_STEPS.includes(id)) {
      if (i < steps - 1) await ui.eval('document.getElementById("wl-next").click()')
      continue
    }
    // Let the step's entrance and the little Mac's first move finish.
    await sleep(id === 'hello' || id === 'mode' || id === 'keys' ? 2200 : 700)
    await ui.eval('(async () => { await Promise.all([...document.images].map((i) => i.decode().catch(() => {}))) })()')
    await painted(ui)
    const { data } = await ui.send('Page.captureScreenshot', { format: 'png' })
    save(path.join(OUT, `welcome-${id}${suffix}.png`), data)
    if (i < steps - 1) await ui.eval('document.getElementById("wl-next").click()')
  }
  await ui.eval('document.getElementById("wl-skip")?.click() ?? document.getElementById("wl-next").click()')
  await waitFor(() => ui.eval('document.getElementById("welcome").hidden'), 'the welcome to close')
}

/** The window with its pages in it, on a transparent background with room for a shadow. */
async function shootWindow(jb, ui, file) {
  await ui.eval(`(() => {
    const style = document.createElement('style')
    style.id = 'shotStyle'
    style.textContent = 'html { background: var(--solid) }'
    document.head.append(style)
  })()`)
  await painted(ui)
  const { data: uiPng } = await ui.send('Page.captureScreenshot', { format: 'png' })
  const ws = await waitFor(() => /Debugger listening on (ws:\/\/\S+)/.exec(jb.output)?.[1], "the main process's inspector")
  const main = new Cdp({ id: 'main', type: 'node', url: '', title: '', webSocketDebuggerUrl: ws })
  const views = await main.eval(`(async () => {
    const { BrowserWindow } = process.mainModule.require('electron')
    const win = BrowserWindow.getAllWindows().find((w) => w.contentView.children.length > 1)
    const out = []
    for (const v of win.contentView.children) {
      const wc = v.webContents
      if (!wc || /\\/dist\\/ui\\/index\\.html$/.test(wc.getURL()) || !v.getVisible?.()) continue
      const b = v.getBounds()
      if (!b.width || !b.height) continue
      out.push({ ...b, png: (await wc.capturePage()).toPNG().toString('base64') })
    }
    return out
  })()`)
  main.close()
  const png = await ui.eval(`(async () => {
    const W = ${WINDOW.width}, H = ${WINDOW.height}, S = ${SCALE}, P = ${PAD}
    const load = (b64) => new Promise((r, j) => { const i = new Image(); i.onload = () => r(i); i.onerror = j; i.src = 'data:image/png;base64,' + b64 })
    const c = document.createElement('canvas')
    c.width = (W + 2 * P) * S
    c.height = (H + 2 * P) * S
    const g = c.getContext('2d')
    g.scale(S, S)
    const frame = () => { g.beginPath(); g.roundRect(P, P, W, H, 12) }
    g.save()
    g.shadowColor = 'rgba(0,0,0,.28)'; g.shadowBlur = 30; g.shadowOffsetY = 12
    frame(); g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--solid'); g.fill()
    g.restore()
    frame(); g.clip()
    g.drawImage(await load(${JSON.stringify(uiPng)}), P, P, W, H)
    for (const v of ${JSON.stringify(views)}) {
      g.save()
      g.beginPath(); g.roundRect(P + v.x, P + v.y, v.width, v.height, 9); g.clip()
      g.drawImage(await load(v.png), P + v.x, P + v.y, v.width, v.height)
      g.restore()
    }
    return c.toDataURL('image/png').split(',')[1]
  })()`)
  await ui.eval(`document.getElementById('shotStyle').remove()`)
  save(file, png)
}

let jb
let web
try {
  web = await startFakeWeb(work)
  for (const appearance of ['light', 'dark']) {
    const suffix = appearance === 'dark' ? '-dark' : ''
    const userData = path.join(work, `user-data-${appearance}`)
    jb = await launch({
      userData,
      settings: {
        welcomed: false,
        appearance,
        dangerousSites: false,
        autoUpdate: false,
        searchSuggestions: false,
        pinned: true,
        panel: { widthFraction: 0.72, heightFraction: 0.78, displays: {}, pinned: { x: 0, y: 0, ...WINDOW } },
      },
      tabs: TABS,
      files: { 'visits.json': JSON.stringify(VISITS) },
      args: [`--user-data-dir=${userData}`, ...web.args, '--inspect=0'],
    })
    const ui = await jb.ui()
    await waitFor(() => ui.eval(`matchMedia('(prefers-color-scheme: dark)').matches === ${appearance === 'dark'}`), `the ${appearance} appearance`)
    await shootWelcome(ui, suffix)

    await vouchForCert(jb, web.tls, { waitFor, Cdp })
    await jb.waitForState((s) => s.tabs.find((t) => t.id === 'aurora')?.loaded && !s.tabs.some((t) => t.loading), 'the pages to load')
    await waitFor(
      () => ui.eval(`[...document.querySelectorAll('img')].filter((i) => i.offsetParent).every((i) => i.complete && i.naturalWidth > 0)`),
      'the favicons to load',
    )
    // The address bar takes the page's color once it's had a look at it.
    await sleep(1500)
    await shootWindow(jb, ui, path.join(OUT, `jbrow${suffix}.png`))
    await jb.quit()
    jb = undefined
  }
} catch (error) {
  console.error(`readme-shots: ${error instanceof Error ? error.message : error}`)
  if (jb) {
    console.error(`--- jbrow output ---\n${jb.log(40)}`)
    const failed = path.join(tmpdir(), 'jbrow-readme-shots-failed.png')
    await jb
      .ui()
      .then((ui) => ui.screenshot())
      .then((png) => (writeFileSync(failed, png), console.error(`readme-shots: the window as it was: ${failed}`)))
      .catch(() => {})
  }
  process.exitCode = 1
} finally {
  await jb?.quit().catch(() => {})
  web?.close()
  rmSync(work, { recursive: true, force: true })
}
