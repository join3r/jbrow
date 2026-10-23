import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, MenuItem, nativeImage, nativeTheme, Notification, session, shell, Tray } from 'electron'
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { ACTIONS, actionKeys, FIXED, isGlobal, shortcutFromKey, shortcutLabel, type ActionId } from '../shared/shortcuts'
import { urlMatcher } from '../shared/patterns'
import { flatFolders, isInFolder, numberedThreads, rootOf, sections, type FolderView } from '../shared/threads'
import { THEMES, type AppEntry, type AppLabel, type Folder, type Prefs, type Profile, type TabRecord, type UiState } from '../shared/types'
import { AppDirectory, bundleIdOf } from './apps'
import { BACKGROUND } from './background'
import { Certificates } from './certs'
import { Logins } from './logins'
import { ExtensionCommands } from './commands'
import { Downloads, type DownloadAction } from './downloads'
import { FindInPage } from './find'
import { frontmostApp, type FrontApp } from './frontmost'
import { secondsSinceInput } from './input'
import { logPath, setupLogging } from './log'
import { Panel } from './panel'
import { SitePermissions } from './permissions'
import { MiniPlayer } from './pip'
import { pickShareSource } from './screenshare'
import { installTestExtensions, loadUnpacked, partitionFor, setupProfile, setupProfiles, type ProfileDeps, type ProfileRuntime, type TabHooks } from './profiles'
import { Restyler } from './restyle'
import { loadSettings, saveSettings, scopeForApp, settingsPath, type Settings } from './settings'
import { Tabs } from './tabs'
import { Zoom, ZOOM_STEPS } from './zoom'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const AWAY_FOCUS_MS = 60 * 1000
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
let logins: Logins
let permissions: SitePermissions
let profileDeps: ProfileDeps
/** The settings screen is recording a shortcut: key presses go to it, not to jbrow or extensions. */
let recordingShortcut = false

let filter = 'all'
let scope: { key: string; name: string } | null = null
let lastFront: FrontApp | null = null
let hiddenAt = 0
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
  app.setPath('logs', `${process.env.JBROW_USER_DATA}/logs`)
  app.setPath('downloads', `${process.env.JBROW_USER_DATA}/Downloads`)
}
setupLogging()
// Utilities that quit apps with no open windows (Vorssaint, for one) will quit jbrow while it's
// hidden. Exclude jbrow in them; this line in the log shows when it happens.
app.on('before-quit', () => console.log('[jbrow] quitting'))

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
    tabs: tabs.uiTabs(),
    activeId: tabs.activeId,
    folders: tabs.folders,
    archived: tabs.archived,
    activeWebContentsId: tabs.activeWebContents()?.id ?? null,
    activePartition: active ? partitionFor(active.profile) : null,
    activeExtensions: actionExtensions(active?.profile),
    profiles: settings.profiles,
    filter,
    scope,
    apps: appLabels(),
    pinned: panel.pinned,
    restyle: active ? restyler.view(active.url) : null,
    cert: active ? certs.view(active.id, active.profile, active.url) : null,
    login: active ? logins.view(active.id) : null,
    crash: active ? tabs.crash(active.id) : null,
    styledSites: restyler.styledSites(),
    zoomSites: zoom.list(),
    nav: tabs.navState(),
    keys: actionKeys(settings.shortcuts),
    prefs: {
      appearance: settings.appearance,
      theme: settings.theme,
      profileStyle: settings.profileStyle,
      animation: settings.animation,
      privateUrls: settings.privateUrls,
      hideFromScreenCapture: settings.hideFromScreenCapture,
      quietLinks: settings.quietLinks,
      summarizeAfterDays: settings.summarizeAfterDays,
      archiveAfterDays: settings.archiveAfterDays,
      earlierAfterHours: settings.earlierAfterHours,
      pinnedExtensions: settings.pinnedExtensions,
      restyleAgent: settings.restyle.agent,
      restyleModel: settings.restyle.model,
      restyleCodexModel: settings.restyle.codexModel,
      defaultProfile: settings.defaultProfile,
      miniPlayer: settings.miniPlayer,
      zoom: { defaultPercent: settings.zoom.defaultPercent, remember: settings.zoom.remember },
    },
    now: Date.now(),
  }
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

let pushQueued = false
function pushState() {
  if (pushQueued) return
  pushQueued = true
  queueMicrotask(() => {
    pushQueued = false
    if (!panel.win.isDestroyed()) panel.ui.send('state', state())
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
  if (!id || !rec?.parent) return
  const committed = wc.getURL()
  if (wc.navigationHistory.canGoBack() || (committed && committed !== 'about:blank')) return
  setTimeout(() => closeTab(id, false), 0)
}

const toast = (text: string) => {
  if (!panel.win.isDestroyed()) panel.ui.send('toast', text)
}

const zoom = new Zoom(() => settings, () => saveSettings(settings))

const finder = new FindInPage((update) => {
  if (!panel.win.isDestroyed()) panel.ui.send('find', update)
})

/** Opens the find bar, or selects its query if it's open. Only for a tab with a page. */
function openFind() {
  if (!tabs.activeWebContents() || !tabs.active()?.url || panel.win.isDestroyed()) return
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
  return sections(tabs.records, { filter, scope: scope?.key ?? null, activeId: tabs.activeId, now: Date.now(), folders: tabs.folders, appNames, earlierAfterMs: settings.earlierAfterHours * HOUR_MS })
}

/** Unloads and archives stale threads, or files them into folders, per settings. */
const sweep = () => tabs.sweep(settings.archiveAfterDays * DAY_MS, settings.summarizeAfterDays * DAY_MS)

/** Most recently seen tab among the threads the sidebar currently shows. */
function mostRecentInView(): string | undefined {
  const s = threadsInView()
  const all = [...flatFolders(s.folders).flatMap((f) => f.threads), ...s.kept, ...s.today, ...s.apps.flatMap((a) => [...a.threads, ...a.earlier]), ...s.earlier]
  return all.sort((a, b) => b.lastSeen - a.lastSeen)[0]?.last.id
}

function activeInView(): boolean {
  const active = tabs.active()
  if (!active) return false
  const root = rootOf(tabs.records, active)
  return (filter === 'all' || root.profile === filter) && (!scope || root.scope === scope.key)
}

// ---------- summoning ----------

async function summon() {
  let focusOmnibox = false
  if (!panel.visible) {
    sweep()
    const away = hiddenAt ? Date.now() - hiddenAt : 0
    if (away > AWAY_FRESH_MS) {
      tabs.newTab({ profile: newTabProfile(), ...scopeFields() })
      focusOmnibox = true
    } else if (away > AWAY_FOCUS_MS) {
      focusOmnibox = true
    }
  }
  if (!activeInView()) {
    const recent = mostRecentInView()
    if (recent) tabs.activate(recent)
    else {
      tabs.newTab({ profile: newTabProfile(), ...scopeFields() })
      focusOmnibox = true
    }
  }
  if (!tabs.active()?.url) focusOmnibox = true
  pushState()
  await panel.show()
  if (focusOmnibox) focusAddressBar()
  else focusActive()
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
  const thread = numberedThreads(threadsInView())[n - 1]
  if (thread) tabs.activate(thread.last.id)
}

/**
 * Moves a tab to another profile. A new tab just switches; a loaded page can't change its
 * session, so it reopens in the other profile next to the original.
 */
function switchProfile(id: string, next: string) {
  const cur = tabs.get(id)
  if (!cur || cur.profile === next) return
  if (filter !== 'all' && filter !== next) filter = 'all'
  if (!cur.url) {
    cur.profile = next
    pushState()
    return
  }
  tabs.create({ profile: next, url: cur.url, ...(cur.parent ? {} : { scope: cur.scope, scopeName: cur.scopeName, app: cur.app }) })
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
      if (tabs.activeId) tabs.close(tabs.activeId)
      if (!tabs.active()) tabs.newTab({ profile: newTabProfile(), ...scopeFields() })
      return
    case 'reopenTab':
      return void tabs.reopen()
    case 'previousTab': {
      const prev = tabs.previous()
      if (prev) tabs.activate(prev)
      return
    }
    case 'address':
      return focusAddressBar()
    case 'find':
      return openFind()
    case 'reload':
      return tabs.activeId ? tabs.reload(tabs.activeId) : undefined
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

function onKey(input: Electron.Input): boolean {
  if (input.type !== 'keyDown' || recordingShortcut) return false
  if (commands?.handleKey(tabs.active()?.profile, input)) return true
  const shortcut = shortcutFromKey({ ...input, command: input.meta })
  if (shortcut) {
    const keys = actionKeys(settings.shortcuts)
    // The summon keys are global shortcuts, so they never reach a window.
    const action = ACTIONS.find((a) => keys[a.id] === shortcut && !isGlobal(a.id))
    if (action) {
      runAction(action.id)
      return true
    }
    // ⌘G and ⇧⌘G step through the matches while the find bar is open.
    if (finder.open && (shortcut === 'Command+G' || shortcut === 'Command+Shift+G')) {
      panel.ui.send('find', { step: shortcut === 'Command+G' ? 1 : -1 })
      return true
    }
  }
  if (!input.meta) return false
  const key = input.key.toLowerCase()
  // Matched by code too, so zoom works on layouts where = and - sit elsewhere or need Shift.
  const zoomKey =
    key === '=' || key === '+' || input.code === 'Equal' || input.code === 'NumpadAdd' ? 1
    : key === '-' || input.code === 'Minus' || input.code === 'NumpadSubtract' ? -1
    : key === '0' || input.code === 'Numpad0' ? 0
    : null
  if (zoomKey !== null && !input.alt) {
    const wc = tabs.activeWebContents()
    if (wc) {
      const percent = zoom.step(wc, zoomKey)
      toast(`Zoom ${percent}%`)
      pushState()
    }
    return true
  }
  if (!input.alt && !input.shift && /^[1-9]$/.test(key)) {
    openThread(Number(key))
    return true
  }
  return false
}

// ---------- settings screen, extensions, thread menu ----------

/** Pins or unpins the window and remembers it for next launch. */
function setPinned(on: boolean) {
  panel.setPinned(on)
  if (settings.pinned !== on) {
    settings.pinned = on
    saveSettings(settings)
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

/** On switching tabs, the old tab's video goes into the mini player and the new tab's comes back. */
function tabSwitched() {
  const wc = tabs.activeWebContents()
  const prev = shownPage
  shownPage = wc
  if (prev === wc) return
  if (wc && miniPlayer.webContents === wc) miniPlayer.exit()
  if (settings.miniPlayer.onTabSwitch && panel.visible) toMiniPlayer(prev)
}

function updatePrefs(prefs: Partial<Prefs>) {
  if (prefs.appearance === 'system' || prefs.appearance === 'light' || prefs.appearance === 'dark') {
    settings.appearance = prefs.appearance
    nativeTheme.themeSource = prefs.appearance
  }
  if (THEMES.some((t) => t.id === prefs.theme)) settings.theme = prefs.theme!
  if (prefs.profileStyle === 'tint' || prefs.profileStyle === 'edge' || prefs.profileStyle === 'solid') settings.profileStyle = prefs.profileStyle
  if (prefs.animation) settings.animation = { ...settings.animation, ...prefs.animation }
  if (prefs.privateUrls) settings.privateUrls = prefs.privateUrls.map((p) => p.trim()).filter(Boolean)
  if (prefs.hideFromScreenCapture !== undefined) {
    settings.hideFromScreenCapture = prefs.hideFromScreenCapture
    panel.applyContentProtection()
  }
  if (prefs.quietLinks !== undefined) settings.quietLinks = prefs.quietLinks
  if (prefs.restyleAgent === 'claude' || prefs.restyleAgent === 'codex') settings.restyle = { ...settings.restyle, agent: prefs.restyleAgent }
  if (prefs.restyleModel) settings.restyle = { ...settings.restyle, model: prefs.restyleModel }
  if (prefs.restyleCodexModel !== undefined) settings.restyle = { ...settings.restyle, codexModel: prefs.restyleCodexModel.trim() }
  if (prefs.earlierAfterHours !== undefined) settings.earlierAfterHours = Math.max(1, prefs.earlierAfterHours)
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

function closeTab(id: string, remember = true) {
  tabs.close(id, remember)
  if (!tabs.active()) tabs.newTab({ profile: newTabProfile(), ...scopeFields() })
}

function threadMenu(id: string) {
  const rec = tabs.get(id)
  if (!rec) return
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: 'Rename', click: () => panel.ui.send('rename-tab', id) },
  ]
  if (rec.url) items.push({ label: 'Copy link', click: () => clipboard.writeText(rec.url) })
  for (const p of settings.profiles) {
    if (p.id !== rec.profile) items.push({ label: `Open in ${p.name}`, click: () => switchProfile(id, p.id) })
  }
  if (rec.parent) items.push({ label: 'Move out of thread', click: () => tabs.move(id, null) })
  else items.push({ label: rec.kept ? 'Stop keeping' : 'Keep', click: () => tabs.move(id, null, !rec.kept) })
  if (!rec.parent && tabs.folders.length) {
    items.push({
      label: 'Move to folder',
      submenu: [
        ...folderChoices().map<Electron.MenuItemConstructorOptions>(({ folder, label }) => ({
          label,
          type: 'checkbox',
          checked: rec.kept && rec.folder === folder.id,
          click: () => tabs.move(id, null, true, folder.id),
        })),
        ...(rec.kept && rec.folder ? [{ type: 'separator' as const }, { label: 'Out of folder', click: () => tabs.move(id, null, true) }] : []),
      ],
    })
  }
  items.push({ type: 'separator' }, { label: 'Close', accelerator: id === tabs.activeId ? 'Cmd+W' : undefined, click: () => closeTab(id) })
  Menu.buildFromTemplate(items).popup({ window: panel.win })
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

function newFolder(parent?: string) {
  const folder = tabs.createFolder('New folder', parent)
  if (parent) tabs.updateFolder(parent, { collapsed: false })
  panel.ui.send('rename-tab', folder.id)
}

/** Every folder in sidebar order, labelled with the folders it sits in. */
function folderChoices(): { folder: Folder; label: string }[] {
  const walk = (views: FolderView<TabRecord>[], prefix: string): { folder: Folder; label: string }[] =>
    views.flatMap((v) => [{ folder: v.folder, label: prefix + v.folder.name }, ...walk(v.folders, `${prefix}${v.folder.name} › `)])
  const s = sections(tabs.records, { filter: 'all', scope: null, activeId: null, now: Date.now(), folders: tabs.folders })
  return walk(s.folders, '')
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
    else closeTab(rec.id)
  } else {
    const view = certs.view(rec.id, rec.profile, rec.url)
    if (!view) return
    certs.distrust(rec.profile, view.host)
    // An open connection would carry on without checking the certificate again.
    void wc.session.closeAllConnections().then(() => wc.reload())
  }
}

// ---------- links from other apps ----------

/**
 * Opens a link another app handed to jbrow, in that app's profile and its section of the sidebar,
 * and brings jbrow up on it. The app the link came from is still in front when it arrives.
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
  const profile = (from && settings.appProfiles[from.bundleId]) || settings.defaultProfile
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
  // Pin and unpin from the menu an extension's button shows on right-click (see scripts/patch-deps.mjs).
  rt.extensions.on('jbrow-action-context-menu', ({ menu, extensionId }: { menu: Menu; extensionId: string }) => {
    const pinned = settings.pinnedExtensions.includes(extensionId)
    menu.append(new MenuItem({ type: 'separator' }))
    menu.append(new MenuItem({ label: pinned ? 'Unpin from toolbar' : 'Pin to toolbar', click: () => togglePinnedExtension(extensionId) }))
  })
}

let addingProfile = false
async function addProfile() {
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
    panel.ui.send('rename-profile', profile.id)
  } catch (error) {
    console.error('[profiles] could not add a profile:', error)
    toast(`Couldn't add a profile: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    addingProfile = false
  }
}

function updateProfile(id: string, change: { name?: string; color?: string }) {
  const profile = settings.profiles.find((p) => p.id === id)
  if (!profile) return
  const name = change.name?.trim()
  if (name) profile.name = name
  if (change.color && /^#[0-9a-f]{6}$/i.test(change.color)) profile.color = change.color
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
  for (const t of doomed.reverse()) tabs.close(t.id)
  tabs.forgetProfile(id)

  settings.profiles = settings.profiles.filter((p) => p.id !== id)
  if (settings.defaultProfile === id) settings.defaultProfile = settings.profiles[0].id
  for (const [bundleId, p] of Object.entries(settings.appProfiles)) if (p === id) delete settings.appProfiles[bundleId]
  delete settings.unpackedExtensions[id]
  delete settings.extensionShortcuts[id]
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
  Menu.buildFromTemplate([
    { label: 'Rename', click: () => panel.ui.send('rename-profile', id) },
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
  for (const t of tabs.records) if (t.scope && !t.parent) keys.add(t.scope)
  return [...keys]
    .map<AppEntry>((key) => {
      const ids = appsIn(key)
      const profiles = new Set(ids.map((id) => settings.appProfiles[id] ?? ''))
      return {
        key,
        apps: ids.map((bundleId) => ({ bundleId, name: apps.name(bundleId), icon: apps.icon(bundleId) })),
        profile: profiles.size === 1 ? [...profiles][0] : null,
        threads: tabs.records.filter((t) => t.scope === key && !t.parent).length,
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
    { label: entry.threads ? 'Remove (close its threads first)' : 'Remove', enabled: !entry.threads, click: () => removeApp(key) },
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
  createTab: async (details) => {
    const rec = tabs.create({ profile: profileId, url: details.url || 'about:blank', activate: details.active !== false })
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
})

// ---------- UI messages ----------

function wireIpc() {
  const on = <T>(name: string, fn: (data: T) => void) => ipcMain.on(`ui:${name}`, (_e, data: T) => fn(data))
  on('ready', () => {
    pushState()
    sendDownloads()
  })
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
  on<{ input: string; profile?: string }>('navigate', ({ input, profile }) => {
    const cur = tabs.active()
    if (!cur) tabs.newTab({ profile: newTabProfile(), ...scopeFields() })
    else if (profile && profile !== cur.profile && settings.profiles.some((p) => p.id === profile)) {
      // Picked with Tab in the address bar. A loaded page stays put; what was typed opens next to it.
      if (cur.url) tabs.create({ profile, ...scopeFields() })
      else cur.profile = profile
      if (filter !== 'all' && filter !== profile) filter = 'all'
    }
    tabs.navigate(input)
  })
  on<{ id: string }>('close', ({ id }) => closeTab(id))
  on<{ id: string }>('thread-menu', ({ id }) => threadMenu(id))
  on('add-extension', () => void addExtensionFromFolder())
  on('open-store', () => {
    tabs.create({ profile: tabs.active()?.profile ?? settings.defaultProfile, url: 'https://chromewebstore.google.com/' })
  })
  on<Partial<Prefs>>('prefs', (prefs) => updatePrefs(prefs))
  on('open-settings-file', () => void shell.openPath(settingsPath()))
  on<{ id: string; name: string }>('rename', ({ id, name }) => tabs.rename(id, name))
  on<{ id: string }>('restore', ({ id }) => tabs.restore(id))
  on('new-folder', () => newFolder())
  on<{ id: string }>('folder-menu', ({ id }) => folderMenu(id))
  on<{ id: string; name?: string; rules?: string[]; collapsed?: boolean }>('folder', ({ id, ...change }) => tabs.updateFolder(id, change))
  on<{ id: string; parent: string | null; kept?: boolean; folder?: string }>('move', ({ id, parent, kept, folder }) => {
    const error = tabs.move(id, parent, kept, folder)
    if (error) toast(error)
  })
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
    if (id) switchProfile(id, profile)
  })
  on('new-tab-menu', () => newTabMenu())
  on<{ action: 'back' | 'forward' | 'reload' | 'stop' }>('nav', ({ action }) => {
    const wc = tabs.activeWebContents()
    if (!wc) return
    if (action === 'back') wc.navigationHistory.goBack()
    else if (action === 'forward') wc.navigationHistory.goForward()
    else if (action === 'reload') tabs.reload(tabs.activeId!)
    else wc.stop()
  })
  on<{ prompt: string }>('restyle', ({ prompt }) => {
    const wc = tabs.activeWebContents()
    if (wc) void restyler.restyle(wc, prompt)
  })
  on<{ action: 'proceed' | 'back' | 'distrust' }>('cert', ({ action }) => certAction(action))
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
  on('hide', () => void panel.hide())
  on('focus-ui', () => panel.ui.focus())
  on('focus-page', () => focusActive())
  on<{ text: string; forward?: boolean }>('find', ({ text, forward }) => {
    const wc = tabs.activeWebContents()
    if (wc) finder.find(wc, text, forward !== false)
  })
  on('find-stop', () => finder.stop())
  on('shortcuts', () => sendShortcuts())
  on('apps', () => sendApps())
  on<{ key: string; profile: string }>('app-profile', ({ key, profile }) => setAppProfile(key, profile))
  on<{ key: string }>('app-menu', ({ key }) => appMenu(key))
  on('add-app', () => void addApp())
  on('add-profile', () => void addProfile())
  on<{ id: string; name?: string; color?: string }>('profile', ({ id, ...change }) => updateProfile(id, change))
  on<{ id: string }>('profile-menu', ({ id }) => profileMenu(id))
  on<{ id: string }>('default-profile', ({ id }) => setDefaultProfile(id))
  on('default-browser', () => sendDefaultBrowser())
  on('make-default-browser', () => makeDefaultBrowser())
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
      { label: 'Open settings.json', click: () => void shell.openPath(settingsPath()) },
      { label: 'Show log file', click: () => { const f = logPath(); if (f) shell.showItemInFolder(f) } },
      { label: 'Open UI DevTools', click: () => panel.ui.openDevTools({ mode: 'detach' }) },
      { label: 'Restart jbrow', click: () => (app.relaunch(), app.quit()) },
      { type: 'separator' },
      { label: 'Quit jbrow', role: 'quit' },
    ])
  tray.on('click', () => void onHotkey())
  tray.on('right-click', () => tray?.popUpContextMenu(menu()))
}

// ---------- startup ----------

app.whenReady().then(async () => {
  app.dock?.hide()
  // Without this, macOS quits jbrow a few seconds after it hides: no windows, not frontmost.
  settings = loadSettings()
  nativeTheme.themeSource = settings.appearance
  // Key equivalents for copy, paste and undo come from the app menu, even when it's never shown.
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      { role: 'appMenu' },
      { role: 'editMenu' },
    ]),
  )
  // <browser-action-list> lives in the UI page, which uses the default session.
  ElectronChromeExtensions.handleCRXProtocol(session.defaultSession)

  panel = new Panel(() => settings, {
    setPageVisible: () => tabs.layout(),
    capture: async () => {
      const wc = tabs.activeWebContents()
      const tabId = tabs.activeId
      if (!wc || !tabId) return null
      try {
        const img = await wc.capturePage()
        return img.isEmpty() ? null : { dataUrl: `data:image/jpeg;base64,${img.toJPEG(82).toString('base64')}`, tabId }
      } catch {
        return null
      }
    },
    onHiding: () => {
      tabs.leaveFullscreen()
      if (settings.miniPlayer.onHide) toMiniPlayer(tabs.activeWebContents())
    },
    onShown: () => pushState(),
    onHidden: () => {
      hiddenAt = Date.now()
      downloads.clearFinished()
      pushState()
    },
  })
  panel.setPinned(settings.pinned)
  panel.ui.on('render-process-gone', (_e, details) => console.error('[jbrow] UI renderer gone:', details))
  panel.ui.on('before-input-event', (event, input) => {
    if (onKey(input)) event.preventDefault()
  })

  permissions = new SitePermissions(() => panel.win)
  restyler = new Restyler({
    settings: () => settings.restyle,
    pages: () => tabs.pages(),
    onChange: () => pushState(),
    notify: toast,
  })
  restyler.load()
  certs = new Certificates(() => {
    tabs.layout()
    pushState()
  })
  logins = new Logins((tabId) => {
    tabs.layout()
    pushState()
    // The sign-in form needs the keyboard; once it's answered, the page gets it back.
    if (tabId === tabs.activeId) focusActive()
  })
  tabs = new Tabs({
    window: () => panel.win,
    runtime: (id) => runtimes.get(id),
    contentBounds: () => panel.contentBounds(),
    contentVisible: () => panel.pageVisible(),
    onViewAdded: () => panel.keepOrder(),
    onChange: () => pushState(),
    onActivated: () => {
      focusActive()
      tabSwitched()
    },
    onKey,
    searchUrl: () => settings.searchUrl,
    permissions,
    certs,
    logins,
    onNavigate: (wc) => {
      restyler.onNavigate(wc)
      zoom.apply(wc)
    },
    print: (wc) => printPage(wc),
    saveAsPdf: (wc) => void savePageAsPdf(wc),
    download: (wc, url) => downloads.start(wc, url),
    onFullscreen: (on, url) => panel.setPageFullscreen(on, siteName(url)),
    profiles: () => settings.profiles,
    openInProfile: (fromId, profile, url) => {
      const from = tabs.get(fromId)
      const root = from && rootOf(tabs.records, from)
      if (filter !== 'all' && filter !== profile) filter = 'all'
      tabs.create({ profile, url, scope: root?.scope, scopeName: root?.scopeName, app: root?.app })
    },
  })

  downloads = new Downloads({
    onChange: () => sendDownloads(),
    onStarted: (wc) => closeDownloadOnlyTab(wc),
    visible: () => panel.visible,
    window: () => panel.win,
  })

  wireIpc()
  profileDeps = { hooks: tabHooks, pickShareSource: (callback) => void pickShareSource(panel.win, callback), permissions }
  runtimes = await setupProfiles(settings, profileDeps)
  for (const rt of runtimes.values()) attachProfile(rt)

  commands = new ExtensionCommands(() => settings, () => runtimes, {
    save: () => saveSettings(settings),
    openPopup: (profileId, extensionId) => void openActionPopup(profileId, extensionId),
    activeTab: (profileId) => (tabs.active()?.profile === profileId ? (tabs.activeWebContents() ?? undefined) : undefined),
  })
  commands.watch()

  tabs.load()
  // Threads opened from one app carry the name it had in front.
  for (const t of tabs.records) if (t.scope && !t.scope.includes('+') && t.scopeName) apps.note(t.scope, t.scopeName)
  // settings.json may have been edited by hand since: put threads where the links now say.
  rescopeThreads()
  sweep()
  setInterval(sweep, SWEEP_EVERY_MS)
  const first = tabs.active() ?? [...tabs.records].sort((a, b) => b.lastSeen - a.lastSeen)[0]
  if (first) tabs.activate(first.id)
  else tabs.newTab({ profile: settings.defaultProfile })

  registerHotkeys(true)
  if (!BACKGROUND) buildTray()
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
  if (settings.pinned || process.argv.includes('--show')) setTimeout(() => void onHotkey(), 600)
})

app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  tabs?.flush()
})
// jbrow has no windows to close; it quits only from the menu bar item.
app.on('window-all-closed', () => {})
// Pinned, jbrow has a Dock icon; clicking it or ⌘Tabbing to jbrow brings the window back.
app.on('activate', () => {
  if (panel?.pinned && !panel.visible) void panel.show()
})
