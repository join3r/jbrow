import { app, BrowserWindow, ipcMain, screen, WebContentsView, type Rectangle, type WebContents } from 'electron'
import path from 'node:path'
import { bezier, EASE } from '../shared/ease'
import type { AnimMessage } from '../shared/types'
import { BACKGROUND } from './background'
import type { Settings } from './settings'

const debug = (...args: unknown[]) => process.env.JBROW_DEBUG && console.log('[panel]', ...args)

/** Sidebar and toolbar sizes; must match src/ui/ui.css. */
export const SIDEBAR_WIDTH = 256
export const TOOLBAR_HEIGHT = 50
const GUTTER = 8

export interface PanelHooks {
  /** Show or hide the active page's native view. */
  setPageVisible: (visible: boolean) => void
  /** Grab a picture of the active page for the next show animation. */
  capture: () => Promise<{ dataUrl: string; tabId: string } | null>
  /** The panel starts to hide, with the page still on screen. */
  onHiding: () => void
  onShown: () => void
  onHidden: () => void
}

/** Past the right edge of every display, for a JBROW_BACKGROUND panel. */
function offScreen() {
  return { x: Math.max(...screen.getAllDisplays().map((d) => d.bounds.x + d.bounds.width)) + 1000, y: 0 }
}

/**
 * The summoned window. Pages are native views stacked on top of the UI, so CSS can't
 * animate them. During the show animation the page stays hidden and the UI animates a
 * snapshot of it in its place; the live page appears when the animation ends.
 */
export class Panel {
  readonly win: BrowserWindow
  /**
   * jbrow's own UI. It lives in a view of its own rather than in the window's page, which always
   * sits beneath every view, so it can move above the page while something of its covers it.
   */
  readonly ui: WebContents
  private uiView: WebContentsView
  visible = false
  pinned = false
  private animating = false
  private tween: NodeJS.Timeout | null = null
  private endFade: (() => void) | null = null
  /** Bumped by every show and hide, so an interrupted one knows to stop. */
  private run = 0
  private overlay = false
  /** A page is fullscreen (a video, usually): the window covers its display and the page all of it. */
  pageFullscreen = false
  /** Where the window was before the page went fullscreen. */
  private beforeFullscreen: Rectangle | null = null
  /** "<site> is full screen. Press Esc to exit." on top of a fullscreen page for its first seconds. */
  private notice: { view: WebContentsView; timer: NodeJS.Timeout } | null = null

  constructor(private settings: () => Settings, private hooks: PanelHooks) {
    this.win = new BrowserWindow({
      // 'panel' makes this a non-activating panel on macOS: it floats over full-screen
      // apps and takes keyboard focus without pulling the whole app forward.
      type: 'panel',
      show: false,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      vibrancy: 'under-window',
      visualEffectState: 'active',
      roundedCorners: true,
      hasShadow: !BACKGROUND,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      // macOS otherwise keeps the window off the menu bar and Dock, which a fullscreen page covers.
      enableLargerThanScreen: true,
      skipTaskbar: true,
      // The window's own page stays empty; the UI is in uiView.
      webPreferences: { sandbox: true, contextIsolation: true },
    })
    this.uiView = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, 'preload-ui.js'),
        sandbox: true,
        contextIsolation: true,
        // The show animation is timed by the page; a hidden page mustn't lag when it wakes.
        backgroundThrottling: false,
      },
    })
    this.uiView.setBackgroundColor('#00000000')
    this.ui = this.uiView.webContents
    this.win.contentView.addChildView(this.uiView)
    this.fitUi()
    this.win.setAlwaysOnTop(true, 'floating')
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    this.applyContentProtection()
    if (BACKGROUND) this.win.setIgnoreMouseEvents(true)
    // The installed app keeps the UI outside app.asar (asarUnpack in package.json): with the
    // grantFileProtocolExtraPrivileges fuse off, as in Chrome, file:// pages can't read inside it.
    void this.ui.loadFile(path.join(__dirname.replace(/\.asar(?=[\\/]|$)/, '.asar.unpacked'), 'ui', 'index.html'))
    this.win.on('resize', () => {
      this.fitUi()
      this.hooks.setPageVisible(this.pageVisible())
    })
    // A panel never activates jbrow on its own, so a pinned one does it when clicked.
    this.win.on('focus', () => this.pinned && !BACKGROUND && app.focus({ steal: true }))
  }

  /**
   * Pinned, jbrow acts like a regular app window: normal window level, one Space, a Dock icon,
   * and clicking it makes jbrow the frontmost app. Tools that work on the frontmost window,
   * like Stem's window peek, skip floating panels and apps without a Dock icon.
   */
  setPinned(on: boolean) {
    if (on === this.pinned || this.win.isDestroyed()) return
    this.pinned = on
    this.win.setAlwaysOnTop(!on, 'floating')
    this.win.setVisibleOnAllWorkspaces(!on, { visibleOnFullScreen: !on })
    if (BACKGROUND) return
    if (on) {
      void app.dock?.show().then(() => {
        if (this.visible && !this.win.isDestroyed()) app.focus({ steal: true })
      })
    } else {
      app.dock?.hide()
      // Leaving the Dock deactivates jbrow; keep the panel in front and focused.
      if (this.visible) this.win.focus()
    }
  }

  /**
   * A page's fullscreen fills the display jbrow is on, menu bar and Dock included, without moving
   * to a Space of its own, so jbrow can still hide on its hotkey or when you click away.
   */
  setPageFullscreen(on: boolean, site = '') {
    if (on === this.pageFullscreen || this.win.isDestroyed()) return
    this.pageFullscreen = on
    this.hideNotice()
    if (on) {
      this.beforeFullscreen = this.win.getBounds()
      const { bounds } = screen.getDisplayMatching(this.beforeFullscreen)
      this.win.setAlwaysOnTop(true, 'screen-saver')
      this.win.setBounds(BACKGROUND ? { ...offScreen(), width: bounds.width, height: bounds.height } : bounds)
      this.showNotice(site, bounds.width)
    } else {
      this.win.setAlwaysOnTop(!this.pinned, 'floating')
      if (this.beforeFullscreen) this.win.setBounds(this.beforeFullscreen)
      this.beforeFullscreen = null
    }
  }

  /**
   * A fullscreen page covers the menu bar and Dock, so it could draw fake system controls. As in
   * Chrome, a notice the page can't cover or dismiss says whose page it is and how to leave.
   */
  private showNotice(site: string, width: number) {
    const view = new WebContentsView({ webPreferences: { sandbox: true, contextIsolation: true, javascript: false } })
    view.setBackgroundColor('#00000000')
    const who = site ? `${site.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)} is` : 'This page is'
    const text = `${who} full screen. Press <b>Esc</b> to exit.`
    const html = `<!doctype html><meta charset="utf-8"><body style="margin:0;display:flex;justify-content:center;align-items:center;height:100vh;font:13px -apple-system,system-ui;background:transparent"><div style="background:rgba(30,30,30,.88);color:#fff;padding:10px 18px;border-radius:10px">${text}</div></body>`
    void view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    const w = Math.min(width, 520)
    view.setBounds({ x: Math.round((width - w) / 2), y: 24, width: w, height: 48 })
    this.win.contentView.addChildView(view)
    this.notice = { view, timer: setTimeout(() => this.hideNotice(), 4000) }
  }

  private hideNotice() {
    if (!this.notice) return
    clearTimeout(this.notice.timer)
    if (!this.win.isDestroyed()) this.win.contentView.removeChildView(this.notice.view)
    this.notice.view.webContents.close()
    this.notice = null
  }

  /** A page view was added on top; the fullscreen notice stays above it. */
  private raiseNotice() {
    if (this.notice) this.win.contentView.addChildView(this.notice.view)
  }

  /** Where the active page goes, in window coordinates. */
  contentBounds(): Rectangle {
    const [width, height] = this.win.getContentSize()
    if (this.pageFullscreen) return { x: 0, y: 0, width, height }
    return {
      x: SIDEBAR_WIDTH,
      y: TOOLBAR_HEIGHT,
      width: Math.max(0, width - SIDEBAR_WIDTH - GUTTER),
      height: Math.max(0, height - TOOLBAR_HEIGHT - GUTTER),
    }
  }

  pageVisible() {
    return this.visible && !this.animating
  }

  private fitUi() {
    const [width, height] = this.win.getContentSize()
    this.uiView.setBounds({ x: 0, y: 0, width, height })
  }

  /** JBROW_ALLOW_CAPTURE=1 lets you screenshot jbrow while developing. */
  applyContentProtection() {
    this.win.setContentProtection(this.settings().hideFromScreenCapture && !process.env.JBROW_ALLOW_CAPTURE)
  }

  /**
   * The UI asks for this while something of its own (suggestions, the extensions list, settings)
   * covers the page area. The UI moves above the page, which stays live beneath it: a video keeps
   * playing, and nothing waits on a screenshot. Re-adding a view only reorders it; focus stays.
   */
  setOverlay(on: boolean) {
    if (on === this.overlay || this.win.isDestroyed()) return
    this.overlay = on
    this.keepOrder()
  }

  /** Puts the UI back where it belongs after a page view was added, which lands on top. */
  keepOrder() {
    if (this.win.isDestroyed()) return
    if (this.overlay) this.win.contentView.addChildView(this.uiView)
    else this.win.contentView.addChildView(this.uiView, 0)
    this.raiseNotice()
  }

  private placeOnPointerDisplay() {
    const { panel } = this.settings()
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    const width = Math.round(area.width * panel.widthFraction)
    const height = Math.round(area.height * panel.heightFraction)
    if (BACKGROUND) return this.win.setBounds({ ...offScreen(), width, height })
    this.win.setBounds({
      x: Math.round(area.x + (area.width - width) / 2),
      y: Math.round(area.y + (area.height - height) / 2.4),
      width,
      height,
    })
  }

  /** Resolves when the UI reports `ui:<name>`, or after `ms` if it never does. */
  private fromUi(name: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const channel = `ui:${name}`
      const done = () => {
        clearTimeout(timer)
        ipcMain.removeListener(channel, listener)
        resolve()
      }
      const listener = (e: Electron.IpcMainEvent) => e.sender === this.ui && done()
      const timer = setTimeout(done, ms)
      ipcMain.on(channel, listener)
    })
  }

  private send(phase: AnimMessage['phase']): AnimMessage {
    const { style, durationMs, ease } = this.settings().animation
    const msg: AnimMessage = { phase, style, durationMs: phase === 'out' ? Math.round(durationMs * 0.7) : durationMs, ease }
    this.ui.send('anim', msg)
    return msg
  }

  /**
   * A JBROW_BACKGROUND panel stays invisible: macOS keeps a sliver of any window on screen, so
   * moving it away isn't enough.
   */
  private setOpacity(value: number) {
    this.win.setOpacity(BACKGROUND ? 0 : value)
  }

  /** Fades the whole native window (glass included) alongside the UI's CSS animation. */
  private fade(from: number, to: number, ms: number, curve: (t: number) => number): Promise<void> {
    // A new fade (hotkey pressed mid-animation) ends the previous one, so its caller moves on.
    this.endFade?.()
    return new Promise((resolve) => {
      if (this.win.isDestroyed()) return resolve()
      if (ms <= 0) {
        this.setOpacity(to)
        return resolve()
      }
      const start = performance.now()
      this.setOpacity(from)
      const end = () => {
        if (this.tween) clearInterval(this.tween)
        this.tween = null
        this.endFade = null
        resolve()
      }
      this.endFade = end
      this.tween = setInterval(() => {
        // The window goes away when jbrow quits mid-animation.
        if (this.win.isDestroyed()) return end()
        const t = Math.min(1, (performance.now() - start) / ms)
        this.setOpacity(from + (to - from) * Math.min(1, curve(t)))
        if (t >= 1) end()
      }, 1000 / 120)
    })
  }

  async show() {
    if (this.win.isDestroyed()) return
    if (this.visible && !this.animating) {
      if (!BACKGROUND) this.win.focus()
      return
    }
    debug('show')
    const run = ++this.run
    this.visible = true
    this.animating = true
    this.hooks.setPageVisible(false)
    this.placeOnPointerDisplay()
    // The UI starts its CSS animation on its first frame after showing and says so; the window
    // fade starts then too, and the live page waits until the UI says the animation has ended.
    const started = this.fromUi('anim-start', 150)
    const msg = this.send('in')
    const ms = msg.style === 'off' ? 0 : msg.durationMs
    const ended = this.fromUi('anim-end', ms + 400)
    this.setOpacity(ms ? 0 : 1)
    if (BACKGROUND) {
      this.win.showInactive()
      // macOS pulls a window back on screen as it orders it in, so push it out as far as it lets.
      this.win.setPosition(offScreen().x, offScreen().y)
    } else {
      this.win.show()
      this.win.focus()
    }
    if (ms) await started
    if (run !== this.run || this.win.isDestroyed()) return
    // The window turns opaque on the curve the content moves on, so it settles together with the
    // content instead of still fading in around content that has already arrived.
    const curve = msg.style === 'fade' ? (t: number) => 1 - (1 - t) ** 3 : (t: number) => bezier(EASE[msg.ease], t)
    await Promise.all([this.fade(0, 1, ms, curve), ended])
    debug('shown; focused =', this.win.isFocused(), 'visible =', this.win.isVisible(), 'window =', this.win.getMediaSourceId())
    if (run !== this.run || this.win.isDestroyed()) return
    this.animating = false
    this.hooks.setPageVisible(this.pageVisible())
    this.hooks.onShown()
  }

  async hide() {
    if (!this.visible || this.win.isDestroyed()) return
    debug('hide', new Error().stack?.split('\n')[2]?.trim())
    const run = ++this.run
    this.visible = false
    this.animating = true
    this.setOverlay(false)
    this.hooks.onHiding()
    // Capture while the page is still on screen, without making hiding wait for it.
    void this.hooks.capture().then((snap) => {
      if (snap && !this.win.isDestroyed()) this.ui.send('snapshot', snap)
    })
    const msg = this.send('out')
    await this.fade(1, 0, msg.style === 'off' ? 0 : msg.durationMs, (t) => t * t)
    if (run !== this.run || this.win.isDestroyed()) return
    this.win.hide()
    this.hooks.setPageVisible(false)
    this.hooks.onHidden()
    this.animating = false
  }

  toggle() {
    return this.visible ? this.hide() : this.show()
  }

  /**
   * Hide on click-away. Called whenever one of jbrow's windows loses focus. Focus moving
   * to another jbrow window (an extension popup, a sign-in popup, devtools) or to a
   * system sheet jbrow opened (file picker, permission dialog) doesn't count.
   */
  checkClickAway(isOwnModalFront: () => Promise<boolean>) {
    setTimeout(async () => {
      debug('blur check', { visible: this.visible, pinned: this.pinned, animating: this.animating, focused: !!BrowserWindow.getFocusedWindow() })
      if (this.win.isDestroyed() || !this.visible || this.pinned || this.animating) return
      if (BrowserWindow.getFocusedWindow()) return
      if (await isOwnModalFront()) return debug('blur ignored: jbrow is the frontmost app')
      if (!this.visible || BrowserWindow.getFocusedWindow()) return
      await this.hide()
    }, 90)
  }
}
