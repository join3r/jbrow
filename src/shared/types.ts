import type { ActionId } from './shortcuts'

export interface Profile {
  id: string
  name: string
  color: string
}

/** One tab as persisted. A tab without a parent is a thread; tabs with children are sub-threads. */
export interface TabRecord {
  id: string
  profile: string
  parent?: string
  /** User-given name, shown instead of the page title. */
  name?: string
  /** Only meaningful on a thread (a tab without a parent). */
  kept?: boolean
  /** Folder in the Kept section. Only meaningful on a kept thread. */
  folder?: string
  /** Place among the items next to it in Kept (see Folder.order), or among the pinned tabs. Only meaningful on a kept thread. */
  order?: number
  /** Shown as an icon at the top of the sidebar instead of a row in Kept. Only meaningful on a kept thread. */
  pinned?: boolean
  /** App scope key (bundle ID, or a linked group) this thread belongs to. */
  scope?: string
  scopeName?: string
  /** Bundle ID of the app the thread was opened from, so it goes back there if that app is unlinked. */
  app?: string
  /** Empty for a new tab that hasn't navigated yet. */
  url: string
  title: string
  favicon?: string
  createdAt: number
  lastSeen: number
  unread?: boolean
  /** Set on every tab of an archived thread. */
  archivedAt?: number
  /** When Undo brought the thread back. Archiving counts it as seen then, so it gets its full time again. */
  restoredAt?: number
}

/** A folder in the Kept section. */
export interface Folder {
  id: string
  name: string
  /** The folder this one sits in. None for a folder at the top of Kept. */
  parent?: string
  /** Address patterns, as for private addresses. A thread about to be archived that matches moves here instead. */
  rules: string[]
  collapsed?: boolean
  createdAt: number
  /** Place in Kept, among folders and the kept threads outside any folder. Lower comes first. */
  order?: number
}

/** Tabs shown side by side, left to right. The active tab's split is on screen, with it focused. */
export interface Split {
  id: string
  tabs: string[]
  /** Each pane's share of the width, in the order of `tabs`. */
  sizes: number[]
}

export interface UiTab extends TabRecord {
  loading: boolean
  /** Its page crashed and hasn't been reloaded. */
  crashed?: boolean
}

export interface UiState {
  tabs: UiTab[]
  activeId: string | null
  folders: Folder[]
  splits: Split[]
  /** Threads (root IDs) archived since you last looked, for the sidebar's Undo. */
  archiveNotice: string[] | null
  /** WebContents ID of the active tab, for <browser-action-list>. Null for a new tab with no page yet. */
  activeWebContentsId: number | null
  /** Session partition of the active tab's profile, for <browser-action-list>. */
  activePartition: string | null
  /** Extensions with a toolbar button in the active tab's profile. */
  activeExtensions: string[]
  profiles: Profile[]
  filter: string
  scope: { key: string; name: string } | null
  /** Names and icons of the apps threads belong to, by scope key. */
  apps: Record<string, AppLabel>
  pinned: boolean
  /** The extension side panel next to the page, if one is open for the active tab. */
  sidePanel: SidePanelState | null
  /** Restyling of the active tab's site. Null when its page isn't a website. */
  restyle: RestyleView | null
  /** The active tab's certificate. Null for pages not loaded over https. */
  cert: CertView | null
  /** The active tab's page came over plain http, from somewhere other than this Mac. */
  insecure: boolean
  /** A phishing or malware site the active tab was stopped from opening. */
  danger: DangerView | null
  /** The phishing and malware lists: how many hosts, and when they were last downloaded. */
  dangerLists: { hosts: number; updated: number | null }
  /** Whether this run blocks third-party cookies, which may differ from the setting until a restart. */
  thirdPartyCookiesBlocked: boolean
  /** A site asking the active tab for a username and password. */
  login: LoginView | null
  /** The active tab's page crashed or stopped responding. */
  crash: CrashView | null
  /** The active tab's page asked for a USB, HID, serial or Bluetooth device. */
  devices: DeviceChooserView | null
  /** Every site with a restyle, for the settings screen. */
  styledSites: StyledSite[]
  /** Sites with a zoom of their own, in percent. */
  zoomSites: { site: string; percent: number }[]
  nav: { canGoBack: boolean; canGoForward: boolean; loading: boolean }
  /** The key of each of jbrow's own commands, '' for none. */
  keys: Record<ActionId, string>
  prefs: Prefs
  now: number
}

/** Color themes for jbrow's own screens. Each has a light and a dark look, see ui.css. */
export const THEMES = [
  { id: 'teal', name: 'Teal' },
  { id: 'graphite', name: 'Graphite' },
  { id: 'ocean', name: 'Ocean' },
  { id: 'moss', name: 'Moss' },
  { id: 'rose', name: 'Rose' },
  { id: 'ember', name: 'Ember' },
  { id: 'violet', name: 'Violet' },
] as const
export type ThemeId = (typeof THEMES)[number]['id']
/** Light or dark, or whichever macOS is using. Pages see it as prefers-color-scheme too. */
export type Appearance = 'system' | 'light' | 'dark'
/** How the address bar shows the tab's profile: a tint behind back, reload and its name, the tint with a solid edge, or the full color. */
export type ProfileStyle = 'tint' | 'edge' | 'solid'

/** The settings the settings screen edits. Everything else stays in settings.json. */
export interface Prefs {
  appearance: Appearance
  theme: ThemeId
  profileStyle: ProfileStyle
  animation: { style: AnimMessage['style']; durationMs: number; ease: AnimMessage['ease'] }
  /** Addresses matching one of these show as "Private" until clicked. `*` matches anything. */
  privateUrls: string[]
  hideFromScreenCapture: boolean
  /** Warn before opening sites on the phishing and malware lists. */
  dangerousSites: boolean
  /** Block third-party cookies from the next launch on. */
  blockThirdPartyCookies: boolean
  /** Links from other apps you didn't click open in the background. */
  quietLinks: boolean
  /** Threads unseen this many days unload their pages and show as one line. 0 never does. */
  summarizeAfterDays: number
  /** Threads unseen this many days are archived. 0 never archives. */
  archiveAfterDays: number
  /** Kept and pinned threads whose pages stay loaded however long they go unseen. Pinned ones load at launch too. */
  keepLoaded: KeepLoaded
  /** Threads unseen this many hours leave the top of the sidebar for Earlier at the bottom. */
  earlierAfterHours: number
  pinnedExtensions: string[]
  /** Rows the pinned tabs' icons share at the top of the sidebar; drag the line under them to change it. */
  pinnedRows: number
  /** Claude model alias for restyling sites. */
  restyleAgent: RestyleAgent
  restyleModel: string
  restyleCodexModel: string
  /** Profile for links from other apps and new tabs when nothing else decides. */
  defaultProfile: string
  miniPlayer: MiniPlayerPrefs
  /** Page zoom for sites you haven't zoomed, in percent, and whether each site's zoom is kept across restarts. */
  zoom: { defaultPercent: number; remember: boolean }
  /** The search engine's address, %s where the query goes. */
  searchUrl: string
  /** Ask the search engine for suggestions while you type in the address bar. */
  searchSuggestions: boolean
}

/** Which kept threads keep their pages loaded. Pinned threads are kept too, but have their own switch. */
export interface KeepLoaded {
  kept: boolean
  pinned: boolean
}

/** A page from the browsing history, as the address bar suggests it. */
export interface VisitView {
  url: string
  title: string
}

/** The site the address bar completes what's typed to: `text` as it shows, `url` where it goes. */
export interface CompletionView {
  text: string
  url: string
}

/** The address bar's suggestions for what's typed, from main. `seq` matches the request. */
export interface SuggestReply {
  seq: number
  input: string
  visits: VisitView[]
  completion: CompletionView | null
}

/** Search suggestions, which arrive after the rest. */
export interface SearchReply {
  seq: number
  input: string
  searches: string[]
}

/** When a playing video moves into the picture-in-picture window. */
export interface MiniPlayerPrefs {
  /** When jbrow hides or you switch to another app. */
  onHide: boolean
  /** When you switch to another tab; it comes back when you return to the video's tab. */
  onTabSwitch: boolean
  /** Muted videos too, not only ones playing with sound. */
  mutedToo: boolean
  /** Which sites: every one, only those in `onlySites`, or every one but those in `exceptSites`. */
  sites: 'all' | 'only' | 'except'
  /** Address patterns, as for private addresses. Both lists are kept whichever `sites` uses. */
  onlySites: string[]
  exceptSites: string[]
}

/** HTTP basic or digest auth: a site (or proxy) wants a username and password. */
export interface LoginView {
  /** Changes with each new question, so the form can start empty. */
  id: number
  /** With the port when it isn't the usual one. */
  host: string
  realm: string
  proxy: boolean
  /** The username and password just tried were wrong. */
  retry: boolean
}

export type DeviceKind = 'usb' | 'hid' | 'serial' | 'bluetooth'

/** A site asking to connect to a device, with the devices it can pick from. */
export interface DeviceChooserView {
  /** Changes with each request. */
  id: number
  kind: DeviceKind
  /** The site that asked, which may be a frame inside the page. */
  host: string
  /** The page's own site, when a frame from another site asked. */
  embedder?: string
  devices: DeviceChoice[]
}

export interface DeviceChoice {
  id: string
  name: string
  /** Vendor and product IDs, or the port: what tells two of a kind apart. May be ''. */
  detail: string
}

/** A page whose renderer is gone or stuck. */
export interface CrashView {
  /** Electron's render-process-gone reason, e.g. `crashed`, `oom`, `killed`. '' when it's only stuck. */
  reason: string
  /** The page stopped responding but is still there; it may recover. */
  hung: boolean
}

export type DangerKind = 'phishing' | 'malware'

/** A site on the phishing or malware lists that a tab was stopped from opening. */
export interface DangerView {
  url: string
  host: string
  kind: DangerKind
}

/** A site's certificate and what's wrong with it, if anything. */
export interface CertView {
  host: string
  url: string
  /** Why it isn't trusted, e.g. `CERT_DATE_INVALID`. '' when it is. */
  error: string
  /** The page didn't load because of it. */
  blocked: boolean
  /** You chose to go ahead despite the error. */
  trusted: boolean
  /** An error you can't go past, such as a revoked certificate. */
  fatal: boolean
  /** The site's certificate first, then each one that signed it. */
  chain: CertInfo[]
}

export interface CertInfo {
  /** Common name. */
  subject: string
  subjectOrg: string
  issuer: string
  issuerOrg: string
  validFrom: number
  validTo: number
  serial: string
  sha256: string
  /** Names it's valid for (subject alternative names). */
  names: string[]
}

export type RestyleAgent = 'claude' | 'codex'

/** One site's restyle, as the restyle pane shows it. */
export interface RestyleView {
  host: string
  /** What you asked for so far and what the agent said it changed, oldest first. */
  changes: { prompt: string; note: string }[]
  enabled: boolean
  /** A request an agent is working on now, with the agent's name. */
  running: { prompt: string; startedAt: number; agent: string } | null
}

export interface StyledSite {
  host: string
  changes: number
  enabled: boolean
}

export interface AnimMessage {
  phase: 'in' | 'out'
  style: 'materialize' | 'slide' | 'scale' | 'fade' | 'off'
  durationMs: number
  ease: 'spring' | 'snappy' | 'smooth'
}

/** An extension command (chrome.commands) and the shortcut it has in one profile. */
export interface ExtensionShortcut {
  profile: string
  extensionId: string
  extensionName: string
  /** The command's name in the manifest, e.g. `_execute_action`. */
  name: string
  description: string
  /** Electron accelerator, e.g. `Command+Shift+L`. Empty when it has none. */
  shortcut: string
  /** Works while jbrow is hidden. */
  global: boolean
}

/** How an app scope (one app, or a linked group) shows in the sidebar. */
export interface AppLabel {
  name: string
  /** Data URLs of the apps' icons, one per app in the group. */
  icons: string[]
}

/** One row of the Apps list in settings: an app, or apps linked into a group. */
export interface AppEntry {
  key: string
  apps: { bundleId: string; name: string; icon?: string }[]
  /** Profile for the apps' new tabs; '' lets the current tab decide, null when the apps disagree. */
  profile: string | null
  threads: number
}

/** A download, as the toolbar shows it. */
export interface DownloadInfo {
  id: string
  profile: string
  filename: string
  /** Where it's saved. */
  path: string
  url: string
  /** `interrupted`: the connection dropped; resuming tries again. */
  state: 'progressing' | 'paused' | 'interrupted' | 'completed' | 'failed'
  received: number
  /** 0 when the server didn't say. */
  total: number
  bytesPerSecond: number
  startedAt: number
  endedAt?: number
  /** False for apps, installers and scripts: Open shows them in Finder instead of running them. */
  openable: boolean
}

/** An extension's side panel (chrome.sidePanel) as the UI draws its header. */
export interface SidePanelState {
  extensionId: string
  name: string
  /** Data URL of the extension's icon. */
  icon?: string
  /** In pixels, as laid out now. */
  width: number
}

/** User scripts (chrome.userScripts) of one extension and world that a page should run. */
export interface UserScriptInjection {
  extensionId: string
  world: 'MAIN' | 'USER_SCRIPT'
  /** Isolated world number for USER_SCRIPT scripts. */
  worldId: number
  worldName: string
  /** The world's content security policy, from configureWorld. */
  csp?: string
  /** User scripts in this world get chrome.runtime.sendMessage. */
  messaging: boolean
  runAt: 'document_start' | 'document_end' | 'document_idle'
  /** The script's sources, in order. */
  js: { code: string; url?: string }[]
}
