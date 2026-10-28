import type { ServiceWorkerMain, WebContents } from 'electron'
import type { ProfileRuntime } from './profiles'

/**
 * The parts of electron-chrome-extensions' private context jbrow reaches into: its message router,
 * for extension APIs jbrow implements itself (chrome.commands, idle, sidePanel, userScripts), and
 * its tab store.
 */
export interface LibraryContext {
  router: {
    sendEvent(extensionId: string, eventName: string, ...args: unknown[]): void
    broadcastEvent(eventName: string, ...args: unknown[]): void
    /** Registers `name` for chrome.* calls; `permission` must be in the calling extension's manifest. */
    apiHandler(): (name: string, callback: (event: ApiEvent, ...args: any[]) => unknown, opts?: { permission?: string }) => void
    /** Event name → the extension contexts listening for it. */
    listeners: Map<string, { extensionId: string }[]>
  }
  store: {
    tabDetailsCache: Map<number, unknown>
    getTabById(id: number): WebContents | undefined
    /** getTabById, and a tab without a page gets one (scripts/patch-deps.mjs). */
    wakeTabById(id: number): WebContents | undefined
  }
}

/** Who called an API: an extension page (frame) or service worker. */
export interface ApiEvent {
  type: 'frame' | 'service-worker'
  sender: WebContents | ServiceWorkerMain
  extension: Electron.Extension
}

export const libraryOf = (rt: ProfileRuntime) => (rt.extensions as unknown as { ctx: LibraryContext }).ctx

/** Permissions an extension's manifest asks for. */
export const permissionsOf = (ext: Electron.Extension): string[] => (ext.manifest as { permissions?: string[] }).permissions ?? []
