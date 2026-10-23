import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Session } from 'electron'

/**
 * Electron never fires chrome.runtime.onInstalled. Extensions miss their first-run setup:
 * Bitwarden leaves its inline menu (the icon in login fields) off and never shows its welcome
 * page. Each extension service worker asks here as it starts (src/preload/extension-shims.ts),
 * and the shim fires the event with the answer:
 *
 * - "install" for an extension jbrow hasn't seen whose storage is still empty,
 * - "update" when its version changed since jbrow last saw it,
 * - nothing otherwise. An extension already in use before jbrow kept track has stored data,
 *   so it isn't treated as new.
 *
 * Versions seen are kept per profile, next to the profile's own data.
 */
export function trackInstalls(sess: Session) {
  const dir = sess.getStoragePath()
  if (!dir) return
  const file = path.join(dir, 'jbrow-extension-versions.json')
  let seen: Record<string, string> = {}
  try {
    seen = JSON.parse(readFileSync(file, 'utf8'))
  } catch {}

  const answer = (scope: string | undefined) => {
    const match = scope?.match(/^chrome-extension:\/\/([a-p]{32})\//)
    const ext = match && sess.extensions.getExtension(match[1])
    if (!ext) return null
    const previous = seen[ext.id]
    if (previous === ext.version) return null
    seen[ext.id] = ext.version
    writeFileSync(file, JSON.stringify(seen, null, 2))
    if (previous) return { reason: 'update', previousVersion: previous }
    return existsSync(path.join(dir, 'Local Extension Settings', ext.id)) ? null : { reason: 'install' }
  }

  // Every worker, websites' too, asks (the preload can't tell them apart), and each must get
  // an answer or it hangs. A worker that restarts is the same object, already listened to.
  const listening = new WeakSet<Electron.ServiceWorkerMain>()
  sess.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
    if (runningStatus !== 'starting') return
    const worker = sess.serviceWorkers.getWorkerFromVersionID(versionId)
    if (!worker || listening.has(worker)) return
    listening.add(worker)
    worker.ipc.on('jbrow-installed', (event) => {
      let details = null
      try {
        details = answer(worker.scope)
        if (details) console.log(`[extensions] ${worker.scope}: onInstalled`, details)
      } catch (error) {
        console.error('[extensions] onInstalled:', error)
      }
      event.returnValue = details
    })
  })
}
