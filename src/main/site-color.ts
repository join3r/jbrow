import type { WebContents } from 'electron'

/** How far a channel may stray between points along the top edge for it to count as one color. */
const TOLERANCE = 12
/** Wait this long after a page stops loading, so its scripts have drawn its header. */
const SETTLE_MS = 400
/** A page that couldn't be looked at is tried again after this long, when its bar asks. */
const RETRY_MS = 1500
/** An isolated world of its own, so the page's scripts can't see or bend what's asked. */
const WORLD = 1996

/** A color as red, green and blue, 0–255. */
export type Rgb = [number, number, number]

/**
 * The background along the very top of the page, at five points across: for each, the first
 * opaque background color up the tree from the element there. Null for a point where something
 * else shows: a background image or gradient, a translucent layer, a frame, or a picture, video or
 * canvas wider than a logo. With nothing opaque, the canvas color shows: the root's or body's, else
 * the browser's default for the page's color scheme.
 */
const SAMPLE = `(() => {
  const W = innerWidth
  if (!W || !document.documentElement) return null
  const rgba = (c) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(c)
    if (!m) return null
    const [r, g, b, a = 1] = m[1].split(/[\\s,/]+/).filter(Boolean).map(Number)
    return { r, g, b, a }
  }
  const opaque = (el) => {
    const c = el && rgba(getComputedStyle(el).backgroundColor)
    return c && c.a >= 0.98 ? [c.r, c.g, c.b] : null
  }
  const canvas = () =>
    opaque(document.documentElement) || opaque(document.body) ||
    (getComputedStyle(document.documentElement).colorScheme.includes('dark') && matchMedia('(prefers-color-scheme: dark)').matches ? [18, 18, 18] : [255, 255, 255])
  const at = (x) => {
    for (let el = document.elementFromPoint(x, 1); el; el = el.parentElement) {
      if (el instanceof HTMLIFrameElement) return null
      if (el instanceof HTMLImageElement || el instanceof HTMLVideoElement || el instanceof HTMLCanvasElement || el instanceof SVGSVGElement) {
        if (el.getBoundingClientRect().width > W * 0.3) return null
        continue
      }
      const s = getComputedStyle(el)
      if (s.backgroundImage !== 'none') return null
      const c = rgba(s.backgroundColor)
      if (c && c.a >= 0.98) return [c.r, c.g, c.b]
      if (c && c.a > 0.02) return null
    }
    return canvas()
  }
  return [0.02, 0.25, 0.5, 0.75, 0.98].map((f) => at(Math.round(W * f)))
})()`

const hex = (n: number) => Math.round(n).toString(16).padStart(2, '0')

/** The color across the top of a page, as #rrggbb, from what SAMPLE found; null unless every point is the same color. */
export function edgeColor(points: (Rgb | null)[] | null): string | null {
  if (!points?.length || points.some((p) => !p)) return null
  const [first] = points as Rgb[]
  if ((points as Rgb[]).some((p) => p.some((v, i) => Math.abs(v - first[i]) > TOLERANCE))) return null
  return `#${first.map(hex).join('')}`
}

interface Watched {
  wc: WebContents
  /** The page's <meta name="theme-color">, as Chromium reports it. */
  theme: string | null
  /** The color across the top of the page; null when it isn't one, undefined until looked at. */
  edge: string | null | undefined
  timer?: NodeJS.Timeout
  busy: boolean
  triedAt: number
}

/**
 * The color each tab's address bar takes, so the bar and its page read as one card: the color
 * across the top of the page when that's a single color, else the page's theme-color, else none,
 * and the bar keeps jbrow's own surface. The top edge wins over theme-color because it's what you
 * see: plenty of sites set a brand color there that their header doesn't use. It's read from the
 * page's styles, not its pixels, so it works for a page that isn't drawing, and costs next to nothing.
 */
export class SiteColors {
  private tabs = new Map<string, Watched>()

  constructor(private onChange: () => void) {}

  watch(id: string, wc: WebContents) {
    this.forget(id)
    const t: Watched = { wc, theme: null, edge: undefined, busy: false, triedAt: 0 }
    this.tabs.set(id, t)
    const later = () => {
      clearTimeout(t.timer)
      t.timer = setTimeout(() => void this.sample(id, t), SETTLE_MS)
    }
    wc.on('did-change-theme-color', (_e, color) => {
      if (this.tabs.get(id) !== t || color === t.theme) return
      t.theme = color
      this.onChange()
    })
    wc.on('did-stop-loading', later)
    wc.on('did-navigate-in-page', (_e, _url, isMainFrame) => isMainFrame && later())
  }

  forget(id: string) {
    const t = this.tabs.get(id)
    if (!t) return
    clearTimeout(t.timer)
    this.tabs.delete(id)
  }

  /** The bar color for a tab. A page not looked at yet is looked at now, and the answer comes with onChange. */
  color(id: string): string | null {
    const t = this.tabs.get(id)
    if (!t) return null
    if (t.edge === undefined && Date.now() - t.triedAt > RETRY_MS) void this.sample(id, t)
    return t.edge ?? t.theme
  }

  private async sample(id: string, t: Watched) {
    if (t.busy || t.wc.isDestroyed() || this.tabs.get(id) !== t) return
    t.busy = true
    t.triedAt = Date.now()
    try {
      const edge = edgeColor((await t.wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code: SAMPLE }])) as (Rgb | null)[] | null)
      if (this.tabs.get(id) !== t || edge === t.edge) return
      t.edge = edge
      this.onChange()
    } catch {
      // A page that went away mid-look, or one that can't run scripts: its bar keeps what it had.
    } finally {
      t.busy = false
    }
  }
}
