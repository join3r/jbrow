import { contextBridge, ipcRenderer, webFrame } from 'electron'
import type { UserScriptInjection } from '../shared/types'

/**
 * Runs extensions' user scripts (chrome.userScripts) in a page. Preloads run in a page's top frame
 * before any of its own scripts, so this asks the main process for the page's scripts
 * (src/main/user-scripts.ts) and runs each at its runAt time: in its extension's USER_SCRIPT
 * world, an isolated world the page can't see, or in the page's MAIN world.
 */
function start() {
  if (!/^(https?|file):$/.test(location.protocol) || window !== window.top) return
  const injections = ipcRenderer.sendSync('jbrow:user-scripts') as UserScriptInjection[]
  if (!injections?.length) return

  const prepared = new Set<number>()
  /** Sets up a USER_SCRIPT world on first use. Returns sources to run before the world's first script. */
  const prepare = (i: UserScriptInjection): { code: string }[] => {
    if (prepared.has(i.worldId)) return []
    prepared.add(i.worldId)
    // A CSP needs an origin to go with it; the page's own keeps fetch and XHR working as before.
    webFrame.setIsolatedWorldInfo(i.worldId, { name: i.worldName, ...(i.csp ? { securityOrigin: location.origin, csp: i.csp } : {}) })
    if (!i.messaging) return []
    const sendMessage = (...args: unknown[]) => {
      const cb = typeof args[args.length - 1] === 'function' ? (args.pop() as (r: unknown) => void) : undefined
      const reply = ipcRenderer.invoke('jbrow:user-script-message', i.extensionId, args[0])
      if (!cb) return reply
      void reply.then(cb, () => cb(undefined))
    }
    // Chromium already puts a `chrome` object in every world, which contextBridge won't replace,
    // so the API goes in under another name and joins `chrome` from inside the world.
    contextBridge.exposeInIsolatedWorld(i.worldId, RUNTIME_KEY, { id: i.extensionId, sendMessage })
    return [{
      code: `(() => {
        const c = globalThis.chrome ?? (globalThis.chrome = {})
        Object.defineProperty(c, 'runtime', { value: globalThis.${RUNTIME_KEY}, configurable: true, enumerable: true })
      })()`,
    }]
  }

  const run = (i: UserScriptInjection) => {
    try {
      if (i.world === 'MAIN') {
        for (const s of i.js) void webFrame.executeJavaScript(s.url ? `${s.code}\n//# sourceURL=${s.url}` : s.code).catch(report)
        return
      }
      void webFrame.executeJavaScriptInIsolatedWorld(i.worldId, [...prepare(i), ...i.js]).catch(report)
    } catch (error) {
      report(error)
    }
  }
  const at = (runAt: UserScriptInjection['runAt']) => injections.filter((i) => i.runAt === runAt).forEach(run)

  // Preloads run before the document has its root element, which Chrome's document_start
  // scripts can count on. The observer fires as soon as the parser adds it, before any page script.
  if (document.documentElement) at('document_start')
  else {
    const observer = new MutationObserver(() => {
      if (!document.documentElement) return
      observer.disconnect()
      at('document_start')
    })
    observer.observe(document, { childList: true })
  }
  const ready = () => {
    at('document_end')
    // document_idle: once the page has loaded, or shortly after DOMContentLoaded if that takes a while.
    let done = false
    const idle = () => {
      if (done) return
      done = true
      at('document_idle')
    }
    if (document.readyState === 'complete') return idle()
    window.addEventListener('load', idle, { once: true })
    setTimeout(idle, 200)
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true })
  else ready()
}

const RUNTIME_KEY = '__jbrowUserScriptRuntime'

const report = (error: unknown) => console.error('[jbrow] user script failed:', error)

try {
  start()
} catch (error) {
  report(error)
}
