import { execFile, spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import { BrowserWindow, screen, systemPreferences, type Rectangle } from 'electron'

const debug = (...args: unknown[]) => process.env.JBROW_DEBUG && console.log('[pip-corner]', ...args)

/** Chromium's PiP window floats at NSFloatingWindowLevel. jbrow's own windows sit elsewhere. */
const PIP_LAYER = 3

/**
 * Prints the PiP window's bounds and the window in front of the other apps' whenever either
 * changes, as a JSON line on stderr (JXA's console.log). The window in front is the topmost
 * ordinary window that isn't jbrow's. CoreGraphics' window list needs no permissions and takes a
 * millisecond, so the loop runs in one process instead of starting one each time. It ends once
 * the PiP window has been gone for 2 seconds, which is also when jbrow quits.
 */
const WATCH = `ObjC.import('CoreGraphics')
function run([pid, ...own]) {
  pid = Number(pid)
  own = own.map(Number)
  let last = ''
  let missing = 0
  for (;;) {
    const list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || []
    const pip = list.find((w) => w.kCGWindowOwnerPID === pid && w.kCGWindowLayer === ${PIP_LAYER} && !own.includes(w.kCGWindowNumber))
    if (pip) missing = 0
    else if (++missing > 8) return
    const front = list.find((w) => w.kCGWindowLayer === 0 && w.kCGWindowOwnerPID !== pid && w.kCGWindowAlpha > 0 && w.kCGWindowBounds.Width >= 100 && w.kCGWindowBounds.Height >= 100)
    const rect = (w) => w && { x: w.kCGWindowBounds.X, y: w.kCGWindowBounds.Y, width: w.kCGWindowBounds.Width, height: w.kCGWindowBounds.Height }
    const line = JSON.stringify({ pip: rect(pip) || null, front: front ? { id: front.kCGWindowNumber, ...rect(front) } : null })
    if (line !== last) console.log(line)
    last = line
    delay(0.25)
  }
}`

/**
 * Moves the window of jbrow's at `at` with size `size` to `to`, through the Accessibility API.
 * Points and sizes travel as the bytes of two doubles in base64: the JXA bridge can't build
 * AXValue's structs itself.
 */
const MOVE = `ObjC.import('ApplicationServices')
function run([pid, at, size, to]) {
  const cf = (s) => $.CFStringCreateWithCString(null, s, 0x08000100)
  const get = (el, name) => {
    const r = Ref()
    return $.AXUIElementCopyAttributeValue(el, cf(name), r) === 0 ? r[0] : null
  }
  const bytes = (value, type) => {
    const d = $.NSMutableData.dataWithLength(16)
    return value && $.AXValueGetValue(ObjC.castRefToObject(value), type, d.mutableBytes) ? ObjC.unwrap(d.base64EncodedStringWithOptions(0)) : ''
  }
  const windows = get($.AXUIElementCreateApplication(Number(pid)), 'AXWindows')
  if (!windows) return 'no windows'
  const list = ObjC.castRefToObject(windows)
  for (let i = 0; i < list.count; i++) {
    const w = list.objectAtIndex(i)
    if (bytes(get(w, 'AXPosition'), 1) !== at || bytes(get(w, 'AXSize'), 2) !== size) continue
    const point = $.NSData.alloc.initWithBase64EncodedStringOptions(to, 0)
    return String($.AXUIElementSetAttributeValue(w, cf('AXPosition'), ObjC.castRefToObject($.AXValueCreate(1, point.bytes))))
  }
  return 'not found'
}`

const doubles = (a: number, b: number) => Buffer.from(new Float64Array([a, b]).buffer).toString('base64')

function overlap(a: Rectangle, b: Rectangle) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  return w > 0 && h > 0 ? w * h : 0
}

/**
 * Where the mini player should go so it doesn't cover `front`: the corner of `area` (the
 * display's work area) that covers the least of it, keeping the gaps it has to the screen's
 * edges. The corner across is tried first, then the one above or below, then the far one. Null
 * when it doesn't cover `front`, or no corner covers less.
 */
export function freeCorner(pip: Rectangle, front: Rectangle, area: Rectangle): { x: number; y: number } | null {
  const now = overlap(pip, front)
  if (!now) return null
  const right = area.x + area.width
  const bottom = area.y + area.height
  const gapX = Math.max(0, Math.min(pip.x - area.x, right - pip.x - pip.width))
  const gapY = Math.max(0, Math.min(pip.y - area.y, bottom - pip.y - pip.height))
  const xs = [area.x + gapX, right - gapX - pip.width]
  const ys = [area.y + gapY, bottom - gapY - pip.height]
  const col = pip.x + pip.width / 2 < area.x + area.width / 2 ? 0 : 1
  const row = pip.y + pip.height / 2 < area.y + area.height / 2 ? 0 : 1
  const corners = [
    { x: xs[1 - col], y: ys[row] },
    { x: xs[col], y: ys[1 - row] },
    { x: xs[1 - col], y: ys[1 - row] },
  ]
  let best: { x: number; y: number } | null = null
  let least = now
  for (const c of corners) {
    const covers = overlap({ ...c, width: pip.width, height: pip.height }, front)
    if (covers < least) [best, least] = [c, covers]
  }
  return best
}

interface Seen {
  pip: Rectangle | null
  front: (Rectangle & { id: number }) | null
}

/**
 * Moves the mini player to another corner when you bring up a window it sits on. Only switching
 * windows counts: one you move or resize under it, or the mini player you drag back over it,
 * stays where it is. macOS only, and it needs Accessibility access to move the window.
 */
export class PipCorner {
  private proc: ChildProcess | null = null
  /** The window in front when we last looked, and whether the PiP window was there then. */
  private front: number | null = null
  private hadPip = false

  /** Watches while `on`, which is whenever jbrow's video is in PiP and the setting is on. */
  watch(on: boolean) {
    if (process.platform !== 'darwin') return
    if (!on) return this.stop()
    if (this.proc) return
    // jbrow's own windows, so a panel raised to the PiP's level doesn't pass for it.
    const own = BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId().split(':')[1])
    const proc = spawn('/usr/bin/osascript', ['-l', 'JavaScript', '-e', WATCH, String(process.pid), ...own], { stdio: ['ignore', 'ignore', 'pipe'] })
    this.proc = proc
    this.front = null
    this.hadPip = false
    debug('watching')
    createInterface({ input: proc.stderr! }).on('line', (line) => {
      if (this.proc !== proc) return
      let seen: Seen
      try {
        seen = JSON.parse(line)
      } catch {
        return console.error('[pip-corner]', line)
      }
      this.seen(seen)
    })
    proc.on('error', (error) => console.error('[pip-corner] osascript failed:', error))
    proc.on('exit', () => {
      if (this.proc === proc) this.proc = null
    })
  }

  stop() {
    this.proc?.kill()
    this.proc = null
  }

  private seen({ pip, front }: Seen) {
    const appeared = !!pip && !this.hadPip
    const switched = (front?.id ?? null) !== this.front
    this.hadPip = !!pip
    this.front = front?.id ?? null
    if (!pip || !front || !(appeared || switched)) return
    const to = freeCorner(pip, front, screen.getDisplayMatching(pip).workArea)
    if (!to) return
    if (!systemPreferences.isTrustedAccessibilityClient(false)) return debug('no Accessibility access')
    debug('moving to', to)
    const args = [String(process.pid), doubles(pip.x, pip.y), doubles(pip.width, pip.height), doubles(to.x, to.y)]
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', MOVE, ...args], { timeout: 2000 }, (error, stdout) => {
      if (error || stdout.trim() !== '0') console.error('[pip-corner] move failed:', error ?? stdout.trim())
    })
  }
}
