import { execFile } from 'node:child_process'
import { systemPreferences } from 'electron'
import { windowContext, type WindowContext, type WindowInfo } from '../shared/contexts'
import type { FrontApp } from './frontmost'

/**
 * Prints the title and document of an app's focused window as JSON, through the Accessibility
 * API. Takes about 60 ms. Without Accessibility access macOS answers with nothing.
 */
const READ = `ObjC.import('ApplicationServices')
function run([pid]) {
  const cf = (s) => $.CFStringCreateWithCString(null, s, 0x08000100)
  const get = (el, name) => {
    const r = Ref()
    return $.AXUIElementCopyAttributeValue(el, cf(name), r) === 0 ? ObjC.castRefToObject(r[0]) : null
  }
  const str = (v) => (v && v.isKindOfClass($.NSString) ? ObjC.unwrap(v) : v && v.isKindOfClass($.NSURL) ? ObjC.unwrap(v.absoluteString) : '')
  const win = get($.AXUIElementCreateApplication(Number(pid)), 'AXFocusedWindow')
  return JSON.stringify(win ? { title: str(get(win, 'AXTitle')), document: str(get(win, 'AXDocument')) } : null)
}`

function readWindow(pid: number): Promise<WindowInfo | null> {
  return new Promise((resolve) => {
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', READ, String(pid)], { timeout: 1000 }, (error, stdout) => {
      if (error) {
        console.error('[context] osascript failed:', error)
        return resolve(null)
      }
      try {
        resolve(JSON.parse(stdout))
      } catch {
        resolve(null)
      }
    })
  })
}

/**
 * What you were working on in `app`: its focused window's conversation, thread or project. Null
 * without Accessibility access, off macOS, or when the window has nothing to group tabs by.
 */
export async function contextOf(app: FrontApp): Promise<WindowContext | null> {
  if (process.platform !== 'darwin' || !systemPreferences.isTrustedAccessibilityClient(false)) return null
  const w = await readWindow(app.pid)
  const context = w?.title !== undefined ? windowContext(app.bundleId, app.name, w) : null
  if (process.env.JBROW_DEBUG) console.log('[context]', app.bundleId, JSON.stringify(w?.title), '→', context?.key.split('\u001f').slice(1).join(' / ') ?? 'none')
  return context
}
