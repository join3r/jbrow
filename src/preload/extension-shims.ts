import { contextBridge, ipcRenderer } from 'electron'

type Invoke = (extensionId: string, name: string, args: unknown[]) => Promise<unknown>
type Listen = (extensionId: string, name: string, listener: (...args: unknown[]) => void) => void

/**
 * Fills gaps in Electron's extension APIs. Runs in every extension service worker and
 * chrome-extension:// page, before electron-chrome-extensions adds its own APIs.
 *
 * `invoke` and `listen` reach APIs jbrow implements in the main process, over
 * electron-chrome-extensions' own channels.
 */
function shims(
  skip: string[] = [],
  installed: { reason: string; previousVersion?: string } | null = null,
  invoke?: Invoke,
  listen?: Listen,
) {
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

  // Static declarativeNetRequest rulesets that the manifest turns on stay off: Chrome indexes them
  // at install, Electron's loader doesn't, and Chromium skips a ruleset it has no index for.
  // Enabling them through the API indexes them (and Chromium remembers it), which is how uBlock
  // Origin Lite's rulesets work. Only once per version, as Chrome resets them on update, and only
  // while none are on, so a ruleset the extension turned off stays off.
  const dnr = chrome.declarativeNetRequest
  if (!skip.includes('rulesets') && typeof g.ServiceWorkerGlobalScope === 'function' && dnr?.updateEnabledRulesets && chrome.storage?.local) {
    const manifest = runtime?.getManifest?.() ?? {}
    const resources: { id: string; enabled?: boolean }[] = manifest.declarative_net_request?.rule_resources ?? []
    const defaults = resources.filter((r) => r.enabled).map((r) => r.id)
    const key = 'jbrow.enabledRulesets'
    if (defaults.length) {
      void (async () => {
        if ((await chrome.storage.local.get(key))[key] === manifest.version) return
        if (!(await dnr.getEnabledRulesets()).length) await dnr.updateEnabledRulesets({ enableRulesetIds: defaults })
        await chrome.storage.local.set({ [key]: manifest.version })
      })().catch((error) => console.warn('[jbrow] could not enable static rulesets:', error))
    }
  }

  // Bitwarden installed before jbrow fired onInstalled (below) never ran its install step, which
  // turns on the icon in login fields. Its setting was never written, and unwritten means off.
  // Write what the install step writes, once per profile. A setting the user chose, off included,
  // is stored and left alone.
  if (!skip.includes('bitwarden') && runtime?.id === 'nngceckbapebfimnlniiiahkandclblb' && typeof g.document === 'undefined') {
    const setting = 'global_autofillSettingsLocal_inlineMenuVisibility'
    const done = 'jbrow.inlineMenuVisibility'
    void (async () => {
      const stored = await chrome.storage.local.get([setting, done])
      if (stored[done]) return
      if (!(setting in stored)) await chrome.storage.local.set({ [setting]: { __json__: true, value: '2' } })
      await chrome.storage.local.set({ [done]: true })
    })().catch((error) => console.warn('[jbrow] could not turn on Bitwarden field icons:', error))
  }

  const event = () => {
    const listeners = new Set<(...args: any[]) => void>()
    return {
      addListener: (fn: (...args: any[]) => void) => void listeners.add(fn),
      removeListener: (fn: (...args: any[]) => void) => void listeners.delete(fn),
      hasListener: (fn: (...args: any[]) => void) => listeners.has(fn),
      hasListeners: () => listeners.size > 0,
      dispatch: (...args: any[]) => listeners.forEach((fn) => fn(...args)),
      forEach: (fn: (listener: (...args: any[]) => any) => void) => listeners.forEach(fn),
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
    // A timer longer than this fires at once, so a far alarm waits in steps.
    const LONGEST = 2 ** 31 - 1
    const schedule = (alarm: Alarm) => {
      const wait = Math.max(0, alarm.scheduledTime - Date.now())
      const timer = setTimeout(() => {
        if (wait > LONGEST) return schedule(alarm)
        if (alarm.periodInMinutes) {
          schedule({ ...alarm, scheduledTime: Date.now() + alarm.periodInMinutes * 60_000 })
        } else alarms.delete(alarm.name)
        onAlarm.dispatch({ ...alarm })
      }, Math.min(wait, LONGEST))
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

  // ---------- APIs jbrow implements in the main process ----------

  const id: string | undefined = runtime?.id
  if (!invoke || !listen || !id) return
  const manifest = runtime.getManifest?.() ?? {}
  const permitted = (name: string) => ((manifest.permissions ?? []) as string[]).includes(name)
  // Errors come back as "Error invoking remote method 'crx-msg': Error: <message>".
  const call = (name: string, args: unknown[]) =>
    invoke(id, name, args).catch((error: Error) => {
      throw new Error(String(error?.message ?? error).replace(/^.*?Error: /, ''))
    })
  /** An API function that takes an optional trailing callback, like Chrome's. */
  const api = (name: string) => (...args: unknown[]) => {
    const cb = typeof args[args.length - 1] === 'function' ? (args.pop() as (v?: unknown) => void) : undefined
    const result = call(name, args)
    if (!cb) return result
    result.then(cb, (error) => {
      console.error(`chrome.${name}:`, error.message)
      cb()
    })
  }
  /** An event the main process sends. It subscribes on the first listener. */
  const remoteEvent = (name: string, deliver?: (listeners: ReturnType<typeof event>, ...args: any[]) => void) => {
    const ev = event()
    let subscribed = false
    return {
      addListener(fn: (...args: any[]) => void) {
        if (!subscribed) {
          subscribed = true
          listen(id, name, (...args) => (deliver ? deliver(ev, ...args) : ev.dispatch(...args)))
        }
        ev.addListener(fn)
      },
      removeListener: ev.removeListener,
      hasListener: ev.hasListener,
      hasListeners: ev.hasListeners,
      /** For telling which listeners to call; see onUserScriptMessage. */
      listeners: ev,
    }
  }
  const define = (target: object, key: string, value: unknown) => {
    try {
      Object.defineProperty(target, key, { value, configurable: true, enumerable: true, writable: true })
    } catch {}
  }

  // chrome.idle (src/main/idle.ts). Electron 44 also exposes Chromium's own, whose queryState
  // works. jbrow's replaces it so every state comes from one powerMonitor reading, and
  // onStateChanged goes through the library's router, which wakes a stopped service worker.
  if (!skip.includes('idle') && permitted('idle')) {
    define(chrome, 'idle', {
      IdleState: { ACTIVE: 'active', IDLE: 'idle', LOCKED: 'locked' },
      queryState: api('idle.queryState'),
      setDetectionInterval: (seconds: number) => void call('idle.setDetectionInterval', [seconds]).catch(() => {}),
      onStateChanged: remoteEvent('idle.onStateChanged'),
    })
  }

  // chrome.storage.onChanged in service workers (src/main/storage-events.ts). Electron never fires
  // it there, so Bitwarden's worker never heard that it was unlocked. Each context reports what
  // its writes changed, read just before the write: storage handles calls in order, so the read
  // sees what the write replaces. Workers get the changes back from the main process; pages
  // already get Chromium's own event.
  const storage = chrome.storage
  if (!skip.includes('storageEvents') && permitted('storage') && storage) {
    const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)
    const copy = (value: unknown) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)))
    const watch = (areaName: string, area: any) => {
      const get = area.get?.bind(area)
      if (!get) return
      const report = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>) => {
        if (Object.keys(changes).length) void call('storage.changed', [changes, areaName]).catch(() => {})
      }
      /** Wraps a write: `changesOf` gets the values it replaced, and the write's own arguments. */
      const wrap = (method: string, keysOf: (arg: any) => string[] | null, changesOf: (old: Record<string, unknown>, arg: any) => Record<string, object>) => {
        const original = area[method]
        if (typeof original !== 'function') return
        define(area, method, (...args: any[]) => {
          const cb = typeof args[args.length - 1] === 'function' ? args.pop() : undefined
          const before: Promise<Record<string, unknown>> = get(keysOf(args[0])).catch(() => ({}))
          const write = (done: (error?: { message?: string }) => void) =>
            original.call(area, ...args, () => {
              const error = chrome.runtime.lastError
              if (!error) void before.then((old) => report(changesOf(old, args[0])))
              done(error)
            })
          // A callback runs while lastError is set, as it would without the wrapper.
          if (cb) return void write(() => cb())
          return new Promise<void>((resolve, reject) => write((error) => (error ? reject(new Error(error.message)) : resolve())))
        })
      }
      const list = (keys: unknown) => (keys == null ? [] : Array.isArray(keys) ? keys : [keys]) as string[]
      wrap('set', (items) => Object.keys(items ?? {}), (old, items) => {
        const changes: Record<string, object> = {}
        for (const [key, value] of Object.entries(items ?? {})) {
          if (value === undefined || (key in old && same(old[key], value))) continue
          changes[key] = key in old ? { oldValue: old[key], newValue: copy(value) } : { newValue: copy(value) }
        }
        return changes
      })
      const removed = (old: Record<string, unknown>) => Object.fromEntries(Object.entries(old).map(([key, value]) => [key, { oldValue: value }]))
      wrap('remove', list, removed)
      wrap('clear', () => null, removed)
    }
    const areas = ['local', 'session'].filter((name) => storage[name])
    for (const name of areas) watch(name, storage[name])

    if (typeof g.ServiceWorkerGlobalScope === 'function') {
      // chrome.storage.onChanged gets (changes, area); each area's own onChanged gets changes.
      const all = event()
      const perArea = new Map(areas.map((name) => [name, event()]))
      const remote = remoteEvent('storage.onChanged')
      let subscribed = false
      const expose = (ev: ReturnType<typeof event>) => ({
        addListener(fn: (...args: any[]) => void) {
          if (!subscribed) {
            subscribed = true
            remote.addListener((changes: object, area: string) => {
              all.dispatch(changes, area)
              perArea.get(area)?.dispatch(changes)
            })
          }
          ev.addListener(fn)
        },
        removeListener: ev.removeListener,
        hasListener: ev.hasListener,
        hasListeners: ev.hasListeners,
      })
      define(storage, 'onChanged', expose(all))
      for (const [name, ev] of perArea) define(storage[name], 'onChanged', expose(ev))
    }
  }

  // chrome.sidePanel (src/main/side-panel.ts).
  if (!skip.includes('sidePanel') && permitted('sidePanel') && !chrome.sidePanel) {
    define(chrome, 'sidePanel', {
      setOptions: api('sidePanel.setOptions'),
      getOptions: api('sidePanel.getOptions'),
      setPanelBehavior: api('sidePanel.setPanelBehavior'),
      getPanelBehavior: api('sidePanel.getPanelBehavior'),
      open: api('sidePanel.open'),
      close: api('sidePanel.close'),
      onOpened: remoteEvent('sidePanel.onOpened'),
      onClosed: remoteEvent('sidePanel.onClosed'),
    })
  }

  // chrome.debugger (src/main/debugger.ts), tab targets only. Stem drives tabs through it, and
  // without it the worker's first `chrome.debugger.onEvent` threw, so it never started.
  if (!skip.includes('debugger') && permitted('debugger') && !chrome.debugger) {
    define(chrome, 'debugger', {
      attach: api('debugger.attach'),
      detach: api('debugger.detach'),
      sendCommand: api('debugger.sendCommand'),
      onEvent: remoteEvent('debugger.onEvent'),
      onDetach: remoteEvent('debugger.onDetach'),
    })
  }

  // chrome.userScripts (src/main/user-scripts.ts), and runtime.onUserScriptMessage for messages
  // from user scripts in a world configured with `messaging: true`. Every context that listens
  // answers: with the first response, or with nothing if no listener there responds.
  if (!skip.includes('userScripts') && permitted('userScripts') && !chrome.userScripts) {
    define(chrome, 'userScripts', {
      ExecutionWorld: { MAIN: 'MAIN', USER_SCRIPT: 'USER_SCRIPT' },
      register: api('userScripts.register'),
      update: api('userScripts.update'),
      unregister: api('userScripts.unregister'),
      getScripts: api('userScripts.getScripts'),
      configureWorld: api('userScripts.configureWorld'),
      getWorldConfigurations: api('userScripts.getWorldConfigurations'),
      resetWorldConfiguration: api('userScripts.resetWorldConfiguration'),
      execute: api('userScripts.execute'),
    })
    const deliver = (ev: ReturnType<typeof event>, message: unknown, sender: unknown, replyId: string) => {
      let replied = false
      let waiting = false
      const respond = (response?: unknown) => {
        if (replied) return
        replied = true
        void call('userScripts.reply', [replyId, { responded: true, response }]).catch(() => {})
      }
      ev.forEach((fn) => {
        try {
          const result = fn(message, sender, respond)
          if (result === true) waiting = true
          else if (result && typeof result.then === 'function') {
            waiting = true
            result.then(respond, () => respond())
          }
        } catch (error) {
          console.error(error)
        }
      })
      if (!waiting && !replied) {
        replied = true
        void call('userScripts.reply', [replyId, {}]).catch(() => {})
      }
    }
    const onUserScriptMessage = remoteEvent('runtime.onUserScriptMessage', deliver)
    define(runtime, 'onUserScriptMessage', {
      addListener: onUserScriptMessage.addListener,
      removeListener: onUserScriptMessage.removeListener,
      hasListener: onUserScriptMessage.hasListener,
      hasListeners: onUserScriptMessage.hasListeners,
    })
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
    const invoke: Invoke = (extensionId, name, args) => ipcRenderer.invoke('crx-msg', extensionId, name, ...args)
    // The router sends `crx-<event>` to every context that asked for it with crx-add-listener.
    const listen: Listen = (extensionId, name, listener) => {
      ipcRenderer.on(`crx-${name}`, (_event, ...args) => listener(...args))
      ipcRenderer.send('crx-add-listener', extensionId, name)
    }
    contextBridge.executeInMainWorld({ func: shims, args: [skip, installed, invoke, listen] })
  } catch (error) {
    console.error('[jbrow] extension shims failed:', error)
  }
}
