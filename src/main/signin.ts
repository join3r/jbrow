import { BrowserWindow, ipcMain, screen, WebContentsView, type AuthInfo, type Rectangle, type WebContents } from 'electron'
import path from 'node:path'
import { BACKGROUND } from './background'
import type { Logins } from './logins'

type Answer = (username?: string, password?: string) => void

/** The sheet's form needs this much room; a smaller window grows while it's asked. */
const MIN = { width: 340, height: 350 }

interface Sheet {
  /** The page that was asked. */
  page: WebContents
  /** jbrow's sign-in form. */
  ui: WebContents
  ready: boolean
  /** In the page's own window, on top of the page. */
  overlay?: { view: WebContentsView; host: BrowserWindow; fit: () => void; minSize: number[]; grown?: Rectangle; before?: Rectangle }
  /** A window of its own, for a page without a window on screen. */
  win?: BrowserWindow
}

/**
 * HTTP auth for pages outside tabs: popup windows that pages open, extension popups, pop-out
 * windows and extension pages without a window. Tabs ask in the page area (logins.ts and the
 * UI); these ask in a sheet over the page, in the page's own window, so an extension popup
 * keeps focus and stays open. A page with no window on screen gets a small window of its own.
 */
export class SignInSheets {
  private sheets = new Map<string, Sheet>()
  private pages = new Map<string, WebContents>()
  private watched = new WeakSet<WebContents>()
  /** The username last tried per page. Each answer takes the sheet down, so a wrong try brings it back with this. */
  private tried = new Map<string, string>()
  /** Pages whose window is still hidden: an extension popup shows once its page has a size. */
  private waiting = new Set<string>()

  constructor(private logins: Logins, private theme: () => string) {
    ipcMain.on('signin:answer', (event, data: { id: number; username?: string; password?: string }) => {
      for (const [owner, s] of this.sheets) {
        // Only the question the form showed: a newer one may have taken its place.
        if (s.ui !== event.sender || this.logins.view(owner)?.id !== data.id) continue
        if (data.username !== undefined) this.tried.set(owner, data.username)
        this.logins.answer(owner, data.username, data.password)
      }
    })
  }

  static owns(owner: string) {
    return owner.startsWith('wc:')
  }

  ask(page: WebContents, info: AuthInfo, callback: Answer) {
    const owner = `wc:${page.id}`
    this.pages.set(owner, page)
    if (!this.watched.has(page)) {
      this.watched.add(page)
      // As in tabs: going somewhere new cancels what was asked, and a page that loads means
      // the next question isn't about a wrong password.
      page.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) this.logins.clear(owner)
      })
      page.on('did-navigate', () => this.logins.loaded(owner))
      page.once('destroyed', () => {
        this.logins.clear(owner)
        this.pages.delete(owner)
        this.tried.delete(owner)
        this.update(owner)
      })
    }
    this.logins.ask(owner, info, callback)
  }

  /** Logins changed for a page outside tabs: show, refresh or take down its sheet. */
  update(owner: string, waited = false) {
    const view = this.logins.view(owner)
    const page = this.pages.get(owner)
    let s = this.sheets.get(owner)
    if (!view || !page || page.isDestroyed()) {
      if (s) this.remove(owner, s)
      return
    }
    if (!s) {
      if (this.waiting.has(owner)) return
      // An extension popup is hidden until its page is laid out, and a script that signs in
      // right away is asked before that. A window of its own would take the popup's focus and
      // close it, so wait a moment for the popup to show.
      const host = BrowserWindow.fromWebContents(page)
      if (host && !host.isDestroyed() && !host.isVisible() && !waited) {
        this.waiting.add(owner)
        const go = () => {
          clearTimeout(timer)
          if (!host.isDestroyed()) host.off('show', go)
          this.waiting.delete(owner)
          this.update(owner, true)
        }
        const timer = setTimeout(go, 1000)
        host.once('show', go)
        return
      }
      s = this.open(owner, page)
    }
    if (s.ready) this.send(owner, s)
  }

  private open(owner: string, page: WebContents): Sheet {
    const webPreferences = { preload: path.join(__dirname, 'preload-signin.js'), sandbox: true, contextIsolation: true }
    const host = BrowserWindow.fromWebContents(page)
    let s: Sheet
    if (host && !host.isDestroyed() && host.isVisible()) {
      const view = new WebContentsView({ webPreferences })
      view.setBackgroundColor('#00000000')
      const minSize = host.getMinimumSize()
      const fit = () => {
        const [width, height] = host.getContentSize()
        view.setBounds({ x: 0, y: 0, width, height })
      }
      s = { page, ui: view.webContents, ready: false, overlay: { view, host, fit, minSize } }
      // An extension popup is sized to its page, often too small for the form. It hangs off its
      // button by the right edge, so it grows to the left and down.
      const before = host.getBounds()
      host.setMinimumSize(Math.max(minSize[0], MIN.width), Math.max(minSize[1], MIN.height))
      const [cw, ch] = host.getContentSize()
      if (cw < MIN.width || ch < MIN.height) {
        const width = before.width + Math.max(0, MIN.width - cw)
        const grown = { x: before.x + before.width - width, y: before.y, width, height: before.height + Math.max(0, MIN.height - ch) }
        host.setBounds(grown)
        s.overlay!.before = before
        s.overlay!.grown = host.getBounds()
      }
      fit()
      host.on('resize', fit)
      host.contentView.addChildView(view)
    } else {
      // No window to ask in, or a hidden one: a small window of its own, closed means cancelled.
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
      const win = new BrowserWindow({
        width: 360,
        height: MIN.height,
        useContentSize: true,
        x: Math.round(area.x + (area.width - 360) / 2),
        y: Math.round(area.y + area.height / 3 - MIN.height / 2),
        show: false,
        title: 'Sign in',
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        // macOS keeps a titled window's title bar on screen; JBROW_BACKGROUND keeps it off.
        frame: !BACKGROUND,
        enableLargerThanScreen: BACKGROUND,
        webPreferences,
      })
      win.on('closed', () => {
        if (this.sheets.get(owner)?.win === win) {
          this.sheets.delete(owner)
          this.logins.clear(owner)
        }
      })
      s = { page, ui: win.webContents, ready: false, win }
    }
    this.sheets.set(owner, s)
    // A file or link dropped on the form would otherwise replace it, keeping the sheet's preload.
    s.ui.on('will-navigate', (e) => e.preventDefault())
    s.ui.once('did-finish-load', () => {
      s.ready = true
      this.send(owner, s)
      if (s.win && BACKGROUND) {
        s.win.showInactive()
        // As with the panel: macOS pulls a window on screen as it orders it in, so push it out after.
        s.win.setPosition(Math.max(...screen.getAllDisplays().map((d) => d.bounds.x + d.bounds.width)) + 1000, 0)
      } else s.win?.show()
      s.ui.focus()
    })
    const dir = __dirname.replace(/\.asar(?=[\\/]|$)/, '.asar.unpacked')
    void s.ui.loadFile(path.join(dir, 'ui', 'signin.html'), { query: { theme: this.theme() } })
    return s
  }

  private send(owner: string, s: Sheet) {
    const view = this.logins.view(owner)
    if (view) s.ui.send('signin:view', { ...view, username: view.retry ? this.tried.get(owner) : undefined })
  }

  private remove(owner: string, s: Sheet) {
    this.sheets.delete(owner)
    const o = s.overlay
    if (o && !o.host.isDestroyed()) {
      o.host.off('resize', o.fit)
      o.host.contentView.removeChildView(o.view)
      o.host.setMinimumSize(o.minSize[0], o.minSize[1])
      // Back to the size it had, unless something else resized it meanwhile.
      const now = o.host.getBounds()
      if (o.before && o.grown && now.width === o.grown.width && now.height === o.grown.height) o.host.setBounds(o.before)
    }
    if (s.win && !s.win.isDestroyed()) s.win.destroy()
    if (!s.ui.isDestroyed()) s.ui.close()
    // The page gets the keyboard back.
    if (o && !s.page.isDestroyed()) s.page.focus()
  }
}
