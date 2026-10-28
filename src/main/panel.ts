import { app, BrowserWindow, ipcMain, screen, systemPreferences, WebContentsView, type Display, type Rectangle, type WebContents } from 'electron'
import path from 'node:path'
import { bezier, cssEase, EASE } from '../shared/ease'
import type { AnimMessage } from '../shared/types'
import { BACKGROUND } from './background'
import type { AnimationStyle, Settings } from './settings'

const debug = (...args: unknown[]) => process.env.JBROW_DEBUG && console.log('[panel]', ...args)

/** Sidebar and toolbar sizes; must match src/ui/ui.css. */
export const SIDEBAR_WIDTH = 256
export const GUTTER = 8
/** Each page's address bar, the top of its card. */
export const BAR_HEIGHT = 40
/** Where pages start: below the gap at the top of the window and their address bars. */
export const TOOLBAR_HEIGHT = GUTTER + BAR_HEIGHT
/** The extension side panel: the gap you drag to resize it, and its header above its page. */
export const SIDE_GAP = 8
export const SIDE_HEADER = 32
/** The smallest you can drag the window to: the sidebar and a usable page. */
const MIN_SIZE = [SIDEBAR_WIDTH + 360, TOOLBAR_HEIGHT + 300] as const

/**
 * Where each style's show animation starts, relative to where the window ends up: the window's
 * size (it grows around content that already has its final size, so the page never lays itself
 * out again), how far below (negative: above) its place it sits, and how blurred everything is.
 */
const START: Record<AnimationStyle, { scale: number; dy: number; blur: number }> = {
  materialize: { scale: 0.975, dy: 6, blur: 8 },
  slide: { scale: 1, dy: -28, blur: 0 },
  scale: { scale: 0.92, dy: 0, blur: 0 },
  fade: { scale: 1, dy: 0, blur: 0 },
  off: { scale: 1, dy: 0, blur: 0 },
}
/** Hiding speeds up as it goes, like CSS's ease-in. */
const EASE_IN: [number, number, number, number] = [0.4, 0, 1, 1]

export interface PanelHooks {
  /** Show or hide the active page's native view. */
  setPageVisible: (visible: boolean) => void
  /**
   * The pages on screen: the active tab's, and the rest of its split. The show animation waits for
   * their first frames, and materialize blurs them.
   */
  pages: () => WebContents[]
  /** You moved or resized the window, or reset it: settings.panel changed and needs saving. */
  onPlaced: () => void
  /** The panel starts to hide, with the page still on screen. */
  onHiding: () => void
  onShown: () => void
  onHidden: () => void
  /** Width of the extension side panel next to the page; 0 when there is none. */
  sideWidth: () => number
}

/** Past the right edge of every display, for a JBROW_BACKGROUND panel. */
function offScreen() {
  return { x: Math.max(...screen.getAllDisplays().map((d) => d.bounds.x + d.bounds.width)) + 1000, y: 0 }
}

/** Keeps `rect` inside `area`, shrinking it if it's bigger. */
function fit(rect: Rectangle, area: Rectangle): Rectangle {
  const width = Math.round(Math.min(rect.width, area.width))
  const height = Math.round(Math.min(rect.height, area.height))
  return {
    x: Math.round(Math.min(Math.max(rect.x, area.x), area.x + area.width - width)),
    y: Math.round(Math.min(Math.max(rect.y, area.y), area.y + area.height - height)),
    width,
    height,
  }
}

const same = (a: Rectangle, b: Rectangle) => a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height

/**
 * The summoned window. Pages are native views stacked on top of the UI, so CSS can't animate
 * them. Showing and hiding move, size and fade the whole native window instead, with the live
 * page in it: a playing video keeps playing, and no picture of the page can go stale. Only
 * materialize's blur is CSS, on the UI and on the page.
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
  private endTween: (() => void) | null = null
  /** Bumped by every show and hide, so an interrupted one knows to stop. */
  private run = 0
  private overlay = false
  /** Where the window is, or is going while it animates. */
  private target: Rectangle = { x: 0, y: 0, width: 0, height: 0 }
  /** The display it was placed on. A JBROW_BACKGROUND window sits off every display. */
  private display: Display | null = null
  /**
   * Where the content sits in the window while it animates. It keeps the size it ends at, so a
   * growing window uncovers it rather than squeezing it.
   */
  private box: Rectangle | null = null
  /** How far the window has moved (0 where the animation starts, 1 in place) and how opaque it is. */
  private progress = 0
  private alpha = 0
  /** Moves jbrow makes itself, which aren't yours to remember. */
  private placing = 0
  private saveTimer: NodeJS.Timeout | null = null
  /** The stylesheets that blur the pages for materialize. */
  private pageBlur: { wc: WebContents; key: Promise<string | null> }[] = []
  /** The pages kept awake while the window comes in, and whether each was throttled in the background before. */
  private woken: { wc: WebContents; throttled: boolean }[] = []
  private sleepTimer: NodeJS.Timeout | null = null
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
      minWidth: MIN_SIZE[0],
      minHeight: MIN_SIZE[1],
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
        // Asleep while the window is hidden, as it starts out; see wakeUi.
      },
    })
    this.uiView.setBackgroundColor('#00000000')
    this.ui = this.uiView.webContents
    // The UI holds the privileged bridge: a link or file dropped on it must never replace it.
    this.ui.on('will-navigate', (e) => e.preventDefault())
    this.ui.setWindowOpenHandler(() => ({ action: 'deny' }))
    this.win.contentView.addChildView(this.uiView)
    this.wakeUi(false)
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
      this.remember()
    })
    this.win.on('move', () => this.remember())
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
    // A move you just made still counts for the mode you made it in.
    this.flush()
    this.pinned = on
    // The window stays where it is, and comes back there in its new mode too.
    if (this.visible && !this.animating && !this.pageFullscreen) this.savePlace()
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
      this.setFrame(BACKGROUND ? { ...offScreen(), width: bounds.width, height: bounds.height } : bounds)
      this.showNotice(site, bounds.width)
    } else {
      this.win.setAlwaysOnTop(!this.pinned, 'floating')
      if (this.beforeFullscreen) this.setFrame(this.beforeFullscreen)
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
    const { x, y, width, height } = this.contentBox()
    if (this.pageFullscreen) return { x, y, width, height }
    const side = this.hooks.sideWidth()
    return {
      x: x + SIDEBAR_WIDTH,
      y: y + TOOLBAR_HEIGHT,
      width: Math.max(0, width - SIDEBAR_WIDTH - GUTTER - (side ? side + SIDE_GAP : 0)),
      height: Math.max(0, height - TOOLBAR_HEIGHT - GUTTER),
    }
  }

  /** Where the extension side panel's page goes, under its header. It reaches up beside the address bars. */
  sideBounds(): Rectangle {
    const { x, y, width, height } = this.contentBox()
    const side = this.hooks.sideWidth()
    return {
      x: x + width - GUTTER - side,
      y: y + GUTTER + SIDE_HEADER,
      width: side,
      height: Math.max(0, height - GUTTER - SIDE_HEADER - GUTTER),
    }
  }

  /** The page is on screen whenever the window is, while it animates in and out too. */
  pageVisible() {
    return this.visible || this.animating
  }

  /** Where jbrow's content goes in the window: all of it, except while the window animates. */
  private contentBox(): Rectangle {
    if (this.box) return this.box
    const [width, height] = this.win.getContentSize()
    return { x: 0, y: 0, width, height }
  }

  private fitUi() {
    this.uiView.setBounds(this.contentBox())
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
  /** Whether the UI covers the page area; see setOverlay. */
  get covered() {
    return this.overlay
  }

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

  /** Sets the window's frame. jbrow's own moves don't count as yours (see remember). */
  private setFrame(bounds: Rectangle) {
    this.placing++
    try {
      this.win.setBounds(bounds)
    } finally {
      this.placing--
    }
  }

  /** The default place: a share of the display's work area, centered a little above the middle. */
  private defaultPlace(area: Rectangle): Rectangle {
    const { panel } = this.settings()
    const width = Math.max(MIN_SIZE[0], Math.round(area.width * panel.widthFraction))
    const height = Math.max(MIN_SIZE[1], Math.round(area.height * panel.heightFraction))
    return fit({ x: area.x + (area.width - width) / 2, y: area.y + (area.height - height) / 2.4, width, height }, area)
  }

  /** Where the unpinned panel goes on a display: where you last left it there, or the default. */
  private floatingPlace(display: Display): Rectangle {
    const area = display.workArea
    const saved = this.settings().panel.displays[String(display.id)]
    if (!saved) return this.defaultPlace(area)
    return fit({ ...saved, x: area.x + saved.x, y: area.y + saved.y }, area)
  }

  /**
   * Where the window goes when it shows. Unpinned, it comes up on the display the pointer is on,
   * where you last left it on that display. Pinned, it's a regular window and comes back where it was.
   */
  private place(): Rectangle {
    const { panel } = this.settings()
    let place: Rectangle
    if (this.pinned && panel.pinned) {
      this.display = screen.getDisplayMatching(panel.pinned)
      // Off screen in the background, the window keeps its size even where the screen is smaller.
      place = BACKGROUND ? panel.pinned : fit(panel.pinned, this.display.workArea)
    } else {
      this.display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
      place = this.floatingPlace(this.display)
      // Otherwise the pinned window would follow the pointer to another display next time.
      if (this.pinned && !BACKGROUND) {
        panel.pinned = place
        this.hooks.onPlaced()
      }
    }
    return BACKGROUND ? { ...offScreen(), width: place.width, height: place.height } : place
  }

  /** You moved or resized the window: it's remembered a moment after you stop. */
  private remember() {
    if (this.placing || this.animating || this.pageFullscreen || !this.visible || this.win.isDestroyed()) return
    const bounds = this.win.getBounds()
    if (same(bounds, this.target)) return
    this.target = bounds
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.savePlace(), 400)
  }

  /**
   * Saves where the window is: pinned, in screen coordinates; unpinned, for the display it's on,
   * relative to that display's work area. A JBROW_BACKGROUND window sits off screen, so only its
   * size counts there. It saves `target`, not the window's frame: a save that comes due while the
   * window animates or a page is fullscreen keeps the place you left it at.
   */
  private savePlace() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    const { panel } = this.settings()
    const bounds = this.target
    const display = BACKGROUND ? (this.display ?? screen.getPrimaryDisplay()) : screen.getDisplayMatching(bounds)
    const area = display.workArea
    const at = (old: Rectangle | null | undefined) => (BACKGROUND ? (old ?? this.defaultPlace(area)) : bounds)
    if (this.pinned) {
      const { x, y } = at(panel.pinned)
      panel.pinned = { x, y, width: bounds.width, height: bounds.height }
    } else {
      const old = panel.displays[String(display.id)]
      const { x, y } = at(old && { ...old, x: area.x + old.x, y: area.y + old.y })
      panel.displays[String(display.id)] = { x: x - area.x, y: y - area.y, width: bounds.width, height: bounds.height }
    }
    this.hooks.onPlaced()
  }

  /** Saves a move or resize that's still waiting to be saved, as jbrow quits. */
  flush() {
    if (this.saveTimer) this.savePlace()
  }

  /** Forgets every place you left the window; it takes the default size, right away if it's showing. */
  resetPlace() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    const { panel } = this.settings()
    panel.displays = {}
    panel.pinned = null
    this.hooks.onPlaced()
    if (!this.visible || this.animating || this.pageFullscreen || this.win.isDestroyed()) return
    const display = BACKGROUND ? (this.display ?? screen.getPrimaryDisplay()) : screen.getDisplayMatching(this.win.getBounds())
    const place = this.defaultPlace(display.workArea)
    this.target = BACKGROUND ? { ...this.win.getBounds(), width: place.width, height: place.height } : place
    this.setFrame(this.target)
    if (this.pinned && !BACKGROUND) this.savePlace()
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

  /** Where a message's animation starts and how long it runs (0: not at all). Reduced motion in macOS keeps only the fade. */
  private motion(msg: AnimMessage) {
    const reduce = systemPreferences.getAnimationSettings().prefersReducedMotion
    return { from: reduce ? START.fade : START[msg.style], ms: msg.style === 'off' ? 0 : msg.durationMs }
  }

  /**
   * A JBROW_BACKGROUND panel stays invisible: macOS keeps a sliver of any window on screen, so
   * moving it away isn't enough.
   */
  private setOpacity(value: number) {
    this.win.setOpacity(BACKGROUND ? 0 : value)
  }

  /**
   * Puts the window `progress` of the way from where a style starts (0) to its place (1), at
   * opacity `alpha`. The content keeps its final size and its place on screen while the window
   * grows around it, and moves with the window when it slides.
   */
  private frameAt(progress: number, alpha: number, from: (typeof START)[AnimationStyle]) {
    this.progress = progress
    this.alpha = alpha
    const t = this.target
    // A spring overshoots: the window slides a little past its place, but never grows past its size.
    const scale = Math.min(1, from.scale + (1 - from.scale) * progress)
    const width = Math.round(t.width * scale)
    const height = Math.round(t.height * scale)
    const dx = Math.round((t.width - width) / 2)
    const dy = Math.round((t.height - height) / 2)
    this.box = dx || dy ? { x: -dx, y: -dy, width: t.width, height: t.height } : null
    this.setOpacity(alpha)
    this.setFrame({ x: t.x + dx, y: t.y + dy + Math.round(from.dy * (1 - progress)), width, height })
    this.fitUi()
    this.hooks.setPageVisible(this.pageVisible())
  }

  /** Calls `step` with t from 0 to 1 over `ms`, at 120 Hz. A new one ends the running one, so its caller moves on. */
  private animate(ms: number, step: (t: number) => void): Promise<void> {
    this.endTween?.()
    return new Promise((resolve) => {
      if (this.win.isDestroyed()) return resolve()
      if (ms <= 0) {
        step(1)
        return resolve()
      }
      const start = performance.now()
      let last = start
      let frames = 0
      let gap = 0
      const end = () => {
        if (this.tween) clearInterval(this.tween)
        this.tween = null
        this.endTween = null
        debug(`animated: ${frames} frames in ${Math.round(last - start)} ms, longest gap ${gap.toFixed(1)} ms`)
        resolve()
      }
      this.endTween = end
      step(0)
      this.tween = setInterval(() => {
        // The window goes away when jbrow quits mid-animation.
        if (this.win.isDestroyed()) return end()
        const now = performance.now()
        gap = Math.max(gap, now - last)
        last = now
        frames++
        const t = Math.min(1, (now - start) / ms)
        step(t)
        if (t >= 1) end()
      }, 1000 / 120)
    })
  }

  /** Resolves once the pages on screen have drawn a fresh frame, or after `ms`, so no old frame shows. */
  private pageFrame(ms: number): Promise<void> {
    const pages = this.hooks.pages()
    if (!pages.length) return Promise.resolve()
    const drawn = pages.map((wc) =>
      wc
        .executeJavaScriptInIsolatedWorld(1997, [{ code: 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(0))))' }])
        .then(() => {}, () => {}),
    )
    return Promise.race([Promise.all(drawn).then(() => {}), new Promise<void>((resolve) => setTimeout(resolve, ms))])
  }

  /**
   * Materialize blurs the page as well as the UI: a CSS animation on the page's root element, in
   * a stylesheet of jbrow's own that goes again once the window is in place or hidden.
   */
  private blurPage(msg: AnimMessage, blur: number) {
    this.unblurPage()
    const [from, to] = msg.phase === 'in' ? [blur, 0] : [0, blur]
    const ease = msg.phase === 'in' ? cssEase(msg.ease) : `cubic-bezier(${EASE_IN.join(',')})`
    const name = `jbrow-materialize-${msg.phase}`
    const css = `@keyframes ${name} { from { filter: blur(${from}px) } to { filter: blur(${to}px) } } html { animation: ${name} ${msg.durationMs}ms ${ease} both !important }`
    // An author sheet: Electron 44 can't remove the user sheets it inserts.
    this.pageBlur = this.hooks.pages().map((wc) => ({ wc, key: wc.insertCSS(css).catch(() => null) }))
  }

  private unblurPage() {
    for (const blur of this.pageBlur.splice(0)) {
      void blur.key.then((key) => {
        if (key && !blur.wc.isDestroyed()) void blur.wc.removeInsertedCSS(key).catch(() => {})
      })
    }
  }

  /**
   * macOS counts a window that's still transparent, or just ordered in, as covered, and Chromium
   * keeps its pages asleep until macOS says otherwise, a few hundred ms later (a second, off
   * screen). Turning background throttling off for the page while the window comes in wakes it
   * right away, so it draws live frames from the first one. It goes back on a while after the
   * window is in place, once macOS has caught up, and as jbrow hides, so a page that's hidden or
   * behind other windows sleeps as before.
   */
  private wakePage() {
    this.letPageSleep()
    this.woken = this.hooks.pages().map((wc) => ({ wc, throttled: wc.getBackgroundThrottling() }))
    for (const { wc } of this.woken) wc.setBackgroundThrottling(false)
  }

  /**
   * The UI times the show animation, so it's awake and unthrottled while the window is up. While
   * the window is hidden it sleeps, as the pages do: Chromium doesn't count a hidden window's view
   * as hidden, and a looping animation in it (a loading tab's pulsing favicon, a running restyle,
   * a download of unknown size) kept it and the GPU drawing frames for as long as jbrow stayed away.
   */
  private wakeUi(on: boolean) {
    if (this.ui.isDestroyed()) return
    this.ui.setBackgroundThrottling(!on)
    this.uiView.setVisible(on)
  }

  private letPageSleep() {
    if (this.sleepTimer) clearTimeout(this.sleepTimer)
    this.sleepTimer = null
    for (const { wc, throttled } of this.woken.splice(0)) if (!wc.isDestroyed()) wc.setBackgroundThrottling(throttled)
  }

  /** Tells the UI the window is coming in, and puts the window where the animation starts. */
  private beginIn() {
    const msg = this.send('in')
    const { from, ms } = this.motion(msg)
    // A hide this show interrupts stops moving the window, and its blur goes.
    this.endTween?.()
    this.unblurPage()
    // The window starts out smaller than you can make it.
    if (ms) this.win.setMinimumSize(0, 0)
    this.frameAt(ms ? 0 : 1, ms ? 0 : 1, from)
    return { msg, from, ms }
  }

  /**
   * Plays the show animation once the UI and the page have drawn their first frames. The UI
   * starts its own part (materialize's blur) on its first frame and says so.
   */
  private async playIn(run: number, { msg, from, ms }: ReturnType<Panel['beginIn']>) {
    const asked = performance.now()
    if (ms) await Promise.all([this.fromUi('anim-start', 150), this.pageFrame(100)])
    debug(`first frames in ${Math.round(performance.now() - asked)} ms`)
    if (run !== this.run || this.win.isDestroyed()) return
    if (ms && from.blur) this.blurPage(msg, from.blur)
    // The window turns opaque on the curve the content moves on, so it settles together with the
    // content instead of still fading in around content that has already arrived.
    const curve = (t: number) => bezier(EASE[msg.ease], t)
    const opacity = msg.style === 'fade' ? (t: number) => 1 - (1 - t) ** 3 : curve
    await this.animate(ms, (t) => this.frameAt(curve(t), Math.min(1, opacity(t)), from))
    if (run !== this.run || this.win.isDestroyed()) return
    this.settle()
    this.sleepTimer = setTimeout(() => this.letPageSleep(), 1500)
    debug('shown; focused =', this.win.isFocused(), 'visible =', this.win.isVisible(), 'window =', this.win.getMediaSourceId())
    this.animating = false
    this.hooks.setPageVisible(this.pageVisible())
    this.hooks.onShown()
  }

  /** The window at its place, the content filling it, after an animation. */
  private settle() {
    this.box = null
    this.setFrame(this.target)
    this.fitUi()
    this.win.setMinimumSize(...MIN_SIZE)
    this.unblurPage()
  }

  /**
   * Puts the unpinned panel back on the floating level. Something can drop it to the normal level
   * while jbrow runs (the installed app's was found there; the cause isn't known yet), and then it
   * opens under the window you're in instead of on top of it.
   */
  private float() {
    if (this.pinned || this.pageFullscreen) return
    if (!this.win.isAlwaysOnTop()) console.log('[panel] the window had dropped to the normal level; floating it again')
    this.win.setAlwaysOnTop(true, 'floating')
  }

  async show() {
    if (this.win.isDestroyed()) return
    this.float()
    if (this.visible && !this.animating) {
      if (!BACKGROUND) this.win.focus()
      return
    }
    debug('show')
    const run = ++this.run
    this.visible = true
    this.animating = true
    this.target = this.place()
    this.wakeUi(true)
    // The live page is in the window from the start, while the window is still transparent.
    this.wakePage()
    const anim = this.beginIn()
    if (BACKGROUND) {
      this.win.showInactive()
      // macOS pulls a window back on screen as it orders it in, so push it out as far as it lets.
      this.setFrame({ ...this.win.getBounds(), ...offScreen() })
    } else {
      this.win.show()
      this.win.focus()
    }
    await this.playIn(run, anim)
  }

  /** Plays the show animation again where the window is, for the preview in settings. */
  async preview() {
    if (!this.visible || this.animating || this.pageFullscreen || this.win.isDestroyed()) return
    const run = ++this.run
    this.animating = true
    this.target = this.win.getBounds()
    // Fading to transparent could put the page to sleep, as on a show.
    this.wakePage()
    await this.playIn(run, this.beginIn())
  }

  async hide() {
    if (!this.visible || this.win.isDestroyed()) return
    debug('hide', new Error().stack?.split('\n')[2]?.trim())
    const run = ++this.run
    this.visible = false
    this.animating = true
    // After an interrupted show; otherwise the page would stay awake once hidden.
    this.letPageSleep()
    this.setOverlay(false)
    this.hooks.onHiding()
    const msg = this.send('out')
    const { from, ms } = this.motion(msg)
    if (ms) this.win.setMinimumSize(0, 0)
    if (ms && from.blur) this.blurPage(msg, from.blur)
    // From wherever an interrupted show got to.
    const [progress, alpha] = [Math.min(1, this.progress), this.alpha]
    await this.animate(ms, (t) => this.frameAt(progress * (1 - bezier(EASE_IN, t)), alpha * (1 - t * t), from))
    if (run !== this.run || this.win.isDestroyed()) return
    this.win.hide()
    this.wakeUi(false)
    this.animating = false
    this.hooks.setPageVisible(false)
    this.settle()
    this.hooks.onHidden()
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
