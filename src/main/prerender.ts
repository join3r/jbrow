import { WebContentsView, type BrowserWindow, type Certificate, type NavigationEntry, type Rectangle, type Session, type WebContents } from 'electron'

/**
 * Loads the site the address bar completes to from your history in a hidden page while you type,
 * so Return shows it at once. Chrome does this from its own browser layer, which Electron leaves
 * out, so jbrow keeps one hidden page of its own and puts it in place of the tab's page on Return
 * (Tabs.navigate). Only sites you've been to, only after typing pauses, one page at a time.
 *
 * The hidden page starts from the tab's back list plus the new address (navigationHistory.restore,
 * as a sleeping tab wakes), so Back after Return goes where it would have. If the tab moved on in
 * the meantime, Return loads the usual way.
 *
 * Until Return the page is muted, opens no windows and isn't in the history. Anything that would
 * need you drops it instead of waiting, and Return then loads the usual way: a permission, a
 * download, a sign-in, a certificate jbrow doesn't trust, a phishing warning, a failed load, or a
 * redirect to a site that opens in another profile. Private addresses are never loaded ahead.
 */

/** How long typing has to pause on a completion before its site loads. */
export const WAIT_MS = 300
/** A page loaded ahead and not wanted in this long goes. */
export const KEEP_MS = 60_000
/** How long after the address bar closes the page waits for the Return that may have closed it. */
export const CLOSE_GRACE_MS = 3000

/** Where the page loaded ahead goes: the tab, its profile, and its back list up to its current page. */
export interface Base {
  tab: string
  profile: string
  /** The tab's back list up to and including its current page; empty for a tab without one. */
  entries: NavigationEntry[]
}

export interface PrerenderDeps {
  enabled: () => boolean
  session: (profile: string) => Session | undefined
  window: () => BrowserWindow
  bounds: () => Rectangle
  onViewAdded: () => void
  isPrivate: (url: string) => boolean
  /** Whether jbrow would stop at a phishing or malware warning. */
  dangerous: (profile: string, url: string) => boolean
  /** The profile a site always opens in, if it has one. */
  siteProfile: (url: string) => string | undefined
  /** A certificate you told jbrow to trust for the site. */
  trusted: (profile: string, url: string, certificate: Certificate) => boolean
}

/** What Return gets: the page, and its favicon, which it reported before any tab listened. */
export interface Ahead {
  view: WebContentsView
  favicon?: string
}

interface Hidden {
  base: Base
  url: string
  view: WebContentsView
  favicon?: string
  bornAt: number
}

/** A back list as a string, to tell whether the tab moved on since its page started loading ahead. */
const listKey = (entries: NavigationEntry[]) => entries.map((e) => e.url).join('\n')

/** `url` as the browser writes it, so a typed one and a stored one compare. */
export function sameUrl(a: string, b: string): boolean {
  try {
    return new URL(a).href === new URL(b).href
  } catch {
    return false
  }
}

export class Prerenderer {
  private hidden: Hidden | null = null
  private waitTimer: NodeJS.Timeout | null = null
  private dropTimer: NodeJS.Timeout | null = null

  constructor(private deps: PrerenderDeps) {}

  /**
   * What the address bar completes to now, from your history, in `profile`, or null. A new one
   * loads once typing pauses; the same one or none keeps the page there.
   * `base` says where Return would go, or null when it would go somewhere loading ahead can't
   * stand in for (another profile, a new tab, a tab mid-restore).
   */
  consider(profile: string, url: string | null, base: () => Base | null) {
    // No completion now: what's typed may still be on its way to the completion (the completed
    // host itself completes to nothing). The page, or the wait for it, stays until another
    // completion, the bar closing or Return.
    if (!url) return
    this.clearWait()
    this.clearDrop()
    if (!this.allowed(profile, url)) return this.drop()
    const h = this.hidden
    if (h && h.base.profile === profile && sameUrl(h.url, url)) return
    this.waitTimer = setTimeout(() => {
      this.waitTimer = null
      const b = base()
      if (b && b.profile === profile && this.allowed(profile, url)) this.start(b, url)
    }, WAIT_MS)
  }

  /** The address bar closed. Return closes it too, just before it navigates, so the page waits a moment. */
  barClosed() {
    this.clearWait()
    this.clearDrop()
    if (this.hidden) this.dropTimer = setTimeout(() => this.drop(), CLOSE_GRACE_MS)
  }

  /**
   * The page loaded ahead for `url` in the tab `base` describes, handed over and no longer this
   * class's, or null when there isn't one that fits. Anything else loaded ahead goes.
   */
  take(url: string, base: Base): Ahead | null {
    const h = this.hidden
    this.clearWait()
    if (!h) return null
    const fits =
      h.base.tab === base.tab &&
      h.base.profile === base.profile &&
      listKey(h.base.entries) === listKey(base.entries) &&
      sameUrl(h.url, url) &&
      !h.view.webContents.isDestroyed() &&
      Date.now() - h.bornAt < KEEP_MS
    if (!fits) {
      this.drop()
      return null
    }
    this.hidden = null
    this.clearDrop()
    const wc = h.view.webContents
    wc.removeAllListeners('certificate-error')
    wc.removeAllListeners('login')
    wc.setAudioMuted(false)
    // The tab sets its own (see Tabs.wire).
    wc.setWindowOpenHandler(() => ({ action: 'deny' }))
    return { view: h.view, favicon: h.favicon }
  }

  /** Whether `wc` is the page loaded ahead. */
  owns(wc: WebContents | null | undefined): boolean {
    return !!wc && this.hidden?.view.webContents === wc
  }

  /** Drops the page loaded ahead if it's `wc`, which wants something only you can give. Returns whether it was. */
  refuse(wc: WebContents | null | undefined, why: string): boolean {
    if (!this.owns(wc)) return false
    this.drop(why)
    return true
  }

  drop(why?: string) {
    const h = this.hidden
    this.hidden = null
    this.clearWait()
    this.clearDrop()
    if (!h) return
    if (why) console.log(`[prerender] dropped ${hostOf(h.url)}: ${why}`)
    const win = this.deps.window()
    if (!win.isDestroyed()) win.contentView.removeChildView(h.view)
    if (!h.view.webContents.isDestroyed()) h.view.webContents.close()
  }

  private allowed(profile: string, url: string): boolean {
    if (!this.deps.enabled() || !/^https?:$/.test(protocolOf(url))) return false
    if (this.deps.isPrivate(url) || this.deps.dangerous(profile, url)) return false
    const own = this.deps.siteProfile(url)
    return !own || own === profile
  }

  private start(base: Base, url: string) {
    this.drop()
    const sess = this.deps.session(base.profile)
    const win = this.deps.window()
    if (!sess || win.isDestroyed()) return
    const view = new WebContentsView({ webPreferences: { session: sess, sandbox: true, contextIsolation: true } })
    view.setVisible(false)
    // At the page area's size, so the page lays out as it will be shown.
    view.setBounds(this.deps.bounds())
    view.setBorderRadius(9)
    win.contentView.addChildView(view)
    this.deps.onViewAdded()
    const h: Hidden = { base, url, view, bornAt: Date.now() }
    this.hidden = h
    this.dropTimer = setTimeout(() => this.drop(), KEEP_MS)
    const wc = view.webContents
    wc.setAudioMuted(true)
    this.watch(h, wc)
    const load = () => wc.loadURL(url).catch(() => {})
    if (!base.entries.length) return void load()
    // The tab's back list, then the new address: what the tab's own page would have after Return.
    // Restoring leaves the page without user agent client hints until its user agent is set again
    // (see Tabs.ensureView); not before restore resolves, which would stall it.
    const hints = () => !wc.isDestroyed() && wc.setUserAgent(sess.getUserAgent())
    wc.navigationHistory
      .restore({ entries: [...base.entries, { url, title: '' }], index: base.entries.length })
      .then(hints, () => {
        hints()
        return load()
      })
      .catch(() => {})
  }

  private watch(h: Hidden, wc: WebContents) {
    const gone = (why: string) => this.hidden === h && this.drop(why)
    const profile = h.base.profile
    wc.setWindowOpenHandler(() => {
      gone('it opened a window')
      return { action: 'deny' }
    })
    const check = (url: string) => {
      if (this.deps.isPrivate(url)) gone('redirected to a private address')
      else if (this.deps.dangerous(profile, url)) gone('a phishing or malware warning')
      else if ((this.deps.siteProfile(url) ?? profile) !== profile) gone('its site opens in another profile')
    }
    wc.on('did-start-navigation', (d) => d.isMainFrame && !d.isSameDocument && check(d.url))
    wc.on('did-redirect-navigation', (d) => d.isMainFrame && check(d.url))
    wc.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
      // -3 is a load replaced by another, which is fine.
      if (isMainFrame && code !== -3) gone(`it failed to load (${code})`)
    })
    wc.on('render-process-gone', () => gone('its page crashed'))
    wc.on('certificate-error', (event, url, _error, certificate, callback) => {
      event.preventDefault()
      const ok = this.deps.trusted(profile, url, certificate)
      callback(ok)
      if (!ok) gone('a certificate jbrow does not trust')
    })
    wc.on('login', (event, _details, _auth, callback) => {
      event.preventDefault()
      callback()
      gone('it asked to sign in')
    })
    wc.on('page-favicon-updated', (_e, favicons) => {
      if (favicons[0]) h.favicon = favicons[0]
    })
  }

  private clearWait() {
    if (this.waitTimer) clearTimeout(this.waitTimer)
    this.waitTimer = null
  }

  private clearDrop() {
    if (this.dropTimer) clearTimeout(this.dropTimer)
    this.dropTimer = null
    // A page still here goes once it has gone unwanted for KEEP_MS from when it started.
    const h = this.hidden
    if (h) this.dropTimer = setTimeout(() => this.drop(), Math.max(0, KEEP_MS - (Date.now() - h.bornAt)))
  }
}

function protocolOf(url: string): string {
  try {
    return new URL(url).protocol
  } catch {
    return ''
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}
