import { contextBridge, ipcRenderer } from 'electron'

/**
 * Fills gaps in Electron's extension APIs. Runs in every extension service worker and
 * chrome-extension:// page, before electron-chrome-extensions adds its own APIs.
 */
function shims(skip: string[] = [], installed: { reason: string; previousVersion?: string } | null = null) {
  const g = globalThis as any
  const chrome = g.chrome
  if (!chrome) return


  // Chromium now defines a separate `browser` namespace. Extensions such as uBlock Origin
  // Lite prefer it over `chrome`, but only `chrome` gets the extra APIs, so point one at the other.
  if (!skip.includes('browser') && g.browser !== chrome) {
    try {
      Object.defineProperty(g, 'browser', { value: chrome, configurable: true, writable: true })
    } catch {}
  }

  // Electron has no sync storage, and electron-chrome-extensions' local fallback doesn't reach
  // service workers. Settings stay on this machine either way.
  // Nor is there a managed area, which holds an administrator's policy. It must not be local
  // storage: Bitwarden applies everything it finds there as policy ("applied 8 managed
  // setting(s)"), its own vault data included. With no administrator, it's empty, as in Chrome.
  try {
    const storage = skip.includes('storage') ? undefined : chrome.storage
    if (storage?.local) {
      const define = (area: string, value: unknown) =>
        Object.defineProperty(storage, area, { value, configurable: true, enumerable: true, writable: true })
      define('sync', storage.local)
      const reply = (value: unknown, cb?: unknown) => (typeof cb === 'function' ? void cb(value) : Promise.resolve(value))
      const readOnly = () => Promise.reject(new Error('This is a read-only store.'))
      define('managed', {
        get: (keys?: unknown, cb?: unknown) => reply({}, typeof keys === 'function' ? keys : cb),
        getKeys: (cb?: unknown) => reply([], cb),
        getBytesInUse: (keys?: unknown, cb?: unknown) => reply(0, typeof keys === 'function' ? keys : cb),
        set: readOnly,
        remove: readOnly,
        clear: readOnly,
        setAccessLevel: readOnly,
        onChanged: { addListener() {}, removeListener() {}, hasListener: () => false, hasListeners: () => false },
      })
    }
  } catch {}

  // chrome.runtime.getContexts leaves out extension pages in jbrow's windows (action popups,
  // pop-out windows, tabs): Electron doesn't give them a view type, so Chromium skips them with
  // "Unexpected view type found: 0". Bitwarden asks it whether its popup is open and focused, and
  // when nothing is, its vault timeout locks or logs out, even mid-login. This adds the missing
  // pages: from a service worker, every window client of the extension; from a page, itself.
  // A page with a jbrow tab is a TAB (as a pop-out window is in Chrome); one without is a POPUP.
  const runtime = chrome.runtime
  if (!skip.includes('contexts') && typeof runtime?.getContexts === 'function') {
    const original = runtime.getContexts.bind(runtime)
    const noHash = (url: string) => url.split('#')[0]
    const pages = async (): Promise<{ url: string }[]> => {
      if (g.clients?.matchAll) return g.clients.matchAll({ type: 'window', includeUncontrolled: true })
      return g.top === g ? [{ url: g.location.href }] : []
    }
    const getContexts = async (filter: Record<string, unknown[] | boolean | undefined> = {}) => {
      const contexts: any[] = await original({})
      const known = new Set(contexts.map((c) => c.documentUrl && noHash(c.documentUrl)))
      const tabs: { id: number; windowId: number; url?: string }[] = await chrome.tabs?.query({}).catch(() => []) ?? []
      for (const page of await pages()) {
        if (known.has(noHash(page.url))) continue
        known.add(noHash(page.url))
        const tab = tabs.find((t) => t.url && noHash(t.url) === noHash(page.url))
        contexts.push({
          contextId: `jbrow-${tab?.id ?? noHash(page.url)}`,
          contextType: tab ? 'TAB' : 'POPUP',
          documentOrigin: new URL(page.url).origin,
          documentUrl: page.url,
          frameId: 0,
          incognito: false,
          tabId: tab?.id ?? -1,
          windowId: tab?.windowId ?? -1,
        })
      }
      const keys: Record<string, string> = {
        contextTypes: 'contextType',
        contextIds: 'contextId',
        documentUrls: 'documentUrl',
        documentOrigins: 'documentOrigin',
        documentIds: 'documentId',
        tabIds: 'tabId',
        windowIds: 'windowId',
        frameIds: 'frameId',
      }
      return contexts.filter(
        (c) =>
          Object.entries(keys).every(([key, field]) => {
            const allowed = filter[key]
            return !Array.isArray(allowed) || allowed.includes(c[field])
          }) &&
          (filter.incognito === undefined || c.incognito === filter.incognito),
      )
    }
    try {
      Object.defineProperty(runtime, 'getContexts', {
        value: (filter?: object, cb?: (contexts: unknown[]) => void) => {
          const result = getContexts(filter as Record<string, unknown[]>)
          return cb ? void result.then(cb) : result
        },
        configurable: true,
        enumerable: true,
        writable: true,
      })
    } catch {}
  }

  const event = () => {
    const listeners = new Set<(...args: any[]) => void>()
    return {
      addListener: (fn: (...args: any[]) => void) => void listeners.add(fn),
      removeListener: (fn: (...args: any[]) => void) => void listeners.delete(fn),
      hasListener: (fn: (...args: any[]) => void) => listeners.has(fn),
      hasListeners: () => listeners.size > 0,
      dispatch: (...args: any[]) => listeners.forEach((fn) => fn(...args)),
    }
  }

  // Electron never fires chrome.runtime.onInstalled, and Bitwarden only turns on its inline menu
  // (the icon in login fields) when it's installed. jbrow's main process says whether this
  // worker's extension was just installed or updated (see src/main/installed.ts), and the event
  // fires once the worker's script has run, as in Chrome. Bitwarden reads it 100ms later.
  if (installed && runtime) {
    const listeners = new Set<(d: object) => void>()
    let fired = false
    const fire = (fn: (d: object) => void) => {
      try {
        fn({ ...installed })
      } catch (error) {
        console.error(error)
      }
    }
    setTimeout(() => {
      fired = true
      listeners.forEach(fire)
    })
    try {
      Object.defineProperty(runtime, 'onInstalled', {
        value: {
          // A listener added later still gets it, while this worker lives.
          addListener: (fn: (d: object) => void) => {
            listeners.add(fn)
            if (fired) setTimeout(() => fire(fn))
          },
          removeListener: (fn: (d: object) => void) => void listeners.delete(fn),
          hasListener: (fn: (d: object) => void) => listeners.has(fn),
          hasListeners: () => listeners.size > 0,
        },
        configurable: true,
        enumerable: true,
        writable: true,
      })
    } catch {}
  }

  // chrome.alarms, on timers. Background scripts are kept alive in Electron, so timers
  // survive; alarms don't persist across restarts, which extensions recreate on startup anyway.
  if (!skip.includes('alarms') && !chrome.alarms) {
    interface Alarm {
      name: string
      scheduledTime: number
      periodInMinutes?: number
    }
    const alarms = new Map<string, { alarm: Alarm; timer: ReturnType<typeof setTimeout> }>()
    const onAlarm = event()
    const clear = (name = '') => {
      const entry = alarms.get(name)
      if (entry) clearTimeout(entry.timer)
      return alarms.delete(name)
    }
    const schedule = (alarm: Alarm) => {
      const timer = setTimeout(() => {
        if (alarm.periodInMinutes) {
          schedule({ ...alarm, scheduledTime: Date.now() + alarm.periodInMinutes * 60_000 })
        } else alarms.delete(alarm.name)
        onAlarm.dispatch({ ...alarm })
      }, Math.max(0, alarm.scheduledTime - Date.now()))
      alarms.set(alarm.name, { alarm, timer })
    }
    // Callers may pass a callback or use the promise.
    const done = <T>(value: T, cb?: (v: T) => void) => (cb ? void cb(value) : Promise.resolve(value))
    chrome.alarms = {
      create(nameOrInfo?: string | object, maybeInfo?: object, cb?: () => void) {
        const name = typeof nameOrInfo === 'string' ? nameOrInfo : ''
        const info = (typeof nameOrInfo === 'string' ? maybeInfo : nameOrInfo) as
          | { when?: number; delayInMinutes?: number; periodInMinutes?: number }
          | undefined
        clear(name)
        const delay = info?.delayInMinutes ?? info?.periodInMinutes ?? 0
        schedule({ name, scheduledTime: info?.when ?? Date.now() + delay * 60_000, periodInMinutes: info?.periodInMinutes })
        return done(undefined, cb)
      },
      get(nameOrCb?: string | ((a?: Alarm) => void), cb?: (a?: Alarm) => void) {
        const name = typeof nameOrCb === 'string' ? nameOrCb : ''
        return done(alarms.get(name)?.alarm, typeof nameOrCb === 'function' ? nameOrCb : cb)
      },
      getAll: (cb?: (a: Alarm[]) => void) => done([...alarms.values()].map((e) => e.alarm), cb),
      clear(nameOrCb?: string | ((ok: boolean) => void), cb?: (ok: boolean) => void) {
        const name = typeof nameOrCb === 'string' ? nameOrCb : ''
        return done(clear(name), typeof nameOrCb === 'function' ? nameOrCb : cb)
      },
      clearAll(cb?: (ok: boolean) => void) {
        const had = alarms.size > 0
        for (const name of [...alarms.keys()]) clear(name)
        return done(had, cb)
      },
      onAlarm: { addListener: onAlarm.addListener, removeListener: onAlarm.removeListener, hasListener: onAlarm.hasListener, hasListeners: onAlarm.hasListeners },
    }
  }
}

const isExtensionContext =
  (process as { type?: string }).type === 'service-worker' || globalThis.location?.href.startsWith('chrome-extension://')

if (isExtensionContext) {
  try {
    const skip = (process.env.JBROW_SHIM_SKIP ?? '').split(',').filter(Boolean)
    // Asked before the worker's own script runs. Pages don't need it.
    const installed =
      (process as { type?: string }).type === 'service-worker' && !skip.includes('installed')
        ? ipcRenderer.sendSync('jbrow-installed')
        : null
    contextBridge.executeInMainWorld({ func: shims, args: [skip, installed] })
  } catch (error) {
    console.error('[jbrow] extension shims failed:', error)
  }
}
