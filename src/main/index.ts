import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, MenuItem, nativeImage, nativeTheme, Notification, powerMonitor, session, shell, systemPreferences, Tray } from 'electron'
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { ACTIONS, actionKeys, FIXED, isGlobal, shortcutFromKey, shortcutLabel, type ActionId } from '../shared/shortcuts'
import { siteProfile as matchSiteProfile, urlMatcher } from '../shared/patterns'
import { awayFromHome, besideClosed, isInFolder, isPinned, keptThreads, numberedThreads, sections, type FolderView } from '../shared/threads'
import { forcedSearch, isSearchUrl, looksLikeAddress, suggestUrlFor } from '../shared/engines'
import { THEMES, URL_BAR_STYLES, type AppEntry, type AppLabel, type Folder, type ExtensionView, type Prefs, type Profile, type RestyleAgent, type SearchReply, type SuggestReply, type TabRecord, type UiState } from '../shared/types'
import { AppDirectory, bundleIdOf } from './apps'
import { BACKGROUND } from './background'
import { Certificates } from './certs'
import { DangerousSites } from './dangerous'
import { DeviceChooser } from './devices'
import { Logins } from './logins'
import { SignInSheets } from './signin'
import { isSearchPage, SiteInfo } from './site-info'
import { ExtensionCommands } from './commands'
import { eraseExtensionData, iconOf, localize, localizedName, messages, readFolder, type ExtensionFolder } from './extension-files'
import { forgetInstall } from './installed'
import { jbrowExtensionDir } from './jbrow-extension'
import { Downloads, type DownloadAction } from './downloads'
import { handleFavicons } from './favicons'
import { FindInPage } from './find'
import { frontmostApp, type FrontApp } from './frontmost'
import { ExtensionDebugger } from './debugger'
import { libraryOf } from './library'
import { IdleWatcher } from './idle'
import { secondsSinceInput } from './input'
import { logPath, setupLogging } from './log'
import { Panel } from './panel'
import { SitePermissions } from './permissions'
import { MiniPlayer } from './pip'
import { pickShareSource } from './screenshare'
import { SidePanels } from './side-panel'
import { attachStorageEvents } from './storage-events'
import { installTestExtensions, loadUnpacked, partitionFor, setupProfile, setupProfiles, startWorker, type ProfileDeps, type ProfileRuntime, type TabHooks } from './profiles'
import { Restyler } from './restyle'
import { loadSettings, saveSettings, scopeForApp, settingsPath, type Settings } from './settings'
import { wireSwipes } from './swipe'
import { Tabs, toUrl, type UnloadKind } from './tabs'
import { blockThirdPartyCookies, thirdPartyCookiesBlocked } from './third-party-cookies'
import { UserScripts } from './user-scripts'
import { topSiteCompletion } from './top-sites'
import { BrowsingHistory, fetchSearchSuggestions } from './visits'
import { takeUpdateRelaunch, Updates } from './updates'
import { Zoom, ZOOM_STEPS, zoomSite } from './zoom'
import { rm, writeFile } from 'node:fs/promises'
import { setDefaultAutoSelectFamilyAttemptTimeout } from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

/** A link this long after your last click or key press opens quietly. */
const QUIET_AFTER_S = 2
const AWAY_FRESH_MS = 4 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS
const SWEEP_EVERY_MS = 10 * 60 * 1000

let settings: Settings
let panel: Panel
let tabs: Tabs
let runtimes = new Map<string, ProfileRuntime>()
let tray: Tray | null = null
let commands: ExtensionCommands
let downloads: Downloads
let restyler: Restyler
let certs: Certificates
let siteInfo: SiteInfo
let dangerous: DangerousSites
let logins: Logins
let signIns: SignInSheets
let devices: DeviceChooser
let permissions: SitePermissions
let profileDeps: ProfileDeps
let sidePanels: SidePanels
let idle: IdleWatcher
let extensionDebugger: ExtensionDebugger
let userScripts: UserScripts
let updates: Updates
/** Pages you've visited, per profile, for the address bar's suggestions. */
const visits = new BrowsingHistory()
/** The settings screen is recording a shortcut: key presses go to it, not to jbrow or extensions. */
let recordingShortcut = false
/** The settings tab is the one showing, so closing a tab closes it. */
let settingsShown = false

let filter = 'all'
let scope: { key: string; name: string } | null = null
let lastFront: FrontApp | null = null
let hiddenAt = 0
/**
 * Threads (root IDs) archived since you last looked, for the sidebar's Undo. `seenAt` is when it
 * was put on screen: archiving while jbrow is hidden counts from the next show. The notice goes
 * when jbrow hides after it's been on screen for a few seconds, so a glance doesn't take it away.
 */
let archiveNotice: { roots: string[]; seenAt: number | null } | null = null
const NOTICE_SEEN_MS = 3000
// The PiP window's "back to tab" brings jbrow back on the video's tab. A page can make its video
// leave PiP while playing too, so it only counts if a click just made jbrow the frontmost app:
// showing the panel takes keyboard focus from whatever you're typing in.
const miniPlayer = new MiniPlayer(async (wc) => {
  if ((await frontmostApp())?.pid !== process.pid) return
  const id = tabs.idForWebContents(wc)
  if (id && id !== tabs.activeId) tabs.activate(id)
  void panel.show()
})
/** The page that was in front, for moving its video into the mini player when you switch tabs. */
let shownPage: Electron.WebContents | null = null
/** Names and icons of apps, for the sidebar's app sections and the Apps settings. */
const apps = new AppDirectory(() => {
  if (!panel) return
  pushState()
  sendApps()
})
/** Apps added in settings this session that have no profile or link yet, so they don't vanish from the list. */
const addedApps = new Set<string>()

// JBROW_USER_DATA=/some/dir runs a separate jbrow with its own tabs, profiles and log, next to
// the one you use, downloading into its own Downloads folder. Handy for debugging extensions
// without touching your real data.
if (process.env.JBROW_USER_DATA) {
  app.setPath('userData', process.env.JBROW_USER_DATA)
  // path.join, not a /: on Windows Chromium fails every download into a folder written C:\x/Downloads.
  app.setPath('logs', path.join(process.env.JBROW_USER_DATA, 'logs'))
  app.setPath('downloads', path.join(process.env.JBROW_USER_DATA, 'Downloads'))
}
setupLogging()
// electron-chrome-web-store downloads extensions with Node's fetch, which tries IPv4 and IPv6 in
// turn and drops each after 250 ms. A connection to Google that takes longer, with IPv6
// unreachable, fails the install as "fetch failed"; Chromium's own stack waits it out.
setDefaultAutoSelectFamilyAttemptTimeout(2000)
// A Chromium switch, so it's read before the app is ready and a change waits for a restart.
if (loadSettings().blockThirdPartyCookies) blockThirdPartyCookies()
// Utilities that quit apps with no open windows (Vorssaint, for one) will quit jbrow while it's
// hidden. Exclude jbrow in them; this line in the log shows when it happens.
app.on('before-quit', () => {
  console.log('[jbrow] quitting')
  // A move or resize from the last moment, while the window is still there.
  panel?.flush()
})

if (!app.requestSingleInstanceLock()) app.quit()

// Links and HTML files from other apps, once jbrow is the default browser (only the packaged app
// can be). macOS can send them before jbrow is ready, when it launches jbrow to open one.
let started = false
const waitingLinks: string[] = []
const openLink = (url: string) => (started ? void openFromApp(url) : waitingLinks.push(url))
app.on('open-url', (event, url) => {
  event.preventDefault()
  openLink(url)
})
app.on('open-file', (event, file) => {
  event.preventDefault()
  openLink(pathToFileURL(file).href)
})

// ---------- state for the UI ----------

function state(): UiState {
  const active = tabs.active()
  return {
    tabs: tabs.uiTabs().map((t) => {
      const wc = tabs.webContentsFor(t.id)
      const drivenBy = wc ? extensionDebugger.holder(wc) : undefined
      return drivenBy ? { ...t, drivenBy } : t
    }),
    activeId: tabs.activeId,
    folders: tabs.folders,
    splits: tabs.splits,
    archiveNotice: noticeRoots(),
    activeWebContentsId: tabs.activeWebContents()?.id ?? null,
    activePartition: active ? partitionFor(active.profile) : null,
    activeExtensions: actionExtensions(active?.profile),
    tabExtensions: tabExtensions(),
    profiles: settings.profiles,
    filter,
    scope,
    apps: appLabels(),
    pinned: panel.pinned,
    sidePanel: sidePanels?.state() ?? null,
    restyle: active ? restyler.view(active.url) : null,
    cert: active ? certs.view(active.id, active.profile, active.url) : null,
    insecure: !!active && isInsecure(active.url),
    danger: active ? dangerous.view(active.id) : null,
    dangerLists: dangerous.status(),
    thirdPartyCookiesBlocked: thirdPartyCookiesBlocked(),
    login: active ? logins.view(active.id) : null,
    crash: active ? tabs.crash(active.id) : null,
    devices: active ? devices.view(active.id) : null,
    styledSites: restyler.styledSites(),
    restyleAgents: restyler.agents(),
    zoomSites: zoom.list(),
    nav: tabs.navState(),
    keys: actionKeys(settings.shortcuts),
    prefs: {
      appearance: settings.appearance,
      theme: settings.theme,
      profileStyle: settings.profileStyle,
      profileSwitcher: settings.profileSwitcher,
      animation: settings.animation,
      whimsy: settings.whimsy,
      privateUrls: settings.privateUrls,
      profileSites: settings.profileSites,
      hideFromScreenCapture: settings.hideFromScreenCapture,
      dangerousSites: settings.dangerousSites,
      blockThirdPartyCookies: settings.blockThirdPartyCookies,
      quietLinks: settings.quietLinks,
      summarizeAfterDays: settings.summarizeAfterDays,
      archiveAfterDays: settings.archiveAfterDays,
      keepLoaded: settings.keepLoaded,
      earlierAfterHours: settings.earlierAfterHours,
      pinnedExtensions: settings.pinnedExtensions,
      pinnedRows: settings.pinnedRows,
      numberFrom: settings.numberFrom,
      newTabsAt: settings.newTabsAt,
      openApps: settings.openApps,
      restyleEnabled: settings.restyle.enabled,
      restyleAgent: settings.restyle.agent,
      restyleModel: settings.restyle.model,
      restyleCodexModel: settings.restyle.codexModel,
      defaultProfile: settings.defaultProfile,
      miniPlayer: settings.miniPlayer,
      zoom: { defaultPercent: settings.zoom.defaultPercent, remember: settings.zoom.remember },
      searchUrl: settings.searchUrl,
      searchSuggestions: settings.searchSuggestions,
      urlBarStyle: settings.urlBarStyle,
      autoUpdate: settings.autoUpdate,
    },
    now: Date.now(),
  }
}

/** The extensions tabs show as having opened them or working in them, by ID. */
function tabExtensions(): UiState['tabExtensions'] {
  const out: UiState['tabExtensions'] = {}
  for (const t of tabs.records) {
    const wc = tabs.webContentsFor(t.id)
    for (const id of [t.openedBy, wc ? extensionDebugger.holder(wc) : undefined]) {
      if (!id || out[id]) continue
      const ext = runtimes.get(t.profile)?.session.extensions.getExtension(id)
      if (ext) out[id] = { name: localizedName(ext), icon: iconOf(ext) }
    }
  }
  return out
}

/** IDs of a profile's extensions that have a toolbar button. */
function actionExtensions(profileId: string | undefined): string[] {
  const rt = profileId ? runtimes.get(profileId) : undefined
  if (!rt) return []
  return rt.session.extensions
    .getAllExtensions()
    .filter((e) => {
      const m = e.manifest as { action?: unknown; browser_action?: unknown }
      return m.action || m.browser_action
    })
    .map((e) => e.id)
}

function togglePinnedExtension(id: string) {
  const pinned = settings.pinnedExtensions
  settings.pinnedExtensions = pinned.includes(id) ? pinned.filter((p) => p !== id) : [...pinned, id]
  saveSettings(settings)
  pushState()
}

// ---------- turning extensions off and removing them ----------

/** Every extension in every profile, on or off, for the Extensions settings. */
function extensionViews(): ExtensionView[] {
  const views: ExtensionView[] = []
  for (const p of settings.profiles) {
    const rt = runtimes.get(p.id)
    if (!rt) continue
    const view = (ext: ExtensionFolder, id: string, enabled: boolean): ExtensionView => ({
      profile: p.id,
      id,
      name: localizedName(ext),
      version: String(ext.manifest.version ?? ''),
      description: localize(String(ext.manifest.description ?? ''), messages(ext)),
      icon: iconOf(ext),
      enabled,
      unpacked: !isInside(ext.path, rt.extensionsPath),
    })
    for (const ext of rt.session.extensions.getAllExtensions()) {
      if (ext.path !== jbrowExtensionDir()) views.push(view(ext, ext.id, true))
    }
    for (const d of settings.disabledExtensions[p.id] ?? []) {
      const ext = readFolder(d.path)
      if (ext) views.push(view(ext, d.id, false))
    }
  }
  return views.sort((a, b) => a.name.localeCompare(b.name))
}

const isInside = (file: string, dir: string) => !path.relative(dir, file).startsWith('..')

let extensionsQueued = false
function sendExtensions() {
  if (extensionsQueued) return
  extensionsQueued = true
  // Removing or loading several at once sends one list.
  setTimeout(() => {
    extensionsQueued = false
    if (!panel.win.isDestroyed() && settingsShown) panel.ui.send('extensions', { profiles: settings.profiles, extensions: extensionViews() })
  }, 50)
}

/** Turns an extension off (it stays installed, and loads no more) or back on. */
async function setExtensionEnabled(profileId: string, id: string, on: boolean) {
  const rt = runtimes.get(profileId)
  if (!rt) return
  const disabled = (settings.disabledExtensions[profileId] ??= [])
  if (!on) {
    const ext = rt.session.extensions.getExtension(id)
    if (!ext) return
    disabled.push({ id, path: ext.path })
    saveSettings(settings)
    rt.session.extensions.removeExtension(id)
  } else {
    const entry = disabled.find((d) => d.id === id)
    if (!entry) return
    try {
      const unpacked = !isInside(entry.path, rt.extensionsPath)
      const ext = await rt.session.extensions.loadExtension(entry.path, unpacked ? { allowFileAccess: true } : undefined)
      await startWorker(rt.session, ext, profileId)
    } catch (error) {
      console.error(`[extensions] could not turn ${id} back on:`, error)
      toast(`That extension didn't load: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  pushState()
  sendExtensions()
}

/** Removes an extension from a profile after asking, with what it stored. A folder you added stays on disk. */
async function removeExtension(profileId: string, id: string) {
  const rt = runtimes.get(profileId)
  if (!rt) return
  const loaded = rt.session.extensions.getExtension(id)
  const entry = settings.disabledExtensions[profileId]?.find((d) => d.id === id)
  const dir = loaded?.path ?? entry?.path
  const folder = dir ? readFolder(dir) : null
  if (!dir || !folder) return
  const name = localizedName(folder)
  const unpacked = !isInside(dir, rt.extensionsPath)
  const { response } = await dialog.showMessageBox(panel.win, {
    type: 'warning',
    message: `Remove "${name}" from ${rt.profile.name}?`,
    detail: unpacked
      ? 'What it stored is erased. Its folder stays where it is, so you can add it again.'
      : 'What it stored is erased, like its settings and anything you saved in it.',
    buttons: ['Cancel', 'Remove'],
    defaultId: 0,
    cancelId: 0,
  })
  if (response !== 1) return

  if (loaded) rt.session.extensions.removeExtension(id)
  if (settings.disabledExtensions[profileId]) {
    settings.disabledExtensions[profileId] = settings.disabledExtensions[profileId].filter((d) => d.id !== id)
  }
  if (unpacked) settings.unpackedExtensions[profileId] = (settings.unpackedExtensions[profileId] ?? []).filter((d) => d !== dir)
  if (settings.extensionShortcuts[profileId]) delete settings.extensionShortcuts[profileId][id]
  const elsewhere = [...runtimes.values()].some(
    (other) => other.session.extensions.getExtension(id) || settings.disabledExtensions[other.profile.id]?.some((d) => d.id === id),
  )
  if (!elsewhere) settings.pinnedExtensions = settings.pinnedExtensions.filter((p) => p !== id)
  saveSettings(settings)
  userScripts.forgetExtension(profileId, id)
  forgetInstall(rt.session, id)
  if (!unpacked) await rm(path.join(rt.extensionsPath, id), { recursive: true, force: true }).catch(() => {})
  await eraseExtensionData(rt.session, id)
  commands.refresh()
  commands.registerGlobal()
  pushState()
  sendExtensions()
  toast(`Removed ${name} from ${rt.profile.name}.`)
}

let pushQueued = false
/** The `tabs.archivedRev` the UI has. Archived tabs can run to thousands, so they go only when they change. */
let archivedSent = -1
function pushState() {
  if (pushQueued) return
  pushQueued = true
  queueMicrotask(() => {
    pushQueued = false
    if (!panel.win.isDestroyed()) {
      if (archivedSent !== tabs.archivedRev) {
        archivedSent = tabs.archivedRev
        panel.ui.send('archived', tabs.archived)
      }
      panel.ui.send('state', state())
    }
    updateTray()
  })
}

/**
 * Keyboard focus lives in one WebContents at a time: a page, or jbrow's UI. Focusing an input
 * inside the UI does nothing until the UI itself has focus, and closing a page leaves focus
 * nowhere, so focus is handed over explicitly.
 */
function focusAddressBar() {
  if (panel.win.isDestroyed()) return
  panel.ui.focus()
  panel.ui.send('focus-omnibox')
}

/**
 * Focus the active page, or the address bar for a new tab. A page jbrow covers with its own
 * screen (sign-in, crash, certificate) leaves focus with jbrow's UI, which picks the field.
 * Only while jbrow is on screen.
 */
function focusActive() {
  if (!panel.visible || panel.win.isDestroyed()) return
  const wc = tabs.activeWebContents()
  const rec = tabs.active()
  if (rec && wc && tabs.covered(rec.id)) panel.ui.focus()
  else if (wc && rec?.url) wc.focus()
  else focusAddressBar()
}

function sendDownloads() {
  if (!panel.win.isDestroyed()) panel.ui.send('downloads', downloads.list())
}

/** A link that opened a new tab only to download something leaves that tab empty; close it, as Chrome does. */
function closeDownloadOnlyTab(wc: Electron.WebContents) {
  const id = tabs.idForWebContents(wc)
  const rec = tabs.get(id)
  if (!id || !rec?.opener) return
  const committed = wc.getURL()
  if (wc.navigationHistory.canGoBack() || (committed && committed !== 'about:blank')) return
  setTimeout(() => void closeTab(id, false, false), 0)
}

const toast = (text: string) => {
  if (!panel.win.isDestroyed()) panel.ui.send('toast', text)
}

const zoom = new Zoom(() => settings, () => saveSettings(settings))

const finder = new FindInPage((update) => {
  if (!panel.win.isDestroyed()) panel.ui.send('find', update)
})

/**
 * Opens the find bar, or selects its query if it's open. Only for a tab with a page, unless
 * settings covers it: the UI then focuses the settings search, or the Archived list's.
 */
function openFind() {
  if (panel.win.isDestroyed() || (!panel.covered && (!tabs.activeWebContents() || !tabs.active()?.url))) return
  panel.ui.focus()
  panel.ui.send('find', { open: true })
}

// ---------- profiles and scopes ----------

function newTabProfile(): string {
  if (filter !== 'all') return filter
  if (scope && lastFront) {
    const forApp = settings.appProfiles[lastFront.bundleId]
    if (forApp) return forApp
  }
  return tabs.active()?.profile ?? settings.defaultProfile
}

/** The profile an address always opens in, by the sites you gave your profiles. */
function siteProfile(url: string): string | undefined {
  const id = matchSiteProfile(settings.profileSites, url)
  return id && settings.profiles.some((p) => p.id === id) ? id : undefined
}

function scopeFields() {
  return scope ? { scope: scope.key, scopeName: scope.name, app: lastFront?.bundleId } : {}
}

/** Bundle IDs in a scope key: one app, or a linked group joined with +. */
const appsIn = (key: string) => key.split('+')

const scopeName = (key: string) => appsIn(key).map((id) => apps.name(id)).join(' + ')

/** Labels for every app scope a thread belongs to. */
function appLabels(): Record<string, AppLabel> {
  const keys = new Set(tabs.records.flatMap((t) => (t.scope ? [t.scope] : [])))
  if (scope) keys.add(scope.key)
  const labels: Record<string, AppLabel> = {}
  for (const key of keys) {
    labels[key] = { name: scopeName(key), icons: appsIn(key).flatMap((id) => apps.icon(id) ?? []) }
  }
  return labels
}

function threadsInView() {
  const appNames = Object.fromEntries(Object.entries(appLabels()).map(([k, l]) => [k, l.name]))
  return sections(tabs.records, { filter, scope: scope?.key ?? null, activeId: tabs.activeId, now: Date.now(), folders: tabs.folders, appNames, earlierAfterMs: settings.earlierAfterHours * HOUR_MS, newTabsAt: settings.newTabsAt })
}

/** Unloads and archives stale threads, or files them into folders, per settings. */
function sweep() {
  const archived = tabs.sweep(settings.archiveAfterDays * DAY_MS, settings.summarizeAfterDays * DAY_MS)
  if (!archived.length) return
  const seenAt = archiveNotice?.seenAt ?? (panel?.visible ? Date.now() : null)
  archiveNotice = { roots: [...new Set([...(archiveNotice?.roots ?? []), ...archived])], seenAt }
  pushState()
}

/** The notice's threads that are still archived; one brought back or forgotten meanwhile drops out. */
function noticeRoots(): string[] | null {
  const roots = archiveNotice?.roots.filter((id) => tabs.archived.some((t) => t.id === id))
  return roots?.length ? roots : null
}

/** Puts the threads the notice names back where they were. */
/** Restoring more threads than this at once asks first, since each takes a place in the sidebar. */
const RESTORE_ASK = 10

/** Brings archived threads (root IDs) back into the sidebar as seen now, from the Archived list. */
async function unarchiveThreads(ids: string[]) {
  if (ids.length > RESTORE_ASK) {
    const { response } = await dialog.showMessageBox(panel.win, {
      type: 'question',
      message: `Restore ${ids.length} tabs?`,
      detail: "They go back into the sidebar as seen now, and archive again if you don't open them.",
      buttons: ['Cancel', 'Restore'],
      defaultId: 1,
      cancelId: 0,
    })
    if (response !== 1) return
  }
  tabs.unarchive(ids)
}

/** Drops archived threads (root IDs) for good. More than one asks first; there's no Undo. */
async function forgetArchived(ids: string[]) {
  if (ids.length > 1) {
    const { response } = await dialog.showMessageBox(panel.win, {
      type: 'warning',
      message: `Forget ${ids.length} archived tabs?`,
      detail: 'Their tabs and back and forward history are gone for good. This cannot be undone.',
      buttons: ['Cancel', 'Forget'],
      defaultId: 0,
      cancelId: 0,
    })
    if (response !== 1) return
  }
  tabs.forget(ids)
}

function undoArchive() {
  const roots = noticeRoots()
  archiveNotice = null
  if (roots) tabs.unarchive(roots, true)
  pushState()
}

/** Most recently seen tab among the threads the sidebar currently shows. */
function mostRecentInView(): string | undefined {
  const s = threadsInView()
  const all = [...s.pinned, ...keptThreads(s), ...s.today, ...s.apps.flatMap((a) => [...a.threads, ...a.earlier]), ...s.earlier]
  return all.sort((a, b) => b.lastSeen - a.lastSeen)[0]?.last.id
}

function activeInView(): boolean {
  const active = tabs.active()
  if (!active) return false
  return (filter === 'all' || active.profile === filter) && (!scope || active.scope === scope.key || isPinned(active))
}

// ---------- summoning ----------

async function summon() {
  if (!panel.visible) {
    sweep()
    const away = hiddenAt ? Date.now() - hiddenAt : 0
    if (away > AWAY_FRESH_MS) tabs.newTab({ profile: newTabProfile(), ...scopeFields() })
  }
  if (!activeInView()) {
    const recent = mostRecentInView()
    if (recent) tabs.activate(recent)
    else tabs.newTab({ profile: newTabProfile(), ...scopeFields() })
  }
  pushState()
  await panel.show()
  // The page, or the address bar for an empty tab.
  focusActive()
}

async function onHotkey() {
  if (panel.visible && !scope) return panel.hide()
  scope = null
  await summon()
}

async function onAppHotkey() {
  const front = panel.visible ? null : await frontmostApp()
  if (front && front.pid !== process.pid) {
    lastFront = front
    apps.note(front.bundleId, front.name)
  }
  if (!lastFront) return onHotkey()
  const key = scopeForApp(settings, lastFront.bundleId)
  if (panel.visible && scope?.key === key) return panel.hide()
  scope = { key, name: scopeName(key) }
  filter = 'all'
  await summon()
}

/** Global shortcuts jbrow holds now, for unregistering. */
let hotkeysHeld: string[] = []

/** Registers the summon keys. `notify` tells you when another app holds one. */
function registerHotkeys(notify = false) {
  unregisterHotkeys()
  if (BACKGROUND) return
  const keys = actionKeys(settings.shortcuts)
  const failed: string[] = []
  for (const [id, run] of [['show', onHotkey], ['showApp', onAppHotkey]] as const) {
    const key = keys[id]
    if (!key) continue
    if (globalShortcut.register(key, () => void run())) hotkeysHeld.push(key)
    else failed.push(shortcutLabel(key))
  }
  if (failed.length) {
    const text = `Another app is using ${failed.join(' and ')}. Pick another in jbrow's settings.`
    console.error(`[hotkeys] ${text}`)
    if (notify) new Notification({ title: 'jbrow hotkey unavailable', body: text }).show()
  }
}

function unregisterHotkeys() {
  for (const key of hotkeysHeld) globalShortcut.unregister(key)
  hotkeysHeld = []
}

/**
 * While the settings screen records a shortcut, every key press goes to it: global shortcuts
 * included, or pressing ⌥Space to choose it would hide jbrow instead.
 */
function setRecording(on: boolean) {
  if (on === recordingShortcut) return
  recordingShortcut = on
  if (on) {
    unregisterHotkeys()
    commands.unregisterGlobal()
  } else {
    registerHotkeys()
    commands.registerGlobal()
  }
}

/** Sets your key for one of jbrow's commands; '' removes it. Returns why it can't have that key, if it can't. */
function setActionKey(id: ActionId, shortcut: string): string | null {
  const action = ACTIONS.find((a) => a.id === id)
  if (!action) return null
  if (!shortcut && id === 'show') return 'Show jbrow needs a shortcut.'
  if (shortcut) {
    if (FIXED.has(shortcut)) return 'jbrow keeps that shortcut for ⌘1–9, zoom or editing.'
    const keys = actionKeys(settings.shortcuts)
    const other = ACTIONS.find((a) => a.id !== id && keys[a.id] === shortcut)
    if (other) return `"${other.label}" already uses that shortcut.`
    const ext = commands.holder(shortcut)
    if (ext) return `${ext.extensionName} uses that shortcut for "${ext.description}". Change it there first.`
    if (isGlobal(id) && !hotkeysHeld.includes(shortcut)) {
      // Ours are let go while recording, so this only fails when another app has it.
      if (!globalShortcut.register(shortcut, () => {})) return 'Another app is using that shortcut.'
      globalShortcut.unregister(shortcut)
    }
  }
  if (shortcut === action.key) delete settings.shortcuts[id]
  else settings.shortcuts[id] = shortcut
  saveSettings(settings)
  commands.refresh()
  buildAppMenu()
  if (!recordingShortcut) {
    registerHotkeys()
    commands.registerGlobal()
  }
  pushState()
  sendShortcuts()
  return null
}

// ---------- keyboard shortcuts inside the panel ----------

function openThread(n: number) {
  const thread = numberedThreads(threadsInView(), { from: settings.numberFrom, openApps: settings.openApps })[n - 1]
  if (thread) tabs.activate(thread.last.id)
}

/**
 * Moves a tab to another profile. A new tab just switches, and so does a loaded one `inPlace`
 * (the profile in the address bar): its page loads again there. Otherwise a loaded page reopens
 * in the other profile next to the original.
 */
function switchProfile(id: string, next: string, inPlace = false) {
  const cur = tabs.get(id)
  if (!cur || cur.profile === next) return
  if (filter !== 'all' && filter !== next) filter = 'all'
  if (!cur.url || inPlace) {
    tabs.setProfile(id, next)
    pushState()
    return
  }
  tabs.create({ profile: next, url: cur.url, scope: cur.scope, scopeName: cur.scopeName, app: cur.app })
}

/** The host a page is on, for notices; '' for one without (a file, a blank page). */
function siteName(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

const profileName = (id: string) => settings.profiles.find((p) => p.id === id)?.name ?? id

function runAction(id: ActionId) {
  const wc = tabs.activeWebContents()
  switch (id) {
    case 'show':
      return void onHotkey()
    case 'showApp':
      return void onAppHotkey()
    case 'newTab':
      tabs.newTab({ profile: newTabProfile(), ...scopeFields() })
      return focusAddressBar()
    case 'newTabNextProfile': {
      const ids = settings.profiles.map((p) => p.id)
      const cur = tabs.active()?.profile ?? settings.defaultProfile
      tabs.create({ profile: ids[(ids.indexOf(cur) + 1) % ids.length], ...scopeFields() })
      return focusAddressBar()
    }
    case 'closeTab':
      if (settingsShown) panel.ui.send('settings', { open: false })
      else if (tabs.activeId) void closeTab(tabs.activeId)
      else tabs.newTab({ profile: newTabProfile(), ...scopeFields() })
      return
    case 'reopenTab':
      return void tabs.reopen()
    case 'previousTab': {
      const prev = tabs.previous()
      if (prev) tabs.activate(prev)
      return
    }
    case 'splitView': {
      const error = tabs.splitNew()
      return error ? toast(error) : undefined
    }
    case 'paneLeft':
    case 'paneRight':
      return tabs.focusPane(id === 'paneLeft' ? -1 : 1)
    case 'address':
      return focusAddressBar()
    case 'copyUrl': {
      const url = tabs.active()?.url
      if (!url) return
      clipboard.writeText(url)
      return panel.ui.send('url-copied')
    }
    case 'find':
      return openFind()
    case 'reload':
    case 'hardReload':
      return tabs.activeId ? tabs.reload(tabs.activeId, id === 'hardReload') : undefined
    case 'print':
      return wc && tabs.active()?.url ? printPage(wc) : undefined
    case 'back':
      return wc?.navigationHistory.goBack()
    case 'forward':
      return wc?.navigationHistory.goForward()
    case 'pin':
      return setPinned(!panel.pinned)
    case 'settings':
      return panel.ui.send('settings', {})
    case 'devTools':
      return wc?.openDevTools({ mode: 'detach' })
  }
}

/** Off macOS, Ctrl does what ⌘ does: ⌃T opens a tab there, as in Chrome. */
const CTRL_IS_COMMAND = process.platform !== 'darwin'
const commandHeld = (input: Electron.Input) => input.meta || (CTRL_IS_COMMAND && input.control)

/**
 * The shortcuts a key press can be, to look up in that order: the key as pressed, then off macOS
 * the same with Ctrl as ⌘. So a key that really uses Control, as ⌃Tab does, still wins.
 */
function shortcutsFor(input: Electron.Input): string[] {
  const exact = shortcutFromKey({ ...input, command: input.meta })
  const asCommand = CTRL_IS_COMMAND && input.control && !input.meta ? shortcutFromKey({ ...input, control: false, command: true }) : null
  return [exact, asCommand].filter((s): s is string => !!s)
}

/** The command a key press runs, if any. The summon keys are global shortcuts, so they never reach a window. */
function actionFor(input: Electron.Input): ActionId | undefined {
  const keys = actionKeys(settings.shortcuts)
  for (const shortcut of shortcutsFor(input)) {
    const action = ACTIONS.find((a) => keys[a.id] === shortcut && !isGlobal(a.id))
    if (action) return action.id
  }
}

/** ⌘+ (1), ⌘− (−1) or ⌘0 (0) for zoom; null for any other key. */
function zoomDirection(input: Electron.Input): -1 | 0 | 1 | null {
  if (!commandHeld(input) || input.alt) return null
  const key = input.key.toLowerCase()
  // Matched by code too, so zoom works on layouts where = and - sit elsewhere or need Shift.
  return key === '=' || key === '+' || input.code === 'Equal' || input.code === 'NumpadAdd' ? 1
    : key === '-' || input.code === 'Minus' || input.code === 'NumpadSubtract' ? -1
    : key === '0' || input.code === 'Numpad0' ? 0
    : null
}

function zoomActive(direction: -1 | 0 | 1) {
  const wc = tabs.activeWebContents()
  if (!wc) return
  const percent = zoom.step(wc, direction)
  toast(`Zoom ${percent}%`)
  pushState()
}

function onKey(input: Electron.Input): boolean {
  if (input.type !== 'keyDown' || recordingShortcut) return false
  if (commands?.handleKey(tabs.active()?.profile, input)) return true
  const action = actionFor(input)
  if (action) {
    runAction(action)
    return true
  }
  // ⌘G and ⇧⌘G step through the matches while the find bar is open.
  const shortcuts = shortcutsFor(input)
  if (finder.open && (shortcuts.includes('Command+G') || shortcuts.includes('Command+Shift+G'))) {
    panel.ui.send('find', { step: shortcuts.includes('Command+G') ? 1 : -1 })
    return true
  }
  if (!commandHeld(input)) return false
  const key = input.key.toLowerCase()
  const zoomKey = zoomDirection(input)
  if (zoomKey !== null) {
    zoomActive(zoomKey)
    return true
  }
  if (!input.alt && !input.shift && /^[1-9]$/.test(key)) {
    openThread(Number(key))
    return true
  }
  return false
}

/** Action popups open for the active tab; extension shortcuts pressed in one act on that tab. */
const popupTabs = new WeakMap<Electron.WebContents, Electron.WebContents>()

/** jbrow's commands that bring up the panel when pressed in another window, to do their thing there. */
const PANEL_ACTIONS = new Set<ActionId>(['newTab', 'newTabNextProfile', 'settings'])

/**
 * Keys in jbrow's other windows: extension popups, pop-out windows and popups pages open. As in
 * Chrome, extension shortcuts work there too, for the window's profile. Your keys for closing a
 * tab, reloading, zoom and DevTools act on the window and its page; new tab, new tab in the next
 * profile and settings bring up the panel to do their thing. Every other key reaches the page.
 */
function onWindowKey(wc: Electron.WebContents, input: Electron.Input): boolean {
  if (input.type !== 'keyDown' || recordingShortcut || wc.isDestroyed()) return false
  // Tabs and side panels have the panel's keys (onKey).
  const win = BrowserWindow.fromWebContents(wc)
  if (!win || win === panel.win || tabs.idForWebContents(wc)) return false
  const profile = [...runtimes.values()].find((rt) => rt.session === wc.session)?.profile.id
  if (!profile) return false
  const popupTab = popupTabs.get(wc)
  if (commands?.handleKey(profile, input, popupTab && !popupTab.isDestroyed() ? popupTab : undefined)) return true
  const zoomKey = zoomDirection(input)
  if (zoomKey !== null) {
    zoom.step(wc, zoomKey)
    // A web page's zoom is its site's, so the site's tabs follow and the panel shows it.
    if (zoomSite(wc.getURL())) pushState()
    return true
  }
  const action = actionFor(input)
  if (!action) return false
  if (PANEL_ACTIONS.has(action)) {
    void (async () => {
      await summon()
      runAction(action)
    })()
    return true
  }
  switch (action) {
    case 'closeTab':
      win.close()
      return true
    case 'reload':
      wc.reload()
      return true
    case 'hardReload':
      wc.reloadIgnoringCache()
      return true
    case 'devTools':
      wc.openDevTools({ mode: 'detach' })
      return true
  }
  return false
}

// ---------- settings screen, extensions, thread menu ----------

/** Brings jbrow up with the welcome over it, to go through again what it asked at first launch. */
async function showWelcome() {
  await summon()
  panel.ui.send('welcome', { first: false })
}

/** The welcome is done or skipped: it doesn't show at launch again, and the window is pinned or not as chosen. */
function finishWelcome(pinned: boolean) {
  if (!settings.welcomed) {
    settings.welcomed = true
    saveSettings(settings)
  }
  if (pinned !== panel.pinned) setPinned(pinned)
  if (!pinned) toast(`jbrow now hides when you click another app. ${shortcutLabel(actionKeys(settings.shortcuts).show)} brings it back.`)
}

/** Pins or unpins the window and remembers it for next launch. */
function setPinned(on: boolean) {
  panel.setPinned(on)
  if (settings.pinned !== on) {
    settings.pinned = on
    saveSettings(settings)
    buildAppMenu()
  }
  pushState()
}

/** Moves a page's playing video into the mini player, if the mini player settings allow its site. */
function toMiniPlayer(wc: Electron.WebContents | null) {
  // A tab being closed has already left `tabs`.
  if (!wc || wc.isDestroyed() || !tabs.idForWebContents(wc)) return
  const { sites, onlySites, exceptSites, mutedToo } = settings.miniPlayer
  const url = wc.getURL()
  if (sites === 'only' && !urlMatcher(onlySites)(url)) return
  if (sites === 'except' && urlMatcher(exceptSites)(url)) return
  void miniPlayer.enter(wc, mutedToo)
}

/**
 * On switching tabs, the old tab's video goes into the mini player and the new tab's comes back.
 * Moving between the panes of a split keeps both on screen, so nothing moves then.
 */
function tabSwitched() {
  const wc = tabs.activeWebContents()
  const prev = shownPage
  shownPage = wc
  if (prev === wc) return
  if (wc && miniPlayer.webContents === wc) miniPlayer.exit()
  const prevId = prev && !prev.isDestroyed() ? tabs.idForWebContents(prev) : undefined
  if (prevId && tabs.shown().includes(prevId)) return
  if (settings.miniPlayer.onTabSwitch && panel.visible) toMiniPlayer(prev)
}

/**
 * Turns restyling on, if claude or codex is installed: looked for again first, since you may have
 * just installed one. If only the other agent is there, it switches to that one.
 */
async function setRestyleEnabled() {
  const found = await restyler.checkAgents()
  const agent = found[settings.restyle.agent] ? settings.restyle.agent : (Object.keys(found) as RestyleAgent[]).find((a) => found[a])
  if (!agent) {
    toast("jbrow can't find Claude Code or Codex. Install one and sign in, then turn restyling on.")
    return pushState()
  }
  settings.restyle = { ...settings.restyle, enabled: true, agent }
  saveSettings(settings)
  restyler.refreshAll()
  pushState()
}

function updatePrefs(prefs: Partial<Prefs>) {
  if (prefs.appearance === 'system' || prefs.appearance === 'light' || prefs.appearance === 'dark') {
    settings.appearance = prefs.appearance
    nativeTheme.themeSource = prefs.appearance
  }
  if (THEMES.some((t) => t.id === prefs.theme)) settings.theme = prefs.theme!
  if (prefs.profileStyle === 'tint' || prefs.profileStyle === 'edge' || prefs.profileStyle === 'solid') settings.profileStyle = prefs.profileStyle
  if (prefs.profileSwitcher === 'auto' || prefs.profileSwitcher === 'menu') settings.profileSwitcher = prefs.profileSwitcher
  if (prefs.animation) settings.animation = { ...settings.animation, ...prefs.animation }
  if (typeof prefs.whimsy === 'boolean') settings.whimsy = prefs.whimsy
  if (prefs.privateUrls) settings.privateUrls = prefs.privateUrls.map((p) => p.trim()).filter(Boolean)
  if (prefs.profileSites) {
    settings.profileSites = Object.fromEntries(
      Object.entries(prefs.profileSites)
        .filter(([id]) => settings.profiles.some((p) => p.id === id))
        .map(([id, list]) => [id, list.map((p) => p.trim()).filter(Boolean)] as const)
        .filter(([, list]) => list.length),
    )
  }
  if (prefs.hideFromScreenCapture !== undefined) {
    settings.hideFromScreenCapture = prefs.hideFromScreenCapture
    panel.applyContentProtection()
  }
  if (prefs.quietLinks !== undefined) settings.quietLinks = prefs.quietLinks
  if (prefs.dangerousSites !== undefined) {
    settings.dangerousSites = prefs.dangerousSites
    if (settings.dangerousSites) dangerous.start()
  }
  if (prefs.blockThirdPartyCookies !== undefined) settings.blockThirdPartyCookies = prefs.blockThirdPartyCookies
  if (prefs.searchUrl !== undefined && isSearchUrl(prefs.searchUrl.trim())) settings.searchUrl = prefs.searchUrl.trim()
  if (prefs.searchSuggestions !== undefined) settings.searchSuggestions = prefs.searchSuggestions
  if (prefs.urlBarStyle && URL_BAR_STYLES.includes(prefs.urlBarStyle)) settings.urlBarStyle = prefs.urlBarStyle
  if (prefs.autoUpdate !== undefined) settings.autoUpdate = prefs.autoUpdate
  // Only an agent that's installed, and restyling only turned on with one (see setRestyleEnabled).
  if ((prefs.restyleAgent === 'claude' || prefs.restyleAgent === 'codex') && restyler.agents()[prefs.restyleAgent]) settings.restyle = { ...settings.restyle, agent: prefs.restyleAgent }
  if (prefs.restyleEnabled === false && settings.restyle.enabled) {
    settings.restyle = { ...settings.restyle, enabled: false }
    restyler.refreshAll()
  }
  if (prefs.restyleEnabled === true) void setRestyleEnabled()
  if (prefs.restyleModel) settings.restyle = { ...settings.restyle, model: prefs.restyleModel }
  if (prefs.restyleCodexModel !== undefined) settings.restyle = { ...settings.restyle, codexModel: prefs.restyleCodexModel.trim() }
  if (prefs.earlierAfterHours !== undefined) settings.earlierAfterHours = Math.max(1, prefs.earlierAfterHours)
  if (Number.isFinite(prefs.pinnedRows)) settings.pinnedRows = Math.max(1, Math.round(prefs.pinnedRows!))
  if (prefs.numberFrom === 'pinned' || prefs.numberFrom === 'kept' || prefs.numberFrom === 'today') settings.numberFrom = prefs.numberFrom
  if (prefs.newTabsAt === 'top' || prefs.newTabsAt === 'bottom') settings.newTabsAt = prefs.newTabsAt
  if (Array.isArray(prefs.openApps)) settings.openApps = prefs.openApps.filter((k) => typeof k === 'string')
  if (prefs.miniPlayer) {
    const mp = { ...settings.miniPlayer, ...prefs.miniPlayer }
    const clean = (list: string[]) => list.map((p) => p.trim()).filter(Boolean)
    settings.miniPlayer = { ...mp, onlySites: clean(mp.onlySites), exceptSites: clean(mp.exceptSites) }
  }
  if (prefs.zoom) {
    if (prefs.zoom.remember !== undefined) zoom.setRemember(prefs.zoom.remember)
    if (ZOOM_STEPS.includes(prefs.zoom.defaultPercent)) settings.zoom.defaultPercent = prefs.zoom.defaultPercent
    for (const wc of tabs.pages()) zoom.apply(wc)
  }
  if (prefs.archiveAfterDays !== undefined || prefs.summarizeAfterDays !== undefined) {
    if (prefs.archiveAfterDays !== undefined) settings.archiveAfterDays = Math.max(0, prefs.archiveAfterDays)
    if (prefs.summarizeAfterDays !== undefined) settings.summarizeAfterDays = Math.max(0, prefs.summarizeAfterDays)
    sweep()
  }
  if (prefs.keepLoaded) {
    settings.keepLoaded = { ...settings.keepLoaded, ...prefs.keepLoaded }
    tabs.keepLoaded = settings.keepLoaded
    tabs.loadPinned()
    sweep()
  }
  saveSettings(settings)
  pushState()
}

/** Loads an unpacked extension into the active tab's profile and remembers it for next launch. */
async function addExtensionFromFolder() {
  const rt = runtimes.get(tabs.active()?.profile ?? settings.defaultProfile)
  if (!rt) return
  const { canceled, filePaths } = await dialog.showOpenDialog(panel.win, {
    title: `Add an extension to ${rt.profile.name}`,
    message: `Choose the extension's folder (the one with manifest.json). It goes into ${rt.profile.name}.`,
    buttonLabel: 'Add extension',
    properties: ['openDirectory'],
  })
  const dir = filePaths[0]
  if (canceled || !dir) return
  try {
    const ext = await loadUnpacked(rt, dir)
    const dirs = (settings.unpackedExtensions[rt.profile.id] ??= [])
    if (!dirs.includes(dir)) {
      dirs.push(dir)
      saveSettings(settings)
    }
    toast(`Added ${ext.name} to ${rt.profile.name}.`)
  } catch (error) {
    console.error(`[extensions] could not load ${dir}:`, error)
    toast(`That folder didn't load as an extension: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Dialogs jbrow has up for a page. The panel doesn't hide on click-away while one is. */
let dialogsOpen = 0

/** Runs a dialog for a page, keeping the panel up and giving it the keyboard back afterwards. */
async function whileDialog<T>(run: () => Promise<T>): Promise<T> {
  dialogsOpen++
  try {
    return await run()
  } finally {
    dialogsOpen--
    if (panel.visible && !panel.win.isDestroyed()) panel.win.focus()
  }
}

/**
 * The system print dialog, which also has Save as PDF. It's an app-modal window rather than a
 * sheet, so jbrow comes to the front first; the non-activating panel alone can't give it the keyboard.
 */
function printPage(wc: Electron.WebContents) {
  app.focus({ steal: true })
  void whileDialog(
    () =>
      new Promise<void>((resolve) =>
        wc.print({}, (ok, reason) => {
          if (!ok && reason && !/cancel/i.test(reason)) toast(`Couldn't print: ${reason}`)
          resolve()
        }),
      ),
  )
}

/** Saves the page as a PDF, asking where; ~/Downloads/<title>.pdf to start with. */
async function savePageAsPdf(wc: Electron.WebContents) {
  const name = wc.getTitle().replace(/[/\\:]/g, '-').trim().slice(0, 120) || 'Page'
  const { canceled, filePath } = await whileDialog(() =>
    dialog.showSaveDialog(panel.win, {
      title: 'Save as PDF',
      defaultPath: path.join(app.getPath('downloads'), `${name}.pdf`),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    }),
  )
  if (canceled || !filePath || wc.isDestroyed()) return
  try {
    await writeFile(filePath, await wc.printToPDF({}))
    toast(`Saved ${path.basename(filePath)}.`)
  } catch (error) {
    console.error('[print] could not save a PDF:', error)
    toast(`Couldn't save the PDF: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/**
 * Closes a tab, leaving a new one if it was the last. Its page can ask first if it has unsaved
 * changes, unless `ask` is false: jbrow closing it on its own, or a page it warned you about.
 */
/** Closes a tab; a kept or pinned one only closes its page unless `remove`. */
async function closeTab(id: string, remember = true, ask = true, remove = false) {
  if (ask) await tabs.closeAsking(id, remember, remove)
  else tabs.close(id, remember, undefined, remove)
  if (!tabs.active()) tabs.newTab({ profile: newTabProfile(), ...scopeFields() })
}

/**
 * Chrome's question for a page with unsaved changes. It's asked while the page waits, so it's a
 * sheet that blocks until answered. A page jbrow isn't showing can't ask: it stays where it is.
 */
function confirmUnload(id: string, kind: UnloadKind): boolean {
  if (!panel.visible || panel.win.isDestroyed()) {
    console.log(`[tabs] a page with unsaved changes stayed (${kind}) while jbrow was hidden`)
    return false
  }
  if (id !== tabs.activeId) tabs.activate(id)
  const reload = kind === 'reload'
  dialogsOpen++
  try {
    const response = dialog.showMessageBoxSync(panel.win, {
      type: 'warning',
      message: reload ? 'Reload site?' : 'Leave site?',
      detail: 'Changes you made may not be saved.',
      buttons: reload ? ['Reload', 'Cancel'] : ['Leave', kind === 'close' ? 'Cancel' : 'Stay'],
      defaultId: 0,
      cancelId: 1,
    })
    return response === 0
  } finally {
    dialogsOpen--
    if (panel.visible && !panel.win.isDestroyed()) panel.win.focus()
  }
}

// ---------- quitting ----------

/** Downloads quitting would cancel: running, paused, or waiting for the network to come back. */
const unfinishedDownloads = () => downloads.list().filter((d) => d.state === 'progressing' || d.state === 'paused' || d.state === 'interrupted').length

/** The quit question is up, so another ⌘Q doesn't ask twice. */
let askingToQuit = false

/**
 * Quitting from jbrow's own ⌘Q, the menu bar item's Quit or Restart jbrow, which asks first if
 * that would cancel downloads. Quits from outside don't ask: Ctrl+C or `kill` in a terminal, the
 * install script (AppleScript), macOS logging out or shutting down, a utility quitting idle apps.
 * Nobody may be at the screen for those, and Electron can't tell them apart before it quits.
 */
async function requestQuit(restart = false) {
  if (askingToQuit || !(await confirmQuit())) return
  // Only once you've said yes: after relaunch(), any quit would start jbrow again.
  if (restart) app.relaunch()
  app.quit()
}

/** Restarts into a downloaded update, asking first if that would cancel downloads, as quitting does. */
async function restartToUpdate() {
  if (askingToQuit || !(await confirmQuit())) return
  updates.install()
}

/** jbrow hidden this long, or nobody touching the Mac this long while it shows, and an update may restart it. */
const UPDATE_AFTER_HIDDEN_MS = 10 * 60 * 1000
const UPDATE_AFTER_IDLE_S = 30 * 60
/** Hidden, you could still be about to call jbrow up; this long without a key or click, you aren't. */
const UPDATE_HIDDEN_IDLE_S = 2 * 60

/**
 * A moment an update can restart jbrow in without anyone noticing: nothing would be cancelled or
 * cut off (downloads, sound, a video in picture-in-picture, a question on screen), and jbrow has
 * been hidden a while, or showing with nobody at the Mac. Tabs come back as they were.
 */
function quietMoment() {
  if (unfinishedDownloads() || askingToQuit || dialogsOpen > 0 || miniPlayer.webContents) return false
  if (tabs.pages().some((wc) => wc.isCurrentlyAudible())) return false
  const idleS = powerMonitor.getSystemIdleTime()
  if (panel.visible) return idleS >= UPDATE_AFTER_IDLE_S
  return Date.now() - hiddenAt >= UPDATE_AFTER_HIDDEN_MS && idleS >= UPDATE_HIDDEN_IDLE_S
}

function sendUpdates() {
  if (!panel.win.isDestroyed()) panel.ui.send('updates', updates.view())
}

/**
 * Asks before quitting cancels downloads. jbrow comes up first if it's hidden, so the question
 * shows over the downloads it's about, as a sheet: an app-modal dialog would stall jbrow.
 */
async function confirmQuit(): Promise<boolean> {
  const count = unfinishedDownloads()
  if (!count) return true
  askingToQuit = true
  try {
    if (!panel.visible) await summon()
    const { response } = await whileDialog(() =>
      dialog.showMessageBox(panel.win, {
        type: 'warning',
        message: 'Quit jbrow?',
        detail: `${count === 1 ? '1 download is' : `${count} downloads are`} in progress and will be cancelled.`,
        buttons: ['Quit', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
      }),
    )
    console.log(`[jbrow] quit with ${count} unfinished downloads: ${response === 0 ? 'quit' : 'cancelled'}`)
    return response === 0
  } finally {
    askingToQuit = false
  }
}

function threadMenu(id: string) {
  const rec = tabs.get(id)
  if (!rec) return
  const pinned = isPinned(rec)
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: 'Rename', click: () => panel.ui.send('rename-tab', id) },
  ]
  if (rec.url) items.push({ label: 'Copy link', click: () => clipboard.writeText(rec.url) })
  const wc = tabs.webContentsFor(id)
  if (wc) {
    const muted = wc.isAudioMuted()
    items.push({ label: muted ? 'Unmute' : 'Mute', click: () => tabs.setMuted(id, !muted) })
  }
  if (rec.kept && rec.home) {
    const away = awayFromHome(rec)
    items.push(
      { label: 'Back to pinned page', enabled: away, click: () => tabs.goHome(id) },
      { label: 'Pin this page here', enabled: away, click: () => tabs.keepHere(id) },
    )
  }
  for (const p of settings.profiles) {
    if (p.id !== rec.profile) items.push({ label: `Open in ${p.name}`, click: () => switchProfile(id, p.id) })
  }
  items.push(...splitItems(id))
  items.push({ label: pinned ? 'Unpin' : 'Pin to top', click: () => (pinned ? tabs.move(id, true) : tabs.pin(id)) })
  if (!pinned) items.push({ label: rec.kept ? 'Stop keeping' : 'Keep', click: () => tabs.move(id, !rec.kept) })
  if (!pinned) {
    items.push({
      label: 'Move to folder',
      submenu: [
        ...folderChoices().map<Electron.MenuItemConstructorOptions>(({ folder, label }) => ({
          label,
          type: 'checkbox',
          checked: rec.kept && rec.folder === folder.id,
          click: () => tabs.move(id, true, folder.id),
        })),
        ...(rec.kept && rec.folder ? [{ label: 'Out of folder', click: () => tabs.move(id, true) }] : []),
        ...(tabs.folders.length ? [{ type: 'separator' as const }] : []),
        { label: 'New folder', click: () => newFolder(rec.kept ? rec.folder : undefined, id) },
      ],
    })
  }
  const closeKey = id === tabs.activeId ? 'Cmd+W' : undefined
  items.push({ type: 'separator' })
  // A kept tab's Close only closes its page, so it stays where you put it; Delete takes it away.
  if (rec.kept) {
    items.push(
      { label: 'Close', accelerator: closeKey, enabled: !!tabs.webContentsFor(id) || awayFromHome(rec), click: () => void closeTab(id) },
      { label: 'Delete', click: () => void closeTab(id, true, true, true) },
    )
  } else items.push({ label: 'Close', accelerator: closeKey, click: () => void closeTab(id) })
  Menu.buildFromTemplate(items).popup({ window: panel.win })
}

/** The thread menu's split view items for a tab: split it or open it beside the active tab, or separate its split. */
function splitItems(id: string): Electron.MenuItemConstructorOptions[] {
  const split = tabs.splitOf(id)
  const report = (error: string | null) => error && toast(error)
  if (split) {
    return [
      { label: 'Separate tabs', click: () => tabs.unsplit(id) },
      ...(split.tabs.length > 2 ? [{ label: 'Take out of split view', click: () => tabs.leaveSplit(id) }] : []),
    ]
  }
  if (!tabs.active()?.url) return []
  if (id === tabs.activeId) {
    const key = actionKeys(settings.shortcuts).splitView
    return [{ label: 'Split view', accelerator: key || undefined, click: () => report(tabs.splitNew()) }]
  }
  return [{ label: 'Open in split view', click: () => report(tabs.splitWith(id)) }]
}

function newTabMenu() {
  const reopenKey = actionKeys(settings.shortcuts).reopenTab
  Menu.buildFromTemplate([
    ...settings.profiles.map((p) => ({
      label: `New tab in ${p.name}`,
      click: () => {
        tabs.create({ profile: p.id, ...scopeFields() })
        focusAddressBar()
      },
    })),
    { type: 'separator' },
    {
      label: 'Reopen closed tab',
      accelerator: reopenKey || undefined,
      enabled: tabs.canReopen(),
      click: () => void tabs.reopen(),
    },
  ]).popup({ window: panel.win })
}

/** Makes a folder at the bottom of `parent` (or of Kept), with the thread `withThread` in it, and starts naming it. */
function newFolder(parent?: string, withThread?: string) {
  const folder = tabs.createFolder('New folder', parent)
  if (parent) tabs.updateFolder(parent, { collapsed: false })
  if (withThread) tabs.move(withThread, true, folder.id)
  panel.ui.send('rename-tab', folder.id)
}

/** Every folder in sidebar order, labelled with the folders it sits in. */
function folderChoices(): { folder: Folder; label: string }[] {
  const walk = (views: FolderView<TabRecord>[], prefix: string): { folder: Folder; label: string }[] =>
    views.flatMap((v) => [{ folder: v.folder, label: prefix + v.folder.name }, ...walk(v.folders, `${prefix}${v.folder.name} › `)])
  const s = sections(tabs.records, { filter: 'all', scope: null, activeId: null, now: Date.now(), folders: tabs.folders })
  return walk(s.folders, '')
}

/** Right-click on the sidebar away from any row. */
function sidebarMenu() {
  Menu.buildFromTemplate([{ label: 'New folder', click: () => newFolder() }]).popup({ window: panel.win })
}

function folderMenu(id: string) {
  const folder = tabs.folder(id)
  if (!folder) return
  // Anywhere but itself, a folder inside it, or where it already is.
  const targets = folderChoices().filter(({ folder: f }) => !isInFolder(tabs.folders, f.id, id) && f.id !== folder.parent)
  const moveTo: Electron.MenuItemConstructorOptions[] = [
    ...(folder.parent ? [{ label: 'Top of Kept', click: () => tabs.moveFolder(id, null) }] : []),
    ...targets.map(({ folder: f, label }) => ({ label, click: () => tabs.moveFolder(id, f.id) })),
  ]
  Menu.buildFromTemplate([
    { label: 'Rename', click: () => panel.ui.send('rename-tab', id) },
    { label: 'Auto-file rules…', click: () => panel.ui.send('folder-rules', id) },
    ...(moveTo.length ? [{ label: 'Move to', submenu: moveTo }] : []),
    { type: 'separator' },
    { label: 'New folder inside', click: () => newFolder(id) },
    { label: 'New folder', click: () => newFolder(folder.parent) },
    { label: 'Delete folder', click: () => tabs.deleteFolder(id) },
  ]).popup({ window: panel.win })
}

/** The certificate warning's buttons, for the active tab. */
function certAction(action: 'proceed' | 'back' | 'distrust') {
  const rec = tabs.active()
  const wc = tabs.activeWebContents()
  if (!rec || !wc) return
  if (action === 'proceed') {
    const url = certs.proceed(rec.id, rec.profile)
    if (url) void wc.loadURL(url).catch(() => {})
  } else if (action === 'back') {
    if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
    else void closeTab(rec.id)
  } else {
    const view = certs.view(rec.id, rec.profile, rec.url)
    if (!view) return
    certs.distrust(rec.profile, view.host)
    // An open connection would carry on without checking the certificate again.
    void wc.session.closeAllConnections().then(() => wc.reload())
  }
}

/** The warning's buttons when the active tab was stopped from opening a phishing or malware site. */
function dangerAction(action: 'proceed' | 'back') {
  const rec = tabs.active()
  const wc = tabs.activeWebContents()
  if (!rec || !wc) return
  if (action === 'proceed') {
    const url = dangerous.proceed(rec.id, rec.profile)
    if (url) void wc.loadURL(url).catch(() => {})
    return
  }
  // The page the tab was on usually never went away; it was under the warning. If the listed page
  // got in before the stop, leave it rather than uncover it.
  const committed = wc.getURL()
  // A listed page doesn't get to keep you there with "Leave site?".
  if (!committed || committed === 'about:blank') return void closeTab(rec.id, true, false)
  if (dangerous.listed(rec.profile, committed)) {
    if (!wc.navigationHistory.canGoBack()) return void closeTab(rec.id, true, false)
    wc.navigationHistory.goBack()
    return
  }
  rec.url = committed
  dangerous.clear(rec.id)
  focusActive()
}

/** Plain http from another machine: anyone on the way can read and change it. This Mac's own servers are fine. */
function isInsecure(url: string) {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:') return false
    const host = u.hostname.replace(/^\[|\]$/g, '')
    return !(host === 'localhost' || host.endsWith('.localhost') || /^127(\.\d{1,3}){3}$/.test(host) || host === '::1')
  } catch {
    return false
  }
}

// ---------- clearing browsing data ----------

/** What sites keep in a profile besides the cache: cookies, storage, service workers. */
const SITE_DATA: NonNullable<Electron.ClearDataOptions['dataTypes']> = ['cookies', 'localStorage', 'indexedDB', 'serviceWorkers', 'fileSystems', 'webSQL', 'backgroundFetch']

/** Extensions keep what they store, as in Chrome: Bitwarden's vault, uBlock's filters. */
const extensionOrigins = (rt: ProfileRuntime) => rt.session.extensions.getAllExtensions().map((e) => `chrome-extension://${e.id}`)

/** Clears cookies and site data, the cache or both, in one profile or all of them, after asking. */
async function clearBrowsingData({ profile, cookies, cache, history }: { profile: string; cookies: boolean; cache: boolean; history?: boolean }) {
  const targets = profile === 'all' ? [...runtimes.values()] : [runtimes.get(profile)].filter((rt) => !!rt)
  if (!targets.length || (!cookies && !cache && !history)) return
  const what = listed([history && 'history', cookies && 'cookies and site data', cache && 'cached images and files'])
  const where = profile === 'all' ? 'every profile' : targets[0].profile.name
  const { response } = await whileDialog(() =>
    dialog.showMessageBox(panel.win, {
      type: 'warning',
      buttons: ['Clear', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: `Clear ${what} in ${where}?`,
      detail: [
        history && "The address bar stops suggesting the pages you've visited.",
        cookies
          ? "You'll be signed out of most sites. Your tabs stay open, and extensions keep their data."
          : cache && 'Sites load a little slower until the cache fills again.',
      ]
        .filter(Boolean)
        .join(' '),
    }),
  )
  if (response !== 0) return
  try {
    if (history) visits.clear(profile)
    for (const rt of targets) {
      if (cookies) {
        await rt.session.clearData({ dataTypes: SITE_DATA, excludeOrigins: extensionOrigins(rt) })
        // Usernames and passwords given to sites' sign-in forms (logins.ts).
        await rt.session.clearAuthCache()
      }
      if (cache) {
        await rt.session.clearCache()
        await rt.session.clearCodeCaches({})
      }
    }
    toast(`Cleared ${what} in ${where}.`)
  } catch (error) {
    console.error('[clear] browsing data:', error)
    toast(`Couldn't clear ${what}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** "a", "a and b", "a, b and c". */
function listed(items: (string | false | undefined)[]): string {
  const xs = items.filter((x): x is string => !!x)
  return xs.length < 2 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}`
}

/**
 * Clears the active tab's site from its profile, after asking: cookies the site can see or set
 * (example.com's for www.example.com, and its subdomains'), and storage of the site with and
 * without www. Then reloads the page, which would otherwise carry on with what it holds.
 */
async function clearSiteData() {
  const rec = tabs.active()
  const wc = tabs.activeWebContents()
  const rt = rec && runtimes.get(rec.profile)
  if (!rec || !wc || !rt) return
  let host = ''
  try {
    const u = new URL(rec.url)
    if (/^https?:$/.test(u.protocol)) host = u.hostname
  } catch {}
  if (!host) return
  const site = host.replace(/^www\./, '')
  const { response } = await whileDialog(() =>
    dialog.showMessageBox(panel.win, {
      type: 'warning',
      buttons: ['Clear', 'Cancel'],
      defaultId: 0,
      cancelId: 1,
      message: `Clear cookies and site data for ${site}?`,
      detail: `You'll be signed out of ${site} in ${rt.profile.name}, and the page reloads. Other sites and profiles keep theirs.`,
    }),
  )
  if (response !== 0) return
  try {
    const related = (domain: string) => {
      const d = domain.replace(/^\./, '')
      return d === host || host.endsWith(`.${d}`) || d === site || d.endsWith(`.${site}`)
    }
    for (const c of await rt.session.cookies.get({})) {
      if (!c.domain || !related(c.domain)) continue
      await rt.session.cookies.remove(`http${c.secure ? 's' : ''}://${c.domain.replace(/^\./, '')}${c.path ?? '/'}`, c.name)
    }
    const hosts = new Set([host, site, `www.${site}`])
    const origins = [...hosts].flatMap((h) => [`https://${h}`, `http://${h}`])
    await rt.session.clearData({ dataTypes: SITE_DATA.filter((t) => t !== 'cookies'), origins })
    if (!wc.isDestroyed()) wc.reload()
    toast(`Cleared cookies and site data for ${site}.`)
  } catch (error) {
    console.error('[clear] site data:', error)
    toast(`Couldn't clear ${site}: ${error instanceof Error ? error.message : String(error)}`)
  }
}

// ---------- address bar suggestions ----------

let searchTimer: NodeJS.Timeout | null = null
let searchAbort: AbortController | null = null

/**
 * Whether `q` may go to the search engine, which sees every keystroke: words only, never anything
 * that looks like an address or matches a private address pattern. `forced` is a search asked for
 * with a leading ?, which may look like an address (?node.js) but still not like a private one.
 */
function maySendToSearch(q: string, forced: boolean, visited: boolean, profile: string): boolean {
  if (!settings.searchSuggestions || !q || q.length > 200 || (!forced && looksLikeAddress(q))) return false
  // Typing the start of a site you've been to is typing an address, not a search: "intr" on the
  // way to a private intranet host mustn't reach the search engine either. A popular site's name
  // tells it nothing about you.
  if (visited) return false
  const isPrivate = urlMatcher(settings.privateUrls)
  if (visits.search(profile, q, 50).some((v) => isPrivate(v.url))) return false
  return !isPrivate(q) && !isPrivate(`https://${q}`)
}

/** Stops waiting for search suggestions nobody needs any more. */
function cancelSearchSuggestions() {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = null
  searchAbort?.abort()
  searchAbort = null
}

/**
 * Answers what's typed in the address bar: history and the site to complete to right away, then
 * the search engine's suggestions once typing pauses. Each keystroke cancels the last request.
 */
function suggest({ input, profile, seq }: { input: string; profile?: string; seq: number }) {
  if (panel.win.isDestroyed()) return
  const p = profile && settings.profiles.some((x) => x.id === profile) ? profile : (tabs.active()?.profile ?? settings.defaultProfile)
  const isPrivate = urlMatcher(settings.privateUrls)
  const visited = visits.completion(p, input, isPrivate)
  const reply: SuggestReply = {
    seq,
    input,
    visits: visits.search(p, input, 12),
    // Your own sites first, then popular ones you haven't been to.
    completion: visited ?? topSiteCompletion(input, isPrivate),
  }
  panel.ui.send('suggestions', reply)
  cancelSearchSuggestions()
  const suggestUrl = suggestUrlFor(settings.searchUrl)
  const forced = forcedSearch(input)
  const query = forced ?? input.trim()
  if (!suggestUrl || !maySendToSearch(query, forced !== undefined, !!visited, p)) return
  searchTimer = setTimeout(async () => {
    searchTimer = null
    const ctrl = (searchAbort = new AbortController())
    const timeout = setTimeout(() => ctrl.abort(), 4000)
    try {
      const searches = await fetchSearchSuggestions(suggestUrl, query, ctrl.signal)
      const answer: SearchReply = { seq, input, searches: searches.slice(0, 6) }
      if (!ctrl.signal.aborted && !panel.win.isDestroyed()) panel.ui.send('search-suggestions', answer)
    } catch (error) {
      if (!ctrl.signal.aborted) console.error('[suggest] search suggestions:', error instanceof Error ? error.message : error)
    } finally {
      clearTimeout(timeout)
      if (searchAbort === ctrl) searchAbort = null
    }
  }, 150)
}

// ---------- links from other apps ----------

/**
 * Opens a link another app handed to jbrow, in its site's profile or else that app's, in that app's
 * section of the sidebar, and brings jbrow up on it. The app the link came from is still in front when it arrives.
 */
async function openFromApp(url: string, clicked = false) {
  const [front, quiet] = await Promise.all([frontmostApp(), !clicked && openQuietly()])
  const from = front && front.pid !== process.pid ? front : null
  let fields = {}
  if (from) {
    lastFront = from
    apps.note(from.bundleId, from.name)
    const key = scopeForApp(settings, from.bundleId)
    fields = { scope: key, scopeName: scopeName(key), app: from.bundleId }
  }
  const profile = siteProfile(url) || (from && settings.appProfiles[from.bundleId]) || settings.defaultProfile
  if (quiet) {
    const rec = tabs.create({ profile, url, ...fields, activate: false, unread: true })
    quietLinks.add(rec.id)
    tabs.webContentsFor(rec.id)?.setAudioMuted(true)
    console.log(`[links] opened quietly: ${url}`)
    return
  }
  if (filter !== 'all' && filter !== profile) filter = 'all'
  if (scope && scope.key !== (fields as { scope?: string }).scope) scope = null
  if (!panel.visible) sweep()
  tabs.create({ profile, url, ...fields })
  pushState()
  await panel.show()
  focusActive()
}

/**
 * Whether a link another app just handed over should open in the background. macOS doesn't say
 * if you clicked it, so a link with no click or key press in the last couple of seconds counts
 * as one a script or a notification opened on its own. Open, or unsure, jbrow comes up as usual.
 */
async function openQuietly(): Promise<boolean> {
  if (!settings.quietLinks || panel.visible) return false
  const seconds = await secondsSinceInput()
  console.log(`[links] last click or key press ${seconds?.toFixed(1) ?? '?'} s ago`)
  return seconds !== null && seconds > QUIET_AFTER_S
}

/** Threads opened quietly that you haven't looked at yet. Their pages stay muted until you do. */
const quietLinks = new Set<string>()

/** Quiet threads still unseen, newest first. */
function unseenQuietLinks(): TabRecord[] {
  for (const id of quietLinks) if (!tabs.get(id)?.unread) {
    quietLinks.delete(id)
    tabs.webContentsFor(id)?.setAudioMuted(false)
  }
  return [...quietLinks].map((id) => tabs.get(id)!).reverse()
}

/** Shows the newest quiet thread. */
function showQuietLink() {
  const rec = unseenQuietLinks()[0]
  if (!rec) return
  filter = 'all'
  scope = null
  if (!panel.visible) sweep()
  tabs.activate(rec.id)
  pushState()
  void panel.show().then(focusActive)
}

/** The menu bar item counts quiet threads you haven't seen. */
function updateTray() {
  const n = tray ? unseenQuietLinks().length : 0
  tray?.setTitle(n ? `jb •${n}` : 'jb')
}

/** Whether jbrow opens web links: 'dev' when it runs from source, which macOS won't offer. */
function sendDefaultBrowser() {
  if (panel.win.isDestroyed()) return
  const status = !app.isPackaged ? 'dev' : app.isDefaultProtocolClient('https') ? 'yes' : 'no'
  panel.ui.send('default-browser', status)
}

/** macOS asks you to confirm; the status updates once you answer. */
function makeDefaultBrowser() {
  if (!app.isPackaged) return
  app.setAsDefaultProtocolClient('http')
  app.setAsDefaultProtocolClient('https')
  for (const ms of [1000, 3000, 8000]) setTimeout(sendDefaultBrowser, ms)
}

// ---------- profiles ----------

const PROFILE_COLORS = ['#2f9aab', '#d0679a', '#7a6ad8', '#d9822b', '#3f9d5a', '#c4483f', '#5b7fa6', '#a08a2a']
/** IDs of profiles deleted this run. Their sessions live on until quit, so a new profile can't reuse one. */
const retiredProfiles = new Set<string>()

function sendProfiles() {
  pushState()
  sendApps()
  sendShortcuts()
}

/** Wires a profile's session into downloads, certificates and the extension button menu. */
function attachProfile(rt: ProfileRuntime) {
  downloads.attach(rt.session, rt.profile.id)
  certs.attach(rt.session, rt.profile.id)
  // Pin and unpin from the menu an extension's button shows on right-click (see scripts/patch-deps.mjs),
  // and open or close its side panel there, as in Chrome.
  rt.extensions.on('jbrow-action-context-menu', ({ menu, extensionId }: { menu: Menu; extensionId: string }) => {
    const pinned = settings.pinnedExtensions.includes(extensionId)
    const ext = rt.session.extensions.getExtension(extensionId)
    menu.append(new MenuItem({ type: 'separator' }))
    if (ext && sidePanels.hasPanel(rt.profile.id, ext)) {
      const open = sidePanels.state()?.extensionId === extensionId
      menu.append(new MenuItem({ label: open ? 'Close side panel' : 'Open side panel', click: () => sidePanels.toggle(rt.profile.id, ext) }))
    }
    menu.append(new MenuItem({ label: pinned ? 'Unpin from toolbar' : 'Pin to toolbar', click: () => togglePinnedExtension(extensionId) }))
    menu.append(new MenuItem({ type: 'separator' }))
    menu.append(new MenuItem({ label: 'Turn off', click: () => void setExtensionEnabled(rt.profile.id, extensionId, false) }))
    menu.append(new MenuItem({ label: `Remove from ${rt.profile.name}…`, click: () => void removeExtension(rt.profile.id, extensionId) }))
  })
  // One installed again from the Web Store, or a folder added again, is on: it no longer counts as turned off.
  rt.session.extensions.on('extension-loaded', (_e, ext) => {
    const disabled = settings.disabledExtensions[rt.profile.id]
    if (disabled?.some((d) => d.id === ext.id)) {
      settings.disabledExtensions[rt.profile.id] = disabled.filter((d) => d.id !== ext.id)
      saveSettings(settings)
    }
    sendExtensions()
  })
  rt.session.extensions.on('extension-unloaded', () => sendExtensions())
  rt.extensions.on('browser-action-popup-created', (popup: { browserWindow?: BrowserWindow }) => {
    const tab = tabs.activeWebContents()
    if (popup.browserWindow && tab) popupTabs.set(popup.browserWindow.webContents, tab)
  })
}

let addingProfile = false
/** Adds a profile; `rename` opens settings with its name ready to type over. */
async function addProfile(rename = true) {
  if (addingProfile) return
  addingProfile = true
  try {
    const taken = (id: string) => settings.profiles.some((p) => p.id === id) || retiredProfiles.has(id)
    let n = settings.profiles.length + 1
    while (taken(`profile-${n}`)) n++
    const used = new Set(settings.profiles.map((p) => p.color))
    const profile: Profile = {
      id: `profile-${n}`,
      name: `Profile ${n}`,
      color: PROFILE_COLORS.find((c) => !used.has(c)) ?? PROFILE_COLORS[n % PROFILE_COLORS.length],
    }
    const rt = await setupProfile(profile, settings, profileDeps)
    settings.profiles.push(profile)
    saveSettings(settings)
    runtimes.set(profile.id, rt)
    attachProfile(rt)
    commands.watchProfile(rt)
    sendProfiles()
    if (rename) panel.ui.send('rename-profile', profile.id)
  } catch (error) {
    console.error('[profiles] could not add a profile:', error)
    toast(`Couldn't add a profile: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    addingProfile = false
  }
}

function updateProfile(id: string, change: { name?: string; color?: string; icon?: string }) {
  const profile = settings.profiles.find((p) => p.id === id)
  if (!profile) return
  const name = change.name?.trim()
  if (name) profile.name = name
  if (change.color && /^#[0-9a-f]{6}$/i.test(change.color)) profile.color = change.color
  if (typeof change.icon === 'string') {
    // One emoji, even one built from several code points (flags, skin tones, families), or two letters.
    const icon = [...new Intl.Segmenter().segment(change.icon.trim())].slice(0, 2).map((s) => s.segment).join('')
    if (icon) profile.icon = icon
    else delete profile.icon
  }
  saveSettings(settings)
  sendProfiles()
}

/** Moves a profile before or after another, which is the order every profile list shows. */
function moveProfile(id: string, target: string, after: boolean) {
  const profile = settings.profiles.find((p) => p.id === id)
  if (!profile || id === target || !settings.profiles.some((p) => p.id === target)) return
  settings.profiles = settings.profiles.filter((p) => p !== profile)
  settings.profiles.splice(settings.profiles.findIndex((p) => p.id === target) + (after ? 1 : 0), 0, profile)
  saveSettings(settings)
  sendProfiles()
}

function setDefaultProfile(id: string) {
  if (!settings.profiles.some((p) => p.id === id)) return
  settings.defaultProfile = id
  saveSettings(settings)
  pushState()
}

/**
 * Deletes a profile after asking: its tabs close and its cookies, logins, site data, extensions
 * and site permissions are erased. The last profile can't go.
 */
async function deleteProfile(id: string) {
  const profile = settings.profiles.find((p) => p.id === id)
  const rt = runtimes.get(id)
  if (!profile || !rt || settings.profiles.length < 2) return
  const open = tabs.records.filter((t) => t.profile === id).length
  const { response } = await dialog.showMessageBox(panel.win, {
    type: 'warning',
    message: `Delete ${profile.name}?`,
    detail:
      (open ? `Its ${open} ${open === 1 ? 'tab closes' : 'tabs close'}, and its` : 'Its') +
      ' logins, cookies, site data, extensions and site permissions are erased. This cannot be undone.',
    buttons: ['Cancel', 'Delete profile'],
    defaultId: 0,
    cancelId: 0,
  })
  if (response !== 1) return

  // Children first, so closing a tab never hands its children to another tab of this profile.
  const doomed = tabs.records.filter((t) => t.profile === id)
  for (const t of doomed.reverse()) tabs.close(t.id, true, undefined, true)
  tabs.forgetProfile(id)
  sidePanels.forgetProfile(id)
  idle.forgetProfile(id)
  extensionDebugger.forgetProfile(id)
  userScripts.forgetProfile(id)
  visits.clear(id)

  settings.profiles = settings.profiles.filter((p) => p.id !== id)
  if (settings.defaultProfile === id) settings.defaultProfile = settings.profiles[0].id
  for (const [bundleId, p] of Object.entries(settings.appProfiles)) if (p === id) delete settings.appProfiles[bundleId]
  delete settings.profileSites[id]
  delete settings.unpackedExtensions[id]
  delete settings.extensionShortcuts[id]
  delete settings.disabledExtensions[id]
  saveSettings(settings)
  permissions.forgetProfile(id)
  runtimes.delete(id)
  retiredProfiles.add(id)
  if (filter === id) filter = 'all'
  commands.refresh()
  commands.registerGlobal()
  if (!tabs.active()) tabs.newTab({ profile: newTabProfile(), ...scopeFields() })
  sendProfiles()

  for (const ext of rt.session.extensions.getAllExtensions()) rt.session.extensions.removeExtension(ext.id)
  await Promise.all([rt.session.clearStorageData(), rt.session.clearCache(), rt.session.clearAuthCache()]).catch((error) =>
    console.error(`[profiles] ${id}: could not erase its data:`, error),
  )
  await rm(rt.extensionsPath, { recursive: true, force: true }).catch(() => {})
  toast(`Deleted ${profile.name}.`)
}

function profileMenu(id: string) {
  const profile = settings.profiles.find((p) => p.id === id)
  if (!profile) return
  const i = settings.profiles.indexOf(profile)
  const before = settings.profiles[i - 1]
  const next = settings.profiles[i + 1]
  Menu.buildFromTemplate([
    { label: 'Rename', click: () => panel.ui.send('rename-profile', id) },
    { label: 'Move up', enabled: !!before, click: () => before && moveProfile(id, before.id, false) },
    { label: 'Move down', enabled: !!next, click: () => next && moveProfile(id, next.id, true) },
    { label: 'Use for links and new tabs', type: 'checkbox', checked: settings.defaultProfile === id, click: () => setDefaultProfile(id) },
    { label: `New tab in ${profile.name}`, click: () => {
      tabs.create({ profile: id, ...scopeFields() })
      panel.ui.send('settings', { open: false })
      focusAddressBar()
    } },
    { type: 'separator' },
    { label: 'Delete profile…', enabled: settings.profiles.length > 1, click: () => void deleteProfile(id) },
  ]).popup({ window: panel.win })
}

// ---------- apps ----------

/** Rows for the Apps list in settings: every app with threads, a profile or a link. */
function appEntries(): AppEntry[] {
  const keys = new Set<string>()
  for (const g of settings.linkedApps) if (g.length > 1) keys.add(scopeForApp(settings, g[0]))
  for (const id of [...Object.keys(settings.appProfiles), ...addedApps]) keys.add(scopeForApp(settings, id))
  for (const t of tabs.records) if (t.scope) keys.add(t.scope)
  return [...keys]
    .map<AppEntry>((key) => {
      const ids = appsIn(key)
      const profiles = new Set(ids.map((id) => settings.appProfiles[id] ?? ''))
      return {
        key,
        apps: ids.map((bundleId) => ({ bundleId, name: apps.name(bundleId), icon: apps.icon(bundleId) })),
        profile: profiles.size === 1 ? [...profiles][0] : null,
        threads: tabs.records.filter((t) => t.scope === key).length,
      }
    })
    .sort((a, b) => scopeName(a.key).localeCompare(scopeName(b.key)))
}

function sendApps() {
  if (panel.win.isDestroyed()) return
  panel.ui.send('apps', { entries: appEntries(), profiles: settings.profiles })
}

function setAppProfile(key: string, profile: string) {
  for (const id of appsIn(key)) {
    if (profile && settings.profiles.some((p) => p.id === profile)) settings.appProfiles[id] = profile
    else delete settings.appProfiles[id]
  }
  saveSettings(settings)
  sendApps()
}

/**
 * Saves new app groups and moves threads to match: linked apps share their threads, and an app
 * taken out of a group takes back the threads opened from it.
 */
function setLinkedApps(groups: string[][]) {
  settings.linkedApps = groups.map((g) => [...new Set(g)]).filter((g) => g.length > 1)
  saveSettings(settings)
  rescopeThreads()
  sendApps()
}

function rescopeThreads() {
  tabs.rescope((rec) => {
    const key = scopeForApp(settings, rec.app ?? appsIn(rec.scope!)[0])
    return { scope: key, scopeName: scopeName(key) }
  })
  if (scope && lastFront) {
    const key = scopeForApp(settings, lastFront.bundleId)
    scope = { key, name: scopeName(key) }
  }
  pushState()
}

function linkApps(a: string, b: string) {
  const members = [...appsIn(a), ...appsIn(b)]
  setLinkedApps([...settings.linkedApps.map((g) => g.filter((id) => !members.includes(id))), members])
}

function unlinkApp(bundleId: string) {
  setLinkedApps(settings.linkedApps.map((g) => g.filter((id) => id !== bundleId)))
}

function removeApp(key: string) {
  const ids = appsIn(key)
  for (const id of ids) {
    delete settings.appProfiles[id]
    addedApps.delete(id)
  }
  setLinkedApps(settings.linkedApps.map((g) => g.filter((id) => !ids.includes(id))))
}

async function addApp() {
  const { canceled, filePaths } = await dialog.showOpenDialog(panel.win, {
    title: 'Add an app',
    defaultPath: '/Applications',
    buttonLabel: 'Add app',
    properties: ['openFile'],
    filters: [{ name: 'Apps', extensions: ['app'] }],
  })
  const appPath = filePaths[0]
  if (canceled || !appPath) return
  const id = await bundleIdOf(appPath)
  if (!id) return toast("That doesn't look like an app: it has no bundle ID.")
  apps.note(id, '', appPath)
  addedApps.add(id)
  sendApps()
}

function appMenu(key: string) {
  const entries = appEntries()
  const entry = entries.find((e) => e.key === key)
  if (!entry) return
  const others = entries.filter((e) => e.key !== key)
  const items: Electron.MenuItemConstructorOptions[] = [
    {
      label: 'Link with',
      enabled: others.length > 0,
      submenu: others.map((o) => ({ label: scopeName(o.key), click: () => linkApps(key, o.key) })),
    },
  ]
  if (entry.apps.length > 1) {
    for (const a of entry.apps) items.push({ label: `Unlink ${a.name}`, click: () => unlinkApp(a.bundleId) })
  }
  items.push(
    { type: 'separator' },
    { label: entry.threads ? 'Remove (close its tabs first)' : 'Remove', enabled: !entry.threads, click: () => removeApp(key) },
  )
  Menu.buildFromTemplate(items).popup({ window: panel.win })
}

// ---------- extension shortcuts ----------

function sendShortcuts() {
  if (panel.win.isDestroyed()) return
  panel.ui.send('shortcuts', {
    profiles: settings.profiles,
    commands: settings.profiles.flatMap((p) => commands.list(p.id)),
  })
}

/**
 * Opens an extension's popup for its shortcut. The UI clicks the pinned button when there is
 * one, so the popup hangs off it; otherwise it sends back where the puzzle icon is.
 */
async function openActionPopup(profileId: string, extensionId: string) {
  if (tabs.active()?.profile !== profileId) return
  if (!panel.visible) await summon()
  panel.ui.send('run-action', extensionId)
}

function popupAt(extensionId: string, anchorRect: { x: number; y: number; width: number; height: number }) {
  const active = tabs.active()
  const wc = tabs.activeWebContents()
  const rt = active && runtimes.get(active.profile)
  if (!rt || !wc) return
  const browserAction = (rt.extensions as unknown as { api: { browserAction: { activateClick(details: object): void } } }).api.browserAction
  try {
    browserAction.activateClick({ eventType: 'click', extensionId, tabId: wc.id, anchorRect, alignment: 'bottom left' })
  } catch (error) {
    console.error(`[commands] could not open the popup of ${extensionId}:`, error)
  }
}

// ---------- extension hooks ----------

const tabHooks: TabHooks = (profileId) => ({
  createTab: async (details, extension) => {
    const rec = tabs.create({ profile: profileId, url: details.url || 'about:blank', activate: details.active !== false, openedBy: extension?.id })
    const wc = tabs.webContentsFor(rec.id)
    if (!wc) throw new Error('jbrow could not create a tab')
    return [wc, panel.win]
  },
  selectTab: (wc) => tabs.selectFromExtension(wc),
  removeTab: (wc) => tabs.closeWebContents(wc),
  // Extensions such as Bitwarden pop out into their own small window.
  createWindow: async (details) => {
    const rt = runtimes.get(profileId)
    const win = new BrowserWindow({
      width: details.width ?? 420,
      height: details.height ?? 640,
      alwaysOnTop: true,
      webPreferences: { session: rt?.session, sandbox: true, contextIsolation: true },
    })
    const url = Array.isArray(details.url) ? details.url[0] : details.url
    if (url) void win.loadURL(url)
    rt?.extensions.addTab(win.webContents, win)
    return win
  },
  removeWindow: (win) => {
    if (win !== panel.win && !win.isDestroyed()) (win as BrowserWindow).destroy()
  },
  mainWindow: () => panel.win,
  // Chrome lists a discarded tab with the title and address it had, and no more.
  pagelessTabs: () => {
    const [width, height] = panel.win.getSize()
    return tabs.pageless(profileId).map(({ id, rec }) => ({
      id,
      windowId: panel.win.id,
      index: -1,
      active: false,
      highlighted: false,
      selected: false,
      pinned: !!rec.pinned,
      audible: false,
      mutedInfo: { muted: false },
      discarded: true,
      autoDiscardable: true,
      frozen: false,
      groupId: -1,
      incognito: false,
      status: 'unloaded',
      title: rec.title,
      url: rec.url,
      lastAccessed: rec.lastSeen,
      width,
      height,
    }))
  },
  // A tab woken for an extension has a new ID; Chrome says so with tabs.onReplaced, as when a
  // discarded tab came back.
  tabFor: (id, wake) => {
    const wc = tabs.pageFor(profileId, id, wake)
    const rt = runtimes.get(profileId)
    if (wc && wake && rt) libraryOf(rt).router.broadcastEvent('tabs.onReplaced', wc.id, id)
    return wc
  },
  pagelessTab: (id) => {
    const now = tabs.pagelessId(profileId, id)
    return now === undefined ? undefined : tabHooks(profileId).pagelessTabs().find((t) => t.id === now)
  },
  removePagelessTab: (id) => tabs.closePageless(profileId, id),
})

// ---------- UI messages ----------

function wireIpc() {
  const on = <T>(name: string, fn: (data: T) => void) => ipcMain.on(`ui:${name}`, (_e, data: T) => fn(data))
  on('ready', () => {
    pushState()
    sendDownloads()
    if (!settings.welcomed) panel.ui.send('welcome', { first: true })
  })
  on<{ pinned: boolean }>('welcome-done', ({ pinned }) => finishWelcome(pinned))
  on<{ id: string; action: DownloadAction }>('download', ({ id, action }) => downloads.act(id, action))
  on<{ id: string }>('activate', ({ id }) => tabs.activate(id))
  on<{ site: string }>('zoom-reset', ({ site }) => {
    zoom.forget(site)
    for (const wc of tabs.pages()) zoom.apply(wc)
    pushState()
  })
  on('new', () => {
    tabs.newTab({ profile: newTabProfile(), ...scopeFields() })
    focusAddressBar()
  })
  on<{ input: string; profile?: string; search?: boolean; open?: 'tab' | 'split' }>('navigate', ({ input, profile, search, open }) => {
    // A site with a profile of its own opens there, unless you picked one with Tab.
    if (!profile && open !== 'split') profile = siteProfile(toUrl(input, settings.searchUrl, search))
    const cur = tabs.active()
    const known = !!profile && settings.profiles.some((p) => p.id === profile)
    // The address bar's tools: in a new tab, or in a new pane beside the page (with no page to go beside, here).
    if (open === 'split' && cur?.url) {
      const error = tabs.splitNew()
      if (error) return toast(error)
    } else if (!cur || open === 'tab') tabs.newTab({ profile: known ? profile! : newTabProfile(), ...scopeFields() })
    else if (profile && profile !== cur.profile && settings.profiles.some((p) => p.id === profile)) {
      // Picked with Tab in the address bar. A loaded page stays put; what was typed opens next to it.
      if (cur.url) tabs.create({ profile, ...scopeFields() })
      else cur.profile = profile
      if (filter !== 'all' && filter !== profile) filter = 'all'
    }
    tabs.navigate(input, search)
  })
  on<{ input: string; profile?: string; seq: number }>('suggest', (request) => suggest(request))
  on('suggest-cancel', () => cancelSearchSuggestions())
  on<{ url: string; profile?: string; seq: number }>('site-info', ({ url, profile, seq }) => {
    const p = profile && settings.profiles.some((x) => x.id === profile) ? profile : (tabs.active()?.profile ?? settings.defaultProfile)
    void siteInfo.ask(url, p, seq)
  })
  on<{ id: string }>('split-with', ({ id }) => {
    const error = tabs.splitWith(id)
    if (error) toast(error)
  })
  on<{ url: string }>('copy-link', ({ url }) => {
    clipboard.writeText(url)
    panel.ui.send('url-copied')
  })
  on<{ profile?: string; url: string }>('forget-visit', ({ profile, url }) => visits.forget(profile ?? tabs.active()?.profile ?? settings.defaultProfile, url))
  on<{ id: string }>('close', ({ id }) => void closeTab(id))
  on<{ id: string }>('go-home', ({ id }) => tabs.goHome(id))
  on<{ id: string; muted: boolean }>('mute', ({ id, muted }) => tabs.setMuted(id, muted))
  on<{ id: string }>('thread-menu', ({ id }) => threadMenu(id))
  on<{ id: string }>('close-pane', ({ id }) => tabs.closePane(id))
  on<{ id: string; sizes: number[]; done?: boolean }>('split-sizes', ({ id, sizes, done }) => tabs.resizeSplit(id, sizes, !!done))
  on('add-extension', () => void addExtensionFromFolder())
  on('open-store', () => {
    tabs.create({ profile: tabs.active()?.profile ?? settings.defaultProfile, url: 'https://chromewebstore.google.com/' })
  })
  on<Partial<Prefs>>('prefs', (prefs) => updatePrefs(prefs))
  on('open-settings-file', () => void shell.openPath(settingsPath()))
  on<{ id: string; name: string }>('rename', ({ id, name }) => tabs.rename(id, name))
  on<{ id: string }>('restore', ({ id }) => tabs.restore(id))
  on<{ ids: string[] }>('unarchive', ({ ids }) => void unarchiveThreads(ids))
  on<{ ids: string[] }>('forget-archived', ({ ids }) => void forgetArchived(ids))
  on('undo-archive', () => undoArchive())
  on('dismiss-archive-notice', () => {
    archiveNotice = null
    pushState()
  })
  on('new-folder', () => newFolder())
  on('sidebar-menu', () => sidebarMenu())
  on<{ id: string }>('folder-menu', ({ id }) => folderMenu(id))
  on<{ id: string; name?: string; rules?: string[]; collapsed?: boolean }>('folder', ({ id, ...change }) => tabs.updateFolder(id, change))
  on<{ id: string; kept?: boolean; folder?: string }>('move', ({ id, kept, folder }) => tabs.move(id, !!kept, folder))
  on<{ id: string; target: string | null; after?: boolean }>('place', ({ id, target, after }) => tabs.place(id, target, after))
  on<{ id: string; target: string | null; after?: boolean }>('pin-tab', ({ id, target, after }) => tabs.pin(id, target, after))
  on<{ id: string; parent: string | null }>('move-folder', ({ id, parent }) => tabs.moveFolder(id, parent))
  on<{ filter: string }>('filter', ({ filter: f }) => {
    filter = f
    if (!activeInView()) {
      const recent = mostRecentInView()
      if (recent) tabs.activate(recent)
    }
    pushState()
  })
  on('unscope', () => {
    scope = null
    pushState()
  })
  on<{ on?: boolean } | undefined>('pin', (data) => setPinned(data?.on ?? !panel.pinned))
  on<{ profile: string }>('set-profile', ({ profile }) => {
    const id = tabs.activeId
    if (id) switchProfile(id, profile, true)
  })
  on('new-tab-menu', () => newTabMenu())
  on<{ action: 'back' | 'forward' | 'reload' | 'stop'; hard?: boolean }>('nav', ({ action, hard }) => {
    const wc = tabs.activeWebContents()
    if (!wc) return
    if (action === 'back') wc.navigationHistory.goBack()
    else if (action === 'forward') wc.navigationHistory.goForward()
    else if (action === 'reload') tabs.reload(tabs.activeId!, hard)
    else wc.stop()
  })
  on('restyle-check', () => void restyler.checkAgents())
  on<{ prompt: string }>('restyle', ({ prompt }) => {
    const wc = tabs.activeWebContents()
    if (wc) void restyler.restyle(wc, prompt)
  })
  on<{ action: 'proceed' | 'back' | 'distrust' }>('cert', ({ action }) => certAction(action))
  on<{ action: 'proceed' | 'back' }>('danger', ({ action }) => dangerAction(action))
  on('clear-site-data', () => void clearSiteData())
  on<{ profile: string; cookies: boolean; cache: boolean; history?: boolean }>('clear-data', (options) => void clearBrowsingData(options))
  on<{ id: number; username?: string; password?: string }>('login', ({ id, username, password }) => {
    // Only the question the form showed: a newer one may have taken its place.
    const tabId = tabs.activeId
    if (tabId && logins.view(tabId)?.id === id) logins.answer(tabId, username, password)
  })
  on<{ action: 'reload' | 'wait' }>('crash', ({ action }) => {
    if (!tabs.activeId) return
    if (action === 'reload') tabs.reload(tabs.activeId)
    else tabs.wait(tabs.activeId)
  })
  on<{ host: string; action: 'undo' | 'reset' | 'on' | 'off' | 'cancel' }>('restyle-site', ({ host, action }) => {
    if (action === 'undo') restyler.undo(host)
    else if (action === 'reset') restyler.reset(host)
    else if (action === 'cancel') restyler.cancel(host)
    else restyler.setEnabled(host, action === 'on')
  })
  on<{ on: boolean }>('overlay', ({ on: covered }) => panel.setOverlay(covered))
  on('side-panel-close', () => sidePanels.closeShown())
  on('side-panel-menu', () => sidePanels.menu())
  on<{ width: number; done?: boolean }>('side-panel-width', ({ width, done }) => sidePanels.resize(width, !!done))
  on<{ id: number; device: string | null }>('device', ({ id, device }) => {
    if (tabs.activeId) devices.answer(tabs.activeId, id, device)
  })
  on('hide', () => void panel.hide())
  on('anim-preview', () => void panel.preview())
  on('window-reset', () => panel.resetPlace())
  on('restart', () => void requestQuit(true))
  on('focus-ui', () => panel.ui.focus())
  on('focus-page', () => focusActive())
  on<{ on: boolean }>('settings-shown', ({ on: shown }) => (settingsShown = shown))
  on<{ text: string; forward?: boolean }>('find', ({ text, forward }) => {
    const wc = tabs.activeWebContents()
    if (wc) finder.find(wc, text, forward !== false)
  })
  on('find-stop', () => finder.stop())
  on('shortcuts', () => sendShortcuts())
  on('apps', () => sendApps())
  on('extensions', () => sendExtensions())
  on<{ profile: string; id: string; on: boolean }>('extension-enabled', ({ profile, id, on: enabled }) => void setExtensionEnabled(profile, id, enabled))
  on<{ profile: string; id: string }>('remove-extension', ({ profile, id }) => void removeExtension(profile, id))
  on<{ key: string; profile: string }>('app-profile', ({ key, profile }) => setAppProfile(key, profile))
  on<{ key: string }>('app-menu', ({ key }) => appMenu(key))
  on('add-app', () => void addApp())
  on<{ rename?: boolean } | undefined>('add-profile', (data) => void addProfile(data?.rename !== false))
  on<{ id: string }>('delete-profile', ({ id }) => void deleteProfile(id))
  on<{ id: string; name?: string; color?: string; icon?: string }>('profile', ({ id, ...change }) => updateProfile(id, change))
  on('emoji-panel', () => app.showEmojiPanel())
  on<{ id: string }>('profile-menu', ({ id }) => profileMenu(id))
  on<{ id: string; target: string; after: boolean }>('move-profile', ({ id, target, after }) => moveProfile(id, target, after))
  on<{ id: string }>('default-profile', ({ id }) => setDefaultProfile(id))
  on('default-browser', () => sendDefaultBrowser())
  on('make-default-browser', () => makeDefaultBrowser())
  on('updates', () => sendUpdates())
  on('check-updates', () => updates.check())
  on('install-update', () => void restartToUpdate())
  on<{ on: boolean }>('recording-shortcut', ({ on: recording }) => setRecording(recording))
  on<{ id: ActionId; shortcut: string }>('set-action-key', ({ id, shortcut }) => {
    const error = setActionKey(id, shortcut)
    if (error) toast(error)
  })
  on<{ profile: string; extensionId: string; name: string; shortcut: string }>('set-shortcut', ({ profile, extensionId, name, shortcut }) => {
    const error = commands.set(profile, extensionId, name, shortcut)
    if (error) toast(error)
    sendShortcuts()
  })
  on<{ extensionId: string; anchorRect: { x: number; y: number; width: number; height: number } }>('action-popup', ({ extensionId, anchorRect }) =>
    popupAt(extensionId, anchorRect),
  )
  // Debug only: wake every extension's service worker so it can be inspected.
  if (process.env.JBROW_DEBUG) {
    on('debug-wake-workers', () => {
      for (const rt of runtimes.values()) {
        for (const ext of rt.session.extensions.getAllExtensions()) {
          void rt.session.serviceWorkers.startWorkerForScope(ext.url).catch(() => {})
        }
      }
    })
  }
}

// ---------- menu bar item ----------

function quietMenuItems(): Electron.MenuItemConstructorOptions[] {
  const n = unseenQuietLinks().length
  if (!n) return []
  return [{ label: n === 1 ? 'Show quiet link' : `Show quiet links (${n})`, click: showQuietLink }, { type: 'separator' }]
}

function buildTray() {
  tray = new Tray(nativeImage.createEmpty())
  tray.setTitle('jb')
  tray.setToolTip('jbrow')
  const menu = () =>
    Menu.buildFromTemplate([
      ...(updates.ready ? [{ label: `Restart to update to ${updates.ready}`, click: () => void restartToUpdate() }, { type: 'separator' as const }] : []),
      ...quietMenuItems(),
      { label: `Show jbrow (${shortcutLabel(actionKeys(settings.shortcuts).show)})`, click: () => void onHotkey() },
      { type: 'separator' },
      {
        label: 'Install test extensions',
        submenu: [...runtimes.values()].map((rt) => ({
          label: `Into ${rt.profile.name}`,
          click: async () => {
            new Notification({ title: 'jbrow', body: `Installing test extensions into ${rt.profile.name}…` }).show()
            const results = await installTestExtensions(rt)
            console.log(`[extensions] ${rt.profile.id}:\n  ${results.join('\n  ')}`)
            new Notification({ title: `Extensions in ${rt.profile.name}`, body: results.join('\n') }).show()
          },
        })),
      },
      {
        label: 'Open Chrome Web Store',
        submenu: [...runtimes.values()].map((rt) => ({
          label: `In ${rt.profile.name}`,
          click: async () => {
            tabs.create({ profile: rt.profile.id, url: 'https://chromewebstore.google.com/' })
            await summon()
          },
        })),
      },
      { type: 'separator' },
      {
        label: 'Settings',
        click: async () => {
          await summon()
          panel.ui.send('settings', { open: true })
        },
      },
      { label: 'Welcome to jbrow', click: () => void showWelcome() },
      { label: 'Open settings.json', click: () => void shell.openPath(settingsPath()) },
      { label: 'Show log file', click: () => { const f = logPath(); if (f) shell.showItemInFolder(f) } },
      { label: 'Open UI DevTools', click: () => panel.ui.openDevTools({ mode: 'detach' }) },
      { label: 'Restart jbrow', click: () => void requestQuit(true) },
      { type: 'separator' },
      { label: 'Quit jbrow', click: () => void requestQuit() },
    ])
  tray.on('click', () => void onHotkey())
  tray.on('right-click', () => tray?.popUpContextMenu(menu()))
}

// ---------- app menu ----------

/**
 * The menu bar while jbrow's window is in front. Its key equivalents for copy, paste and undo work
 * even when it's never shown. jbrow's own commands show your keys, but the keys themselves are
 * handled where they're pressed (onKey, onWindowKey), which already knows about recording a shortcut
 * and about popups; a key that gets past those to the menu does nothing, as before there was one.
 */
function buildAppMenu() {
  const keys = actionKeys(settings.shortcuts)
  const item = (id: ActionId, label: string): Electron.MenuItemConstructorOptions => ({
    label,
    accelerator: keys[id] || undefined,
    click: (_item, _win, event) => {
      if (!event.triggeredByAccelerator) runAction(id)
    },
  })
  const zoomItem = (direction: -1 | 0 | 1, label: string, accelerator: string): Electron.MenuItemConstructorOptions => ({
    label,
    accelerator,
    click: (_item, _win, event) => {
      if (!event.triggeredByAccelerator) zoomActive(direction)
    },
  })
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        role: 'appMenu',
        // The standard app menu, with a ⌘Q that asks about running downloads first.
        submenu: [
          { role: 'about' },
          {
            label: 'Check for Updates…',
            click: () => {
              if (updates.ready) return void restartToUpdate()
              updates.check()
              panel.ui.send('settings', { open: true, section: 'general' })
            },
          },
          { type: 'separator' },
          item('settings', 'Settings…'),
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { label: `Quit ${app.name}`, accelerator: 'Command+Q', click: () => void requestQuit() },
        ],
      },
      {
        label: 'File',
        submenu: [
          item('newTab', 'New Tab'),
          item('newTabNextProfile', 'New Tab in Next Profile'),
          { label: 'New Folder', click: () => newFolder() },
          item('reopenTab', 'Reopen Closed Tab'),
          { type: 'separator' },
          item('closeTab', 'Close Tab'),
          { type: 'separator' },
          item('print', 'Print…'),
        ],
      },
      {
        label: 'Edit',
        submenu: [
          { role: 'undo' },
          { role: 'redo' },
          { type: 'separator' },
          { role: 'cut' },
          { role: 'copy' },
          { role: 'paste' },
          { role: 'pasteAndMatchStyle' },
          { role: 'delete' },
          { role: 'selectAll' },
          { type: 'separator' },
          item('find', 'Find…'),
        ],
      },
      {
        label: 'View',
        submenu: [
          item('reload', 'Reload'),
          item('hardReload', 'Reload Without Cache'),
          { type: 'separator' },
          zoomItem(0, 'Actual Size', 'Command+0'),
          zoomItem(1, 'Zoom In', 'Command+='),
          zoomItem(-1, 'Zoom Out', 'Command+-'),
          { type: 'separator' },
          item('splitView', 'Split View'),
          item('paneLeft', 'Focus Left Pane'),
          item('paneRight', 'Focus Right Pane'),
          { type: 'separator' },
          item('address', 'Address Bar'),
          item('copyUrl', 'Copy URL'),
          item('devTools', 'Developer Tools'),
        ],
      },
      {
        label: 'History',
        submenu: [item('back', 'Back'), item('forward', 'Forward')],
      },
      {
        role: 'windowMenu',
        submenu: [
          { ...item('pin', 'Pin the Window'), type: 'checkbox', checked: settings.pinned },
          { type: 'separator' },
          { role: 'front' },
        ],
      },
      {
        role: 'help',
        submenu: [
          { label: 'Welcome to jbrow', click: () => void showWelcome() },
          { type: 'separator' },
          { label: 'Open settings.json', click: () => void shell.openPath(settingsPath()) },
          { label: 'Show Log File', click: () => { const f = logPath(); if (f) shell.showItemInFolder(f) } },
        ],
      },
    ]),
  )
}

// ---------- startup ----------

app.whenReady().then(async () => {
  app.dock?.hide()
  // Back from an update jbrow installed on its own: it comes back hidden or showing, as it was.
  const updated = takeUpdateRelaunch()
  // Without this, macOS quits jbrow a few seconds after it hides: no windows, not frontmost.
  settings = loadSettings()
  nativeTheme.themeSource = settings.appearance
  buildAppMenu()
  // <browser-action-list> lives in the UI page, which uses the default session.
  ElectronChromeExtensions.handleCRXProtocol(session.defaultSession)
  // Before the profiles are set up, since the UI shows icons right away; same session either way.
  handleFavicons(session.defaultSession, (id) => (settings.profiles.some((p) => p.id === id) ? session.fromPartition(partitionFor(id)) : null))

  panel = new Panel(() => settings, {
    setPageVisible: () => {
      tabs.layout()
      sidePanels?.layout()
    },
    sideWidth: () => sidePanels?.width() ?? 0,
    pages: () =>
      (tabs?.shown() ?? []).flatMap((id) => {
        const wc = tabs.webContentsFor(id)
        return wc && !tabs.covered(id) ? [wc] : []
      }),
    onPlaced: () => {
      saveSettings(settings)
      pushState()
    },
    onHiding: () => {
      tabs.leaveFullscreen()
      if (settings.miniPlayer.onHide) toMiniPlayer(tabs.activeWebContents())
    },
    onShown: () => {
      if (archiveNotice) archiveNotice.seenAt ??= Date.now()
      pushState()
    },
    onHidden: () => {
      hiddenAt = Date.now()
      // Seen long enough, it goes; a glance counts from the next show again.
      if (archiveNotice?.seenAt && Date.now() - archiveNotice.seenAt >= NOTICE_SEEN_MS) archiveNotice = null
      else if (archiveNotice) archiveNotice.seenAt = null
      downloads.clearFinished()
      pushState()
    },
  })
  panel.setPinned(settings.pinned)
  panel.ui.on('render-process-gone', (_e, details) => console.error('[jbrow] UI renderer gone:', details))
  // A UI that (re)loads has no archived list yet, and one sent while it was loading went nowhere.
  panel.ui.on('did-finish-load', () => {
    archivedSent = -1
    pushState()
  })
  panel.ui.on('before-input-event', (event, input) => {
    if (onKey(input)) event.preventDefault()
  })
  app.on('web-contents-created', (_e, wc) => {
    if (wc.getType() !== 'window') return
    wc.on('before-input-event', (event, input) => {
      if (onWindowKey(wc, input)) event.preventDefault()
    })
  })

  permissions = new SitePermissions(() => panel.win)
  restyler = new Restyler({
    settings: () => settings.restyle,
    pages: () => tabs.pages(),
    onChange: () => pushState(),
    notify: toast,
  })
  restyler.load()
  void restyler.checkAgents()
  certs = new Certificates(() => {
    tabs.layout()
    pushState()
  })
  siteInfo = new SiteInfo({
    resolve: async (profile, host) => (await runtimes.get(profile)?.session.resolveHost(host))?.endpoints[0]?.address,
    cert: (profile, host) => certs.seenOn(profile, host),
    isPrivate: (url) => urlMatcher(settings.privateUrls)(url),
    isSearch: (url) => isSearchPage(url, settings.searchUrl),
    send: (reply) => {
      if (!panel.win.isDestroyed()) panel.ui.send('site-info', reply)
    },
  })
  dangerous = new DangerousSites({
    enabled: () => settings.dangerousSites,
    onChange: () => {
      tabs?.layout()
      pushState()
    },
  })
  dangerous.start()
  logins = new Logins((tabId) => {
    if (SignInSheets.owns(tabId)) return signIns.update(tabId)
    tabs.layout()
    pushState()
    // The sign-in form needs the keyboard; once it's answered, the page gets it back.
    if (tabId === tabs.activeId) focusActive()
  })
  signIns = new SignInSheets(logins, () => settings.theme)
  // HTTP auth for pages outside tabs: sign-in popups that pages open, extension popups, pop-out
  // windows. Tabs answer through their own 'login' handler (tabs.ts).
  app.on('login', (event, wc, _details, authInfo, callback) => {
    if (!wc || tabs.idForWebContents(wc)) return
    event.preventDefault()
    signIns.ask(wc, authInfo, callback)
  })
  devices = new DeviceChooser(permissions, {
    tabFor: (wc) => tabs.idForWebContents(wc),
    onChange: (tabId) => {
      pushState()
      // The chooser takes the keyboard while it's open; once it's answered, the page gets it back.
      if (tabId === tabs.activeId && !devices.view(tabId)) focusActive()
    },
  })
  tabs = new Tabs({
    window: () => panel.win,
    // A popup that closes itself takes you back to the page that opened it.
    closedByPage: (id) => {
      const opener = tabs.get(id)?.opener
      const back = tabs.activeId === id && opener && tabs.get(opener) ? opener : undefined
      void closeTab(id, false, false).then(() => {
        if (back && tabs.get(back)) tabs.activate(back)
      })
    },
    runtime: (id) => runtimes.get(id),
    contentBounds: () => panel.contentBounds(),
    contentVisible: () => panel.pageVisible(),
    onViewAdded: () => panel.keepOrder(),
    whimsy: () => settings.whimsy && !systemPreferences.getAnimationSettings().prefersReducedMotion,
    onChange: () => pushState(),
    onActivated: () => {
      sidePanels?.layout()
      focusActive()
      tabSwitched()
    },
    refocus: focusActive,
    onKey,
    searchUrl: () => settings.searchUrl,
    permissions,
    certs,
    dangerous,
    logins,
    devices,
    onNavigate: (wc) => {
      restyler.onNavigate(wc)
      zoom.apply(wc)
    },
    onVisit: (profile, url) => visits.record(profile, url, ''),
    onTitle: (profile, url, title) => visits.setTitle(profile, url, title),
    print: (wc) => printPage(wc),
    saveAsPdf: (wc) => void savePageAsPdf(wc),
    download: (wc, url) => downloads.start(wc, url),
    onFullscreen: (on, url) => {
      panel.setPageFullscreen(on, siteName(url))
      // The side panel steps aside for a fullscreen page and comes back after.
      sidePanels.layout()
    },
    held: (wc) => !!extensionDebugger.holder(wc),
    confirmUnload,
    besideClosed: (id) => besideClosed(threadsInView(), id, settings.newTabsAt),
    profiles: () => settings.profiles,
    openInProfile: (fromId, profile, url, background) => {
      const from = tabs.get(fromId)
      if (!background && filter !== 'all' && filter !== profile) filter = 'all'
      tabs.create({ profile, url, scope: from?.scope, scopeName: from?.scopeName, app: from?.app, ...(background && { activate: false, unread: true }) })
    },
    siteProfile,
    extensionInUse: () => {
      const focused = BrowserWindow.getFocusedWindow()
      const page = focused && !focused.isDestroyed() ? focused.webContents.getURL() : ''
      return page.startsWith('chrome-extension://') || Date.now() - commands.lastRunAt < 2000
    },
  })

  downloads = new Downloads({
    onChange: () => sendDownloads(),
    onStarted: (wc) => closeDownloadOnlyTab(wc),
    visible: () => panel.visible,
    window: () => panel.win,
  })

  sidePanels = new SidePanels({
    window: () => panel.win,
    active: () => {
      const active = tabs.active()
      return active ? { profile: active.profile, wc: tabs.activeWebContents() } : null
    },
    bounds: () => panel.sideBounds(),
    visible: () => panel.pageVisible() && !panel.pageFullscreen,
    onViewAdded: () => panel.keepOrder(),
    onChange: () => {
      tabs.layout()
      pushState()
    },
    onKey,
    openTab: (profile, url) => void tabs.create({ profile, url }),
    width: () => settings.sidePanelWidth,
    setWidth: (width, save) => {
      settings.sidePanelWidth = width
      if (save) saveSettings(settings)
      sidePanels.layout()
    },
  })
  idle = new IdleWatcher()
  extensionDebugger = new ExtensionDebugger(() => pushState())
  userScripts = new UserScripts()
  updates = new Updates({
    enabled: () => settings.autoUpdate,
    quietMoment,
    shown: () => panel.visible,
    beforeInstall: () => panel.flush(),
    onChange: () => sendUpdates(),
  })

  wireIpc()
  wireSwipes(panel.win, (wc) => (tabs.idForWebContents(wc) ? wc : null), () => tabs.activeWebContents())
  profileDeps = {
    hooks: tabHooks,
    pickShareSource: (callback) => void pickShareSource(panel.win, callback),
    permissions,
    devices,
    attach: (rt) => {
      idle.attach(rt)
      extensionDebugger.attach(rt)
      sidePanels.attach(rt)
      userScripts.attach(rt)
      attachStorageEvents(rt)
    },
  }
  runtimes = await setupProfiles(settings, profileDeps)
  for (const rt of runtimes.values()) attachProfile(rt)

  commands = new ExtensionCommands(() => settings, () => runtimes, {
    save: () => saveSettings(settings),
    openPopup: (profileId, extensionId) => void openActionPopup(profileId, extensionId),
    activeTab: (profileId) => (tabs.active()?.profile === profileId ? (tabs.activeWebContents() ?? undefined) : undefined),
  })
  commands.watch()

  tabs.keepLoaded = settings.keepLoaded
  tabs.load()
  visits.load()
  // Threads opened from one app carry the name it had in front.
  for (const t of tabs.records) if (t.scope && !t.scope.includes('+') && t.scopeName) apps.note(t.scope, t.scopeName)
  // settings.json may have been edited by hand since: put threads where the links now say.
  rescopeThreads()
  sweep()
  setInterval(sweep, SWEEP_EVERY_MS)
  const first = tabs.active() ?? [...tabs.records].sort((a, b) => b.lastSeen - a.lastSeen)[0]
  if (first) tabs.activate(first.id)
  else tabs.newTab({ profile: settings.defaultProfile })
  // Pinned pages load in the background after the one you'll see.
  tabs.loadPinned()

  registerHotkeys(true)
  if (!BACKGROUND) buildTray()
  updates.start()
  // Back from picture-in-picture whenever jbrow is in front again, unless the video belongs to
  // another tab you switched away from: that one waits until you're on its tab.
  panel.win.on('focus', () => {
    if (!settings.miniPlayer.onTabSwitch || miniPlayer.webContents === tabs.activeWebContents()) miniPlayer.exit()
  })
  // A pinned jbrow stays on screen behind other apps; its video follows you out anyway.
  app.on('did-resign-active', () => {
    if (panel.pinned && panel.visible && settings.miniPlayer.onHide) toMiniPlayer(tabs.activeWebContents())
  })
  app.on('browser-window-blur', () =>
    panel.checkClickAway(async () => dialogsOpen > 0 || (await frontmostApp())?.pid === process.pid),
  )
  const keys = actionKeys(settings.shortcuts)
  console.log(`[jbrow] ready. ${keys.show} for everything, ${keys.showApp || 'no key'} for the app in front.`)
  // `npm start -- --install-extensions=personal` installs the test extensions into that profile.
  const installArg = process.argv.find((a) => a.startsWith('--install-extensions='))
  const installInto = installArg && runtimes.get(installArg.split('=')[1])
  if (installInto) {
    const results = await installTestExtensions(installInto)
    console.log(`[extensions] ${installInto.profile.id}:\n  ${results.join('\n  ')}`)
  }
  started = true
  // macOS launched jbrow to open these, which you asked for.
  for (const url of waitingLinks.splice(0)) await openFromApp(url, true)
  // Pinned, jbrow opens its window at launch like any browser. `npm start -- --show` does too.
  if (updated ? updated.shown : settings.pinned || process.argv.includes('--show')) {
    // The log line tells automated runs (test/e2e) that jbrow is up and has handed out focus.
    setTimeout(() => void onHotkey().then(() => console.log('[jbrow] shown')), 600)
  }
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  tabs?.flush()
  visits.flush()
})
// jbrow has no windows to close; it quits only from the menu bar item.
app.on('window-all-closed', () => {})
// Pinned, jbrow has a Dock icon; clicking it or ⌘Tabbing to jbrow brings the window back.
app.on('activate', () => {
  if (panel?.pinned && !panel.visible) void panel.show()
})
