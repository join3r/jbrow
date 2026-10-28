import type { WebContents } from 'electron'
import path from 'node:path'
import { libraryOf } from './library'
import type { ProfileRuntime } from './profiles'

interface Target {
  tabId?: number
}

interface Attached {
  profile: string
  extensionId: string
  wc: WebContents
  off: () => void
}

/**
 * chrome.debugger for tabs, on each page's own `webContents.debugger`. Electron has no debugger
 * API for extensions; Stem drives tabs through it. One extension at a time per tab, as in Chrome.
 * Events and detaches go through the library's router, which wakes a stopped service worker. The
 * extension side is in src/preload/extension-shims.ts.
 */
export class ExtensionDebugger {
  /** By tab (WebContents) ID. */
  private attached = new Map<number, Attached>()

  /** `onChange` hears when an extension attaches to a tab or lets go of one. */
  constructor(private onChange: () => void) {}

  /** The extension working in this page, if one is attached to it. */
  holder(wc: WebContents): string | undefined {
    for (const a of this.attached.values()) if (a.wc === wc) return a.extensionId
    return undefined
  }

  /** Adds chrome.debugger to a profile; see setupProfiles. */
  attach(rt: ProfileRuntime) {
    const lib = libraryOf(rt)
    const handle = lib.router.apiHandler()
    const opts = { permission: 'debugger' }
    const profile = rt.profile.id
    // Attaching is what loads a tab without a page: the extension is about to work in it.
    const tabOf = (target: Target = {}, wake = false) => {
      if (target.tabId === undefined) throw new Error('Only tab targets are supported.')
      const wc = wake ? lib.store.wakeTabById(target.tabId) : lib.store.getTabById(target.tabId)
      if (!wc || wc.isDestroyed()) throw new Error(`No tab with given id ${target.tabId}.`)
      return wc
    }
    const mine = (extensionId: string, target: Target = {}) => {
      const a = target.tabId === undefined ? undefined : this.attached.get(target.tabId)
      if (!a || a.extensionId !== extensionId || a.profile !== profile) {
        throw new Error(`Debugger is not attached to the tab with id: ${target.tabId}.`)
      }
      return a
    }

    handle(
      'debugger.attach',
      ({ extension }, target: Target, version?: string) => {
        const wc = tabOf(target, true)
        const tabId = target.tabId!
        // An extension that went away lets go of its tabs, as in Chrome.
        const held = this.attached.get(tabId)
        if (held && !rt.session.extensions.getExtension(held.extensionId)) {
          this.forget(tabId)
          if (wc.debugger.isAttached()) wc.debugger.detach()
        }
        if (this.attached.has(tabId) || wc.debugger.isAttached()) {
          throw new Error(`Another debugger is already attached to the tab with id: ${tabId}.`)
        }
        if (!mayDebugPage(wc, extension.id)) throw new Error(`Cannot access contents of url "${wc.getURL()}".`)
        wc.debugger.attach(version)
        const onMessage = (_e: Electron.Event, method: string, params: unknown, sessionId?: string) =>
          lib.router.sendEvent(extension.id, 'debugger.onEvent', sessionId ? { tabId, sessionId } : { tabId }, method, params)
        const onDetach = (_e: Electron.Event, reason: string) => {
          this.forget(tabId)
          lib.router.sendEvent(extension.id, 'debugger.onDetach', { tabId }, chromeReason(reason))
        }
        const onGone = () => {
          if (!this.attached.has(tabId)) return
          this.forget(tabId)
          lib.router.sendEvent(extension.id, 'debugger.onDetach', { tabId }, 'target_closed')
        }
        // A tab that goes somewhere an extension may not debug (jbrow's own pages, another
        // extension's, a file) lets the debugger go first, as in Chrome.
        const leave = () => {
          onGone()
          if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach()
        }
        const onNavigate = (details: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
          if (details.isMainFrame && !mayDebug(details.url, extension.id)) leave()
        }
        // A redirect goes somewhere else than the navigation said; what committed is checked last.
        const onNavigated = () => {
          if (!wc.isDestroyed() && !mayDebugPage(wc, extension.id)) leave()
        }
        wc.debugger.on('message', onMessage)
        wc.debugger.on('detach', onDetach)
        wc.once('destroyed', onGone)
        wc.on('did-start-navigation', onNavigate)
        wc.on('did-redirect-navigation', onNavigate)
        wc.on('did-navigate', onNavigated)
        this.attached.set(tabId, {
          profile,
          extensionId: extension.id,
          wc,
          off: () => {
            wc.debugger.off('message', onMessage)
            wc.debugger.off('detach', onDetach)
            wc.off('destroyed', onGone)
            if (wc.isDestroyed()) return
            wc.off('did-start-navigation', onNavigate)
            wc.off('did-redirect-navigation', onNavigate)
            wc.off('did-navigate', onNavigated)
          },
        })
        this.onChange()
      },
      opts,
    )

    handle(
      'debugger.detach',
      ({ extension }, target: Target) => {
        const a = mine(extension.id, target)
        this.forget(target.tabId!)
        if (!a.wc.isDestroyed() && a.wc.debugger.isAttached()) a.wc.debugger.detach()
      },
      opts,
    )

    // Chrome's errors are the protocol's own, as JSON ({"code":-32000,"message":"..."}).
    handle(
      'debugger.sendCommand',
      async ({ extension }, target: Target, method: string, params?: object) => {
        const a = mine(extension.id, target)
        refuseCommand(method, params, extension.id, hasFileAccess(rt, extension))
        // Navigation events can be missed (a redirect, a renderer swap); the tab's address is checked too.
        if (!a.wc.isDestroyed() && !mayDebugPage(a.wc, extension.id)) {
          this.forget(target.tabId!)
          if (a.wc.debugger.isAttached()) a.wc.debugger.detach()
          lib.router.sendEvent(extension.id, 'debugger.onDetach', { tabId: target.tabId }, 'target_closed')
          throw new Error(`Cannot access contents of url "${a.wc.getURL()}".`)
        }
        try {
          const result = a.wc.debugger.sendCommand(method, params ?? {})
          if (method === 'Page.captureScreenshot') keepDrawing(a.wc, result)
          return (await result) ?? {}
        } catch (error) {
          throw new Error(JSON.stringify({ code: -32000, message: (error as Error)?.message ?? String(error) }))
        }
      },
      opts,
    )
  }

  /** A deleted profile's tabs are closed by then; this drops what's left. */
  forgetProfile(profile: string) {
    for (const [tabId, a] of this.attached) if (a.profile === profile) this.forget(tabId)
  }

  private forget(tabId: number) {
    const a = this.attached.get(tabId)
    if (!a) return
    a.off()
    this.attached.delete(tabId)
    this.onChange()
  }
}

/**
 * Where an extension's debugger may go: web pages and the extension's own pages, as in Chrome.
 * Not jbrow's own pages, other extensions', files, or devtools. A blob: is judged by the page it
 * belongs to.
 */
function mayDebug(url: string, extensionId: string) {
  if (!url || url === 'about:blank') return true
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  // The URL inside says whose it is (URL's own origin is "null" for any but a web one).
  if (parsed.protocol === 'blob:') return /^https?:/.test(parsed.pathname) || parsed.pathname.startsWith(`chrome-extension://${extensionId}/`)
  if (parsed.protocol === 'data:' || parsed.protocol === 'http:' || parsed.protocol === 'https:') return true
  return parsed.protocol === 'chrome-extension:' && parsed.host === extensionId
}

function mayDebugOrigin(origin: string, extensionId: string) {
  return origin === 'null' || /^https?:\/\//.test(origin) || origin === `chrome-extension://${extensionId}`
}

/** A page as it is now: its address, and for about:blank the origin it inherited. */
function mayDebugPage(wc: WebContents, extensionId: string) {
  const url = wc.getURL()
  if (!mayDebug(url, extensionId)) return false
  const origin = wc.mainFrame?.origin
  return !url.startsWith('about:') || !origin || mayDebugOrigin(origin, extensionId)
}

/** jbrow lets unpacked extensions (yours) read files, as Chrome's "Allow access to file URLs". */
function hasFileAccess(rt: ProfileRuntime, ext: Electron.Extension) {
  return path.relative(rt.extensionsPath, ext.path).startsWith('..')
}

/**
 * webContents.debugger is a full DevTools session, which can reach the browser, other targets,
 * other origins' storage and the whole cookie jar. Chrome holds an extension's to its own tab, so
 * only domains that act on the page are let through, less the methods that reach past it. Picking
 * files for an upload, and loading a resource the page couldn't, need file access, as in Chrome.
 */
const PAGE_DOMAINS = new Set([
  'Accessibility',
  'Animation',
  'Audits',
  'CSS',
  'Console',
  'DOM',
  'DOMDebugger',
  'DOMSnapshot',
  'Debugger',
  'Emulation',
  'Fetch',
  'Input',
  'Inspector',
  'LayerTree',
  'Log',
  'Network',
  'Overlay',
  'Page',
  'Performance',
  'Profiler',
  'Runtime',
  'Schema',
])
const OUT_OF_PAGE = new Set([
  'Page.setDownloadBehavior',
  'Network.getAllCookies',
  'Network.setCookie',
  'Network.setCookies',
  'Network.deleteCookies',
  'Network.clearBrowserCookies',
  'Network.clearBrowserCache',
])
const FILE_ACCESS = new Set(['DOM.setFileInputFiles', 'Network.loadNetworkResource'])

function refuseCommand(method: string, params: unknown, extensionId: string, fileAccess: boolean) {
  const deny = () => {
    throw new Error(JSON.stringify({ code: -32000, message: `${method} is not allowed for extensions.` }))
  }
  const p = (params ?? {}) as { url?: unknown; urls?: unknown }
  if (!PAGE_DOMAINS.has(method.split('.')[0]) && method !== 'Browser.getVersion') deny()
  if (OUT_OF_PAGE.has(method)) deny()
  if (FILE_ACCESS.has(method) && !fileAccess) deny()
  // Without `urls` it's the page's own cookies.
  if (method === 'Network.getCookies' && p.urls !== undefined) deny()
  if (method === 'Page.navigate' && !mayDebug(String(p.url ?? ''), extensionId)) deny()
}

/**
 * A hidden page draws nothing, so CDP's screenshot waits for a frame that never comes: a
 * background tab, or any tab while jbrow is hidden. Chrome counts the debugger as a capturer and
 * keeps such a tab drawing. Electron 44 has no capturer count to hold, but capturePage keeps the
 * page drawing while hidden for as long as it runs, so this captures every 100 ms until `until`
 * settles. A tab must have a size for it (see ensureView in tabs.ts).
 */
function keepDrawing(wc: WebContents, until: Promise<unknown>) {
  let done = false
  void until.finally(() => (done = true)).catch(() => {})
  const again = () => {
    if (done || wc.isDestroyed()) return
    const next = () => void setTimeout(again, 100)
    wc.capturePage(undefined, { stayHidden: true, stayAwake: true }).then(next, next)
  }
  again()
}

/** Electron passes Chromium's own words ("target closed", "Render process gone."); Chrome's API has two reasons. */
function chromeReason(reason: string) {
  return /cancel/i.test(reason) ? 'canceled_by_user' : 'target_closed'
}
