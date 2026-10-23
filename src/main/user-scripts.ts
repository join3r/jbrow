import { app, ipcMain, webFrameMain, type Session } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { UserScriptInjection } from '../shared/types'
import { libraryOf, permissionsOf } from './library'
import type { ProfileRuntime } from './profiles'

type RunAt = UserScriptInjection['runAt']
type World = UserScriptInjection['world']

interface Source {
  code?: string
  file?: string
}

interface UserScript {
  id: string
  matches?: string[]
  excludeMatches?: string[]
  includeGlobs?: string[]
  excludeGlobs?: string[]
  js: Source[]
  runAt: RunAt
  allFrames: boolean
  world: World
  worldId?: string
}

interface WorldProperties {
  worldId?: string
  csp?: string
  messaging?: boolean
}

interface Registered {
  scripts: UserScript[]
  worlds: WorldProperties[]
}

const storePath = () => path.join(app.getPath('userData'), 'user-scripts.json')

/** Messages from user scripts wait this long for the extension to answer. */
const REPLY_TIMEOUT_MS = 5 * 60 * 1000

/**
 * chrome.userScripts. Registrations are kept per profile and extension in user-scripts.json, so
 * they survive restarts as in Chrome. Each top-level page asks for its scripts from its preload
 * (src/preload/user-scripts.ts) before any of the page's own scripts run, and runs them at their
 * runAt time, in the extension's USER_SCRIPT world or the page's MAIN world. Frames inside a page
 * get no preload, so `allFrames` scripts run there from here, after the frame loads, and only
 * MAIN-world ones. The extension side is in src/preload/extension-shims.ts.
 */
export class UserScripts {
  private registered: Record<string, Record<string, Registered>> = {}
  private replies = new Map<string, (reply: { responded?: boolean; response?: unknown }) => void>()
  private files = new Map<string, string>()
  private runtimes: ProfileRuntime[] = []

  constructor() {
    try {
      if (existsSync(storePath())) this.registered = JSON.parse(readFileSync(storePath(), 'utf8'))
    } catch (error) {
      console.error('[user-scripts] could not read user-scripts.json:', error)
    }

    // A top-level page's preload asks for its scripts before the page's own scripts run.
    // The page's address comes from the main process, not from what the renderer says it is.
    ipcMain.on('jbrow:user-scripts', (event) => {
      const rt = this.runtimeFor(event.sender.session)
      const frame = event.senderFrame
      try {
        event.returnValue = rt && frame && frame === event.sender.mainFrame ? this.injections(rt, frame.url, true) : []
      } catch (error) {
        console.error('[user-scripts] could not collect scripts:', error)
        event.returnValue = []
      }
    })
    ipcMain.handle('jbrow:user-script-message', (event, extId: string, message: unknown) => this.message(event, extId, message))

    // Frames inside pages have no preload; their MAIN-world `allFrames` scripts run once they load.
    app.on('web-contents-created', (_e, wc) => {
      wc.on('did-frame-finish-load', (_e2, isMainFrame, processId, routingId) => {
        if (isMainFrame) return
        const rt = this.runtimeFor(wc.session)
        const frame = rt && webFrameMain.fromId(processId, routingId)
        if (!frame || frame.isDestroyed()) return
        for (const i of this.injections(rt, frame.url, false)) {
          if (i.world !== 'MAIN') continue
          for (const s of i.js) void frame.executeJavaScript(s.code).catch(() => {})
        }
      })
    })
  }

  private save() {
    writeFileSync(storePath(), JSON.stringify(this.registered, null, 2))
  }

  /** A deleted profile's registrations go with it. */
  forgetProfile(profile: string) {
    this.runtimes = this.runtimes.filter((rt) => rt.profile.id !== profile)
    if (!this.registered[profile]) return
    delete this.registered[profile]
    this.save()
  }

  private of(profile: string, extId: string): Registered {
    return ((this.registered[profile] ??= {})[extId] ??= { scripts: [], worlds: [] })
  }

  private runtimeFor(sess: Session) {
    return this.runtimes.find((rt) => rt.session === sess)
  }

  /** Adds chrome.userScripts to a profile; see setupProfiles. */
  attach(rt: ProfileRuntime) {
    this.runtimes.push(rt)
    const profile = rt.profile.id
    const handle = libraryOf(rt).router.apiHandler()
    const opts = { permission: 'userScripts' }
    const changed = () => this.save()
    handle('userScripts.register', ({ extension }, scripts: Partial<UserScript>[]) => {
      const reg = this.of(profile, extension.id)
      const ids = new Set(reg.scripts.map((s) => s.id))
      const added = (scripts ?? []).map((s) => {
        if (ids.has(s.id!)) throw new Error(`Duplicate script ID '${s.id}'`)
        ids.add(s.id!)
        return this.validate(extension, s)
      })
      reg.scripts.push(...added)
      changed()
    }, opts)
    handle('userScripts.update', ({ extension }, scripts: Partial<UserScript>[]) => {
      const reg = this.of(profile, extension.id)
      const updated = (scripts ?? []).map((s) => {
        const old = reg.scripts.find((r) => r.id === s.id)
        if (!old) throw new Error(`Script with ID '${s.id}' does not exist or is not fully registered`)
        return this.validate(extension, { ...old, ...withoutUndefined(s) })
      })
      reg.scripts = reg.scripts.map((r) => updated.find((u) => u.id === r.id) ?? r)
      changed()
    }, opts)
    handle('userScripts.unregister', ({ extension }, filter?: { ids?: string[] }) => {
      const reg = this.of(profile, extension.id)
      const missing = filter?.ids?.find((id) => !reg.scripts.some((s) => s.id === id))
      if (missing) throw new Error(`Nonexistent script ID '${missing}'`)
      reg.scripts = filter?.ids ? reg.scripts.filter((s) => !filter.ids!.includes(s.id)) : []
      changed()
    }, opts)
    handle('userScripts.getScripts', ({ extension }, filter?: { ids?: string[] }) =>
      this.of(profile, extension.id).scripts.filter((s) => !filter?.ids || filter.ids.includes(s.id)),
    opts)
    handle('userScripts.configureWorld', ({ extension }, props: WorldProperties = {}) => {
      const reg = this.of(profile, extension.id)
      reg.worlds = [...reg.worlds.filter((w) => w.worldId !== props.worldId), withoutUndefined(props)]
      changed()
    }, opts)
    handle('userScripts.getWorldConfigurations', ({ extension }) => this.of(profile, extension.id).worlds, opts)
    handle('userScripts.resetWorldConfiguration', ({ extension }, worldId?: string) => {
      const reg = this.of(profile, extension.id)
      reg.worlds = reg.worlds.filter((w) => w.worldId !== (worldId ?? undefined))
      changed()
    }, opts)
    handle('userScripts.execute', async ({ extension }, injection: { target?: { tabId?: number }; js?: Source[]; world?: World; worldId?: string }) => {
      const wc = libraryOf(rt).store.getTabById(injection?.target?.tabId ?? -1)
      if (!wc) throw new Error(`No tab with id: ${injection?.target?.tabId}`)
      const url = wc.getURL()
      if (!hostAllowed(extension, url)) throw new Error('Cannot access contents of the page. Extension manifest must request permission to access the respective host.')
      // The tab may navigate before a script runs, so each one first checks it's still on the
      // origin that was allowed, and throws instead of running on another site.
      const guard = `if (${JSON.stringify(originOf(url))} !== (location.protocol === 'file:' ? 'file:' : location.origin)) throw new Error('The page navigated away.');\n`
      const js = (injection.js ?? []).map((s) => {
        const source = this.source(extension, s)
        return { ...source, code: guard + source.code }
      })
      let result: unknown
      if (injection.world === 'MAIN') for (const s of js) result = await wc.executeJavaScript(s.code)
      else result = await wc.executeJavaScriptInIsolatedWorld(worldNumber(extension.id, injection.worldId), js)
      return [{ frameId: 0, result }]
    }, opts)
    handle('userScripts.reply', (_event, replyId: string, reply: { responded?: boolean; response?: unknown }) => this.replies.get(replyId)?.(reply), opts)
    // Files are read again after an extension reloads, in case they changed.
    rt.session.extensions.on('extension-loaded', (_e, ext) => {
      for (const key of this.files.keys()) if (key.startsWith(`${ext.path}\0`)) this.files.delete(key)
    })
  }

  /** The scripts a page or frame at `url` runs, in registration order. */
  injections(rt: ProfileRuntime, url: string, top: boolean): UserScriptInjection[] {
    if (!/^(https?|file):/i.test(url)) return []
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return []
    }
    const out: UserScriptInjection[] = []
    for (const [extId, reg] of Object.entries(this.registered[rt.profile.id] ?? {})) {
      if (!reg.scripts.length) continue
      const ext = rt.session.extensions.getExtension(extId)
      if (!ext || !permissionsOf(ext).includes('userScripts') || !hostAllowed(ext, url)) continue
      for (const s of reg.scripts) {
        if ((!top && !s.allFrames) || !scriptMatches(s, parsed)) continue
        const world = reg.worlds.find((w) => (w.worldId ?? '') === (s.worldId ?? '')) ?? reg.worlds.find((w) => !w.worldId) ?? {}
        try {
          out.push({
            extensionId: ext.id,
            world: s.world,
            worldId: worldNumber(ext.id, s.worldId),
            worldName: `${ext.name} user scripts${s.worldId ? ` (${s.worldId})` : ''}`,
            csp: world.csp,
            messaging: !!world.messaging,
            runAt: s.runAt,
            js: s.js.map((src) => this.source(ext, src)),
          })
        } catch (error) {
          console.error(`[user-scripts] ${ext.name}: script ${s.id}:`, error)
        }
      }
    }
    return out
  }

  /** Checks a script the way Chrome does and fills in its defaults. */
  private validate(ext: Electron.Extension, s: Partial<UserScript>): UserScript {
    const id = s.id
    if (typeof id !== 'string' || !id) throw new Error('A user script needs an id')
    if (id.startsWith('_')) throw new Error(`Script's ID '${id}' must not start with '_'`)
    if (!s.matches?.length && !s.includeGlobs?.length) throw new Error(`Script with ID '${id}' must specify either 'matches' or 'includeGlobs'`)
    for (const [i, m] of [...(s.matches ?? []), ...(s.excludeMatches ?? [])].entries()) {
      if (!parsePattern(m)) throw new Error(`Script with ID '${id}' has an invalid match pattern at ${i}: '${m}'`)
    }
    if (!s.js?.length) throw new Error(`Script with ID '${id}' must specify at least one js source`)
    for (const src of s.js) {
      if ((src.code === undefined) === (src.file === undefined)) throw new Error(`User script with ID '${id}' must specify exactly one of 'code' or 'file' as a js source`)
      if (src.file !== undefined) this.source(ext, src)
    }
    const runAt = s.runAt ?? 'document_idle'
    if (!['document_start', 'document_end', 'document_idle'].includes(runAt)) throw new Error(`Script with ID '${id}' has an invalid runAt: '${runAt}'`)
    const world = s.world ?? 'USER_SCRIPT'
    if (world !== 'MAIN' && world !== 'USER_SCRIPT') throw new Error(`Script with ID '${id}' has an invalid world: '${world}'`)
    return withoutUndefined({
      id,
      matches: s.matches,
      excludeMatches: s.excludeMatches,
      includeGlobs: s.includeGlobs,
      excludeGlobs: s.excludeGlobs,
      js: s.js.map((src) => (src.file !== undefined ? { file: src.file } : { code: String(src.code) })),
      runAt,
      allFrames: !!s.allFrames,
      world,
      worldId: world === 'USER_SCRIPT' ? s.worldId : undefined,
    })
  }

  /** A script source's code, reading `file` from the extension's folder. */
  private source(ext: Electron.Extension, src: Source): { code: string; url?: string } {
    if (src.file === undefined) return { code: String(src.code ?? '') }
    const file = path.resolve(ext.path, src.file.replace(/^\//, ''))
    if (!file.startsWith(ext.path + path.sep)) throw new Error(`Could not load javascript '${src.file}' for script.`)
    const key = `${ext.path}\0${file}`
    let code = this.files.get(key)
    if (code === undefined) {
      try {
        code = readFileSync(file, 'utf8')
      } catch {
        throw new Error(`Could not load javascript '${src.file}' for script.`)
      }
      this.files.set(key, code)
    }
    return { code, url: new URL(src.file.replace(/^\//, ''), ext.url).href }
  }

  /**
   * chrome.runtime.sendMessage from a user script, delivered as runtime.onUserScriptMessage. It
   * resolves with the first answer, or with nothing once every listening context has passed.
   */
  private message(event: Electron.IpcMainInvokeEvent, extId: string, message: unknown): Promise<unknown> {
    const rt = this.runtimeFor(event.sender.session)
    const ext = rt?.session.extensions.getExtension(extId)
    const reg = rt && this.registered[rt.profile.id]?.[extId]
    if (!rt || !ext || !reg) return Promise.resolve(undefined)
    // Only a page this extension put a messaging world into may send as it.
    const frame = event.senderFrame
    if (!frame || !this.injections(rt, frame.url, frame === event.sender.mainFrame).some((i) => i.extensionId === extId && i.messaging)) {
      return Promise.resolve(undefined)
    }
    const ctx = libraryOf(rt)
    const listening = (ctx.router.listeners.get('runtime.onUserScriptMessage') ?? []).filter((l) => l.extensionId === extId).length
    if (!listening) return Promise.resolve(undefined)
    const replyId = randomUUID()
    const url = event.senderFrame?.url ?? event.sender.getURL()
    const sender = {
      id: extId,
      url,
      origin: (() => {
        try {
          return new URL(url).origin
        } catch {
          return undefined
        }
      })(),
      frameId: event.senderFrame && event.senderFrame !== event.sender.mainFrame ? event.senderFrame.frameTreeNodeId : 0,
      tab: ctx.store.tabDetailsCache.get(event.sender.id),
    }
    return new Promise((resolve) => {
      let left = listening
      const finish = (value: unknown) => {
        clearTimeout(timer)
        this.replies.delete(replyId)
        resolve(value)
      }
      const timer = setTimeout(() => finish(undefined), REPLY_TIMEOUT_MS)
      this.replies.set(replyId, (reply) => {
        if (reply?.responded) finish(reply.response)
        else if (--left <= 0) finish(undefined)
      })
      ctx.router.sendEvent(extId, 'runtime.onUserScriptMessage', message, sender, replyId)
    })
  }
}

const withoutUndefined = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T

/** Isolated world numbers, one per extension and worldId; never shared, so worlds can't collide. */
const worldNumbers = new Map<string, number>()

/**
 * The number of an extension's user script world. They start well above every world jbrow uses
 * itself (Electron's 999, and 1077 and 1997–1999 in pip.ts, panel.ts, tabs.ts and restyle.ts).
 */
const FIRST_USER_SCRIPT_WORLD = 100_000

function worldNumber(extId: string, worldId = ''): number {
  const key = `${extId}|${worldId}`
  let n = worldNumbers.get(key)
  if (n === undefined) worldNumbers.set(key, (n = FIRST_USER_SCRIPT_WORLD + worldNumbers.size))
  return n
}

/** What the execute guard compares with: the origin, or just "file:" for local files. */
function originOf(url: string): string {
  try {
    const u = new URL(url)
    return u.protocol === 'file:' ? 'file:' : u.origin
  } catch {
    return ''
  }
}

// ---------- match patterns and globs ----------

const glob = (g: string) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, 's')

/** Chrome's match pattern syntax: `<all_urls>` or scheme://host/path, with `*` wildcards. */
function parsePattern(pattern: string): ((url: URL) => boolean) | null {
  if (pattern === '<all_urls>') return (u) => /^(https?|file|ftp|wss?):$/.test(u.protocol)
  const m = /^(\*|https?|file|ftp|wss?):\/\/([^/]*)(\/.*)$/.exec(pattern)
  if (!m) return null
  const [, scheme, hostPort, pathPattern] = m
  if (scheme !== 'file' && !hostPort) return null
  const hp = /^(\*|\*\.[^:*]+|[^:*]*)(?::(\d+|\*))?$/.exec(hostPort)
  if (!hp) return null
  const [, host, port] = hp
  const pathRe = glob(pathPattern)
  return (u) => {
    const s = u.protocol.slice(0, -1)
    if (scheme === '*' ? s !== 'http' && s !== 'https' : s !== scheme) return false
    if (scheme !== 'file') {
      const h = u.hostname.toLowerCase()
      const want = host.toLowerCase()
      if (want !== '*' && !(want.startsWith('*.') ? h === want.slice(2) || h.endsWith(want.slice(1)) : h === want)) return false
      if (port && port !== '*' && u.port !== port) return false
    }
    return pathRe.test(u.pathname + u.search)
  }
}

function anyPattern(patterns: string[] | undefined, url: URL): boolean {
  return (patterns ?? []).some((p) => parsePattern(p)?.(url))
}

function scriptMatches(s: UserScript, url: URL): boolean {
  const href = url.href.split('#')[0]
  const included = s.matches?.length ? anyPattern(s.matches, url) : true
  const globbed = !s.includeGlobs?.length || s.includeGlobs.some((g) => glob(g).test(href))
  return included && globbed && !anyPattern(s.excludeMatches, url) && !(s.excludeGlobs ?? []).some((g) => glob(g).test(href))
}

/** User scripts only run on sites the extension has host permissions for, as in Chrome. */
function hostAllowed(ext: Electron.Extension, url: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  const m = ext.manifest as { host_permissions?: string[] }
  return anyPattern([...(m.host_permissions ?? []), ...permissionsOf(ext).filter((p) => p === '<all_urls>' || p.includes('://'))], parsed)
}
