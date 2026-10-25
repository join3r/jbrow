// Launches the built jbrow (dist/) in the background and drives it over the Chrome DevTools
// Protocol, with nothing but Node's built-ins. Works the same on macOS, Windows and Linux.
//
//   const jb = await launch()
//   const ui = await jb.ui()                       // jbrow's own UI page
//   await ui.send('navigate', { input: url })      // what the UI sends to the main process
//   const s = await jb.waitForState((s) => s.tabs.some((t) => t.url === url))
//   const page = await jb.page(url)                // a tab's page
//   await jb.close()
//
// Each launch gets its own user data folder (JBROW_USER_DATA) and a free debugging port, so
// test files can run side by side, and next to the jbrow you use.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createRequire } from 'node:module'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { UiState } from '../../src/shared/types'

export const ROOT = process.env.JBROW_TEST_ROOT ?? process.cwd()
const ELECTRON: string = createRequire(path.join(ROOT, 'package.json'))('electron')

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Polls `fn` until it returns something truthy, or fails after `timeout` ms with `what`. */
export async function waitFor<T>(fn: () => T | Promise<T>, what: string, timeout = 15_000, every = 50): Promise<NonNullable<T>> {
  const end = Date.now() + timeout
  let last: unknown
  for (;;) {
    try {
      const value = await fn()
      if (value) return value as NonNullable<T>
    } catch (error) {
      last = error
    }
    if (Date.now() > end) throw new Error(`timed out after ${timeout} ms waiting for ${what}${last ? `: ${String(last)}` : ''}`)
    await sleep(every)
  }
}

// ---------- CDP ----------

interface Target {
  id: string
  type: string
  url: string
  title: string
  webSocketDebuggerUrl: string
}

/** One DevTools connection to one target (a page, a service worker). */
export class Cdp {
  private ws: WebSocket
  private nextId = 1
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void; method: string }>()
  private listeners = new Map<string, ((params: any) => void)[]>()
  readonly opened: Promise<void>
  closed = false

  constructor(readonly target: Target) {
    this.ws = new WebSocket(target.webSocketDebuggerUrl)
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true })
      this.ws.addEventListener('error', () => reject(new Error(`can't connect to ${target.url}`)), { once: true })
    })
    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data))
      if (msg.id) {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.error) p.reject(new Error(`${p.method}: ${msg.error.message}`))
        else p.resolve(msg.result)
      } else if (msg.method) {
        for (const fn of this.listeners.get(msg.method) ?? []) fn(msg.params)
      }
    })
    this.ws.addEventListener('close', () => {
      this.closed = true
      for (const p of this.pending.values()) p.reject(new Error(`${p.method}: connection closed`))
      this.pending.clear()
    })
  }

  async send<T = any>(method: string, params: object = {}): Promise<T> {
    await this.opened
    if (this.closed) throw new Error(`${method}: connection closed`)
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method })
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  on(method: string, fn: (params: any) => void) {
    this.listeners.set(method, [...(this.listeners.get(method) ?? []), fn])
  }

  /** Evaluates an expression (awaiting a promise) and returns its value, or throws what it threw. */
  async eval<T = any>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
    if (r.exceptionDetails) {
      const e = r.exceptionDetails
      throw new Error(`eval failed: ${e.exception?.description ?? e.text}\n  in: ${expression.slice(0, 200)}`)
    }
    return r.result.value as T
  }

  /** Runs `fn` in the page with JSON-serializable `args`. */
  async call<A extends unknown[], R>(fn: (...args: A) => R, ...args: A): Promise<Awaited<R>> {
    return this.eval<Awaited<R>>(`(${fn.toString()})(...${JSON.stringify(args)})`)
  }

  /** Presses a key, as a real key press (it goes through before-input-event in the main process). */
  async press(key: string, opts: { code?: string; keyCode?: number; modifiers?: number; text?: string } = {}) {
    const code = opts.code ?? keyCodeName(key)
    const windowsVirtualKeyCode = opts.keyCode ?? virtualKey(key)
    const text = opts.text ?? (key.length === 1 && ((opts.modifiers ?? 0) & ~SHIFT) === 0 ? key : undefined)
    const base = { key, code, windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode, modifiers: opts.modifiers ?? 0 }
    await this.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) })
    await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  /** Types text into whatever has focus. */
  async type(text: string) {
    await this.send('Input.insertText', { text })
  }

  async click(x: number, y: number, button: 'left' | 'right' = 'left') {
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: 1 })
    }
  }

  /** Clicks the middle of the first element matching a CSS selector. */
  async clickOn(selector: string, button: 'left' | 'right' = 'left') {
    const box = await waitFor(
      () =>
        this.call((sel) => {
          const el = document.querySelector(sel)
          if (!el) return null
          const r = el.getBoundingClientRect()
          return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null
        }, selector),
      `a visible ${selector}`,
    )
    await this.click(box.x, box.y, button)
  }

  /** A PNG of the page, as a buffer. */
  async screenshot(): Promise<Buffer> {
    const { data } = await this.send('Page.captureScreenshot', { format: 'png' })
    return Buffer.from(data, 'base64')
  }

  close() {
    if (!this.closed) this.ws.close()
    this.closed = true
  }
}

export const ALT = 1
export const CTRL = 2
export const META = 4
export const SHIFT = 8
/** ⌘ on macOS, Ctrl elsewhere: what jbrow's "CommandOrControl" shortcuts use. */
export const CMD = process.platform === 'darwin' ? META : CTRL

function keyCodeName(key: string): string {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  const named: Record<string, string> = { ' ': 'Space', '=': 'Equal', '-': 'Minus', '[': 'BracketLeft', ']': 'BracketRight', ',': 'Comma', '.': 'Period', '/': 'Slash' }
  return named[key] ?? key
}

function virtualKey(key: string): number {
  if (/^[a-z]$/i.test(key)) return key.toUpperCase().charCodeAt(0)
  if (/^[0-9]$/.test(key)) return key.charCodeAt(0)
  const codes: Record<string, number> = {
    Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
    ' ': 32, '=': 187, '-': 189, '[': 219, ']': 221, ',': 188, '.': 190, '/': 191, F5: 116, F12: 123, Home: 36, End: 35,
  }
  return codes[key] ?? 0
}

// ---------- the app ----------

export interface LaunchOptions {
  /** Merged over jbrow's settings.json before launch. `welcomed: true` is the default. */
  settings?: Record<string, unknown>
  /** Written as tabs.json before launch. */
  tabs?: unknown
  /** Files to put in the user data folder before launch, by relative path. */
  files?: Record<string, string>
  /** Reuse a user data folder, for relaunching with what the previous run saved. */
  userData?: string
  env?: Record<string, string>
  args?: string[]
  /** Leave out --show (jbrow starts hidden unless it's pinned). */
  hidden?: boolean
}

export class Jbrow {
  private uiCdp: Cdp | null = null
  private conns: Cdp[] = []
  private exited: Promise<number | null>
  output = ''
  /** The X display it runs on, on Linux (see ownDisplay). */
  display = process.env.DISPLAY ?? ''
  stopDisplay = () => {}

  constructor(
    readonly proc: ChildProcess,
    readonly userData: string,
    readonly port: number,
    private ownsUserData: boolean,
  ) {
    this.exited = new Promise((resolve) => proc.once('exit', (code: number | null) => resolve(code)))
  }

  get running() {
    return this.proc.exitCode === null && this.proc.signalCode === null
  }

  async targets(): Promise<Target[]> {
    const res = await fetch(`http://127.0.0.1:${this.port}/json/list`, { headers: { connection: 'close' } })
    return (await res.json()) as Target[]
  }

  private async connect(target: Target): Promise<Cdp> {
    const cdp = new Cdp(target)
    await cdp.opened
    this.conns.push(cdp)
    return cdp
  }

  /** jbrow's own UI page, with a listener that keeps the latest state on window.__state. */
  async ui(): Promise<Cdp> {
    if (this.uiCdp && !this.uiCdp.closed) return this.uiCdp
    const target = await waitFor(
      async () => (await this.targets()).find((t) => t.type === 'page' && /\/dist\/ui\/index\.html$/.test(t.url.replace(/\\/g, '/'))),
      'the UI page',
    )
    const cdp = await this.connect(target)
    await waitFor(() => cdp.eval('typeof window.jbrow === "object" && document.readyState === "complete"'), 'the UI to load')
    await cdp.eval(`(() => {
      if (window.__stateHooked) return
      window.__stateHooked = true
      window.__toasts = []
      window.jbrow.on('state', (s) => { window.__state = s; window.__stateCount = (window.__stateCount || 0) + 1 })
      window.jbrow.on('toast', (t) => window.__toasts.push(t))
      window.jbrow.send('ready')
    })()`)
    this.uiCdp = cdp
    return cdp
  }

  /** Sends a message as jbrow's UI does (window.jbrow.send). */
  async send(channel: string, data?: unknown) {
    const ui = await this.ui()
    await ui.eval(`window.jbrow.send(${JSON.stringify(channel)}, ${data === undefined ? 'undefined' : JSON.stringify(data)})`)
  }

  /** The state the main process last pushed to the UI. */
  async state(): Promise<UiState> {
    const ui = await this.ui()
    return waitFor(() => ui.eval<UiState | undefined>('window.__state'), 'the first state')
  }

  /** Waits for a pushed state that passes `test`, and returns it. */
  async waitForState(test: (s: UiState) => unknown, what = 'the state to change', timeout = 15_000): Promise<UiState> {
    let last: UiState | undefined
    try {
      return await waitFor(
        async () => {
          last = await this.state()
          return test(last) ? last : null
        },
        what,
        timeout,
      )
    } catch (error) {
      const tabs = last?.tabs.map((t) => ({ id: t.id, url: t.url, title: t.title, kept: t.kept, loading: t.loading, profile: t.profile }))
      throw new Error(`${(error as Error).message}\n  last state: active ${last?.activeId}, tabs ${JSON.stringify(tabs)}`)
    }
  }

  /** Toasts the UI has shown since launch. */
  async toasts(): Promise<unknown[]> {
    return (await this.ui()).eval('window.__toasts')
  }

  /** Opens `input` (an address or a search) in the active tab, or a new one if there's none. */
  async navigate(input: string, opts: { profile?: string; newTab?: boolean } = {}): Promise<UiState> {
    const before = await this.state()
    if (opts.newTab) {
      await this.send('new')
      // An empty tab that's already showing is reused.
      await this.waitForState((s) => {
        const t = s.tabs.find((x) => x.id === s.activeId)
        return t && !t.url && (t.id !== before.activeId || !before.tabs.find((x) => x.id === before.activeId)?.url)
      }, 'a new tab')
    }
    await this.send('navigate', { input, profile: opts.profile })
    return this.waitForState((s) => {
      const t = s.tabs.find((x) => x.id === s.activeId)
      return t && t.url.startsWith(input.replace(/\/$/, '')) && !t.loading
    }, `${input} to load`)
  }

  /** A tab's page, by its address (a prefix is enough) or a test on its target. */
  async page(match: string | ((t: Target) => boolean), timeout = 15_000): Promise<Cdp> {
    const test = typeof match === 'string' ? (t: Target) => t.url.startsWith(match) : match
    const target = await waitFor(async () => (await this.targets()).find((t) => t.type === 'page' && test(t)), `a page for ${String(match)}`, timeout)
    return this.connect(target)
  }

  /**
   * Waits for the keyboard to reach the page at `url`, which jbrow hands it when the tab opens.
   * It gets there a moment after the page loads, and a test typing into jbrow's own UI before then
   * would have its field blurred mid-way. Gives up quietly after `timeout` ms, for pages jbrow covers
   * with its own screen (a sign-in, a crash), which keep the keyboard in the UI.
   */
  async pageFocused(url: string, timeout = 3000) {
    let page: Cdp | undefined
    try {
      page = await this.page((t) => t.url === url, timeout)
      await waitFor(() => page!.eval('document.hasFocus()'), `${url} to have the keyboard`, timeout)
    } catch {
    } finally {
      page?.close()
    }
  }

  /** Path of a file in the user data folder. */
  file(...parts: string[]) {
    return path.join(this.userData, ...parts)
  }

  /** Reads a JSON file jbrow saved, such as settings.json or tabs.json. */
  readJson<T = any>(name: string): T {
    return JSON.parse(readFileSync(this.file(name), 'utf8')) as T
  }

  /**
   * Quits jbrow the way an outside quit does, so it saves what it keeps on quitting, and waits for
   * it to exit. DevTools' Browser.close does that everywhere; a signal would only on macOS and
   * Linux (Windows has none: the process is just ended).
   */
  async quit(timeout = 10_000) {
    for (const c of this.conns) c.close()
    this.conns = []
    this.uiCdp = null
    if (!this.running) return this.stopDisplay()
    const exited = (ms: number) => {
      let timer: NodeJS.Timeout | undefined
      return Promise.race([this.exited.then(() => true), new Promise<boolean>((r) => (timer = setTimeout(() => r(false), ms)))]).finally(() => clearTimeout(timer))
    }
    try {
      const { webSocketDebuggerUrl } = (await (await fetch(`http://127.0.0.1:${this.port}/json/version`, { headers: { connection: 'close' } })).json()) as {
        webSocketDebuggerUrl: string
      }
      const browser = new Cdp({ id: 'browser', type: 'browser', url: '', title: '', webSocketDebuggerUrl })
      await browser.opened
      void browser.send('Browser.close').catch(() => {})
      const done = await exited(timeout)
      browser.close()
      if (done) return this.stopDisplay()
    } catch {}
    this.proc.kill('SIGTERM')
    if (!(await exited(timeout))) {
      this.proc.kill('SIGKILL')
      await this.exited
    }
    this.stopDisplay()
  }

  /** Quits and deletes the user data folder (unless it was passed in). */
  async close() {
    await this.quit()
    // JBROW_TEST_LOGS=<dir> keeps what each jbrow printed, for CI to keep when a test fails.
    if (process.env.JBROW_TEST_LOGS) {
      mkdirSync(process.env.JBROW_TEST_LOGS, { recursive: true })
      writeFileSync(path.join(process.env.JBROW_TEST_LOGS, `${path.basename(this.userData)}.log`), this.output)
    }
    // Helper processes can hold the output pipes open for a while after jbrow exits.
    this.proc.stdout?.destroy()
    this.proc.stderr?.destroy()
    if (this.ownsUserData) await removeDir(this.userData)
  }

  /** What jbrow printed, for a failing test's message. */
  log(lines = 60) {
    return this.output.split('\n').slice(-lines).join('\n')
  }
}

/** Removes a folder, retrying while Windows still holds files in it open. */
export async function removeDir(dir: string) {
  for (let i = 0; i < 20; i++) {
    try {
      rmSync(dir, { recursive: true, force: true })
      return
    } catch {
      await sleep(250)
    }
  }
}

export function tempDir(prefix = 'jbrow-e2e-') {
  return mkdtempSync(path.join(tmpdir(), prefix))
}

const hasXvfb = (() => {
  if (process.platform !== 'linux') return false
  try {
    execFileSync('Xvfb', ['-help'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

/**
 * On Linux, a virtual display for one jbrow. X11 gives keyboard focus to whichever window asked
 * last, background or not, so two jbrows on one display take it from each other mid-test.
 */
async function ownDisplay(): Promise<{ display: string; stop: () => void } | null> {
  if (!hasXvfb) return null
  const x = spawn('Xvfb', ['-displayfd', '3', '-screen', '0', '1440x900x24', '-nolisten', 'tcp'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] })
  const n = await new Promise<string>((resolve, reject) => {
    let out = ''
    x.stdio[3]!.on('data', (d) => {
      out += d
      if (out.includes('\n')) resolve(out.trim())
    })
    x.once('exit', (code) => reject(new Error(`Xvfb exited with ${code}`)))
  })
  return { display: `:${n}`, stop: () => x.kill() }
}

export async function launch(opts: LaunchOptions = {}): Promise<Jbrow> {
  const userData = opts.userData ?? tempDir()
  mkdirSync(userData, { recursive: true })
  const settingsFile = path.join(userData, 'settings.json')
  const existing = existsSync(settingsFile) ? JSON.parse(readFileSync(settingsFile, 'utf8')) : {}
  if (!opts.userData || opts.settings) {
    writeFileSync(settingsFile, JSON.stringify({ welcomed: true, ...existing, ...opts.settings }, null, 2))
  }
  if (opts.tabs) writeFileSync(path.join(userData, 'tabs.json'), JSON.stringify(opts.tabs, null, 2))
  // Fresh, empty phishing and malware lists, so jbrow doesn't download the real ones. Tests
  // never touch the internet.
  const lists = { 'blocklists/phishing.txt': '# none\n', 'blocklists/malware.txt': '# none\n' }
  for (const name of Object.keys(lists) as (keyof typeof lists)[]) if (existsSync(path.join(userData, name))) delete lists[name]
  for (const [name, content] of Object.entries({ ...lists, ...opts.files })) {
    mkdirSync(path.dirname(path.join(userData, name)), { recursive: true })
    writeFileSync(path.join(userData, name), content)
  }
  rmSync(path.join(userData, 'DevToolsActivePort'), { force: true })

  const args = [ROOT, ...(opts.hidden ? [] : ['--show']), '--remote-debugging-port=0', ...(opts.args ?? [])]
  // GitHub's Linux runners don't allow Chromium's sandbox (unprivileged user namespaces).
  if (process.platform === 'linux') args.push('--no-sandbox')
  const x = await ownDisplay()
  const proc = spawn(ELECTRON, args, {
    cwd: ROOT,
    env: { ...process.env, ...(x ? { DISPLAY: x.display } : {}), JBROW_USER_DATA: userData, JBROW_BACKGROUND: '1', ELECTRON_ENABLE_LOGGING: '0', ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const jb = new Jbrow(proc, userData, 0, !opts.userData)
  if (x) {
    jb.display = x.display
    jb.stopDisplay = x.stop
    proc.once('exit', x.stop)
  }
  proc.stdout!.on('data', (d) => (jb.output += d))
  proc.stderr!.on('data', (d) => (jb.output += d))

  const portFile = path.join(userData, 'DevToolsActivePort')
  let port: number
  try {
    port = await waitFor(
      () => {
        if (!jb.running) throw new Error(`jbrow exited with ${proc.exitCode ?? proc.signalCode}`)
        if (!existsSync(portFile)) return 0
        return Number(readFileSync(portFile, 'utf8').split('\n')[0])
      },
      'the DevTools port',
      30_000,
    )
  } catch (error) {
    proc.kill('SIGKILL')
    throw new Error(`${(error as Error).message}\n--- jbrow output ---\n${jb.output}`)
  }
  ;(jb as { port: number }).port = port
  try {
    await jb.ui()
    // The UI loads while the main process is still setting up profiles; tabs.json is read after
    // that, and a message sent before then would be lost in the restore.
    await waitFor(() => {
      if (!jb.running) throw new Error(`jbrow exited with ${proc.exitCode ?? proc.signalCode}`)
      return jb.output.includes('[jbrow] ready.')
    }, 'jbrow to finish starting', 30_000)
    // And has come up (a moment after starting, unless it starts hidden), so focusing the page
    // then doesn't take focus from what a test is typing into.
    if (!opts.hidden) await waitFor(() => jb.output.includes('[jbrow] shown'), 'jbrow to come up', 30_000)
  } catch (error) {
    await jb.quit()
    throw new Error(`${(error as Error).message}\n--- jbrow output ---\n${jb.output}`)
  }
  return jb
}

// ---------- a local web server for test pages ----------

export type Route = string | { status?: number; headers?: Record<string, string>; body?: string | Buffer; delay?: number } | ((req: IncomingMessage, res: ServerResponse) => void)

export interface TestServer {
  /** http://127.0.0.1:<port> */
  url: string
  /** Requests it has served, by path. */
  hits: string[]
  route(path: string, route: Route): void
  close(): Promise<void>
}

/** Serves `routes` (path → HTML, a response, or a handler) on a free local port. */
export async function serve(routes: Record<string, Route> = {}): Promise<TestServer> {
  const table = new Map(Object.entries(routes))
  const hits: string[] = []
  const server = createServer((req, res) => {
    const p = new URL(req.url ?? '/', 'http://x').pathname
    hits.push(p)
    const route = table.get(p)
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'text/html' }).end('<title>Not found</title>not found')
      return
    }
    if (typeof route === 'function') return route(req, res)
    const r = typeof route === 'string' ? { body: route } : route
    const reply = () => {
      res.writeHead(r.status ?? 200, { 'content-type': 'text/html; charset=utf-8', ...r.headers })
      res.end(r.body ?? '')
    }
    if (r.delay) setTimeout(reply, r.delay)
    else reply()
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    hits,
    route: (p, r) => void table.set(p, r),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}

/** A small HTML page with a title. */
export const html = (title: string, body = '') => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`
