import { app, BrowserWindow, ipcMain, screen, type Rectangle } from 'electron'
import path from 'node:path'
import type { AnimMessage } from '../shared/types'
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
  onShown: () => void
  onHidden: () => void
}

/**
 * The summoned window. Pages are native views stacked on top of the UI, so CSS can't
 * animate them. During the show animation the page stays hidden and the UI animates a
 * snapshot of it in its place; the live page appears when the animation ends.
 */
export class Panel {
  readonly win: BrowserWindow
  visible = false
  pinned = false
  private animating = false
  private tween: NodeJS.Timeout | null = null
  private endFade: (() => void) | null = null
  /** Bumped by every show and hide, so an interrupted one knows to stop. */
  private run = 0
  private overlay = false
  private overlayRun = 0

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
      hasShadow: true,
      resizable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      webPreferences: {
        preload: path.join(__dirname, 'preload-ui.js'),
        sandbox: true,
        contextIsolation: true,
        // The show animation is timed by the page; a hidden page mustn't lag when it wakes.
        backgroundThrottling: false,
      },
    })
    this.win.setAlwaysOnTop(true, 'floating')
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    this.applyContentProtection()
    void this.win.loadFile(path.join(__dirname, 'ui', 'index.html'))
    this.win.on('resize', () => this.hooks.setPageVisible(this.pageVisible()))
    // A panel never activates jbrow on its own, so a pinned one does it when clicked.
    this.win.on('focus', () => this.pinned && app.focus({ steal: true }))
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

  /** Where the active page goes, in window coordinates. */
  contentBounds(): Rectangle {
    const [width, height] = this.win.getContentSize()
    return {
      x: SIDEBAR_WIDTH,
      y: TOOLBAR_HEIGHT,
      width: Math.max(0, width - SIDEBAR_WIDTH - GUTTER),
      height: Math.max(0, height - TOOLBAR_HEIGHT - GUTTER),
    }
  }

  pageVisible() {
    return this.visible && !this.animating && !this.overlay
  }

  /** JBROW_ALLOW_CAPTURE=1 lets you screenshot jbrow while developing. */
  applyContentProtection() {
    this.win.setContentProtection(this.settings().hideFromScreenCapture && !process.env.JBROW_ALLOW_CAPTURE)
  }

  /**
   * The UI asks for this while something of its own (suggestions, the extensions list, settings)
   * covers the page area. The native page would sit on top of it, so the page hides and a
   * snapshot of it stands in.
   */
  async setOverlay(on: boolean) {
    const run = ++this.overlayRun
    if (on && !this.overlay && this.pageVisible()) {
      const snap = await this.hooks.capture()
      if (run !== this.overlayRun || this.win.isDestroyed()) return
      if (snap) this.win.webContents.send('snapshot', snap)
    }
    this.overlay = on
    this.hooks.setPageVisible(this.pageVisible())
  }

  private placeOnPointerDisplay() {
    const { panel } = this.settings()
    const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    const width = Math.round(area.width * panel.widthFraction)
    const height = Math.round(area.height * panel.heightFraction)
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
      const listener = (e: Electron.IpcMainEvent) => e.sender === this.win.webContents && done()
      const timer = setTimeout(done, ms)
      ipcMain.on(channel, listener)
    })
  }

  private send(phase: AnimMessage['phase']): AnimMessage {
    const { style, durationMs, ease } = this.settings().animation
    const msg: AnimMessage = { phase, style, durationMs: phase === 'out' ? Math.round(durationMs * 0.7) : durationMs, ease }
    this.win.webContents.send('anim', msg)
    return msg
  }

  /** Fades the whole native window (glass included) alongside the UI's CSS animation. */
  private fade(from: number, to: number, ms: number): Promise<void> {
    // A new fade (hotkey pressed mid-animation) ends the previous one, so its caller moves on.
    this.endFade?.()
    return new Promise((resolve) => {
      if (this.win.isDestroyed()) return resolve()
      if (ms <= 0) {
        this.win.setOpacity(to)
        return resolve()
      }
      const start = performance.now()
      this.win.setOpacity(from)
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
        const eased = to > from ? 1 - Math.pow(1 - t, 3) : t * t
        this.win.setOpacity(from + (to - from) * eased)
        if (t >= 1) end()
      }, 1000 / 120)
    })
  }

  async show() {
    if (this.win.isDestroyed()) return
    if (this.visible && !this.animating) {
      this.win.focus()
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
    this.win.setOpacity(ms ? 0 : 1)
    this.win.show()
    this.win.focus()
    if (ms) await started
    if (run !== this.run || this.win.isDestroyed()) return
    await Promise.all([this.fade(0, 1, ms), ended])
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
    this.overlay = false
    this.overlayRun++
    // Capture while the page is still on screen, without making hiding wait for it.
    void this.hooks.capture().then((snap) => {
      if (snap && !this.win.isDestroyed()) this.win.webContents.send('snapshot', snap)
    })
    const msg = this.send('out')
    await this.fade(1, 0, msg.style === 'off' ? 0 : msg.durationMs)
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
