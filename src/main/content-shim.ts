import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Session } from 'electron'

/**
 * Content scripts get Chromium's own chrome.storage, which in Electron has no `sync` area:
 * Video Speed Controller's settings load fails with '"sync" is not available in this instance of
 * Chrome' and it never attaches to videos. Preload scripts can't reach content script worlds, so
 * jbrow writes a shim into the extension's folder and lists it first in each content script that
 * runs in the extension's isolated world. Like the service worker shim, sync is local storage.
 */
const SHIM_FILE = 'jbrow-content-shim.js'
const SHIM = `// Added by jbrow: Electron has no chrome.storage.sync, so it points at local storage.
// Nor managed storage, which with no administrator is empty.
(() => {
  try {
    const storage = globalThis.chrome && chrome.storage
    if (!storage || !storage.local) return
    const define = (area, value) => Object.defineProperty(storage, area, { value, configurable: true, enumerable: true, writable: true })
    define('sync', storage.local)
    const reply = (value, cb) => (typeof cb === 'function' ? void cb(value) : Promise.resolve(value))
    const readOnly = () => Promise.reject(new Error('This is a read-only store.'))
    define('managed', {
      get: (keys, cb) => reply({}, typeof keys === 'function' ? keys : cb),
      getKeys: (cb) => reply([], cb),
      getBytesInUse: (keys, cb) => reply(0, typeof keys === 'function' ? keys : cb),
      set: readOnly,
      remove: readOnly,
      clear: readOnly,
      onChanged: { addListener() {}, removeListener() {}, hasListener: () => false, hasListeners: () => false },
    })
  } catch {}
})()
`

interface ContentScript {
  js?: string[]
  world?: string
}

/** Adds the shim to an extension folder. Safe to run again; returns false if it changed nothing. */
export function addContentShim(dir: string): boolean {
  const manifestPath = path.join(dir, 'manifest.json')
  if (!existsSync(manifestPath)) return false
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, '')) as { content_scripts?: ContentScript[] }
    // MAIN-world scripts run as the page and have no chrome.storage.
    const scripts = (manifest.content_scripts ?? []).filter((c) => c.js?.length && c.world !== 'MAIN')
    const missing = scripts.filter((c) => c.js![0] !== SHIM_FILE)
    const shimPath = path.join(dir, SHIM_FILE)
    if (!scripts.length) return false
    if (!existsSync(shimPath) || readFileSync(shimPath, 'utf8') !== SHIM) writeFileSync(shimPath, SHIM)
    if (!missing.length) return false
    for (const c of missing) c.js = [SHIM_FILE, ...c.js!.filter((f) => f !== SHIM_FILE)]
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
    return true
  } catch (error) {
    console.error(`[extensions] could not add the content script shim to ${dir}:`, error)
    return false
  }
}

/**
 * Shims every extension the session loads from `extensionsPath` (Web Store installs and their
 * updates) before it loads. Unpacked folders elsewhere are yours, so they're left as they are.
 */
export function shimContentScripts(sess: Session, extensionsPath: string) {
  const exts = sess.extensions
  const load = exts.loadExtension.bind(exts)
  exts.loadExtension = (dir: string, options?: Electron.LoadExtensionOptions) => {
    const inside = path.relative(extensionsPath, dir)
    if (inside && !inside.startsWith('..') && !path.isAbsolute(inside)) addContentShim(dir)
    return load(dir, options)
  }
}
