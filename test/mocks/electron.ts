// Stands in for Electron in unit tests (test/run.mjs aliases 'electron' to this file).
//
// Every export is a plain mutable object, so a test can replace what it needs:
//
//   import { app, net } from 'electron'
//   net.fetch = async () => new Response('...')
//
// Anything a test hasn't set is a no-op function that returns undefined, and so are its
// properties, so code that merely touches Electron at import time still loads.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const noop = () => undefined

/** An object whose unknown properties are no-op functions, so `x.anything()` works. */
function stub<T extends object>(base: T): T & Record<string, any> {
  return new Proxy(base as T & Record<string, any>, {
    get(target, key) {
      if (key in target || typeof key === 'symbol' || key === 'then') return (target as any)[key]
      return noop
    },
  })
}

/** A class whose instances are stubs; constructor arguments are kept in `options`. */
function stubClass(name: string) {
  const C = class {
    options: unknown[]
    constructor(...options: unknown[]) {
      this.options = options
      return stub(this)
    }
  }
  Object.defineProperty(C, 'name', { value: name })
  return C as unknown as new (...args: any[]) => any
}

/** A fresh directory standing in for app.getPath('userData') and friends. */
export const userData = mkdtempSync(path.join(tmpdir(), 'jbrow-unit-'))
const paths: Record<string, string> = {
  userData,
  logs: path.join(userData, 'logs'),
  downloads: path.join(userData, 'Downloads'),
  temp: tmpdir(),
  home: userData,
  appData: userData,
}
const switches = new Map<string, string>()
const listeners = new Map<string, ((...args: any[]) => void)[]>()

export const app = stub({
  getPath: (name: string) => paths[name] ?? userData,
  setPath: (name: string, value: string) => void (paths[name] = value),
  getName: () => 'jbrow',
  getVersion: () => '0.0.0-test',
  getAppPath: () => process.cwd(),
  isPackaged: false,
  isReady: () => true,
  whenReady: () => Promise.resolve(),
  requestSingleInstanceLock: () => true,
  userAgentFallback: 'Mozilla/5.0 (test) Chrome/140.0.0.0 Electron/44.0.0 jbrow/0.0.0',
  commandLine: stub({
    appendSwitch: (name: string, value = '') => void switches.set(name, value),
    hasSwitch: (name: string) => switches.has(name),
    getSwitchValue: (name: string) => switches.get(name) ?? '',
    removeSwitch: (name: string) => void switches.delete(name),
  }),
  on(event: string, fn: (...args: any[]) => void) {
    listeners.set(event, [...(listeners.get(event) ?? []), fn])
    return app
  },
  once(event: string, fn: (...args: any[]) => void) {
    return app.on(event, fn)
  },
  /** Test helper: runs the listeners registered with app.on(event). */
  emit(event: string, ...args: any[]) {
    for (const fn of listeners.get(event) ?? []) fn(...args)
  },
  dock: undefined as unknown,
})

export const net = stub({
  fetch: async (..._args: any[]): Promise<Response> => {
    throw new Error('net.fetch: no network in unit tests (replace net.fetch in the test)')
  },
  isOnline: () => true,
})

const ipcHandlers = new Map<string, (...args: any[]) => unknown>()
export const ipcMain = stub({
  on(channel: string, fn: (...args: any[]) => void) {
    ipcHandlers.set(channel, fn)
    return ipcMain
  },
  handle(channel: string, fn: (...args: any[]) => unknown) {
    ipcHandlers.set(channel, fn)
  },
  removeListener: noop,
  removeHandler: (channel: string) => void ipcHandlers.delete(channel),
  /** Test helper: the listener or handler registered for a channel. */
  handler: (channel: string) => ipcHandlers.get(channel),
})

export const clipboard = stub({
  text: '',
  writeText(text: string) {
    clipboard.text = text
  },
  readText: () => clipboard.text,
})
export const shell = stub({ openExternal: async () => {}, openPath: async () => '', showItemInFolder: noop, beep: noop })
export const dialog = stub({
  showMessageBox: async () => ({ response: 0, checkboxChecked: false }),
  showMessageBoxSync: () => 0,
  showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
  showSaveDialog: async () => ({ canceled: true }),
})
export const globalShortcut = stub({ register: () => true, unregister: noop, unregisterAll: noop, isRegistered: () => false })
export const nativeTheme = stub({ shouldUseDarkColors: false, themeSource: 'system' })
export const nativeImage = stub({
  createEmpty: () => stub({ isEmpty: () => true, toDataURL: () => '', resize: () => nativeImage.createEmpty() }),
  createFromPath: () => nativeImage.createEmpty(),
  createFromDataURL: () => nativeImage.createEmpty(),
  createFromBuffer: () => nativeImage.createEmpty(),
  createThumbnailFromPath: async () => nativeImage.createEmpty(),
})
const display = { id: 1, bounds: { x: 0, y: 0, width: 1440, height: 900 }, workArea: { x: 0, y: 25, width: 1440, height: 875 }, scaleFactor: 2 }
export const screen = stub({
  getPrimaryDisplay: () => display,
  getAllDisplays: () => [display],
  getDisplayMatching: () => display,
  getDisplayNearestPoint: () => display,
  getCursorScreenPoint: () => ({ x: 0, y: 0 }),
})
export const systemPreferences = stub({
  getAnimationSettings: () => ({ shouldRenderRichAnimation: true, scrollAnimationsEnabledBySystem: true, prefersReducedMotion: false }),
  getMediaAccessStatus: () => 'granted',
})
export const powerMonitor = stub({ getSystemIdleTime: () => 0, on: noop })
export const desktopCapturer = stub({ getSources: async () => [] })
export const session = stub({ fromPartition: () => stub({}), defaultSession: stub({}) })
export const webContents = stub({ getAllWebContents: () => [], fromId: () => undefined })
export const webFrameMain = stub({ fromId: () => undefined })
export const contextBridge = stub({ exposeInMainWorld: noop })
export const ipcRenderer = stub({ on: noop, send: noop, invoke: async () => undefined })
export const webFrame = stub({ executeJavaScript: async () => undefined })

export const BrowserWindow = Object.assign(stubClass('BrowserWindow'), { getAllWindows: () => [], getFocusedWindow: () => null, fromWebContents: () => null })
export const WebContentsView = stubClass('WebContentsView')
export const Tray = stubClass('Tray')
export const MenuItem = stubClass('MenuItem')
export const Notification = Object.assign(stubClass('Notification'), { isSupported: () => false })
export const Menu = Object.assign(stubClass('Menu'), {
  buildFromTemplate: (template: unknown[]) => stub({ template, popup: noop, items: template }),
  setApplicationMenu: noop,
})

export default {
  app, net, ipcMain, clipboard, shell, dialog, globalShortcut, nativeTheme, nativeImage, screen, systemPreferences, powerMonitor,
  desktopCapturer, session, webContents, webFrameMain, contextBridge, ipcRenderer, webFrame, BrowserWindow, WebContentsView, Tray,
  MenuItem, Notification, Menu,
}
