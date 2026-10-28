import { app, BrowserWindow, Menu, WebContentsView, clipboard, shell, type Rectangle, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { bezier } from '../shared/ease'
import { addressUrl, forcedSearch } from '../shared/engines'
import { urlMatcher } from '../shared/patterns'
import { MAX_PANES, PANE_HEAD, paneSpans, splitOf } from '../shared/split'
import { byOrder, createdBeside, flatten, isAsleep, isInFolder, isRoot, parentFolder, samePage, subtree, threadsOf } from '../shared/threads'
import type { CrashView, Folder, KeepLoaded, Profile, Split, TabRecord, UiTab } from '../shared/types'
import type { Certificates } from './certs'
import type { DangerousSites } from './dangerous'
import type { DeviceChooser } from './devices'
import { faviconUrl } from './favicons'
import type { Logins } from './logins'
import type { SitePermissions } from './permissions'
import type { ProfileRuntime } from './profiles'

interface LiveTab {
  view: WebContentsView
  /** The view's page, kept here because the view lets go of it once it's destroyed. */
  wc: WebContents
  loading: boolean
}

export interface TabsDeps {
  window: () => BrowserWindow
  runtime: (profileId: string) => ProfileRuntime | undefined
  contentBounds: () => Rectangle
  /** False while the panel is hidden; the active view stays hidden. It shows while the panel animates. */
  contentVisible: () => boolean
  /** A new view lands on top of everything; this puts jbrow's UI back where it belongs. */
  onViewAdded: () => void
  onChange: () => void
  /** Called after a tab becomes active, to move keyboard focus to it. */
  onActivated: () => void
  /** Moves keyboard focus back to what's in front: the active page, or jbrow's UI. */
  refocus: () => void
  /** Whimsy is on and macOS doesn't ask for reduced motion: pages slide in as you switch tabs. */
  whimsy: () => boolean
  /** Return true if jbrow handled the key, so the page doesn't see it. */
  onKey: (input: Electron.Input) => boolean
  searchUrl: () => string
  permissions: SitePermissions
  certs: Certificates
  dangerous: DangerousSites
  logins: Logins
  devices: DeviceChooser
  /** A page committed a navigation to a new document. */
  onNavigate: (wc: WebContents) => void
  /** A tab's page went to an address, for the browsing history; and its title arrived. */
  onVisit: (profile: string, url: string) => void
  onTitle: (profile: string, url: string, title: string) => void
  /** The page menu's Print… and Save as PDF…. */
  print: (wc: WebContents) => void
  saveAsPdf: (wc: WebContents) => void
  /** Save link, image or video: a download you asked for. */
  download: (wc: WebContents, url: string) => void
  profiles: () => Profile[]
  /** Opens a link as a new thread in another profile, next to the tab's thread. */
  openInProfile: (fromId: string, profile: string, url: string, background?: boolean) => void
  /** The profile an address always opens in, if its site has one (Sites under Profiles in settings). */
  siteProfile: (url: string) => string | undefined
  /** The active page went fullscreen or left it. */
  onFullscreen: (on: boolean, url: string) => void
  /** An extension is working in the page (its chrome.debugger is attached), so it doesn't sleep or archive. */
  held: (wc: WebContents) => boolean
  /**
   * A page with unsaved changes (beforeunload) wants to stay. Return true to leave anyway. It has
   * to answer before returning: Electron only lets the page go from inside the event.
   */
  confirmUnload: (id: string, kind: UnloadKind) => boolean
  /** The tab beside one in the sidebar that takes over when it closes, per settings. Asked before it goes. */
  besideClosed: (id: string) => string | undefined
  /** The tab's page closed itself with window.close(): a popup that's done, say. */
  closedByPage: (id: string) => void
  /** You're using an extension: one of its windows has focus, or you just pressed one of its shortcuts. */
  extensionInUse: () => boolean
}

/** What a page asking to stay would be left for: another page, the same one again, or nothing. */
export type UnloadKind = 'leave' | 'reload' | 'close'

export interface CreateOptions {
  profile: string
  url?: string
  /**
   * The tab it was opened from. The new tab goes right beside it in Today, or in the opener's app
   * section, on the side new tabs go. Never into Kept: a kept or pinned tab stays what it was, and
   * what it opens goes where new tabs go.
   */
  opener?: string
  scope?: string
  scopeName?: string
  app?: string
  activate?: boolean
  /** A guest WebContents Chromium already created for window.open. */
  webContents?: WebContents
  unread?: boolean
  /** The extension that opened it (chrome.tabs.create). */
  openedBy?: string
}

/**
 * The page is a PDF in Chromium's viewer. Asked in a world of jbrow's own, so the page's scripts
 * can't change the answer.
 */
async function isPdf(wc: WebContents): Promise<boolean> {
  try {
    return (await wc.executeJavaScriptInIsolatedWorld(1998, [{ code: 'document.contentType' }])) === 'application/pdf'
  } catch {
    return false
  }
}

/** Links a page hands jbrow to open. Other schemes (file:, javascript:, chrome:) stay where they are. */
const isWebUrl = (url: string) => /^https?:/i.test(url)

const storePath = () => path.join(app.getPath('userData'), 'tabs.json')
/** Back and forward lists, apart from tabs.json because they're bigger and change with every page. */
const historyPath = () => path.join(app.getPath('userData'), 'history.json')

/** A tab's back and forward list, as navigationHistory.restore takes it. */
type NavHistory = { entries: Electron.NavigationEntry[]; index: number }

/** How many back and forward entries a tab keeps, as in Chrome. */
const HISTORY_KEEP = 50

/** Archived threads are forgotten after this long. */
const ARCHIVE_KEEP_MS = 90 * 24 * 60 * 60 * 1000

/** How far the page you switch to slides in from, how long it takes, and its curve (the sidebar's glide). */
const SLIDE_PX = 14
const SLIDE_MS = 320
const SLIDE_EASE: [number, number, number, number] = [0.34, 1.25, 0.64, 1]

/** How long an extension may bring back the tab that was in front before it, without you using the extension. */
const EXTENSION_BACK_MS = 5000

/** How many closed tabs ⇧⌘T can bring back. */
const CLOSED_KEEP = 25

/** Where the IDs of tabs without a page since launch start, far past any WebContents ID. */
const PAGELESS_IDS = 1_000_000

/** How long a typed host gets to answer over https before the tab tries http, as in Chrome. */
const UPGRADE_WAIT_MS = 3000
/** No answer over http either: not online, the name doesn't resolve, or the load was stopped. */
const UPGRADE_KEEP_ERRORS = new Set([-3, -105, -106, -137])

/** A closed tab, with what it takes to put it back where it was. */
interface ClosedTab {
  rec: TabRecord
  /** Its place in `records`. */
  index: number
  history?: NavHistory
}

/** A tab waiting for its page to agree to close. */
interface Closing {
  remember: boolean
  /** Removes a kept tab too, rather than closing only its page. */
  remove: boolean
  /** Taken before the page goes, since a closed page has no back and forward list left to read. */
  history?: NavHistory
  done: (closed: boolean) => void
}

export class Tabs {
  records: TabRecord[] = []
  folders: Folder[] = []
  /** Tabs shown side by side. A tab is in one split at most; closing it down to one tab ends the split. */
  splits: Split[] = []
  /** Archived tabs. They have no views. */
  archived: TabRecord[] = []
  /** Bumped whenever `archived` changes, so the UI gets the list (which can be long) only then. */
  archivedRev = 0
  activeId: string | null = null
  private live = new Map<string, LiveTab>()
  /** The tabs layout() last put on screen, so it only has to hide those. */
  private placed: string[] = []
  private saveTimer: NodeJS.Timeout | null = null
  /** Most recently used first, for ⌃Tab. */
  private mru: string[] = []
  /** Set while jbrow hands a new view to the extensions library, which marks every new tab active. */
  private addingView = false
  /** The tab that was in front before the active one, and when it stopped being. */
  private leftFront: { id: string; at: number } | null = null
  /** Set while jbrow takes a view away from the extensions library, which reports that as the tab closing. */
  private droppingView = false
  /** Tabs whose page crashed or stopped responding, until it loads again. */
  private crashed = new Map<string, CrashView>()
  /** Stuck pages jbrow crashed on purpose, to reload once their process is gone, and whether to skip the cache. */
  private killing = new Map<string, boolean>()
  /** Tabs jbrow is reloading, so a page asking to stay is asked about reloading rather than leaving. */
  private reloading = new Set<string>()
  /** Tabs you closed whose page gets to ask first (beforeunload). */
  private closing = new Map<string, Closing>()
  /** Recently closed tabs, most recent last, for ⇧⌘T. Not kept across restarts. */
  private closed: ClosedTab[] = []
  /** The tab whose page is fullscreen. */
  private fullscreenId: string | null = null
  /**
   * Back and forward lists of tabs without a page (asleep, archived, or not opened since launch),
   * used instead of a plain load when their view is made. Saved to history.json.
   */
  private histories = new Map<string, NavHistory>()
  private historyTimer: NodeJS.Timeout | null = null
  /** Tabs whose back and forward list is being restored, with the address to end up on. */
  private restoring = new Map<string, string>()
  /**
   * Tabs going to a host typed without a scheme, which got https:// (see addressUrl). If the site
   * fails over https, shows a bad certificate or hasn't answered in UPGRADE_WAIT_MS, the tab goes
   * to http:// instead, as Chrome's HTTPS-Upgrades does. The wait starts once that load does.
   */
  private upgrades = new Map<string, { https: string; http: string; timer?: NodeJS.Timeout }>()
  /** When each tab last sent a link to its site's profile. See sendToSiteProfile. */
  private sentAt = new Map<string, number>()
  /** Tabs that fell back to http, with the https address whose error page is left in their history. */
  private fellBack = new Map<string, string>()

  /** How far above (less than 0) or below its place the shown page is while it slides in. */
  private slideY = 0
  private slideTimer: NodeJS.Timeout | null = null

  /**
   * The IDs extensions know tabs without a page by, to the tab. Chrome keeps a tab's ID when it
   * discards it, but here each page load is a new WebContents with a new ID. A tab whose page
   * unloaded keeps the ID its page had; one with no page since launch gets one from PAGELESS_IDS
   * up. Every ID a tab had reaches it, page or not, until it closes.
   */
  private extensionIds = new Map<number, string>()
  /** A tab without a page, to the ID extensions know it by now. */
  private pagelessIds = new Map<string, number>()
  private nextPagelessId = PAGELESS_IDS

  /** Kept and pinned threads whose pages never unload (see sweep). Main sets it from settings. */
  keepLoaded: KeepLoaded = { kept: false, pinned: true }

  constructor(private deps: TabsDeps) {}

  // ---------- persistence ----------

  load() {
    if (!existsSync(storePath())) return
    try {
      const data = JSON.parse(readFileSync(storePath(), 'utf8')) as {
        tabs: TabRecord[]
        activeId: string | null
        folders?: Folder[]
        splits?: Split[]
        archived?: TabRecord[]
      }
      // Empty new tabs aren't worth restoring.
      this.records = data.tabs.filter((t) => t.url)
      // Tabs saved while they nested in threads stand on their own now.
      flatten(this.records)
      flatten(data.archived ?? [])
      // Kept tabs from before pinned pages are kept on the page they're on.
      for (const t of this.records) if (t.kept && !t.home) this.setHome(t)
      this.folders = data.folders ?? []
      this.splits = data.splits ?? []
      this.prune()
      const cutoff = Date.now() - ARCHIVE_KEEP_MS
      this.archived = (data.archived ?? []).filter((t) => (t.archivedAt ?? 0) > cutoff)
      // Icons saved before jbrow fetched them itself were the sites' own URLs.
      for (const t of [...this.records, ...this.archived]) if (t.favicon) t.favicon = faviconUrl(t.profile, t.favicon)
      this.archivedRev++
      this.activeId = this.records.some((t) => t.id === data.activeId) ? data.activeId : null
      this.mru = [...this.records].sort((a, b) => b.lastSeen - a.lastSeen).map((t) => t.id)
      this.renumber()
    } catch (error) {
      console.error('[tabs] could not read tabs.json, starting empty:', error)
    }
    if (!existsSync(historyPath())) return
    try {
      const histories = JSON.parse(readFileSync(historyPath(), 'utf8')) as Record<string, NavHistory>
      for (const [id, h] of Object.entries(histories)) if (h.entries?.length) this.histories.set(id, h)
    } catch (error) {
      console.error('[tabs] could not read history.json, tabs start without back and forward:', error)
    }
  }

  private save() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = setTimeout(() => this.flush(), 400)
  }

  flush() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    this.saveTimer = null
    const data = { tabs: this.records, activeId: this.activeId, folders: this.folders, splits: this.splits, archived: this.archived }
    writeFileSync(storePath(), JSON.stringify(data, null, 2))
    this.flushHistory()
  }

  /** A page went somewhere; its back and forward list is saved a little later. */
  private saveHistory() {
    if (this.historyTimer) return
    this.historyTimer = setTimeout(() => this.flushHistory(), 3000)
  }

  private flushHistory() {
    if (this.historyTimer) clearTimeout(this.historyTimer)
    this.historyTimer = null
    for (const id of this.live.keys()) this.captureHistory(id)
    const ids = new Set([...this.records, ...this.archived].map((t) => t.id))
    for (const id of this.histories.keys()) if (!ids.has(id)) this.histories.delete(id)
    writeFileSync(historyPath(), JSON.stringify(Object.fromEntries(this.histories)))
  }

  /** The back and forward list of a tab's page, or the saved one if it has no page. */
  private historyOf(id: string): NavHistory | undefined {
    const wc = this.webContentsFor(id)
    if (!wc) return this.histories.get(id)
    const entries = wc.navigationHistory.getAllEntries()
    if (!entries.length) return undefined
    let index = wc.navigationHistory.getActiveIndex()
    // Keep the entries nearest the current one.
    const start = Math.max(0, Math.min(index - HISTORY_KEEP / 2, entries.length - HISTORY_KEEP))
    index -= start
    return { entries: entries.slice(start, start + HISTORY_KEEP), index }
  }

  private captureHistory(id: string) {
    const history = this.historyOf(id)
    if (history) this.histories.set(id, history)
  }

  private changed() {
    this.renumber()
    // A tab that went (closed, archived, dropped) leaves its split; one left alone fills the page area.
    if (this.prune()) this.layout()
    this.save()
    this.deps.onChange()
  }

  /**
   * Numbers the items in Kept 0, 1, 2… wherever they sit: the top of Kept and each folder, each
   * holding folders and threads. Items without a place yet go to the bottom, which lays out a
   * tabs.json from before ordering as folders first, then threads, oldest first. Pinned threads
   * have their own numbering.
   */
  private renumber() {
    const roots = this.records.filter((t) => t.kept && isRoot(this.records, t)).sort((a, b) => a.createdAt - b.createdAt)
    const kept = roots.filter((t) => !t.pinned)
    roots.filter((t) => t.pinned).sort(byOrder).forEach((t, i) => (t.order = i))
    const folders = [...this.folders].sort((a, b) => a.createdAt - b.createdAt)
    for (const container of [undefined, ...folders.map((f) => f.id)]) {
      const items = [
        ...folders.filter((f) => parentFolder(this.folders, f) === container),
        ...kept.filter((t) => this.containerOf(t) === container),
      ]
      items.sort(byOrder).forEach((item, i) => (item.order = i))
    }
  }

  /** The folder a kept item sits in, or undefined at the top of Kept. */
  private containerOf(item: Folder | TabRecord): string | undefined {
    if ('rules' in item) return parentFolder(this.folders, item)
    return item.folder && this.folder(item.folder) ? item.folder : undefined
  }

  // ---------- lookups ----------

  get(id: string | null | undefined) {
    return id ? this.records.find((t) => t.id === id) : undefined
  }
  active() {
    return this.get(this.activeId)
  }
  activeWebContents(): WebContents | null {
    const live = this.activeId ? this.live.get(this.activeId) : undefined
    return live && !live.wc.isDestroyed() ? live.wc : null
  }
  webContentsFor(id: string): WebContents | null {
    const live = this.live.get(id)
    return live && !live.wc.isDestroyed() ? live.wc : null
  }
  /** Every page that's loaded. */
  pages(): WebContents[] {
    return [...this.live.values()].map((l) => l.wc).filter((wc) => !wc.isDestroyed())
  }
  splitOf(id: string | null | undefined): Split | undefined {
    return splitOf(this.splits, id)
  }
  /** The tabs a tab shows with: its split, left to right, or just itself. */
  private panesOf(id: string): string[] {
    return this.splitOf(id)?.tabs ?? [id]
  }
  /** The tabs on screen: the active tab and the rest of its split. */
  shown(): string[] {
    return this.activeId ? this.panesOf(this.activeId) : []
  }
  idForWebContents(wc: WebContents): string | undefined {
    for (const [id, live] of this.live) if (live.wc === wc) return id
    return undefined
  }
  uiTabs(): UiTab[] {
    return this.records.map((t) => {
      const wc = this.webContentsFor(t.id)
      return {
        ...t,
        loading: this.live.get(t.id)?.loading ?? false,
        loaded: this.live.has(t.id),
        crashed: this.crashed.get(t.id)?.reason ? true : undefined,
        audible: wc?.isCurrentlyAudible() || undefined,
        muted: wc?.isAudioMuted() || undefined,
      }
    })
  }
  /** Mutes a tab's page, or lets it be heard again. */
  setMuted(id: string, muted: boolean) {
    const wc = this.webContentsFor(id)
    if (!wc || wc.isAudioMuted() === muted) return
    wc.setAudioMuted(muted)
    this.deps.onChange()
  }
  navState() {
    const wc = this.activeWebContents()
    return {
      canGoBack: wc?.navigationHistory.canGoBack() ?? false,
      canGoForward: wc?.navigationHistory.canGoForward() ?? false,
      loading: wc?.isLoading() ?? false,
    }
  }

  // ---------- lifecycle ----------

  create(opts: CreateOptions): TabRecord {
    const now = Date.now()
    const from = opts.opener ? this.get(opts.opener) : undefined
    const rec: TabRecord = {
      id: randomUUID(),
      profile: opts.profile,
      opener: from?.id,
      scope: from ? from.scope : opts.scope,
      scopeName: from ? from.scopeName : opts.scopeName,
      app: from ? from.app : opts.app,
      url: opts.url ?? '',
      title: '',
      createdAt: from ? createdBeside(this.records, from, now) : now,
      lastSeen: now,
      unread: opts.unread,
      openedBy: opts.openedBy,
    }
    this.records.push(rec)
    if (opts.webContents || rec.url) this.ensureView(rec, opts.webContents)
    if (opts.activate !== false) this.activate(rec.id)
    else this.changed()
    return rec
  }

  /** Reuses the active tab if it's an empty new tab outside a split, so new tabs don't pile up. */
  newTab(opts: Omit<CreateOptions, 'url'>): TabRecord {
    const cur = this.active()
    if (cur && !cur.url && !this.splitOf(cur.id)) {
      cur.profile = opts.profile
      cur.scope = opts.scope
      cur.scopeName = opts.scopeName
      cur.app = opts.app
      this.changed()
      return cur
    }
    return this.create(opts)
  }

  private ensureView(rec: TabRecord, guest?: WebContents): LiveTab | undefined {
    const existing = this.live.get(rec.id)
    if (existing) return existing
    const rt = this.deps.runtime(rec.profile)
    if (!rt) {
      console.error(`[tabs] no profile "${rec.profile}" for tab ${rec.id}`)
      return undefined
    }
    const view = guest
      ? new WebContentsView({ webContents: guest })
      : new WebContentsView({ webPreferences: { session: rt.session, sandbox: true, contextIsolation: true } })
    view.setVisible(false)
    // A tab opened in the background is laid out at the page area's size, as in Chrome, not at
    // 0×0 until it's first shown: its page measures a real viewport, and a debugger can capture it.
    view.setBounds(this.deps.contentBounds())
    view.setBorderRadius(9)
    const win = this.deps.window()
    win.contentView.addChildView(view)
    this.deps.onViewAdded()
    const live: LiveTab = { view, wc: view.webContents, loading: false }
    this.live.set(rec.id, live)
    this.wire(rec.id, view.webContents, rt)
    this.addingView = true
    try {
      rt.extensions.addTab(view.webContents, win)
      // Tell the library which tab is really in front, or a background tab would count as active.
      const active = this.activeId !== rec.id ? this.live.get(this.activeId ?? '') : undefined
      if (active && this.active()?.profile === rec.profile) rt.extensions.selectTab(active.wc)
    } finally {
      this.addingView = false
    }
    const history = this.histories.get(rec.id)
    if (guest) return live
    // A tab that was asleep or archived comes back where it was, with back and forward. One you
    // just typed an address into goes there after, so that address is one step further.
    const load = (url: string) => (url ? view.webContents.loadURL(url) : undefined)
    if (!history) void load(rec.url)?.catch(() => {})
    else {
      // An address typed while it's restoring (see navigate) replaces this one.
      this.restoring.set(rec.id, rec.url)
      const target = () => {
        const url = this.restoring.get(rec.id) ?? rec.url
        this.restoring.delete(rec.id)
        return url
      }
      // Electron's restore leaves the tab without user agent client hints, for good: no Sec-CH-UA
      // headers, and no navigator.userAgentData in workers. To Cloudflare that's a fake Chrome, and
      // Turnstile never lets it through (bistro.sk's login). Setting the user agent again brings
      // them back for everything after. Not before restore resolves: that stalls the restore.
      const hints = () => view.webContents.setUserAgent(rt.session.getUserAgent())
      void view.webContents.navigationHistory
        .restore(history)
        .then(
          () => {
            hints()
            const url = target()
            return history.entries[history.index]?.url !== url ? load(url) : undefined
          },
          () => {
            hints()
            return load(target())
          },
        )
        .catch(() => {})
    }
    return live
  }

  private wire(id: string, wc: WebContents, rt: ProfileRuntime) {
    const rec = () => this.get(id)
    wc.on('page-title-updated', (_e, title) => {
      const r = rec()
      if (r) {
        r.title = title
        if (r.home && samePage(wc.getURL()) === samePage(r.home.url)) r.home.title = title
        this.changed()
      }
      this.deps.onTitle(r?.profile ?? rt.profile.id, wc.getURL(), title)
    })
    wc.on('page-favicon-updated', (_e, favicons) => {
      const r = rec()
      if (r && favicons[0]) {
        r.favicon = faviconUrl(r.profile, favicons[0])
        if (r.home && samePage(wc.getURL()) === samePage(r.home.url)) r.home.favicon = r.favicon
        this.changed()
      }
    })
    const onNav = (_e: unknown, url: string) => {
      const r = rec()
      if (r) {
        r.url = url
        // A kept tab that had no page yet (a new pane split from one) is kept on its first.
        if (r.kept && !r.home) this.setHome(r)
        this.changed()
      }
      this.saveHistory()
    }
    wc.on('did-navigate', (e, url) => {
      // The site answered, over https or after falling back: nothing left to wait for.
      this.clearUpgrade(id)
      this.dropFailedUpgrade(id, wc, url)
      onNav(e, url)
      this.deps.onVisit(rec()?.profile ?? rt.profile.id, url)
      this.deps.logins.loaded(id)
      this.deps.onNavigate(wc)
    })
    wc.on('did-navigate-in-page', (e, url, isMainFrame) => {
      // A single-page site moving to another page counts as a visit; a jump to #section doesn't.
      const before = rec()?.url ?? ''
      onNav(e, url)
      if (isMainFrame && url.split('#')[0] !== before.split('#')[0]) this.deps.onVisit(rec()?.profile ?? rt.profile.id, url)
    })
    // Stopping from inside a navigation event crashes Electron. A tick later the site hasn't
    // answered yet, and a page that somehow got through still stays under the warning.
    const stopSoon = () => setImmediate(() => !wc.isDestroyed() && wc.stop())
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        this.reloading.delete(id)
        this.deps.certs.clear(id)
        this.deps.dangerous.clear(id)
        this.deps.logins.clear(id)
        this.deps.devices.cancel(id)
        this.setCrashed(id, null)
        this.upgradeStarted(id, wc, details.url)
        // A phishing or malware site: the page it's on stays, under jbrow's warning.
        if (this.deps.dangerous.check(id, rec()?.profile ?? rt.profile.id, details.url)) stopSoon()
      }
    })
    wc.on('did-redirect-navigation', (details) => {
      // The site answered over https.
      if (details.isMainFrame && this.upgrades.get(id)?.timer) this.clearUpgrade(id)
      if (details.isMainFrame && this.deps.dangerous.check(id, rec()?.profile ?? rt.profile.id, details.url)) stopSoon()
    })
    // HTTP auth for the page or a proxy. Logins answers once you sign in or cancel.
    wc.on('login', (event, _details, authInfo, callback) => {
      event.preventDefault()
      this.deps.logins.ask(id, authInfo, callback)
    })
    wc.on('render-process-gone', (_e, details) => {
      // Unloading an asleep thread's page or closing the tab drops its view first; that's no crash.
      if (details.reason === 'clean-exit' || this.live.get(id)?.wc !== wc) return
      const hard = this.killing.get(id)
      if (hard !== undefined) {
        this.killing.delete(id)
        return void (hard ? wc.reloadIgnoringCache() : wc.reload())
      }
      this.deps.logins.clear(id)
      this.deps.devices.cancel(id)
      this.setLoading(id, false)
      if (this.fullscreenId === id) this.setFullscreen(null)
      this.setCrashed(id, { reason: details.reason, hung: false })
    })
    wc.on('unresponsive', () => {
      if (!this.crashed.has(id)) this.setCrashed(id, { reason: '', hung: true })
    })
    wc.on('responsive', () => {
      if (this.crashed.get(id)?.hung) this.setCrashed(id, null)
    })
    // A page with unsaved changes asks before it goes, whether you close the tab, reload or go
    // elsewhere. Without an answer here Electron keeps the page and silently drops what you asked for.
    wc.on('will-prevent-unload', (event) => {
      const closing = this.closing.get(id)
      const kind: UnloadKind = closing ? 'close' : this.reloading.has(id) ? 'reload' : 'leave'
      this.reloading.delete(id)
      if (this.deps.confirmUnload(id, kind)) return event.preventDefault()
      if (closing) {
        this.closing.delete(id)
        closing.done(false)
      }
    })
    wc.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
      if (isMainFrame && url === this.upgrades.get(id)?.https && !UPGRADE_KEEP_ERRORS.has(code)) this.fallBack(id, wc)
    })
    wc.on('certificate-error', (event, url, error, certificate, callback, isMainFrame) => {
      event.preventDefault()
      // jbrow added the https; a bad certificate there means trying http, not a warning.
      const profileId = rec()?.profile ?? rt.profile.id
      if (isMainFrame && url === this.upgrades.get(id)?.https && !this.deps.certs.trusted(profileId, url, certificate)) return callback(false)
      callback(this.deps.certs.onError(id, rec()?.profile ?? rt.profile.id, url, error, certificate, isMainFrame))
    })
    // The sidebar shows which tabs make sound, so a page playing somewhere out of sight can be found.
    wc.on('audio-state-changed', () => this.deps.onChange())
    wc.on('did-start-loading', () => this.setLoading(id, true))
    wc.on('did-stop-loading', () => this.setLoading(id, false))
    wc.on('before-input-event', (event, input) => {
      // Esc leaves fullscreen, as in Chrome; the page doesn't get it.
      if (input.type === 'keyDown' && input.key === 'Escape' && this.fullscreenId === id) {
        event.preventDefault()
        return this.leaveFullscreen()
      }
      if (this.deps.onKey(input)) event.preventDefault()
    })
    wc.on('context-menu', (_e, params) => void this.contextMenu(id, wc, params, rt))
    // A tab opened in the background (⌘-click) takes keyboard focus as it starts up. Hidden, it
    // gets no keys, so ⌘W and the rest went nowhere until you clicked; hand focus back.
    wc.on('focus', () => {
      if (!this.shown().includes(id)) this.deps.refocus()
    })
    // Clicking into another pane of the split focuses it, toolbar and keys and all. Taken from the
    // click, not from the page getting focus: focus also passes through panes on its own, when one
    // loads or while jbrow hands it elsewhere (on Linux, focusing jbrow's UI does).
    wc.on('before-mouse-event', (_e, mouse) => {
      if (mouse.type === 'mouseDown' && id !== this.activeId && this.shown().includes(id)) this.activate(id)
    })
    this.deps.devices.watch(wc, rt.profile.id)
    wc.on('enter-html-full-screen', () => {
      // Only the page in front can have the screen; one in the background stays in its place.
      if (id !== this.activeId) return void this.exitFullscreen(wc)
      this.setFullscreen(id)
    })
    wc.on('leave-html-full-screen', () => {
      if (this.fullscreenId === id) this.setFullscreen(null)
    })

    // A link to a site that has a profile of its own opens there, and this page stays. Redirects
    // stay put: a sign-in that passes through the site would lose its way.
    wc.on('will-navigate', (e) => {
      if (!e.isMainFrame || e.isSameDocument) return
      const from = rec()?.profile ?? rt.profile.id
      const to = this.deps.siteProfile(e.url)
      if (!to || to === from || !isWebUrl(wc.getURL()) || !this.sendToSiteProfile(id, to, e.url)) return
      e.preventDefault()
    })

    wc.setWindowOpenHandler((details) => {
      const background = details.disposition === 'background-tab'
      // So does a link opened in a new tab. A popup doesn't: it needs its opener.
      const to = background || details.disposition === 'foreground-tab' ? this.deps.siteProfile(details.url) : undefined
      if (to && to !== (rec()?.profile ?? rt.profile.id) && this.sendToSiteProfile(id, to, details.url, background)) return { action: 'deny' }
      // A popup (window.open with a size: a sign-in, a payment, a Proxmox console) is a tab too.
      // It keeps its opener and can close itself, as a window could, and it gets what tabs have
      // and windows don't: the certificate you trusted, sign-in sheets, keys.
      return {
        action: 'allow',
        outlivesOpener: true,
        // Electron passes the guest WebContents here, though its typings don't say so.
        createWindow: (options) => {
          const guest = (options as { webContents?: WebContents }).webContents
          const r = rec()
          const child = this.create({
            profile: r?.profile ?? rt.profile.id,
            opener: id,
            webContents: guest,
            url: details.url,
            activate: !background,
            unread: background,
          })
          // Chromium navigates the guest itself, under the opener's rules.
          return this.live.get(child.id)!.wc
        },
      }
    })

    // Electron emits this for window.close(), though its typings don't say so. Chromium only lets
    // it through for a page a script opened, or one with nothing to go back to. jbrow closing the
    // tab (closeAsking) emits it too; 'destroyed' handles that one.
    ;(wc as unknown as NodeJS.EventEmitter).on('close', () => {
      if (this.live.get(id)?.wc === wc && !this.closing.has(id)) this.deps.closedByPage(id)
    })

    wc.on('destroyed', () => {
      this.sentAt.delete(id)
      // A page that agreed to close: now the tab goes.
      const closing = this.closing.get(id)
      if (closing) {
        this.closing.delete(id)
        if (this.live.get(id)?.wc === wc) this.close(id, closing.remember, closing.history, closing.remove)
        closing.done(true)
      }
      if (this.fullscreenId === id) this.setFullscreen(null)
      // A crashed page's view may have been replaced by now; only forget this one.
      if (this.live.get(id)?.wc === wc) this.live.delete(id)
      this.killing.delete(id)
      this.deps.certs.clear(id)
      this.deps.dangerous.clear(id)
      this.deps.logins.clear(id)
      this.deps.devices.cancel(id)
      this.setCrashed(id, null)
    })
  }

  private setFullscreen(id: string | null) {
    this.fullscreenId = id
    const live = id ? this.live.get(id) : undefined
    live?.view.setBorderRadius(0)
    for (const [tid, l] of this.live) if (tid !== id) l.view.setBorderRadius(9)
    this.deps.onFullscreen(!!id, (id && this.webContentsFor(id)?.getURL()) || '')
    this.layout()
  }

  private exitFullscreen(wc: WebContents) {
    if (!wc.isDestroyed()) void wc.executeJavaScript('document.fullscreenElement && document.exitFullscreen()', true).catch(() => {})
  }

  /** Takes the fullscreen page back into the panel: jbrow is hiding, or you went to another tab. */
  leaveFullscreen() {
    const id = this.fullscreenId
    if (!id) return
    const wc = this.webContentsFor(id)
    this.setFullscreen(null)
    if (wc) this.exitFullscreen(wc)
  }

  private setCrashed(id: string, crash: CrashView | null) {
    if (crash) this.crashed.set(id, crash)
    else if (!this.crashed.delete(id)) return
    this.deps.onChange()
    if (id !== this.activeId) return
    this.layout()
    // Keyboard focus moves to jbrow's crash screen, so ⌘R still works, and back to the page after.
    this.deps.onActivated()
  }

  /** Why the tab's page is gone or stuck, if it is. */
  crash(id: string): CrashView | null {
    return this.crashed.get(id) ?? null
  }

  /**
   * Reloads the tab's page, from the network if `hard` (⇧⌘R). A stuck page can't unload by
   * itself, so its process is ended first and the page reloads once it's gone.
   */
  reload(id: string, hard = false) {
    const wc = this.webContentsFor(id)
    if (!wc) return
    if (!this.crashed.get(id)?.hung || wc.isCrashed()) {
      this.reloading.add(id)
      return hard ? wc.reloadIgnoringCache() : wc.reload()
    }
    this.killing.set(id, hard)
    wc.forcefullyCrashRenderer()
  }

  /** Wait on a stuck page: shows it again, and asks again if it stays stuck. */
  wait(id: string) {
    if (this.crashed.get(id)?.hung) this.setCrashed(id, null)
  }

  private setLoading(id: string, loading: boolean) {
    const live = this.live.get(id)
    if (live && live.loading !== loading) {
      live.loading = loading
      this.deps.onChange()
    }
  }

  private async contextMenu(id: string, wc: WebContents, params: Electron.ContextMenuParams, rt: ProfileRuntime) {
    const pdf = await isPdf(wc)
    if (wc.isDestroyed()) return
    const items: Electron.MenuItemConstructorOptions[] = []
    const section = (...more: Electron.MenuItemConstructorOptions[]) => items.push(...more, { type: 'separator' })
    const openHere = (url: string, background = false) =>
      this.create({ profile: rt.profile.id, opener: id, url, activate: !background, unread: background || undefined })
    const others = this.deps.profiles().filter((p) => p.id !== rt.profile.id)

    if (params.misspelledWord) {
      const suggestions = params.dictionarySuggestions.slice(0, 5)
      section(
        ...(suggestions.length
          ? suggestions.map((word) => ({ label: word, click: () => wc.replaceMisspelling(word) }))
          : [{ label: 'No suggestions', enabled: false }]),
        { label: 'Add to dictionary', click: () => wc.session.addWordToSpellCheckerDictionary(params.misspelledWord) },
      )
    }
    if (params.linkURL) {
      const web = isWebUrl(params.linkURL)
      section(
        { label: 'Open link in new tab', enabled: web, click: () => openHere(params.linkURL) },
        { label: 'Open link in background', enabled: web, click: () => openHere(params.linkURL, true) },
        ...(others.length
          ? [{
              label: 'Open link in profile',
              enabled: web,
              submenu: others.map((p) => ({ label: p.name, click: () => this.deps.openInProfile(id, p.id, params.linkURL) })),
            }]
          : []),
        { label: 'Save link', enabled: web, click: () => this.deps.download(wc, params.linkURL) },
        { label: 'Copy link', click: () => clipboard.writeText(params.linkURL) },
      )
    }
    const media = params.mediaType === 'image' ? 'image' : params.mediaType === 'video' ? 'video' : params.mediaType === 'audio' ? 'audio' : null
    if (media && params.srcURL) {
      // blob: and MediaSource addresses (most streaming video) only exist inside the page.
      const reachable = isWebUrl(params.srcURL) || (media === 'image' && params.srcURL.startsWith('data:'))
      section(
        { label: `Open ${media} in new tab`, enabled: isWebUrl(params.srcURL), click: () => openHere(params.srcURL) },
        { label: `Save ${media}`, enabled: reachable, click: () => this.deps.download(wc, params.srcURL) },
        ...(media === 'image' ? [{ label: 'Copy image', enabled: params.hasImageContents, click: () => wc.copyImageAt(params.x, params.y) }] : []),
        { label: `Copy ${media} address`, enabled: reachable, click: () => clipboard.writeText(params.srcURL) },
      )
    }
    const selection = params.selectionText.trim().replace(/\s+/g, ' ')
    if (params.isEditable) {
      section({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'pasteAndMatchStyle' }, { role: 'selectAll' })
    } else if (selection) {
      section({ role: 'copy' })
    }
    if (selection && !params.linkURL) {
      const short = selection.length > 32 ? `${selection.slice(0, 30)}…` : selection
      section(
        { label: `Search ${searchEngineName(this.deps.searchUrl())} for “${short}”`, click: () => openHere(toUrl(selection, this.deps.searchUrl(), true)) },
        ...(process.platform === 'darwin' ? [{ label: `Look Up “${short}”`, click: () => wc.showDefinitionForSelection() }] : []),
      )
    }
    items.push(
      { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => this.reload(id) },
      { type: 'separator' },
      { label: 'Print…', click: () => this.deps.print(wc) },
    )
    const url = wc.getURL()
    // A PDF already is one: saving it keeps the file itself, as the viewer's own download button does.
    if (!pdf) items.push({ label: 'Save as PDF…', click: () => this.deps.saveAsPdf(wc) })
    else if (isWebUrl(url)) items.push({ label: 'Save PDF', click: () => this.deps.download(wc, url) })
    else if (url.startsWith('file:')) items.push({ label: 'Show in Finder', click: () => shell.showItemInFolder(fileURLToPath(url)) })
    if (this.deps.permissions.has(rt.profile.id, url)) {
      items.push({ label: 'Reset site permissions', click: () => this.deps.permissions.reset(rt.profile.id, url) })
    }
    const extensionItems = rt.extensions.getContextMenuItems(wc, params)
    const menu = Menu.buildFromTemplate([
      ...items,
      ...(extensionItems.length ? [{ type: 'separator' as const }] : []),
      { type: 'separator' },
      { label: 'Inspect', click: () => wc.inspectElement(params.x, params.y) },
    ])
    for (const item of extensionItems) menu.insert(menu.items.length - 2, item)
    menu.popup({ window: this.deps.window() })
  }

  /**
   * An extension (chrome.tabs.update) or the extensions library wants this tab in front. Only
   * while you're using the extension, or to give back the tab that was in front a moment ago (Stem
   * does, after a page it clicked opened a tab in front). Otherwise a page pulls you away from the
   * one you're on: Bitwarden ends every passkey request by bringing its page to the front, even
   * the quiet one a sign-in page makes each time it loads in the background.
   */
  selectFromExtension(wc: WebContents) {
    if (this.addingView) return
    const id = this.idForWebContents(wc)
    if (!id || id === this.activeId) return
    const back = this.leftFront?.id === id && Date.now() - this.leftFront.at < EXTENSION_BACK_MS
    if (back || this.deps.extensionInUse()) return this.activate(id)
    // The library already counts it active; once it's done telling extensions so, put back the real one.
    queueMicrotask(() => {
      const active = this.active()
      const live = active && this.live.get(active.id)
      if (live && active.profile === this.get(id)?.profile) this.deps.runtime(active.profile)?.extensions.selectTab(live.wc)
    })
  }

  activate(id: string) {
    if (!this.get(id)) return
    const panes = this.panesOf(id)
    const wasShown = this.shown()
    const from = this.records.findIndex((t) => t.id === this.activeId)
    // Drop empty new tabs you've moved away from, panes of a split you left included. An empty
    // pane of the split you stay in stays.
    for (const prev of this.shown().map((p) => this.get(p))) {
      if (!prev || panes.includes(prev.id) || prev.url || this.live.has(prev.id)) continue
      this.records = this.records.filter((t) => t.id !== prev.id)
      this.mru = this.mru.filter((m) => m !== prev.id)
    }
    if (this.fullscreenId && this.fullscreenId !== id) this.leaveFullscreen()
    if (this.activeId && this.activeId !== id) this.leftFront = { id: this.activeId, at: Date.now() }
    this.activeId = id
    // Every pane of a split is on screen, so each counts as seen and has its page.
    const now = Date.now()
    for (const pane of panes.map((p) => this.get(p))) {
      if (!pane) continue
      pane.lastSeen = now
      pane.unread = false
      if (pane.url) this.ensureView(pane)
    }
    this.mru = [id, ...this.mru.filter((m) => m !== id)]
    const live = this.live.get(id)
    if (live) {
      this.deps.runtime(this.get(id)!.profile)?.extensions.selectTab(live.wc)
    }
    // Another pane of the same split, or the tab again, keeps its page where it is (sliding or not).
    const to = this.records.findIndex((t) => t.id === id)
    if (from >= 0 && !panes.some((p) => wasShown.includes(p))) this.slideIn(to > from ? SLIDE_PX : -SLIDE_PX)
    this.layout()
    this.changed()
    this.deps.onActivated()
  }

  /**
   * Whimsy: the page you switch to slides into place from a little below if its tab is further
   * down the sidebar, from above if it's further up, overshooting a touch. Only its place changes,
   * never its size, so the page doesn't lay out again on every frame.
   */
  private slideIn(from: number) {
    if (this.slideTimer) clearInterval(this.slideTimer)
    this.slideTimer = null
    this.slideY = 0
    if (!this.deps.whimsy() || !this.deps.contentVisible() || this.fullscreenId) return
    const start = performance.now()
    this.slideY = from
    this.slideTimer = setInterval(() => {
      const t = Math.min(1, (performance.now() - start) / SLIDE_MS)
      this.slideY = Math.round(from * (1 - bezier(SLIDE_EASE, t)))
      if (t >= 1) {
        clearInterval(this.slideTimer!)
        this.slideTimer = null
      }
      this.layout()
    }, 1000 / 120)
  }

  /**
   * Positions the active view, and the other panes of its split beside it, and shows them if the
   * panel allows. A page a certificate or the phishing and malware lists stopped, a site asking
   * for a password, or a crashed page stays hidden, so jbrow's screen beneath it shows. A
   * fullscreen page has the screen to itself.
   */
  layout() {
    const shown = this.shown()
    for (const id of this.placed) if (!shown.includes(id)) this.live.get(id)?.view.setVisible(false)
    this.placed = shown
    const area = this.deps.contentBounds()
    const split = this.fullscreenId ? undefined : this.splitOf(this.activeId)
    const spans = split ? paneSpans(area.width, split.sizes) : null
    shown.forEach((id, i) => {
      const live = this.live.get(id)
      if (!live) return
      const on = !this.fullscreenId || id === this.fullscreenId
      if (on) {
        const y = area.y + (this.fullscreenId ? 0 : this.slideY)
        live.view.setBounds(
          spans
            ? { x: area.x + spans[i].x, y: y + PANE_HEAD, width: spans[i].width, height: Math.max(0, area.height - PANE_HEAD) }
            : { ...area, y },
        )
      }
      live.view.setVisible(on && this.deps.contentVisible() && !this.covered(id))
    })
  }

  /** jbrow shows its own screen in place of the tab's page. */
  covered(id: string) {
    return this.deps.certs.isBlocked(id) || this.deps.dangerous.isBlocked(id) || this.deps.logins.isAsking(id) || this.crashed.has(id)
  }

  /**
   * Opens a link from tab `id` in its site's profile. Electron doesn't say whether you clicked it,
   * so a page can't flood another profile with tabs: past one a second, links load where they are.
   */
  private sendToSiteProfile(id: string, profile: string, url: string, background?: boolean): boolean {
    const now = Date.now()
    if (now - (this.sentAt.get(id) ?? 0) < 1000) return false
    this.sentAt.set(id, now)
    this.deps.openInProfile(id, profile, url, background)
    return true
  }

  /** `search` sends the text to the search engine even if it looks like an address. */
  navigate(input: string, search = false) {
    const url = toUrl(input, this.deps.searchUrl(), search)
    const rec = this.active()
    if (!rec) return
    rec.url = url
    this.clearUpgrade(rec.id)
    const text = input.trim()
    if (!search && url.startsWith('https://') && url !== text && url === addressUrl(text)) {
      const https = new URL(url)
      const http = new URL(url)
      http.protocol = 'http:'
      this.upgrades.set(rec.id, { https: https.href, http: http.href })
    }
    // A tab without a page goes to the address once its view is made.
    const live = this.live.get(rec.id)
    if (!live) this.ensureView(rec)
    // Its back and forward list is still coming back, which would take over; it goes there after.
    else if (this.restoring.has(rec.id)) this.restoring.set(rec.id, url)
    else if (live.wc.getURL() !== url) void live.wc.loadURL(url).catch(() => {})
    this.activate(rec.id)
  }

  /** A tab's page started a load: the https one an upgrade waits on, or something else instead. */
  private upgradeStarted(id: string, wc: WebContents, url: string) {
    const u = this.upgrades.get(id)
    if (!u) return
    // Restoring a back and forward list loads its own page first; only that one is let past.
    if (url === u.https) u.timer ??= setTimeout(() => this.fallBack(id, wc), UPGRADE_WAIT_MS)
    else if (u.timer) this.clearUpgrade(id)
  }

  private clearUpgrade(id: string) {
    clearTimeout(this.upgrades.get(id)?.timer)
    this.upgrades.delete(id)
  }

  /** The https address didn't work out: the tab goes to http instead. */
  private fallBack(id: string, wc: WebContents) {
    const u = this.upgrades.get(id)
    this.clearUpgrade(id)
    if (!u || wc.isDestroyed()) return
    this.fellBack.set(id, u.https)
    const rec = this.get(id)
    if (rec) rec.url = u.http
    // Still waiting on https.
    if (wc.isLoading()) wc.stop()
    void wc.loadURL(u.http).catch(() => {})
  }

  /** A failed https load leaves its error page in the history; Back shouldn't go there. */
  private dropFailedUpgrade(id: string, wc: WebContents, url: string) {
    const https = this.fellBack.get(id)
    if (!https) return
    this.fellBack.delete(id)
    const nav = wc.navigationHistory
    const prev = nav.getActiveIndex() - 1
    if (url.startsWith('http:') && prev >= 0 && nav.getEntryAtIndex(prev)?.url === https) nav.removeEntryAtIndex(prev)
  }

  /**
   * Closes a tab you asked to close. Its page may ask first if it has unsaved changes
   * (beforeunload), as in Chrome; resolves with whether the tab closed. A page that doesn't ask
   * closes a moment later, once its process lets it go. A crashed or stuck page can't ask.
   */
  closeAsking(id: string, remember = true, remove = false): Promise<boolean> {
    const wc = this.webContentsFor(id)
    if (!wc || this.crashed.has(id)) {
      this.close(id, remember, undefined, remove)
      return Promise.resolve(true)
    }
    // Already asking: a second ⌘W waits on the same answer.
    const pending = this.closing.get(id)
    if (pending) return new Promise((resolve) => (pending.done = chain(pending.done, resolve)))
    return new Promise((resolve) => {
      this.closing.set(id, { remember, remove, history: this.historyOf(id), done: resolve })
      wc.close({ waitForBeforeUnload: true })
    })
  }

  /**
   * Closes a tab now; its page doesn't get to ask, as when Chrome discards a tab. For closes
   * jbrow does on its own or many at once. `remember` false leaves it out of what ⇧⌘T reopens.
   * A kept or pinned tab only closes its page, as in Arc: it stays in the sidebar, back on its
   * pinned page for when you next open it. `remove` takes it out of the sidebar too.
   */
  close(id: string, remember = true, history?: NavHistory, remove = false) {
    const rec = this.get(id)
    if (!rec) return
    this.clearUpgrade(id)
    this.fellBack.delete(id)
    const panes = this.panesOf(id)
    const beside = this.activeId === id && !rec.kept ? this.deps.besideClosed(id) : undefined
    if (rec.kept && rec.home && !remove) {
      this.dropView(rec)
      this.histories.delete(rec.id)
      // Its split carries on without it, so opening the split doesn't load it again.
      this.leaveSplit(id)
      rec.url = rec.home.url
      rec.title = rec.home.title
      rec.favicon = rec.home.favicon
      rec.unread = undefined
    } else {
      if (remember && rec.url) this.remember(rec, history)
      this.dropView(rec)
      this.records = this.records.filter((t) => t.id !== id)
    }
    this.mru = this.mru.filter((m) => m !== id)
    this.prune()
    if (this.activeId === id) {
      this.activeId = null
      // In a split, the pane to its left (or right) takes over. Otherwise the tab beside it in the
      // sidebar, on the side new tabs go, or else the last one used outside Kept; a kept tab only
      // comes up when asked for.
      const i = panes.indexOf(id)
      const pane = [panes[i - 1], panes[i + 1]].find((p) => p && p !== id && this.get(p))
      const next = pane ?? (beside && this.get(beside) ? beside : undefined) ?? this.mru.find((m) => {
        const t = this.get(m)
        return t && !t.kept
      })
      if (next) this.activate(next)
      else this.layout()
    }
    this.changed()
  }

  /** Remembers the page a kept tab is on as its pinned page. */
  private setHome(rec: TabRecord) {
    rec.home = rec.url ? { url: rec.url, title: rec.title, favicon: rec.favicon } : undefined
  }

  /** Makes the page a kept or pinned tab is on its pinned page, which closing it goes back to. */
  keepHere(id: string) {
    const rec = this.get(id)
    if (!rec?.kept) return
    this.setHome(rec)
    this.changed()
  }

  /**
   * Takes a kept or pinned tab back to its pinned page, as clicking the favicon of one that's
   * wandered off does in Arc.
   */
  goHome(id: string) {
    const rec = this.get(id)
    if (!rec?.kept || !rec.home) return
    const wc = this.webContentsFor(id)
    if (wc) void wc.loadURL(rec.home.url).catch(() => {})
    else {
      rec.url = rec.home.url
      this.histories.delete(id)
    }
    this.activate(id)
  }

  private remember(rec: TabRecord, history = this.historyOf(rec.id)) {
    this.closed.push({ rec: { ...rec }, index: this.records.indexOf(rec), history })
    if (this.closed.length > CLOSED_KEEP) this.closed.shift()
  }

  canReopen() {
    return this.closed.some((c) => this.deps.runtime(c.rec.profile))
  }

  /** ⇧⌘T: brings back the most recently closed tab where it was. Tabs of deleted profiles are skipped. */
  reopen(): TabRecord | undefined {
    let c: ClosedTab | undefined
    while ((c = this.closed.pop()) && !this.deps.runtime(c.rec.profile));
    if (!c) return undefined
    const rec: TabRecord = { ...c.rec, id: this.get(c.rec.id) ? randomUUID() : c.rec.id, lastSeen: Date.now(), unread: undefined }
    if (rec.folder && !this.folder(rec.folder)) rec.folder = undefined
    if (c.history) this.histories.set(rec.id, c.history)
    this.records.splice(Math.min(c.index, this.records.length), 0, rec)
    this.activate(rec.id)
    return rec
  }

  private dropView(rec: TabRecord) {
    const live = this.live.get(rec.id)
    if (!live) return
    this.captureHistory(rec.id)
    this.deps.window().contentView.removeChildView(live.view)
    this.live.delete(rec.id)
    // A page that agreed to close is gone already.
    const wc = live.wc
    this.extensionIds.set(wc.id, rec.id)
    this.pagelessIds.set(rec.id, wc.id)
    if (wc.isDestroyed()) return
    this.droppingView = true
    try {
      this.deps.runtime(rec.profile)?.extensions.removeTab(wc)
    } finally {
      this.droppingView = false
    }
    wc.close()
  }

  /**
   * Moves a tab to another profile in place. A page can't change its session, so a loaded one
   * closes and loads again in the other profile's, back and forward kept.
   */
  setProfile(id: string, profile: string) {
    const rec = this.get(id)
    if (!rec || rec.profile === profile) return
    const loaded = this.live.has(id)
    this.dropView(rec)
    rec.profile = profile
    const live = loaded ? this.ensureView(rec) : undefined
    if (live && id === this.activeId) this.deps.runtime(profile)?.extensions.selectTab(live.wc)
    this.layout()
    this.changed()
  }

  closeWebContents(wc: WebContents) {
    if (this.droppingView) return
    const id = this.idForWebContents(wc)
    if (id) this.close(id)
  }

  // ---------- tabs without a page, for extensions ----------

  /** A profile's tabs without a page, with the ID extensions know each by (see extensionIds). */
  pageless(profile: string): { id: number; rec: TabRecord }[] {
    for (const [id, recId] of this.extensionIds) if (!this.get(recId)) this.extensionIds.delete(id)
    for (const recId of this.pagelessIds.keys()) if (!this.get(recId)) this.pagelessIds.delete(recId)
    const out: { id: number; rec: TabRecord }[] = []
    for (const rec of this.records) {
      // An empty new tab is nothing to an extension.
      if (rec.profile !== profile || !rec.url || this.live.has(rec.id)) continue
      let id = this.pagelessIds.get(rec.id)
      if (id === undefined) {
        id = this.nextPagelessId++
        this.pagelessIds.set(rec.id, id)
        this.extensionIds.set(id, rec.id)
      }
      out.push({ id, rec })
    }
    return out
  }

  /** The ID a tab without a page goes by now, for one an extension knows by any ID it had. */
  pagelessId(profile: string, id: number): number | undefined {
    const rec = this.get(this.extensionIds.get(id))
    if (!rec || rec.profile !== profile || this.live.has(rec.id)) return undefined
    return this.pageless(profile).find((p) => p.rec === rec)?.id
  }

  /**
   * The page of the tab an extension knows by `id`, an ID its page had or the one it has without
   * a page. With `wake`, a tab without a page gets it, in the background.
   */
  pageFor(profile: string, id: number, wake: boolean): WebContents | undefined {
    const rec = this.get(this.extensionIds.get(id))
    if (!rec || rec.profile !== profile) return undefined
    const live = this.live.get(rec.id)
    if (live) return live.wc.isDestroyed() ? undefined : live.wc
    if (!wake || !rec.url) return undefined
    const woke = this.ensureView(rec)
    this.changed()
    return woke?.wc
  }

  /** chrome.tabs.remove on a tab without a page. */
  closePageless(profile: string, id: number) {
    const rec = this.get(this.extensionIds.get(id))
    if (rec && rec.profile === profile && !this.live.has(rec.id)) this.close(rec.id)
  }

  private held(rec: TabRecord) {
    const wc = this.live.get(rec.id)?.wc
    return !!wc && !wc.isDestroyed() && this.deps.held(wc)
  }

  rename(id: string, name: string) {
    const rec = this.get(id)
    if (!rec) return
    const trimmed = name.trim()
    rec.name = trimmed && trimmed !== rec.title ? trimmed : undefined
    this.changed()
  }

  /** Keeps a tab (in `folder`, if there is one) or moves it out of Kept. */
  move(id: string, kept: boolean, folder?: string) {
    const rec = this.get(id)
    if (!rec) return
    this.toThread(rec, kept, folder)
    this.changed()
  }

  /** Puts a tab in Kept (in `folder`, if there is one) or out of it, unpinned either way. */
  private toThread(rec: TabRecord, kept: boolean, folder?: string) {
    const into = kept && folder && this.folder(folder) ? folder : undefined
    // Somewhere new in Kept, it goes to the bottom.
    if (!kept || !rec.kept || rec.pinned || rec.folder !== into) rec.order = undefined
    // Kept now, it's kept on the page it's on; out of Kept, it has no pinned page.
    if (kept && !rec.kept) this.setHome(rec)
    if (!kept) rec.home = undefined
    rec.kept = kept || undefined
    rec.pinned = undefined
    rec.folder = into
  }

  /**
   * Pins a tab as a thread of its own, just before or after another pinned thread, or after the
   * last one without a `target`. Pinned threads are kept, so they never sleep or archive.
   */
  pin(id: string, target: string | null = null, after = false) {
    const rec = this.get(id)
    const at = target ? this.get(target) : undefined
    if (!rec || id === target || (target && !(at?.pinned && at.kept))) return
    if (!rec.pinned) this.toThread(rec, true)
    rec.pinned = true
    rec.order = at ? (at.order ?? 0) + (after ? 0.5 : -0.5) : undefined
    this.changed()
    this.loadPinned()
  }

  /** Loads the pages of pinned threads that have none yet, when settings keep them loaded, so they're ready when clicked. */
  loadPinned() {
    if (!this.keepLoaded.pinned) return
    for (const t of this.records) if (t.pinned && t.kept && t.url && !this.live.has(t.id)) this.ensureView(t)
  }

  /**
   * Puts a folder or thread in Kept just before or after another item there, in the same folder,
   * or at the bottom of the top of Kept without a `target`. A folder doesn't go inside itself.
   */
  place(id: string, target: string | null, after = false) {
    const at = target ? (this.folder(target) ?? this.get(target)) : undefined
    if (target && (!at || id === target)) return
    if (at && !('rules' in at) && !(at.kept && !at.pinned)) return
    const into = at && this.containerOf(at)
    const folder = this.folder(id)
    let item: Folder | TabRecord
    if (folder) {
      if (into && isInFolder(this.folders, into, id)) return
      folder.parent = into
      item = folder
    } else {
      const rec = this.get(id)
      if (!rec) return
      this.toThread(rec, true, into)
      item = rec
    }
    item.order = at ? (at.order ?? 0) + (after ? 0.5 : -0.5) : undefined
    this.changed()
  }

  /**
   * Moves threads to new app scopes, open and archived alike, after apps are linked or
   * unlinked. `to` gives a thread's scope and the name to use if that differs from its own.
   */
  rescope(to: (rec: TabRecord) => { scope: string; scopeName: string }) {
    let changed = false
    for (const rec of [...this.records, ...this.archived]) {
      if (!rec.scope) continue
      const next = to(rec)
      if (!next || next.scope === rec.scope) continue
      rec.scope = next.scope
      rec.scopeName = next.scopeName
      changed = true
    }
    if (changed) {
      this.archivedRev++
      this.changed()
    }
  }

  // ---------- split view ----------

  /**
   * ⌘D: a new pane right of the active tab, in its profile, waiting for an address. As in Arc, the
   * split is one row in the sidebar where its first tab is: a kept tab's new pane is kept right
   * after it, so the split stays in Kept. A pinned tab stays an icon, and its pane goes to Today
   * like any tab opened from it. Returns why it can't, if it can't.
   */
  splitNew(): string | null {
    const cur = this.active()
    if (!cur?.url) return null
    if (this.panesOf(cur.id).length >= MAX_PANES) return `Split view holds up to ${MAX_PANES} tabs.`
    const rec = this.create({ profile: cur.profile, opener: cur.id, activate: false })
    if (cur.kept && !cur.pinned) {
      rec.kept = true
      rec.folder = cur.folder
      rec.order = (cur.order ?? 0) + 0.5
    }
    this.join(cur.id, rec.id)
    this.activate(rec.id)
    return null
  }

  /** Shows a tab next to the active one, focused, wherever it sits in the sidebar. Returns why it can't, if it can't. */
  splitWith(id: string): string | null {
    const cur = this.active()
    if (!cur?.url || !this.get(id) || this.panesOf(cur.id).includes(id)) return null
    if (this.panesOf(cur.id).length >= MAX_PANES) return `Split view holds up to ${MAX_PANES} tabs.`
    this.join(cur.id, id)
    this.activate(id)
    return null
  }

  /** Puts tab `id` right of `to` in its split, out of any other. The panes share the width evenly. */
  private join(to: string, id: string) {
    const from = this.splitOf(id)
    if (from) {
      from.sizes.splice(from.tabs.indexOf(id), 1)
      from.tabs = from.tabs.filter((t) => t !== id)
    }
    let split = this.splitOf(to)
    if (!split) this.splits.push((split = { id: randomUUID(), tabs: [to], sizes: [1] }))
    split.tabs.splice(split.tabs.indexOf(to) + 1, 0, id)
    split.sizes = split.tabs.map(() => 1)
    this.prune()
  }

  /** Separates a split's tabs: each is a tab of its own again, and the one you're on fills the page area. */
  unsplit(id: string) {
    this.splits = this.splits.filter((s) => !s.tabs.includes(id))
    this.layout()
    this.changed()
  }

  /** Takes one tab out of its split; the rest stay together. */
  leaveSplit(id: string) {
    const split = this.splitOf(id)
    if (!split) return
    split.sizes.splice(split.tabs.indexOf(id), 1)
    split.tabs = split.tabs.filter((t) => t !== id)
    this.prune()
    this.layout()
    this.changed()
  }

  /** A pane's ×: takes its tab out of the split, and the pane beside it takes focus if it had it. */
  closePane(id: string) {
    const split = this.splitOf(id)
    if (!split) return
    const i = split.tabs.indexOf(id)
    const next = id === this.activeId ? (split.tabs[i + 1] ?? split.tabs[i - 1]) : undefined
    this.leaveSplit(id)
    if (next) this.activate(next)
  }

  /** Dragging a divider. Saved once you let go. */
  resizeSplit(id: string, sizes: number[], done: boolean) {
    const split = this.splits.find((s) => s.id === id)
    if (!split || sizes.length !== split.tabs.length || !sizes.every((x) => Number.isFinite(x) && x > 0)) return
    split.sizes = sizes
    this.layout()
    if (done) this.changed()
  }

  /** Moves focus to the pane left (-1) or right (1) of the focused one. */
  focusPane(step: -1 | 1) {
    const shown = this.shown()
    const next = shown[shown.indexOf(this.activeId ?? '') + step]
    if (next) this.activate(next)
  }

  /** Drops tabs that are gone from their splits; a split down to one tab ends. Returns whether any changed. */
  private prune(): boolean {
    const ids = new Set(this.records.map((t) => t.id))
    const taken = new Set<string>()
    let changed = false
    this.splits = this.splits.filter((s) => {
      const keep: [string, number][] = []
      s.tabs.forEach((id, i) => {
        if (!ids.has(id) || taken.has(id)) return
        taken.add(id)
        keep.push([id, s.sizes[i] || 1])
      })
      if (keep.length !== s.tabs.length) {
        changed = true
        s.tabs = keep.map(([id]) => id)
        s.sizes = keep.map(([, size]) => size)
      }
      if (keep.length > 1) return true
      changed = true
      return false
    })
    return changed
  }

  // ---------- folders ----------

  folder(id: string) {
    return this.folders.find((f) => f.id === id)
  }

  createFolder(name = 'New folder', parent?: string): Folder {
    const folder: Folder = { id: randomUUID(), name, rules: [], createdAt: Date.now() }
    if (parent && this.folder(parent)) folder.parent = parent
    this.folders.push(folder)
    this.changed()
    return folder
  }

  updateFolder(id: string, change: Partial<Pick<Folder, 'name' | 'rules' | 'collapsed'>>) {
    const folder = this.folder(id)
    if (!folder) return
    if (change.name !== undefined) folder.name = change.name.trim() || folder.name
    if (change.rules) folder.rules = change.rules.map((r) => r.trim()).filter(Boolean)
    if (change.collapsed !== undefined) folder.collapsed = change.collapsed || undefined
    this.changed()
  }

  /** Moves a folder into another, at its bottom, or to the top of Kept with none. Not into itself or a folder inside it. */
  moveFolder(id: string, parent: string | null) {
    const folder = this.folder(id)
    if (!folder || (parent && (!this.folder(parent) || isInFolder(this.folders, parent, id)))) return
    if (parentFolder(this.folders, folder) !== (parent || undefined)) folder.order = undefined
    folder.parent = parent || undefined
    this.changed()
  }

  /** Removes a folder. Its threads and folders move up to its parent, or stay kept outside any folder, where it was. */
  deleteFolder(id: string) {
    const folder = this.folder(id)
    const parent = folder?.parent
    const inside = [...this.records.filter((t) => t.folder === id), ...this.folders.filter((f) => f.parent === id)]
    for (const item of inside) {
      if ('rules' in item) item.parent = parent
      else item.folder = parent
      item.order = (folder?.order ?? 0) + ((item.order ?? 0) + 1) / (inside.length + 1)
    }
    this.folders = this.folders.filter((f) => f.id !== id)
    this.changed()
  }

  // ---------- archive ----------

  /**
   * Archives threads unseen for `afterMs`. Kept threads and the active thread stay. Kept threads
   * unseen for `sleepAfterMs` unload their pages too, unless `keepLoaded` keeps them, but stay
   * full rows rather than summaries. A thread
   * with an address matching a folder's rules moves into that folder (and so becomes kept)
   * instead; the oldest folder wins. Threads unseen for `sleepAfterMs` but not yet archived
   * unload their pages (see isAsleep). 0 turns either off. Returns the root IDs of the threads
   * it archived.
   */
  sweep(afterMs: number, sleepAfterMs: number): string[] {
    const now = Date.now()
    const folders = [...this.folders]
      .sort((a, b) => a.createdAt - b.createdAt)
      .filter((f) => f.rules.length)
      .map((f) => ({ id: f.id, matches: urlMatcher(f.rules) }))
    let changed = false
    const archived: string[] = []
    const shown = this.shown()
    for (const root of this.records.filter((t) => isRoot(this.records, t) && !t.kept)) {
      const all = subtree(this.records, root)
      if (all.some((t) => shown.includes(t.id) || this.held(t))) continue
      if (afterMs <= 0 || now - Math.max(...all.map((t) => Math.max(t.lastSeen, t.restoredAt ?? 0))) < afterMs) {
        if (isAsleep(all, { now, afterMs: sleepAfterMs, activeId: this.activeId }) && this.unload(all)) changed = true
        continue
      }
      const into = folders.find((f) => all.some((t) => f.matches(t.url)))
      if (into) {
        root.kept = true
        root.folder = into.id
        this.setHome(root)
      } else {
        for (const t of all) {
          this.dropView(t)
          t.archivedAt = now
          t.restoredAt = undefined
        }
        const ids = new Set(all.map((t) => t.id))
        this.records = this.records.filter((t) => !ids.has(t.id))
        this.mru = this.mru.filter((m) => !ids.has(m))
        this.archived.push(...all)
        this.archivedRev++
        archived.push(root.id)
      }
      changed = true
    }
    if (sleepAfterMs > 0) {
      for (const root of this.records.filter((t) => isRoot(this.records, t) && t.kept)) {
        if (root.pinned ? this.keepLoaded.pinned : this.keepLoaded.kept) continue
        const all = subtree(this.records, root)
        if (all.some((t) => t.id === this.activeId || shown.includes(t.id) || this.held(t))) continue
        if (now - Math.max(...all.map((t) => t.lastSeen)) >= sleepAfterMs && this.unload(all)) changed = true
      }
    }
    const cutoff = now - ARCHIVE_KEEP_MS
    if (this.archived.some((t) => (t.archivedAt ?? 0) <= cutoff)) {
      this.archived = this.archived.filter((t) => (t.archivedAt ?? 0) > cutoff)
      this.archivedRev++
      changed = true
    }
    if (changed) this.changed()
    return archived
  }

  /** Closes an asleep thread's pages; each loads again when opened. A page playing sound stays. */
  private unload(all: TabRecord[]): boolean {
    let unloaded = false
    for (const t of all) {
      const wc = this.webContentsFor(t.id)
      if (!wc || wc.isCurrentlyAudible()) continue
      this.dropView(t)
      unloaded = true
    }
    return unloaded
  }

  /** Drops a deleted profile's archived threads. Its open tabs are closed first. */
  forgetProfile(profileId: string) {
    this.archived = this.archived.filter((t) => t.profile !== profileId)
    this.archivedRev++
    this.closed = this.closed.filter((c) => c.rec.profile !== profileId)
    this.changed()
  }

  /** Every tab of the archived threads that `ids` (any tab of each) belong to, each thread once. */
  private archivedThreads(ids: string[]): TabRecord[] {
    const want = new Set(ids)
    return threadsOf(this.archived)
      .filter((th) => th.all.some((t) => want.has(t.id)))
      .flatMap((th) => th.all)
  }

  /**
   * Brings archived threads back whole, their back and forward lists with them. `ids` can be any
   * tab of a thread. Undo passes `inPlace`: a thread keeps when it was last seen, so it goes back
   * to the same spot in the sidebar (asleep, if it was), and gets its full time before archiving
   * again. Otherwise it counts as seen now.
   */
  unarchive(ids: string[], inPlace = false) {
    const all = this.archivedThreads(ids)
    if (!all.length) return
    const back = new Set(all.map((t) => t.id))
    this.archived = this.archived.filter((t) => !back.has(t.id))
    this.archivedRev++
    const now = Date.now()
    for (const t of all) {
      t.archivedAt = undefined
      if (inPlace) t.restoredAt = now
      else t.lastSeen = now
    }
    this.records.push(...all)
    this.changed()
  }

  /** Brings an archived tab's whole thread back and makes that tab active. */
  restore(id: string) {
    if (!this.archived.some((t) => t.id === id)) return
    this.unarchive([id])
    this.activate(id)
  }

  /** Drops archived threads for good. `ids` can be any tab of a thread. */
  forget(ids: string[]) {
    const gone = new Set(this.archivedThreads(ids).map((t) => t.id))
    if (!gone.size) return
    this.archived = this.archived.filter((t) => !gone.has(t.id))
    this.archivedRev++
    this.changed()
  }

  /** ⌃Tab: the tab used before the current one. */
  previous(): string | undefined {
    return this.mru.find((m) => m !== this.activeId && this.get(m))
  }
}

/** Calls both, for a second caller waiting on the same answer. */
function chain<T>(a: (v: T) => void, b: (v: T) => void) {
  return (v: T) => {
    a(v)
    b(v)
  }
}

/** "Google" for Google's search address, otherwise the search site's name. */
function searchEngineName(searchUrl: string): string {
  try {
    const host = new URL(searchUrl.replace('%s', '')).hostname.replace(/^(www|search)\./, '')
    const name = host.split('.')[0] ?? host
    return name === 'duckduckgo' ? 'DuckDuckGo' : name.charAt(0).toUpperCase() + name.slice(1)
  } catch {
    return 'the web'
  }
}

/** `search` sends the text to the search engine even if it looks like an address, as a leading ? does. */
export function toUrl(input: string, searchUrl: string, search = false): string {
  const text = input.trim()
  const query = search ? text : forcedSearch(text)
  const url = query === undefined ? addressUrl(text) : undefined
  return url ?? searchUrl.replace('%s', encodeURIComponent(query ?? text))
}
