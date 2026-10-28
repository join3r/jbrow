import type { ActionId } from './shortcuts'

export interface Profile {
  id: string
  name: string
  color: string
  /** An emoji or a character or two, shown in place of the color dot in the profile switcher. */
  icon?: string
}

/** One tab as persisted. A tab without a parent is a thread; tabs with children are sub-threads. */
export interface TabRecord {
  id: string
  profile: string
  /** Only in tabs saved while tabs nested in threads; flatten() lifts them out on load. */
  parent?: string
  /** The tab it was opened from by a link or a script, if any. */
  opener?: string
  /** User-given name, shown instead of the page title. */
  name?: string
  kept?: boolean
  /** Folder in the Kept section. Only meaningful on a kept thread. */
  folder?: string
  /** Place among the items next to it in Kept (see Folder.order), or among the pinned tabs. Only meaningful on a kept thread. */
  order?: number
  /**
   * The page a kept or pinned tab was kept on, as Arc's pinned URL: closing the tab takes it back
   * there, and the sidebar shows when it's somewhere else. Set when the tab is kept.
   */
  home?: { url: string; title: string; favicon?: string }
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
  /** ID of the extension that opened it (chrome.tabs.create), as Stem does. */
  openedBy?: string
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
  /** Its page is open. A kept tab you closed has none until you open it again. */
  loaded: boolean
  /** Its page crashed and hasn't been reloaded. */
  crashed?: boolean
  /** ID of the extension working in its page now (its chrome.debugger is attached). */
  drivenBy?: string
  /** Its page is making sound right now. */
  audible?: boolean
  /** Its page's sound is muted. */
  muted?: boolean
}

/**
 * What one pane's address bar shows: the active tab's, or each tab of its split. The active
 * tab's bar has the rest of UiState besides; the others are drawn from this alone.
 */
export interface PaneBar {
  id: string
  /** For its <browser-action> buttons. Null for a new tab with no page yet. */
  webContentsId: number | null
  /** Session partition of the tab's profile. */
  partition: string | null
  /** Extensions with a toolbar button in the tab's profile. */
  extensions: string[]
  canGoBack: boolean
  loading: boolean
  /** The lock: a trusted https page, one with a certificate error or over plain http, or neither (jbrow's own pages, local files). */
  lock: 'secure' | 'warn' | null
  /** The color the bar takes from the page, as #rrggbb; null keeps jbrow's surface. */
  color: string | null
}

export interface UiState {
  tabs: UiTab[]
  activeId: string | null
  /** The address bars on screen, one per pane, left to right. */
  panes: PaneBar[]
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
  /** Names and icons of the extensions in tabs' openedBy and drivenBy, by ID. */
  tabExtensions: Record<string, { name: string; icon?: string }>
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
  /** Whether the claude and codex commands are installed; null until jbrow has looked. */
  restyleAgents: Record<RestyleAgent, boolean | null>
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

/** The profile switcher above the tabs: labels, then icons, as room allows (auto), or always a menu. */
export type ProfileSwitcher = 'auto' | 'menu'

/** The settings the settings screen edits. Everything else stays in settings.json. */
export interface Prefs {
  appearance: Appearance
  theme: ThemeId
  profileStyle: ProfileStyle
  profileSwitcher: ProfileSwitcher
  animation: { style: AnimMessage['style']; durationMs: number; ease: AnimMessage['ease'] }
  /** Playful animations in jbrow's own UI. */
  whimsy: boolean
  /** Addresses matching one of these show as "Private" until clicked. `*` matches anything. */
  privateUrls: string[]
  /** Sites per profile ID that always open in that profile. */
  profileSites: Record<string, string[]>
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
  /** Where ⌘1 starts: the pinned icons, the Kept rows, or Today, skipping the sections above. */
  numberFrom: NumberFrom
  /** Where new tabs go outside Kept, and so which tab closing one moves to. */
  newTabsAt: NewTabsAt
  /** App sections at the bottom of the sidebar that are open, by scope key. The rest are collapsed. */
  openApps: string[]
  /** Restyling is on (see RestyleSettings.enabled). */
  restyleEnabled: boolean
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
  /** How the address bar lays out its suggestions (see URL_BAR_STYLES). */
  urlBarStyle: UrlBarStyle
  /** Check for, download and install new releases on its own. */
  autoUpdate: boolean
}

/** Where updating stands, for settings. */
export interface UpdateView {
  /** The version running now. */
  version: string
  /**
   * 'source': running from a checkout. 'local': a build made on this Mac, which doesn't update.
   * 'idle': hasn't checked yet, or a quiet check failed. 'latest': no newer release.
   */
  state: 'source' | 'local' | 'idle' | 'checking' | 'downloading' | 'ready' | 'latest' | 'error'
  /** Of the download, 0–100. */
  percent: number
  /** The release being downloaded or ready. */
  newVersion: string
  /** Why the last check you asked for failed. */
  error: string
  /** When a check last got an answer, 0 for never. */
  checkedAt: number
}

/** The first sidebar section ⌘1–9 count from. */
export type NumberFrom = 'pinned' | 'kept' | 'today'

/** Where new tabs go in the sidebar outside Kept. Closing a tab focuses the one beside it on that side. */
export type NewTabsAt = 'top' | 'bottom'

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
  /** A request an agent is working on now, with the agent's name and what it's doing ("working on “…”"). */
  running: { prompt: string; startedAt: number; agent: string; doing: string } | null
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

/** An extension in a profile, for the Extensions settings. */
export interface ExtensionView {
  profile: string
  id: string
  name: string
  version: string
  description: string
  /** Data URL. */
  icon?: string
  enabled: boolean
  /** Loaded from a folder you chose, rather than installed from the Chrome Web Store. */
  unpacked: boolean
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

/**
 * Layouts for the address bar's suggestions. 'columns': the site you're typing on a card, searches
 * under it, then history and your tabs side by side. 'preview': one list, with the highlighted
 * row's details and tools beside it.
 */
export const URL_BAR_STYLES = ['columns', 'preview'] as const
export type UrlBarStyle = (typeof URL_BAR_STYLES)[number]

/**
 * What jbrow knows about the site behind an address bar suggestion, for the preview layout's
 * "Site" details. All of it comes from this machine: the system's DNS and the certificates the
 * profile was shown this run. Nothing is looked up for a private address. Room for later:
 * registrar, domain age and location, which need a lookup service.
 */
export interface SiteInfoReply {
  /** The request's seq, so the UI can drop an answer to a row it has moved off. */
  seq: number
  url: string
  /** Host name without the port, '' for an address without one. */
  host: string
  /** 'https', 'http', or another scheme without its colon (about, file, chrome-extension…). */
  scheme: string
  /** The address matches a private address pattern, so nothing was looked up and nothing else is filled in. */
  private: boolean
  /** The address the system's DNS gives for the host. Missing when it didn't resolve or wasn't looked up. */
  ip?: string
  /** The IP address is this machine or the local network (loopback, 10/8, 172.16/12, 192.168/16, link-local, fc00::/7). */
  local?: boolean
  /** Missing for private addresses and anything that isn't http or https. */
  cert?: SiteCert
}

/**
 * The site's certificate as the profile last saw it this run. 'valid': Chromium accepted it.
 * 'error': it didn't (see `error`). 'unknown': jbrow hasn't connected to the host this run, and
 * won't just to find out. 'none': plain http, no certificate.
 */
export interface SiteCert {
  state: 'valid' | 'error' | 'unknown' | 'none'
  /** Chromium's error without net::ERR_, such as CERT_DATE_INVALID or CERT_AUTHORITY_INVALID. */
  error?: string
  /** Who signed it: the issuer's common name, or its organization. */
  issuer?: string
  /** When it expires, in ms. */
  validTo?: number
  /** Whole days until it expires; negative once it has. */
  daysLeft?: number
  /** You chose to go ahead despite the error. */
  trusted?: boolean
}
