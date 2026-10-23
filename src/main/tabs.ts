import { app, BrowserWindow, Menu, WebContentsView, clipboard, type Rectangle, type WebContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { urlMatcher } from '../shared/patterns'
import { childrenOf, isAsleep, isRoot, rootOf, subtree } from '../shared/threads'
import type { Folder, TabRecord, UiTab } from '../shared/types'
import type { Certificates } from './certs'
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
  /** False while the panel animates or an overlay covers the page; the active view stays hidden. */
  contentVisible: () => boolean
  onChange: () => void
  /** Called after a tab becomes active, to move keyboard focus to it. */
  onActivated: () => void
  /** Return true if jbrow handled the key, so the page doesn't see it. */
  onKey: (input: Electron.Input) => boolean
  searchUrl: () => string
  permissions: SitePermissions
  certs: Certificates
  /** A page committed a navigation to a new document. */
  onNavigate: (wc: WebContents) => void
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

/** Archived threads are forgotten after this long. */
const ARCHIVE_KEEP_MS = 90 * 24 * 60 * 60 * 1000

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
    return this.records.map((t) => ({ ...t, loading: this.live.get(t.id)?.loading ?? false }))
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
    if (!guest && rec.url) void view.webContents.loadURL(rec.url).catch(() => {})
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
    }
    wc.on('did-navigate', (e, url) => {
      onNav(e, url)
      this.deps.onNavigate(wc)
    })
    wc.on('did-navigate-in-page', onNav)
    wc.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.deps.certs.clear(id)
    })
    wc.on('certificate-error', (event, url, error, certificate, callback, isMainFrame) => {
      event.preventDefault()
      callback(this.deps.certs.onError(id, rec()?.profile ?? rt.profile.id, url, error, certificate, isMainFrame))
    })
    wc.on('did-start-loading', () => this.setLoading(id, true))
    wc.on('did-stop-loading', () => this.setLoading(id, false))
    wc.on('before-input-event', (event, input) => {
      if (this.deps.onKey(input)) event.preventDefault()
    })
    wc.on('context-menu', (_e, params) => this.contextMenu(id, wc, params, rt))

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
      this.live.delete(id)
      this.deps.certs.clear(id)
    })
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
    if (params.linkURL) {
      const web = isWebUrl(params.linkURL)
      items.push(
        { label: 'Open link in this thread', enabled: web, click: () => this.create({ profile: rt.profile.id, parent: id, url: params.linkURL }) },
        {
          label: 'Open link in background',
          enabled: web,
          click: () => this.create({ profile: rt.profile.id, parent: id, url: params.linkURL, activate: false, unread: true }),
        },
        { label: 'Copy link', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' },
      )
    }
    if (params.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' })
    else if (params.selectionText) items.push({ role: 'copy' }, { type: 'separator' })
    items.push(
      { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
      { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
      { label: 'Reload', click: () => wc.reload() },
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
   * Positions the active view and shows it if the panel allows. A page a certificate stopped
   * stays hidden, so jbrow's warning beneath it shows.
   */
  layout() {
    const live = this.activeId ? this.live.get(this.activeId) : undefined
    if (!live) return
    live.view.setBounds(this.deps.contentBounds())
    live.view.setVisible(this.deps.contentVisible() && !this.deps.certs.isBlocked(this.activeId!))
  }

  navigate(input: string) {
    const url = toUrl(input, this.deps.searchUrl())
    const rec = this.active()
    if (!rec) return
    rec.url = url
    const live = this.ensureView(rec)
    if (live && live.view.webContents.getURL() !== url) void live.view.webContents.loadURL(url).catch(() => {})
    this.activate(rec.id)
  }

  close(id: string) {
    const rec = this.get(id)
    if (!rec) return
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
      const next = this.mru.find((m) => this.get(m))
      if (next) this.activate(next)
    }
    this.changed()
  }

  private dropView(rec: TabRecord) {
    const live = this.live.get(rec.id)
    if (!live) return
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

  createFolder(name = 'New folder'): Folder {
    const folder: Folder = { id: randomUUID(), name, rules: [], createdAt: Date.now() }
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

  /** Removes a folder. Its threads stay kept, outside any folder. */
  deleteFolder(id: string) {
    for (const t of this.records) if (t.folder === id) t.folder = undefined
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

function toUrl(input: string, searchUrl: string): string {
  const text = input.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|chrome-extension|file):/i.test(text)) return text
  if (/^(localhost|[\w-]+(\.[\w-]+)+)(:\d+)?(\/.*)?$/i.test(text) && !text.includes(' ')) return `https://${text}`
  return searchUrl.replace('%s', encodeURIComponent(text))
}
