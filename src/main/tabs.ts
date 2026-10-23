import { app, BrowserWindow, Menu, WebContentsView, clipboard, type Rectangle, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { urlMatcher } from '../shared/patterns'
import { childrenOf, isAsleep, isInFolder, isRoot, rootOf, subtree } from '../shared/threads'
import type { CrashView, Folder, Profile, TabRecord, UiTab } from '../shared/types'
import type { Certificates } from './certs'
import type { Logins } from './logins'
import type { SitePermissions } from './permissions'
import type { ProfileRuntime } from './profiles'

interface LiveTab {
  view: WebContentsView
  loading: boolean
}

export interface TabsDeps {
  window: () => BrowserWindow
  runtime: (profileId: string) => ProfileRuntime | undefined
  contentBounds: () => Rectangle
  /** False while the panel animates or is hidden; the active view stays hidden. */
  contentVisible: () => boolean
  /** A new view lands on top of everything; this puts jbrow's UI back where it belongs. */
  onViewAdded: () => void
  onChange: () => void
  /** Called after a tab becomes active, to move keyboard focus to it. */
  onActivated: () => void
  /** Return true if jbrow handled the key, so the page doesn't see it. */
  onKey: (input: Electron.Input) => boolean
  searchUrl: () => string
  permissions: SitePermissions
  certs: Certificates
  logins: Logins
  /** A page committed a navigation to a new document. */
  onNavigate: (wc: WebContents) => void
  /** The page menu's Print… and Save as PDF…. */
  print: (wc: WebContents) => void
  saveAsPdf: (wc: WebContents) => void
  /** Save link, image or video: a download you asked for. */
  download: (wc: WebContents, url: string) => void
  profiles: () => Profile[]
  /** Opens a link as a new thread in another profile, next to the tab's thread. */
  openInProfile: (fromId: string, profile: string, url: string) => void
  /** The active page went fullscreen or left it. */
  onFullscreen: (on: boolean, url: string) => void
}

export interface CreateOptions {
  profile: string
  url?: string
  parent?: string
  scope?: string
  scopeName?: string
  app?: string
  activate?: boolean
  /** A guest WebContents Chromium already created for window.open. */
  webContents?: WebContents
  unread?: boolean
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

/** How many closed tabs ⇧⌘T can bring back. */
const CLOSED_KEEP = 25

/** A closed tab, with what it takes to put it back where it was. */
interface ClosedTab {
  rec: TabRecord
  /** Its place in `records`, which orders a thread's tabs. */
  index: number
  /** The app section of its thread, for when it comes back as a thread of its own. */
  root: Pick<TabRecord, 'scope' | 'scopeName' | 'app'>
  /** Its children, which close() moved up a level, so they can move back under it. */
  children: string[]
  history?: NavHistory
}

export class Tabs {
  records: TabRecord[] = []
  folders: Folder[] = []
  /** Tabs of archived threads, with their parent links intact. They have no views. */
  archived: TabRecord[] = []
  activeId: string | null = null
  private live = new Map<string, LiveTab>()
  private saveTimer: NodeJS.Timeout | null = null
  /** Most recently used first, for ⌃Tab. */
  private mru: string[] = []
  /** Set while jbrow hands a new view to the extensions library, which marks every new tab active. */
  private addingView = false
  /** Set while jbrow takes a view away from the extensions library, which reports that as the tab closing. */
  private droppingView = false
  /** Tabs whose page crashed or stopped responding, until it loads again. */
  private crashed = new Map<string, CrashView>()
  /** Stuck pages jbrow crashed on purpose, to reload once their process is gone. */
  private killing = new Set<string>()
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

  constructor(private deps: TabsDeps) {}

  // ---------- persistence ----------

  load() {
    if (!existsSync(storePath())) return
    try {
      const data = JSON.parse(readFileSync(storePath(), 'utf8')) as {
        tabs: TabRecord[]
        activeId: string | null
        folders?: Folder[]
        archived?: TabRecord[]
      }
      // Empty new tabs aren't worth restoring.
      this.records = data.tabs.filter((t) => t.url)
      this.folders = data.folders ?? []
      const cutoff = Date.now() - ARCHIVE_KEEP_MS
      this.archived = (data.archived ?? []).filter((t) => (t.archivedAt ?? 0) > cutoff)
      this.activeId = this.records.some((t) => t.id === data.activeId) ? data.activeId : null
      this.mru = [...this.records].sort((a, b) => b.lastSeen - a.lastSeen).map((t) => t.id)
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
    const data = { tabs: this.records, activeId: this.activeId, folders: this.folders, archived: this.archived }
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
    this.save()
    this.deps.onChange()
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
    return live && !live.view.webContents.isDestroyed() ? live.view.webContents : null
  }
  webContentsFor(id: string): WebContents | null {
    const live = this.live.get(id)
    return live && !live.view.webContents.isDestroyed() ? live.view.webContents : null
  }
  /** Every page that's loaded. */
  pages(): WebContents[] {
    return [...this.live.values()].map((l) => l.view.webContents).filter((wc) => !wc.isDestroyed())
  }
  idForWebContents(wc: WebContents): string | undefined {
    for (const [id, live] of this.live) if (live.view.webContents === wc) return id
    return undefined
  }
  uiTabs(): UiTab[] {
    return this.records.map((t) => ({ ...t, loading: this.live.get(t.id)?.loading ?? false, crashed: this.crashed.get(t.id)?.reason ? true : undefined }))
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
    const rec: TabRecord = {
      id: randomUUID(),
      profile: opts.profile,
      parent: opts.parent,
      scope: opts.parent ? undefined : opts.scope,
      scopeName: opts.parent ? undefined : opts.scopeName,
      app: opts.parent ? undefined : opts.app,
      url: opts.url ?? '',
      title: '',
      createdAt: now,
      lastSeen: now,
      unread: opts.unread,
    }
    this.records.push(rec)
    if (opts.webContents || rec.url) this.ensureView(rec, opts.webContents)
    if (opts.activate !== false) this.activate(rec.id)
    else this.changed()
    return rec
  }

  /** Reuses the active tab if it's an empty new tab, so new tabs don't pile up. */
  newTab(opts: Omit<CreateOptions, 'url'>): TabRecord {
    const cur = this.active()
    if (cur && !cur.url && !cur.parent) {
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
    view.setBorderRadius(9)
    const win = this.deps.window()
    win.contentView.addChildView(view)
    this.deps.onViewAdded()
    const live: LiveTab = { view, loading: false }
    this.live.set(rec.id, live)
    this.wire(rec.id, view.webContents, rt)
    this.addingView = true
    try {
      rt.extensions.addTab(view.webContents, win)
      // Tell the library which tab is really in front, or a background tab would count as active.
      const active = this.activeId !== rec.id ? this.live.get(this.activeId ?? '') : undefined
      if (active && this.active()?.profile === rec.profile) rt.extensions.selectTab(active.view.webContents)
    } finally {
      this.addingView = false
    }
    const history = this.histories.get(rec.id)
    if (guest) return live
    // A tab that was asleep or archived comes back where it was, with back and forward. One you
    // just typed an address into goes there after, so that address is one step further.
    const url = rec.url
    const load = () => (url ? view.webContents.loadURL(url) : undefined)
    if (!history) void load()?.catch(() => {})
    else {
      void view.webContents.navigationHistory
        .restore(history)
        .then(() => (history.entries[history.index]?.url !== url ? load() : undefined), load)
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
        this.changed()
      }
    })
    wc.on('page-favicon-updated', (_e, favicons) => {
      const r = rec()
      if (r && favicons[0]) {
        r.favicon = favicons[0]
        this.changed()
      }
    })
    const onNav = (_e: unknown, url: string) => {
      const r = rec()
      if (r) {
        r.url = url
        this.changed()
      }
      this.saveHistory()
    }
    wc.on('did-navigate', (e, url) => {
      onNav(e, url)
      this.deps.logins.loaded(id)
      this.deps.onNavigate(wc)
    })
    wc.on('did-navigate-in-page', onNav)
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) {
        this.deps.certs.clear(id)
        this.deps.logins.clear(id)
        this.setCrashed(id, null)
      }
    })
    // HTTP auth for the page or a proxy. Logins answers once you sign in or cancel.
    wc.on('login', (event, _details, authInfo, callback) => {
      event.preventDefault()
      this.deps.logins.ask(id, authInfo, callback)
    })
    wc.on('render-process-gone', (_e, details) => {
      // Unloading an asleep thread's page or closing the tab drops its view first; that's no crash.
      if (details.reason === 'clean-exit' || this.live.get(id)?.view.webContents !== wc) return
      if (this.killing.delete(id)) return void wc.reload()
      this.deps.logins.clear(id)
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
    wc.on('certificate-error', (event, url, error, certificate, callback, isMainFrame) => {
      event.preventDefault()
      callback(this.deps.certs.onError(id, rec()?.profile ?? rt.profile.id, url, error, certificate, isMainFrame))
    })
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
    wc.on('context-menu', (_e, params) => this.contextMenu(id, wc, params, rt))
    wc.on('enter-html-full-screen', () => {
      // Only the page in front can have the screen; one in the background stays in its place.
      if (id !== this.activeId) return void this.exitFullscreen(wc)
      this.setFullscreen(id)
    })
    wc.on('leave-html-full-screen', () => {
      if (this.fullscreenId === id) this.setFullscreen(null)
    })

    wc.setWindowOpenHandler((details) => {
      // window.open with size features is usually a sign-in or payment popup. It needs a real
      // window so it can close itself and talk to its opener.
      if (details.disposition === 'new-window' && details.features) {
        return { action: 'allow', overrideBrowserWindowOptions: { parent: this.deps.window(), width: 520, height: 680 } }
      }
      const background = details.disposition === 'background-tab'
      return {
        action: 'allow',
        outlivesOpener: true,
        // Electron passes the guest WebContents here, though its typings don't say so.
        createWindow: (options) => {
          const guest = (options as { webContents?: WebContents }).webContents
          const r = rec()
          const child = this.create({
            profile: r?.profile ?? rt.profile.id,
            parent: id,
            webContents: guest,
            url: details.url,
            activate: !background,
            unread: background,
          })
          // Chromium navigates the guest itself, under the opener's rules.
          return this.live.get(child.id)!.view.webContents
        },
      }
    })

    wc.on('destroyed', () => {
      if (this.fullscreenId === id) this.setFullscreen(null)
      // A crashed page's view may have been replaced by now; only forget this one.
      if (this.live.get(id)?.view.webContents === wc) this.live.delete(id)
      this.killing.delete(id)
      this.deps.certs.clear(id)
      this.deps.logins.clear(id)
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
   * Reloads the tab's page. A stuck page can't unload by itself, so its process is ended first
   * and the page reloads once it's gone.
   */
  reload(id: string) {
    const wc = this.webContentsFor(id)
    if (!wc) return
    if (!this.crashed.get(id)?.hung || wc.isCrashed()) return wc.reload()
    this.killing.add(id)
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

  private contextMenu(id: string, wc: WebContents, params: Electron.ContextMenuParams, rt: ProfileRuntime) {
    const items: Electron.MenuItemConstructorOptions[] = []
    const section = (...more: Electron.MenuItemConstructorOptions[]) => items.push(...more, { type: 'separator' })
    const openHere = (url: string, background = false) =>
      this.create({ profile: rt.profile.id, parent: id, url, activate: !background, unread: background || undefined })
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
        { label: 'Open link in this thread', enabled: web, click: () => openHere(params.linkURL) },
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
        { label: `Open ${media} in this thread`, enabled: isWebUrl(params.srcURL), click: () => openHere(params.srcURL) },
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
      { label: 'Reload', click: () => wc.reload() },
      { type: 'separator' },
      { label: 'Print…', click: () => this.deps.print(wc) },
      { label: 'Save as PDF…', click: () => this.deps.saveAsPdf(wc) },
    )
    const url = wc.getURL()
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

  /** An extension (chrome.tabs.update) or the extensions library wants this tab in front. */
  selectFromExtension(wc: WebContents) {
    if (this.addingView) return
    const id = this.idForWebContents(wc)
    if (id) this.activate(id)
  }

  activate(id: string) {
    const rec = this.get(id)
    if (!rec) return
    // Drop empty new tabs you've moved away from.
    const prev = this.active()
    if (prev && prev.id !== id && !prev.url && !this.live.has(prev.id)) {
      this.records = this.records.filter((t) => t.id !== prev.id)
      this.mru = this.mru.filter((m) => m !== prev.id)
    }
    if (this.fullscreenId && this.fullscreenId !== id) this.leaveFullscreen()
    for (const [tid, live] of this.live) if (tid !== id) live.view.setVisible(false)
    this.activeId = id
    rec.lastSeen = Date.now()
    rec.unread = false
    this.mru = [id, ...this.mru.filter((m) => m !== id)]
    const live = rec.url ? this.ensureView(rec) : this.live.get(id)
    if (live) {
      this.deps.runtime(rec.profile)?.extensions.selectTab(live.view.webContents)
    }
    this.layout()
    this.changed()
    this.deps.onActivated()
  }

  /**
   * Positions the active view and shows it if the panel allows. A page a certificate stopped,
   * a site asking for a password, or a crashed page stays hidden, so jbrow's screen beneath it shows.
   */
  layout() {
    const live = this.activeId ? this.live.get(this.activeId) : undefined
    if (!live) return
    live.view.setBounds(this.deps.contentBounds())
    live.view.setVisible(this.deps.contentVisible() && !this.covered(this.activeId!))
  }

  /** jbrow shows its own screen in place of the tab's page. */
  covered(id: string) {
    return this.deps.certs.isBlocked(id) || this.deps.logins.isAsking(id) || this.crashed.has(id)
  }

  navigate(input: string) {
    const url = toUrl(input, this.deps.searchUrl())
    const rec = this.active()
    if (!rec) return
    rec.url = url
    // A tab without a page goes to the address once its view is made.
    const live = this.live.get(rec.id)
    if (!live) this.ensureView(rec)
    else if (live.view.webContents.getURL() !== url) void live.view.webContents.loadURL(url).catch(() => {})
    this.activate(rec.id)
  }

  /** `remember` false leaves it out of what ⇧⌘T reopens. */
  close(id: string, remember = true) {
    const rec = this.get(id)
    if (!rec) return
    if (remember && rec.url) this.remember(rec)
    const thread = new Set(subtree(this.records, rootOf(this.records, rec)).map((t) => t.id))
    // Children move up to the closed tab's parent so a thread doesn't fall apart.
    for (const child of childrenOf(this.records, id)) {
      child.parent = rec.parent
      if (!rec.parent) {
        child.scope = rec.scope
        child.scopeName = rec.scopeName
        child.app = rec.app
        child.kept = rec.kept
        child.folder = rec.folder
      }
    }
    this.dropView(rec)
    this.records = this.records.filter((t) => t.id !== id)
    this.mru = this.mru.filter((m) => m !== id)
    if (this.activeId === id) {
      this.activeId = null
      // The next tab comes from the same thread or from outside Kept; a kept thread only comes up when asked for.
      const next = this.mru.find((m) => {
        const t = this.get(m)
        return t && (thread.has(m) || !rootOf(this.records, t).kept)
      })
      if (next) this.activate(next)
    }
    this.changed()
  }

  private remember(rec: TabRecord) {
    const root = rootOf(this.records, rec)
    this.closed.push({
      rec: { ...rec },
      index: this.records.indexOf(rec),
      root: { scope: root.scope, scopeName: root.scopeName, app: root.app },
      children: childrenOf(this.records, rec.id).map((c) => c.id),
      history: this.historyOf(rec.id),
    })
    if (this.closed.length > CLOSED_KEEP) this.closed.shift()
  }

  canReopen() {
    return this.closed.some((c) => this.deps.runtime(c.rec.profile))
  }

  /**
   * ⇧⌘T: brings back the most recently closed tab, under its parent if that's still open,
   * otherwise as a thread of its own. Children it had come back under it if they're still where
   * closing it put them. Tabs of deleted profiles are skipped.
   */
  reopen(): TabRecord | undefined {
    let c: ClosedTab | undefined
    while ((c = this.closed.pop()) && !this.deps.runtime(c.rec.profile));
    if (!c) return undefined
    const rec: TabRecord = { ...c.rec, id: this.get(c.rec.id) ? randomUUID() : c.rec.id, lastSeen: Date.now(), unread: undefined }
    if (rec.parent && !this.get(rec.parent)) {
      rec.parent = undefined
      Object.assign(rec, c.root)
    }
    if (rec.folder && !this.folder(rec.folder)) rec.folder = undefined
    for (const child of c.children.map((id) => this.get(id))) {
      if (!child || child.profile !== rec.profile || child.parent !== rec.parent) continue
      if (!rec.parent && (child.kept !== rec.kept || child.folder !== rec.folder)) continue
      child.parent = rec.id
      child.kept = child.folder = child.scope = child.scopeName = child.app = undefined
    }
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
    this.droppingView = true
    try {
      this.deps.runtime(rec.profile)?.extensions.removeTab(live.view.webContents)
    } finally {
      this.droppingView = false
    }
    live.view.webContents.close()
    this.live.delete(rec.id)
  }

  closeWebContents(wc: WebContents) {
    if (this.droppingView) return
    const id = this.idForWebContents(wc)
    if (id) this.close(id)
  }

  rename(id: string, name: string) {
    const rec = this.get(id)
    if (!rec) return
    const trimmed = name.trim()
    rec.name = trimmed && trimmed !== rec.title ? trimmed : undefined
    this.changed()
  }

  /**
   * Moves a tab (with everything under it) under another tab, or to the top level.
   * Returns an error message for moves that aren't allowed.
   */
  move(id: string, parent: string | null, kept?: boolean, folder?: string): string | null {
    const rec = this.get(id)
    if (!rec) return null
    if (parent) {
      const target = this.get(parent)
      if (!target || target.id === id) return null
      if (subtree(this.records, rec).includes(target)) return "A thread can't go inside one of its own sub-threads."
      if (target.profile !== rec.profile) return 'Threads only merge within one profile, because their pages share a login.'
      rec.parent = target.id
      rec.kept = undefined
      rec.folder = undefined
      rec.scope = undefined
      rec.scopeName = undefined
      rec.app = undefined
    } else {
      if (rec.parent) {
        const root = rootOf(this.records, rec)
        rec.scope = root.scope
        rec.scopeName = root.scopeName
        rec.app = root.app
      }
      rec.parent = undefined
      rec.kept = kept || undefined
      rec.folder = kept && folder && this.folders.some((f) => f.id === folder) ? folder : undefined
    }
    this.changed()
    return null
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
    if (changed) this.changed()
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

  /** Moves a folder into another, or to the top of Kept with none. Not into itself or a folder inside it. */
  moveFolder(id: string, parent: string | null) {
    const folder = this.folder(id)
    if (!folder || (parent && (!this.folder(parent) || isInFolder(this.folders, parent, id)))) return
    folder.parent = parent || undefined
    this.changed()
  }

  /** Removes a folder. Its threads and folders move up to its parent, or stay kept outside any folder. */
  deleteFolder(id: string) {
    const parent = this.folder(id)?.parent
    for (const t of this.records) if (t.folder === id) t.folder = parent
    for (const f of this.folders) if (f.parent === id) f.parent = parent
    this.folders = this.folders.filter((f) => f.id !== id)
    this.changed()
  }

  // ---------- archive ----------

  /**
   * Archives threads unseen for `afterMs`. Kept threads and the active thread stay. A thread
   * with an address matching a folder's rules moves into that folder (and so becomes kept)
   * instead; the oldest folder wins. Threads unseen for `sleepAfterMs` but not yet archived
   * unload their pages (see isAsleep). 0 turns either off.
   */
  sweep(afterMs: number, sleepAfterMs: number) {
    const now = Date.now()
    const folders = [...this.folders]
      .sort((a, b) => a.createdAt - b.createdAt)
      .filter((f) => f.rules.length)
      .map((f) => ({ id: f.id, matches: urlMatcher(f.rules) }))
    let changed = false
    for (const root of this.records.filter((t) => isRoot(this.records, t) && !t.kept)) {
      const all = subtree(this.records, root)
      if (all.some((t) => t.id === this.activeId)) continue
      if (afterMs <= 0 || now - Math.max(...all.map((t) => t.lastSeen)) < afterMs) {
        if (isAsleep(all, { now, afterMs: sleepAfterMs, activeId: this.activeId }) && this.unload(all)) changed = true
        continue
      }
      const into = folders.find((f) => all.some((t) => f.matches(t.url)))
      if (into) {
        root.kept = true
        root.folder = into.id
      } else {
        for (const t of all) {
          this.dropView(t)
          t.archivedAt = now
        }
        const ids = new Set(all.map((t) => t.id))
        this.records = this.records.filter((t) => !ids.has(t.id))
        this.mru = this.mru.filter((m) => !ids.has(m))
        this.archived.push(...all)
      }
      changed = true
    }
    const cutoff = now - ARCHIVE_KEEP_MS
    if (this.archived.some((t) => (t.archivedAt ?? 0) <= cutoff)) {
      this.archived = this.archived.filter((t) => (t.archivedAt ?? 0) > cutoff)
      changed = true
    }
    if (changed) this.changed()
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
    this.closed = this.closed.filter((c) => c.rec.profile !== profileId)
    this.changed()
  }

  /** Brings an archived tab's whole thread back and makes that tab active. */
  restore(id: string) {
    const rec = this.archived.find((t) => t.id === id)
    if (!rec) return
    const all = subtree(this.archived, rootOf(this.archived, rec))
    const ids = new Set(all.map((t) => t.id))
    this.archived = this.archived.filter((t) => !ids.has(t.id))
    const now = Date.now()
    for (const t of all) {
      t.archivedAt = undefined
      t.lastSeen = now
    }
    this.records.push(...all)
    this.activate(id)
  }

  /** ⌃Tab: the tab used before the current one. */
  previous(): string | undefined {
    return this.mru.find((m) => m !== this.activeId && this.get(m))
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

/** `search` sends the text to the search engine even if it looks like an address. */
function toUrl(input: string, searchUrl: string, search = false): string {
  const text = input.trim()
  if (search) return searchUrl.replace('%s', encodeURIComponent(text))
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|chrome-extension|file):/i.test(text)) return text
  if (/^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?(\/.*)?$/i.test(text) && !text.includes(' ')) return `https://${text}`
  return searchUrl.replace('%s', encodeURIComponent(text))
}
