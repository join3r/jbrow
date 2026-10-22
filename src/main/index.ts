import { app, BrowserWindow, clipboard, dialog, globalShortcut, ipcMain, Menu, MenuItem, nativeImage, Notification, session, shell, Tray } from 'electron'
import { ElectronChromeExtensions } from 'electron-chrome-extensions'
import { numberedThreads, rootOf, sections } from '../shared/threads'
import type { Prefs, UiState } from '../shared/types'
import { ExtensionCommands } from './commands'
import { frontmostApp, type FrontApp } from './frontmost'
import { logPath, setupLogging } from './log'
import { Panel } from './panel'
import { SitePermissions } from './permissions'
import { MiniPlayer } from './pip'
import { pickShareSource } from './screenshare'
import { installTestExtensions, loadUnpacked, partitionFor, setupProfiles, type ProfileRuntime, type TabHooks } from './profiles'
import { loadSettings, saveSettings, scopeForApp, settingsPath, type Settings } from './settings'
import { Tabs } from './tabs'

const AWAY_FOCUS_MS = 60 * 1000
const AWAY_FRESH_MS = 4 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
const SWEEP_EVERY_MS = 10 * 60 * 1000

let settings: Settings
let panel: Panel
let tabs: Tabs
let runtimes = new Map<string, ProfileRuntime>()
let tray: Tray | null = null
let commands: ExtensionCommands
/** The settings screen is recording a shortcut: key presses go to it, not to jbrow or extensions. */
let recordingShortcut = false

let filter = 'all'
let scope: { key: string; name: string } | null = null
let lastFront: FrontApp | null = null
let hiddenAt = 0
// The PiP window's "back to tab" brings jbrow back. A page can make its video leave PiP while
// playing too, so it only counts if a click just made jbrow the frontmost app: showing the
// panel takes keyboard focus from whatever you're typing in.
const miniPlayer = new MiniPlayer(async () => {
  if ((await frontmostApp())?.pid === process.pid) void panel.show()
})
/** Display names of apps seen by the app hotkey, keyed by bundle ID. */
const appNames = new Map<string, string>()

// JBROW_USER_DATA=/some/dir runs a separate jbrow with its own tabs, profiles and log, next to
// the one you use. Handy for debugging extensions without touching your real data.
if (process.env.JBROW_USER_DATA) {
  app.setPath('userData', process.env.JBROW_USER_DATA)
  app.setPath('logs', `${process.env.JBROW_USER_DATA}/logs`)
}
setupLogging()
// Utilities that quit apps with no open windows (Vorssaint, for one) will quit jbrow while it's
// hidden. Exclude jbrow in them; this line in the log shows when it happens.
app.on('before-quit', () => console.log('[jbrow] quitting'))

if (!app.requestSingleInstanceLock()) app.quit()

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
    pinned: panel.pinned,
    nav: tabs.navState(),
    prefs: {
      animation: settings.animation,
      privateUrls: settings.privateUrls,
      hideFromScreenCapture: settings.hideFromScreenCapture,
      archiveAfterDays: settings.archiveAfterDays,
      pinnedExtensions: settings.pinnedExtensions,
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
    if (!panel.win.isDestroyed()) panel.win.webContents.send('state', state())
  })
}

/**
 * Keyboard focus lives in one WebContents at a time: a page, or jbrow's UI. Focusing an input
 * inside the UI does nothing until the UI itself has focus, and closing a page leaves focus
 * nowhere, so focus is handed over explicitly.
 */
function focusAddressBar() {
  if (panel.win.isDestroyed()) return
  panel.win.webContents.focus()
  panel.win.webContents.send('focus-omnibox')
}

/** Focus the active page, or the address bar for a new tab. Only while jbrow is on screen. */
function focusActive() {
  if (!panel.visible || panel.win.isDestroyed()) return
  const wc = tabs.activeWebContents()
  if (wc && tabs.active()?.url) wc.focus()
  else focusAddressBar()
}

const toast = (text: string) => {
  if (!panel.win.isDestroyed()) panel.win.webContents.send('toast', text)
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
  return scope ? { scope: scope.key, scopeName: scope.name } : {}
}

function scopeName(front: FrontApp): string {
  const group = settings.linkedApps.find((g) => g.includes(front.bundleId))
  if (!group) return front.name
  return group.map((id) => appNames.get(id) ?? id.split('.').pop() ?? id).join(' + ')
}

function threadsInView() {
  return sections(tabs.records, { filter, scope: scope?.key ?? null, activeId: tabs.activeId, now: Date.now(), folders: tabs.folders })
}

/** Archives stale threads, or files them into folders, per settings. */
const sweep = () => tabs.sweep(settings.archiveAfterDays * DAY_MS)

/** Most recently seen tab among the threads the sidebar currently shows. */
function mostRecentInView(): string | undefined {
  const s = threadsInView()
  const all = [...s.folders.flatMap((f) => f.threads), ...s.kept, ...s.today, ...s.earlier]
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
    appNames.set(front.bundleId, front.name)
  }
  if (!lastFront) return onHotkey()
  const key = scopeForApp(settings, lastFront.bundleId)
  if (panel.visible && scope?.key === key) return panel.hide()
  scope = { key, name: scopeName(lastFront) }
  filter = 'all'
  await summon()
}

function registerHotkeys() {
  const failed: string[] = []
  if (!globalShortcut.register(settings.hotkeys.all, () => void onHotkey())) failed.push(settings.hotkeys.all)
  if (!globalShortcut.register(settings.hotkeys.app, () => void onAppHotkey())) failed.push(settings.hotkeys.app)
  if (failed.length) {
    const text = `Another app is using ${failed.join(' and ')}. Change "hotkeys" in settings.json and restart jbrow.`
    console.error(`[hotkeys] ${text}`)
    new Notification({ title: 'jbrow hotkey unavailable', body: text }).show()
  }
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
  tabs.create({ profile: next, url: cur.url, ...(cur.parent ? {} : { scope: cur.scope, scopeName: cur.scopeName }) })
}

const profileName = (id: string) => settings.profiles.find((p) => p.id === id)?.name ?? id

function onKey(input: Electron.Input): boolean {
  if (input.type !== 'keyDown' || recordingShortcut) return false
  if (commands?.handleKey(tabs.active()?.profile, input)) return true
  const key = input.key.toLowerCase()
  const wc = tabs.activeWebContents()
  if (input.control && key === 'tab') {
    const prev = tabs.previous()
    if (prev) tabs.activate(prev)
    return true
  }
  if (!input.meta) return false
  // Matched by code too, so zoom works on layouts where = and - sit elsewhere or need Shift.
  const zoom =
    key === '=' || key === '+' || input.code === 'Equal' || input.code === 'NumpadAdd' ? 1
    : key === '-' || input.code === 'Minus' || input.code === 'NumpadSubtract' ? -1
    : key === '0' || input.code === 'Numpad0' ? 0
    : null
  if (zoom !== null && !input.alt) {
    if (wc) wc.setZoomLevel(zoom === 0 ? 0 : Math.min(9, Math.max(-8, wc.getZoomLevel() + zoom * 0.5)))
    return true
  }
  if (input.shift) {
    if (key === 'n') {
      const ids = settings.profiles.map((p) => p.id)
      const cur = tabs.active()?.profile ?? settings.defaultProfile
      tabs.create({ profile: ids[(ids.indexOf(cur) + 1) % ids.length], ...scopeFields() })
      focusAddressBar()
      return true
    }
    if (key === 'p') {
      panel.setPinned(!panel.pinned)
      pushState()
      return true
    }
    return false
  }
  if (input.alt && (key === 'i' || input.code === 'KeyI')) {
    wc?.openDevTools({ mode: 'detach' })
    return true
  }
  if (input.alt) return false
  if (/^[1-9]$/.test(key)) {
    openThread(Number(key))
    return true
  }
  switch (key) {
    case 't':
      tabs.newTab({ profile: newTabProfile(), ...scopeFields() })
      focusAddressBar()
      return true
    case 'w': {
      const id = tabs.activeId
      if (id) tabs.close(id)
      if (!tabs.active()) tabs.newTab({ profile: newTabProfile(), ...scopeFields() })
      return true
    }
    case 'l':
      focusAddressBar()
      return true
    case 'r':
      wc?.reload()
      return true
    case '[':
      wc?.navigationHistory.goBack()
      return true
    case ']':
      wc?.navigationHistory.goForward()
      return true
    case ',':
      panel.win.webContents.send('settings', {})
      return true
  }
  return false
}

// ---------- settings screen, extensions, thread menu ----------

function updatePrefs(prefs: Partial<Prefs>) {
  if (prefs.animation) settings.animation = { ...settings.animation, ...prefs.animation }
  if (prefs.privateUrls) settings.privateUrls = prefs.privateUrls.map((p) => p.trim()).filter(Boolean)
  if (prefs.hideFromScreenCapture !== undefined) {
    settings.hideFromScreenCapture = prefs.hideFromScreenCapture
    panel.applyContentProtection()
  }
  if (prefs.archiveAfterDays !== undefined) {
    settings.archiveAfterDays = Math.max(0, prefs.archiveAfterDays)
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

function closeTab(id: string) {
  tabs.close(id)
  if (!tabs.active()) tabs.newTab({ profile: newTabProfile(), ...scopeFields() })
}

function threadMenu(id: string) {
  const rec = tabs.get(id)
  if (!rec) return
  const items: Electron.MenuItemConstructorOptions[] = [
    { label: 'Rename', click: () => panel.win.webContents.send('rename-tab', id) },
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
        ...[...tabs.folders]
          .sort((a, b) => a.createdAt - b.createdAt)
          .map<Electron.MenuItemConstructorOptions>((f) => ({
            label: f.name,
            type: 'checkbox',
            checked: rec.kept && rec.folder === f.id,
            click: () => tabs.move(id, null, true, f.id),
          })),
        ...(rec.kept && rec.folder ? [{ type: 'separator' as const }, { label: 'Out of folder', click: () => tabs.move(id, null, true) }] : []),
      ],
    })
  }
  items.push({ type: 'separator' }, { label: 'Close', accelerator: id === tabs.activeId ? 'Cmd+W' : undefined, click: () => closeTab(id) })
  Menu.buildFromTemplate(items).popup({ window: panel.win })
}

function newTabMenu() {
  Menu.buildFromTemplate(
    settings.profiles.map((p) => ({
      label: `New tab in ${p.name}`,
      click: () => {
        tabs.create({ profile: p.id, ...scopeFields() })
        focusAddressBar()
      },
    })),
  ).popup({ window: panel.win })
}

function newFolder() {
  const folder = tabs.createFolder()
  panel.win.webContents.send('rename-tab', folder.id)
}

function folderMenu(id: string) {
  const folder = tabs.folder(id)
  if (!folder) return
  Menu.buildFromTemplate([
    { label: 'Rename', click: () => panel.win.webContents.send('rename-tab', id) },
    { label: 'Auto-file rules…', click: () => panel.win.webContents.send('folder-rules', id) },
    { type: 'separator' },
    { label: 'New folder', click: () => newFolder() },
    { label: 'Delete folder', click: () => tabs.deleteFolder(id) },
  ]).popup({ window: panel.win })
}

// ---------- extension shortcuts ----------

function sendShortcuts() {
  if (panel.win.isDestroyed()) return
  panel.win.webContents.send('shortcuts', {
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
  panel.win.webContents.send('run-action', extensionId)
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
  selectTab: (wc) => {
    const id = tabs.idForWebContents(wc)
    if (id) tabs.activate(id)
  },
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
  on('ready', () => pushState())
  on<{ id: string }>('activate', ({ id }) => tabs.activate(id))
  on('new', () => {
    tabs.newTab({ profile: newTabProfile(), ...scopeFields() })
    focusAddressBar()
  })
  on<{ input: string }>('navigate', ({ input }) => {
    if (!tabs.active()) tabs.newTab({ profile: newTabProfile(), ...scopeFields() })
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
  on('pin', () => {
    panel.setPinned(!panel.pinned)
    pushState()
  })
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
    else if (action === 'reload') wc.reload()
    else wc.stop()
  })
  on<{ on: boolean }>('overlay', ({ on: covered }) => panel.setOverlay(covered))
  on('hide', () => void panel.hide())
  on('focus-ui', () => panel.win.webContents.focus())
  on('focus-page', () => focusActive())
  on('shortcuts', () => sendShortcuts())
  on<{ on: boolean }>('recording-shortcut', ({ on: recording }) => (recordingShortcut = recording))
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

function buildTray() {
  tray = new Tray(nativeImage.createEmpty())
  tray.setTitle('jb')
  tray.setToolTip('jbrow')
  const menu = () =>
    Menu.buildFromTemplate([
      { label: `Show jbrow (${settings.hotkeys.all})`, click: () => void onHotkey() },
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
          panel.win.webContents.send('settings', { open: true })
        },
      },
      { label: 'Open settings.json', click: () => void shell.openPath(settingsPath()) },
      { label: 'Show log file', click: () => { const f = logPath(); if (f) shell.showItemInFolder(f) } },
      { label: 'Open UI DevTools', click: () => panel.win.webContents.openDevTools({ mode: 'detach' }) },
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
    onHiding: () => void miniPlayer.enter(tabs.activeWebContents()),
    onShown: () => pushState(),
    onHidden: () => {
      hiddenAt = Date.now()
      pushState()
    },
  })
  panel.win.webContents.on('render-process-gone', (_e, details) => console.error('[jbrow] UI renderer gone:', details))
  panel.win.webContents.on('before-input-event', (event, input) => {
    if (onKey(input)) event.preventDefault()
  })

  const permissions = new SitePermissions(() => panel.win)
  tabs = new Tabs({
    window: () => panel.win,
    runtime: (id) => runtimes.get(id),
    contentBounds: () => panel.contentBounds(),
    contentVisible: () => panel.pageVisible(),
    onChange: () => pushState(),
    onActivated: () => focusActive(),
    onKey,
    searchUrl: () => settings.searchUrl,
    permissions,
  })

  wireIpc()
  runtimes = await setupProfiles(settings, tabHooks, (callback) => void pickShareSource(panel.win, callback), permissions)
  // Pin and unpin from the menu an extension's button shows on right-click (see scripts/patch-deps.mjs).
  for (const rt of runtimes.values()) {
    rt.extensions.on('jbrow-action-context-menu', ({ menu, extensionId }: { menu: Menu; extensionId: string }) => {
      const pinned = settings.pinnedExtensions.includes(extensionId)
      menu.append(new MenuItem({ type: 'separator' }))
      menu.append(new MenuItem({ label: pinned ? 'Unpin from toolbar' : 'Pin to toolbar', click: () => togglePinnedExtension(extensionId) }))
    })
  }

  commands = new ExtensionCommands(() => settings, () => runtimes, {
    save: () => saveSettings(settings),
    openPopup: (profileId, extensionId) => void openActionPopup(profileId, extensionId),
    activeTab: (profileId) => (tabs.active()?.profile === profileId ? (tabs.activeWebContents() ?? undefined) : undefined),
  })
  commands.watch()

  tabs.load()
  sweep()
  setInterval(sweep, SWEEP_EVERY_MS)
  const first = tabs.active() ?? [...tabs.records].sort((a, b) => b.lastSeen - a.lastSeen)[0]
  if (first) tabs.activate(first.id)
  else tabs.newTab({ profile: settings.defaultProfile })

  registerHotkeys()
  buildTray()
  // Back from picture-in-picture whenever jbrow is in front again.
  panel.win.on('focus', () => miniPlayer.exit())
  // A pinned jbrow stays on screen behind other apps; its video follows you out anyway.
  app.on('did-resign-active', () => {
    if (panel.pinned && panel.visible) void miniPlayer.enter(tabs.activeWebContents())
  })
  app.on('browser-window-blur', () =>
    panel.checkClickAway(async () => (await frontmostApp())?.pid === process.pid),
  )
  console.log(`[jbrow] ready. ${settings.hotkeys.all} for everything, ${settings.hotkeys.app} for the app in front.`)
  // `npm start -- --install-extensions=personal` installs the test extensions into that profile.
  const installArg = process.argv.find((a) => a.startsWith('--install-extensions='))
  const installInto = installArg && runtimes.get(installArg.split('=')[1])
  if (installInto) {
    const results = await installTestExtensions(installInto)
    console.log(`[extensions] ${installInto.profile.id}:\n  ${results.join('\n  ')}`)
  }
  // `npm start -- --show` summons the panel right away, handy while developing.
  if (process.argv.includes('--show')) setTimeout(() => void onHotkey(), 600)
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
