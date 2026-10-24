import { BrowserWindow, ipcMain, type WebContents } from 'electron'
import { execFile } from 'node:child_process'

/** macOS settings change rarely; read them again at most this often. */
const PREFS_MS = 15 * 1000

interface SwipePrefs {
  /** "Swipe between pages" with two fingers (on by default, also on for "two or three"). */
  twoFinger: boolean
  natural: boolean
}

/**
 * After a swipe navigates, the trackpad's momentum keeps scrolling for a moment, into the page
 * that just loaded. That's still the old swipe, so the new page doesn't get to start one yet.
 */
const COOLDOWN_MS = 800
const swipedAt = new WeakMap<WebContents, number>()

let prefs: SwipePrefs = { twoFinger: true, natural: true }
let readAt = 0

/** A global boolean default, or `fallback` when it was never written (macOS's own default). */
function readBool(key: string, fallback: boolean): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('/usr/bin/defaults', ['read', '-g', key], { timeout: 1000 }, (error, stdout) => {
      resolve(error ? fallback : stdout.trim() !== '0')
    })
  })
}

async function swipePrefs(): Promise<SwipePrefs> {
  if (Date.now() - readAt > PREFS_MS) {
    readAt = Date.now()
    const [twoFinger, natural] = await Promise.all([
      readBool('AppleEnableSwipeNavigateWithScrolls', true),
      readBool('com.apple.swipescrolldirection', true),
    ])
    prefs = { twoFinger, natural }
  }
  return prefs
}

/**
 * Back and forward from the trackpad. Two-finger swipes are tracked in the page by
 * src/preload/swipe.ts, which asks here whether it may and says when to go. Three-finger swipes
 * (macOS set to "Swipe with three fingers", or "two or three") come as the window's 'swipe' event,
 * which Electron names after AppKit's deltaX: 'left' is Chrome's back.
 */
export function wireSwipes(win: BrowserWindow, tab: (wc: WebContents) => WebContents | null, active: () => WebContents | null) {
  void swipePrefs()
  ipcMain.handle('page:swipe-allowed', async (e) => {
    const wc = e.senderFrame === e.sender.mainFrame ? tab(e.sender) : null
    if (!wc || Date.now() - (swipedAt.get(wc) ?? 0) < COOLDOWN_MS) return null
    const { twoFinger, natural } = await swipePrefs()
    if (!twoFinger) return null
    return { back: wc.navigationHistory.canGoBack(), forward: wc.navigationHistory.canGoForward(), natural }
  })
  ipcMain.on('page:swipe-go', (e, dir: unknown) => {
    const wc = e.senderFrame === e.sender.mainFrame ? tab(e.sender) : null
    if (!wc) return
    swipedAt.set(wc, Date.now())
    go(wc, dir)
  })
  win.on('swipe', (_e, direction) => {
    const wc = active()
    if (wc) go(wc, direction === 'left' ? 'back' : direction === 'right' ? 'forward' : null)
  })
}

function go(wc: WebContents, dir: unknown) {
  if (dir === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
  else if (dir === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
}
