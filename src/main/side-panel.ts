import { app, Menu, WebContentsView, type BrowserWindow, type Rectangle, type WebContents } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { SidePanelState } from '../shared/types'
import { iconOf } from './extension-files'
import { libraryOf, permissionsOf } from './library'
import { GUTTER, SIDE_GAP, SIDEBAR_WIDTH } from './panel'
import type { ProfileRuntime } from './profiles'

/** The side panel never gets narrower than this, and leaves the page at least PAGE_MIN. */
const MIN_WIDTH = 240
const PAGE_MIN = 400

interface Options {
  path?: string
  enabled?: boolean
}

/** What's kept per profile and extension in side-panel.json: global options and the action-click behavior. */
interface Saved extends Options {
  openPanelOnActionClick?: boolean
}

interface Shown {
  profile: string
  ext: Electron.Extension
  path: string
  /** Set when the panel belongs to this tab only. */
  tabId?: number
  key: string
}

export interface SidePanelHooks {
  window: () => BrowserWindow
  /** The active tab's profile, and its page (null for a new tab with no page yet). */
  active: () => { profile: string; wc: WebContents | null } | null
  bounds: () => Rectangle
  /** False while the panel animates or jbrow's own UI covers the page area. */
  visible: () => boolean
  /** The panel came, went or changed size: lay out the page again and tell the UI. */
  onChange: () => void
  /** A page view was added, which lands on top of jbrow's UI. */
  onViewAdded: () => void
  onKey: (input: Electron.Input) => boolean
  openTab: (profile: string, url: string) => void
  /** Your width, from settings. */
  width: () => number
  /** `save` once you let go of the edge; a drag sets it on every frame. */
  setWidth: (width: number, save: boolean) => void
}

const storePath = () => path.join(app.getPath('userData'), 'side-panel.json')

/**
 * chrome.sidePanel. An extension's side panel shows to the right of the page, for tabs in the
 * extension's profile. As in Chrome, a panel opened for a tab with its own options (setOptions
 * with a tabId) stays with that tab; otherwise it's the profile's global panel, shown next to
 * every tab of the profile that doesn't turn it off. The extension side is in
 * src/preload/extension-shims.ts.
 */
export class SidePanels {
  private saved: Record<string, Record<string, Saved>> = {}
  /** Options set for one tab, by tab (WebContents) ID and extension. */
  private tabOptions = new Map<number, Map<string, Options>>()
  /** The global panel open in each profile. */
  private openGlobal = new Map<string, string>()
  /** Panels open for one tab only. */
  private openTab = new Map<number, { profile: string; ext: string }>()
  private views = new Map<string, WebContentsView>()
  private runtimes = new Map<string, ProfileRuntime>()

  constructor(private hooks: SidePanelHooks) {
    try {
      if (existsSync(storePath())) this.saved = JSON.parse(readFileSync(storePath(), 'utf8'))
    } catch (error) {
      console.error('[side-panel] could not read side-panel.json:', error)
    }
  }

  private save() {
    writeFileSync(storePath(), JSON.stringify(this.saved, null, 2))
  }

  private savedFor(profile: string, extId: string): Saved {
    return ((this.saved[profile] ??= {})[extId] ??= {})
  }

  /** Adds chrome.sidePanel to a profile; see setupProfiles. */
  attach(rt: ProfileRuntime) {
    this.runtimes.set(rt.profile.id, rt)
    const profile = rt.profile.id
    const handle = libraryOf(rt).router.apiHandler()
    const opts = { permission: 'sidePanel' }
    handle('sidePanel.setOptions', ({ extension }, options: Options & { tabId?: number } = {}) => this.setOptions(rt, extension, options), opts)
    handle('sidePanel.getOptions', ({ extension }, { tabId }: { tabId?: number } = {}) => {
      const g = this.saved[profile]?.[extension.id] ?? {}
      const t = tabId !== undefined ? this.tabOptions.get(tabId)?.get(extension.id) : undefined
      if (t) return { tabId, path: t.path ?? g.path ?? defaultPath(extension), enabled: t.enabled ?? g.enabled ?? true }
      return { path: g.path ?? defaultPath(extension), enabled: g.enabled ?? true }
    }, opts)
    handle('sidePanel.setPanelBehavior', ({ extension }, { openPanelOnActionClick }: { openPanelOnActionClick?: boolean } = {}) => {
      if (openPanelOnActionClick === undefined) return
      this.savedFor(profile, extension.id).openPanelOnActionClick = !!openPanelOnActionClick
      this.save()
    }, opts)
    handle('sidePanel.getPanelBehavior', ({ extension }) => ({
      openPanelOnActionClick: !!this.saved[profile]?.[extension.id]?.openPanelOnActionClick,
    }), opts)
    handle('sidePanel.open', ({ extension }, { tabId, windowId }: { tabId?: number; windowId?: number } = {}) => {
      if (tabId === undefined && windowId === undefined) throw new Error('At least one of tabId and windowId must be provided')
      if (tabId !== undefined && !libraryOf(rt).store.getTabById(tabId)) throw new Error(`No tab with tabId: ${tabId}`)
      this.open(profile, extension, tabId)
    }, opts)
    handle('sidePanel.close', ({ extension }, { tabId }: { tabId?: number; windowId?: number } = {}) => this.close(profile, extension.id, tabId), opts)

    // The extension's toolbar button opens its panel instead of its popup, if it asked for that.
    const actions = (rt.extensions as unknown as { api: { browserAction: { activateClick(details: { extensionId: string; tabId?: number }): void } } }).api.browserAction
    const activateClick = actions.activateClick.bind(actions)
    actions.activateClick = (details) => {
      const ext = rt.session.extensions.getExtension(details.extensionId)
      if (ext && this.saved[profile]?.[ext.id]?.openPanelOnActionClick && this.hasPanel(profile, ext)) return this.toggle(profile, ext)
      activateClick(details)
    }
    rt.session.extensions.on('extension-unloaded', (_e, ext) => {
      if (this.openGlobal.get(profile) === ext.id) this.openGlobal.delete(profile)
      for (const [tabId, open] of this.openTab) if (open.profile === profile && open.ext === ext.id) this.openTab.delete(tabId)
      this.layout()
      this.hooks.onChange()
    })
  }

  private setOptions(rt: ProfileRuntime, ext: Electron.Extension, { tabId, path: p, enabled }: Options & { tabId?: number }) {
    const change: Options = {}
    if (p !== undefined) change.path = String(p).replace(/^\//, '')
    if (enabled !== undefined) change.enabled = !!enabled
    if (tabId !== undefined) {
      const wc = libraryOf(rt).store.getTabById(tabId)
      if (!wc) throw new Error(`No tab with tabId: ${tabId}`)
      let forTab = this.tabOptions.get(tabId)
      if (!forTab) {
        this.tabOptions.set(tabId, (forTab = new Map()))
        wc.once('destroyed', () => {
          this.tabOptions.delete(tabId)
          this.openTab.delete(tabId)
        })
      }
      forTab.set(ext.id, { ...forTab.get(ext.id), ...change })
      if (change.enabled === false && this.openTab.get(tabId)?.ext === ext.id) this.close(rt.profile.id, ext.id, tabId)
    } else {
      Object.assign(this.savedFor(rt.profile.id, ext.id), change)
      this.save()
      if (change.enabled === false && this.openGlobal.get(rt.profile.id) === ext.id) this.close(rt.profile.id, ext.id)
    }
    this.layout()
    this.hooks.onChange()
  }

  /** A deleted profile's panels close. */
  forgetProfile(profile: string) {
    this.openGlobal.delete(profile)
    for (const [tabId, open] of this.openTab) if (open.profile === profile) this.openTab.delete(tabId)
    this.runtimes.delete(profile)
    delete this.saved[profile]
    this.save()
    this.layout()
  }

  /** Whether an extension has a side panel page in a profile. */
  hasPanel(profile: string, ext: Electron.Extension) {
    return permissionsOf(ext).includes('sidePanel') && !!(this.saved[profile]?.[ext.id]?.path ?? defaultPath(ext))
  }

  /** The panel showing now, if any: whatever is open for the active tab, else the profile's global one. */
  private shown(): Shown | null {
    const active = this.hooks.active()
    if (!active) return null
    const rt = this.runtimes.get(active.profile)
    const tabId = active.wc?.id
    const forTab = tabId !== undefined ? this.openTab.get(tabId)?.ext : undefined
    const extId = forTab ?? this.openGlobal.get(active.profile)
    const ext = extId ? rt?.session.extensions.getExtension(extId) : undefined
    if (!ext) return null
    const g = this.saved[active.profile]?.[ext.id] ?? {}
    const t = tabId !== undefined ? this.tabOptions.get(tabId)?.get(ext.id) : undefined
    const p = t?.path ?? g.path ?? defaultPath(ext)
    if (!(t?.enabled ?? g.enabled ?? true) || !p) return null
    const own = forTab !== undefined || t?.path !== undefined ? tabId : undefined
    return { profile: active.profile, ext, path: p, tabId: own, key: `${active.profile}|${ext.id}|${own ?? 'global'}|${p}` }
  }

  open(profile: string, ext: Electron.Extension, tabId?: number) {
    const forTab = tabId !== undefined && this.tabOptions.get(tabId)?.has(ext.id) ? tabId : undefined
    const was = forTab !== undefined ? this.openTab.get(forTab)?.ext : this.openGlobal.get(profile)
    if (forTab !== undefined) this.openTab.set(forTab, { profile, ext: ext.id })
    else this.openGlobal.set(profile, ext.id)
    const rt = this.runtimes.get(profile)
    if (rt && was !== ext.id) {
      const g = this.saved[profile]?.[ext.id]
      const t = forTab !== undefined ? this.tabOptions.get(forTab)?.get(ext.id) : undefined
      libraryOf(rt).router.sendEvent(ext.id, 'sidePanel.onOpened', {
        path: t?.path ?? g?.path ?? defaultPath(ext),
        windowId: this.hooks.window().id,
        ...(forTab !== undefined ? { tabId: forTab } : {}),
      })
    }
    this.layout()
    this.hooks.onChange()
  }

  close(profile: string, extId: string, tabId?: number) {
    // onClosed has a tabId only for a panel that was open for that tab alone.
    let forTab: number | undefined
    if (tabId !== undefined && this.openTab.get(tabId)?.ext === extId) {
      this.openTab.delete(tabId)
      forTab = tabId
    } else if (!(this.openGlobal.get(profile) === extId && this.openGlobal.delete(profile))) return
    const rt = this.runtimes.get(profile)
    if (rt) libraryOf(rt).router.sendEvent(extId, 'sidePanel.onClosed', { windowId: this.hooks.window().id, ...(forTab !== undefined ? { tabId: forTab } : {}) })
    this.layout()
    this.hooks.onChange()
  }

  /** The toolbar button or its menu: open the extension's panel, or close it if it's showing. */
  toggle(profile: string, ext: Electron.Extension) {
    const shown = this.shown()
    if (shown?.ext.id === ext.id) return this.close(profile, ext.id, shown.tabId)
    this.open(profile, ext, this.hooks.active()?.wc?.id)
  }

  /** The close button on the panel's header. */
  closeShown() {
    const shown = this.shown()
    if (shown) this.close(shown.profile, shown.ext.id, shown.tabId)
  }

  /** Right-click on the panel's header: switch to another extension's panel, or close it. */
  menu() {
    const shown = this.shown()
    const rt = shown && this.runtimes.get(shown.profile)
    if (!shown || !rt) return
    const others = rt.session.extensions.getAllExtensions().filter((e) => e.id !== shown.ext.id && this.hasPanel(shown.profile, e))
    Menu.buildFromTemplate([
      ...others.map((e) => ({ label: `Open ${e.name}`, click: () => this.open(shown.profile, e, this.hooks.active()?.wc?.id) })),
      ...(others.length ? [{ type: 'separator' as const }] : []),
      { label: 'Reload', click: () => this.views.get(shown.key)?.webContents.reload() },
      { label: 'Inspect', click: () => this.views.get(shown.key)?.webContents.openDevTools({ mode: 'detach' }) },
      { type: 'separator' },
      { label: 'Close side panel', click: () => this.close(shown.profile, shown.ext.id, shown.tabId) },
    ]).popup({ window: this.hooks.window() })
  }

  /** Width of the panel showing now, kept within what the window allows; 0 when there is none. */
  width(): number {
    if (!this.shown()) return 0
    const [w] = this.hooks.window().getContentSize()
    const max = w - SIDEBAR_WIDTH - GUTTER - SIDE_GAP - PAGE_MIN
    return Math.max(Math.min(MIN_WIDTH, max), Math.min(this.hooks.width(), max))
  }

  resize(width: number, save: boolean) {
    this.hooks.setWidth(Math.max(MIN_WIDTH, Math.round(width)), save)
    this.hooks.onChange()
  }

  /** For the UI: the panel showing now. */
  state(): SidePanelState | null {
    const shown = this.shown()
    if (!shown) return null
    return { extensionId: shown.ext.id, name: shown.ext.name, icon: iconOf(shown.ext), width: this.width() }
  }

  /**
   * Shows the panel's page for the active tab, loading it if needed. Open panels' pages stay
   * loaded while you switch tabs, so they keep their state; pages nothing has open any more close.
   */
  layout() {
    const shown = this.shown()
    const keep = new Set<string>()
    if (shown) keep.add(shown.key)
    const path = (profile: string, extId: string, tabId?: number) => {
      const ext = this.runtimes.get(profile)?.session.extensions.getExtension(extId)
      return (tabId !== undefined ? this.tabOptions.get(tabId)?.get(extId)?.path : undefined) ?? this.saved[profile]?.[extId]?.path ?? (ext && defaultPath(ext))
    }
    for (const [profile, extId] of this.openGlobal) keep.add(`${profile}|${extId}|global|${path(profile, extId)}`)
    for (const [tabId, { profile, ext }] of this.openTab) keep.add(`${profile}|${ext}|${tabId}|${path(profile, ext, tabId)}`)
    for (const [key, view] of this.views) {
      if (keep.has(key)) continue
      this.hooks.window().contentView.removeChildView(view)
      view.webContents.close()
      this.views.delete(key)
    }
    for (const [key, view] of this.views) if (key !== shown?.key) view.setVisible(false)
    if (!shown) return
    const view = this.views.get(shown.key) ?? this.create(shown)
    if (!view) return
    view.setBounds(this.hooks.bounds())
    view.setVisible(this.hooks.visible())
  }

  private create(shown: Shown): WebContentsView | undefined {
    const rt = this.runtimes.get(shown.profile)
    if (!rt) return undefined
    const view = new WebContentsView({ webPreferences: { session: rt.session, sandbox: true, contextIsolation: true } })
    view.setVisible(false)
    view.setBorderRadius(9)
    this.hooks.window().contentView.addChildView(view)
    this.hooks.onViewAdded()
    this.views.set(shown.key, view)
    const wc = view.webContents
    wc.on('before-input-event', (event, input) => {
      if (this.hooks.onKey(input)) event.preventDefault()
    })
    // Links from the panel open as tabs in its profile.
    wc.setWindowOpenHandler(({ url }) => {
      this.hooks.openTab(shown.profile, url)
      return { action: 'deny' }
    })
    wc.on('context-menu', (_e, params) => {
      const items: Electron.MenuItemConstructorOptions[] = []
      if (params.isEditable) items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' })
      else if (params.selectionText) items.push({ role: 'copy' }, { type: 'separator' })
      items.push({ label: 'Reload', click: () => wc.reload() }, { label: 'Inspect', click: () => wc.inspectElement(params.x, params.y) })
      Menu.buildFromTemplate(items).popup({ window: this.hooks.window() })
    })
    // The path must stay inside the extension: "https://…" or "//host/…" would load any site.
    // URL.origin is "null" for every chrome-extension: URL, so compare scheme and host instead.
    const url = URL.parse(shown.path, shown.ext.url)
    if (!url || url.protocol !== 'chrome-extension:' || url.host !== shown.ext.id) {
      console.error(`[side-panel] ${shown.ext.name}: ${shown.path} is not a page of the extension`)
      return view
    }
    void wc.loadURL(url.href).catch((error) => {
      console.error(`[side-panel] ${shown.ext.name}: could not load ${shown.path}:`, error)
    })
    return view
  }
}

const defaultPath = (ext: Electron.Extension): string | undefined =>
  (ext.manifest as { side_panel?: { default_path?: string } }).side_panel?.default_path?.replace(/^\//, '')

