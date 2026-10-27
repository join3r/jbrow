import { libraryOf } from './library'
import type { ProfileRuntime } from './profiles'

/**
 * chrome.storage.onChanged for extension service workers. Electron never fires it there, for
 * changes made by the worker or by the extension's pages. Bitwarden learns that it was unlocked
 * through it: its toolbar icon and field menu stayed locked, while the popup (a page, which does
 * get the event) showed it unlocked, until the worker stopped and the next one read storage afresh.
 *
 * Every extension context reports the writes it makes (src/preload/extension-shims.ts), and
 * they're passed to the extension's worker, waking it if it's stopped. Pages aren't sent them:
 * they get Chromium's own event.
 */
export function attachStorageEvents(rt: ProfileRuntime) {
  const router = libraryOf(rt).router
  router.apiHandler()(
    'storage.changed',
    ({ type, sender, extension }, changes: Record<string, unknown>, area: string) => {
      // Only the extension's own pages and worker speak for its storage.
      const url = type === 'service-worker' ? (sender as Electron.ServiceWorkerMain).scope : (sender as Electron.WebContents).getURL()
      if (!url.startsWith(`chrome-extension://${extension.id}/`)) throw new Error('Not this extension.')
      if (area !== 'local' && area !== 'session') throw new Error(`Unknown storage area: ${area}`)
      if (!changes || typeof changes !== 'object') throw new Error('Changes must be an object.')
      router.sendEvent(extension.id, 'storage.onChanged', changes, area)
    },
    { permission: 'storage' },
  )
}
