import { ipcRenderer } from 'electron'

/**
 * Two-finger swipe back and forward, as in Chrome. Chrome does this in its own browser layer from
 * the trackpad's gesture phases and the compositor's overscroll, neither of which Electron passes
 * on: there's no OverscrollHistoryNavigation on macOS, scroll-touch-* events are gone, and a
 * wheel `input-event` carries nothing but its type. What's left is the page's own wheel events, so
 * this preload watches them. It runs in the preload's isolated world, which shares the page's DOM
 * but none of its JavaScript, so a page can't see or tamper with its code. Frames don't get it:
 * a swipe over an iframe stays with the iframe.
 *
 * A gesture swipes only if it starts out sideways, nothing under the pointer can scroll further
 * that way, and the page doesn't call preventDefault (maps and carousels do). Without phases,
 * the gesture ends when wheel events stop, or early once it's past the threshold and the deltas
 * start dying off the way they do once the fingers lift.
 */

interface Allowed {
  back: boolean
  forward: boolean
  /** Natural scrolling flips deltaX; swiping follows the fingers either way. */
  natural: boolean
}

/** Wheel events further apart than this belong to separate gestures. */
const GAP_MS = 180
/** A quiet spell this long ends a swipe. */
const END_MS = 110
/** Movement needed to tell a sideways gesture from a vertical one. */
const DECIDE_PX = 8
/** How far the fingers travel, in CSS pixels, before letting go navigates. */
const THRESHOLD_PX = 150
const ARROW_SIZE = 44
const ACCENT = '#1a7f8e'

type Phase = 'idle' | 'deciding' | 'asking' | 'swiping' | 'ignoring'

let phase: Phase = 'idle'
let last = -Infinity
let dx = 0
let dy = 0
/** Positive toward back. */
let pull = 0
let dir: 'back' | 'forward' = 'back'
let natural = true
let lastDelta = 0
let decays = 0
let endTimer: ReturnType<typeof setTimeout> | undefined
let arrow: Arrow | null = null

function onWheel(e: WheelEvent) {
  const now = e.timeStamp
  if (now - last > GAP_MS) startGesture()
  last = now
  // Pinch zoom arrives as ctrl+wheel; ⌘ and ⇧ wheels aren't swipes either.
  if (e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return stop()
  if (phase === 'ignoring') return
  // The page's own listeners run after this one, so whether it called preventDefault shows up
  // only once the event has gone everywhere. By then its path is gone, so keep that now.
  const path = phase === 'deciding' ? e.composedPath() : []
  setTimeout(() => afterDispatch(e, path))
}

function afterDispatch(e: WheelEvent, path: EventTarget[]) {
  if (phase === 'ignoring' || phase === 'idle') return
  if (e.defaultPrevented) return stop()
  if (phase === 'deciding') {
    dx += e.deltaX
    dy += e.deltaY
    if (Math.abs(dx) + Math.abs(dy) < DECIDE_PX) return
    // Mostly vertical, or something on the way can still scroll this way: not ours.
    if (Math.abs(dx) < Math.abs(dy) * 2 || canScroll(path, Math.sign(dx))) return stop(true)
    phase = 'asking'
    pull = 0
    track(e.deltaX)
    void ipcRenderer.invoke('page:swipe-allowed').then((allowed: Allowed | null) => {
      if (phase !== 'asking') return
      natural = allowed?.natural ?? true
      dir = toward(dx)
      if (!allowed || !allowed[dir]) return stop(true)
      phase = 'swiping'
      update()
    })
    return
  }
  track(e.deltaX)
  if (phase === 'swiping') update()
}

/** Which way a deltaX moves the fingers. */
const toward = (deltaX: number): 'back' | 'forward' => ((deltaX < 0) === natural ? 'back' : 'forward')

function track(deltaX: number) {
  pull += natural ? -deltaX : deltaX
  const size = Math.abs(deltaX)
  decays = size < lastDelta ? decays + 1 : 0
  lastDelta = size
  clearTimeout(endTimer)
  endTimer = setTimeout(finish, END_MS)
  // Past the threshold and slowing down for several frames in a row: the fingers have lifted and
  // what's left is momentum, so go now instead of waiting it out.
  if (phase === 'swiping' && progress() >= 1 && decays >= 3) finish()
}

/** 0 to 1 toward the threshold, in the direction the gesture started. */
const progress = () => Math.max(0, (dir === 'back' ? pull : -pull) / THRESHOLD_PX)

function update() {
  arrow ??= new Arrow(dir)
  arrow.set(progress())
}

function finish() {
  clearTimeout(endTimer)
  const go = phase === 'swiping' && progress() >= 1
  if (go) ipcRenderer.send('page:swipe-go', dir)
  arrow?.leave(go)
  arrow = null
  // Momentum keeps sending wheel events after a swipe; they belong to the finished gesture.
  phase = 'ignoring'
}

function startGesture() {
  clearTimeout(endTimer)
  arrow?.leave(false)
  arrow = null
  phase = 'deciding'
  dx = dy = pull = 0
  lastDelta = decays = 0
}

/** Gives up on the current gesture; with `quiet`, without waiting for the arrow. */
function stop(quiet = false) {
  clearTimeout(endTimer)
  arrow?.leave(false, quiet)
  arrow = null
  phase = 'ignoring'
}

/** Whether anything the wheel event passes through can scroll further in deltaX's direction. */
function canScroll(path: EventTarget[], sign: number): boolean {
  // Pinch-zoomed in, a sideways swipe pans the zoomed view first.
  const vv = window.visualViewport
  if (vv && vv.scale > 1.01) {
    if (sign < 0 ? vv.offsetLeft > 0.5 : vv.offsetLeft + vv.width < window.innerWidth - 0.5) return true
  }
  const root = document.scrollingElement ?? document.documentElement
  for (const node of path) {
    if (!(node instanceof Element) || node === root || node === document.body) continue
    const style = getComputedStyle(node)
    if (!/(auto|scroll|overlay)/.test(style.overflowX) || node.scrollWidth - node.clientWidth < 1) continue
    // overscroll-behavior-x: contain or none is how a page says "no swipe navigation from here".
    if (style.overscrollBehaviorX !== 'auto') return true
    if (canMove(node, sign, style.direction === 'rtl')) return true
  }
  const html = getComputedStyle(document.documentElement)
  const body = document.body && getComputedStyle(document.body)
  if (html.overscrollBehaviorX !== 'auto' || (body && body.overscrollBehaviorX !== 'auto')) return true
  // The page itself scrolls sideways unless html (or body, which hands its overflow to the
  // viewport when html leaves its own alone) hides it.
  const hidden = html.overflowX === 'hidden' || html.overflowX === 'clip' || (html.overflowX === 'visible' && body && /hidden|clip/.test(body.overflowX))
  return !hidden && root.scrollWidth - root.clientWidth >= 1 && canMove(root, sign, html.direction === 'rtl')
}

function canMove(el: Element, sign: number, rtl: boolean): boolean {
  const max = el.scrollWidth - el.clientWidth
  // Right-to-left scrollers count scrollLeft from 0 down to -max.
  const [lo, hi] = rtl ? [-max, 0] : [0, max]
  return sign < 0 ? el.scrollLeft > lo + 0.5 : el.scrollLeft < hi - 0.5
}

/**
 * Chrome's arrow: a circle that slides in from the edge as the fingers move and fills in once
 * letting go would navigate. It lives in a closed shadow root in the top layer (a manual
 * popover), so page styles and stacking can't reach it, and only for the length of the swipe.
 * Styles go through the CSSOM, which no Content-Security-Policy blocks.
 */
class Arrow {
  private host: HTMLElement
  private circle: HTMLElement
  private ready = false
  private dark = matchMedia('(prefers-color-scheme: dark)').matches

  constructor(private dir: 'back' | 'forward') {
    const dark = this.dark
    this.host = document.createElement('jbrow-swipe')
    css(this.host, {
      position: 'fixed',
      // inset alone keeps it inside the viewport, off the scrollbar.
      inset: '0',
      width: 'auto',
      height: 'auto',
      margin: '0',
      padding: '0',
      border: '0',
      background: 'transparent',
      overflow: 'hidden',
      'pointer-events': 'none',
      'z-index': '2147483647',
      display: 'block',
      opacity: '1',
      visibility: 'visible',
    })
    const shadow = this.host.attachShadow({ mode: 'closed' })
    this.circle = document.createElement('div')
    css(this.circle, {
      position: 'absolute',
      top: `calc(50% - ${ARROW_SIZE / 2}px)`,
      [dir === 'back' ? 'left' : 'right']: `${-ARROW_SIZE}px`,
      width: `${ARROW_SIZE}px`,
      height: `${ARROW_SIZE}px`,
      'border-radius': '50%',
      display: 'flex',
      'align-items': 'center',
      'justify-content': 'center',
      background: dark ? '#3a3f48' : '#ffffff',
      color: dark ? '#e7ebf1' : '#5d6573',
      'box-shadow': '0 1px 4px rgba(0, 0, 0, 0.25)',
      'will-change': 'transform, opacity',
    })
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    svg.setAttribute('viewBox', '0 0 24 24')
    svg.setAttribute('width', '22')
    svg.setAttribute('height', '22')
    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
    path.setAttribute('d', dir === 'back' ? 'M19 12H5M11 6l-6 6 6 6' : 'M5 12h14M13 6l6 6-6 6')
    path.setAttribute('fill', 'none')
    path.setAttribute('stroke', 'currentColor')
    path.setAttribute('stroke-width', '2.2')
    path.setAttribute('stroke-linecap', 'round')
    path.setAttribute('stroke-linejoin', 'round')
    svg.append(path)
    this.circle.append(svg)
    shadow.append(this.circle)
    this.host.popover = 'manual'
    document.documentElement.append(this.host)
    try {
      this.host.showPopover()
    } catch {}
  }

  /** `p` runs from 0 (nothing yet) to 1 (letting go navigates), and past it. */
  set(p: number) {
    // Follows the fingers up to the threshold, then only creeps on, like a rubber band.
    const travel = ARROW_SIZE + 16
    const x = p <= 1 ? p * travel : travel + Math.min(24, (p - 1) * 30)
    css(this.circle, {
      transform: `translateX(${this.dir === 'back' ? x : -x}px)`,
      opacity: String(Math.min(1, p * 1.6)),
    })
    const ready = p >= 1
    if (ready === this.ready) return
    this.ready = ready
    css(this.circle, {
      // jbrow's accent once letting go would navigate, as Chrome turns its arrow blue.
      background: ready ? ACCENT : this.dark ? '#3a3f48' : '#ffffff',
      color: ready ? '#ffffff' : this.dark ? '#e7ebf1' : '#5d6573',
    })
  }

  leave(went: boolean, quiet = false) {
    const host = this.host
    if (quiet) return host.remove()
    css(this.circle, {
      transition: 'transform 160ms ease-out, opacity 160ms ease-out',
      opacity: '0',
      ...(went ? {} : { transform: 'translateX(0)' }),
    })
    setTimeout(() => host.remove(), 180)
  }
}

function css(el: HTMLElement, styles: Record<string, string>) {
  for (const [name, value] of Object.entries(styles)) el.style.setProperty(name, value, 'important')
}

// Top-level pages only, and not extension pages and popups. The main process further checks the
// page is one of jbrow's tabs.
if (window.top === window && location.protocol !== 'chrome-extension:') {
  window.addEventListener('wheel', onWheel, { capture: true, passive: true })
}
