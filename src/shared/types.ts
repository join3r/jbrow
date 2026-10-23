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
}

export interface UiTab extends TabRecord {
  loading: boolean
}

export interface UiState {
  tabs: UiTab[]
  activeId: string | null
  folders: Folder[]
  /** Tabs of archived threads, for finding them from the address bar. */
  archived: TabRecord[]
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
  /** Restyling of the active tab's site. Null when its page isn't a website. */
  restyle: RestyleView | null
  /** The active tab's certificate. Null for pages not loaded over https. */
  cert: CertView | null
  /** Every site with a restyle, for the settings screen. */
  styledSites: StyledSite[]
  nav: { canGoBack: boolean; canGoForward: boolean; loading: boolean }
  /** The key of each of jbrow's own commands, '' for none. */
  keys: Record<ActionId, string>
  prefs: Prefs
  now: number
}

/** The settings the settings screen edits. Everything else stays in settings.json. */
export interface Prefs {
  animation: { style: AnimMessage['style']; durationMs: number; ease: AnimMessage['ease'] }
  /** Addresses matching one of these show as "Private" until clicked. `*` matches anything. */
  privateUrls: string[]
  hideFromScreenCapture: boolean
  /** Threads unseen this many days unload their pages and show as one line. 0 never does. */
  summarizeAfterDays: number
  /** Threads unseen this many days are archived. 0 never archives. */
  archiveAfterDays: number
  pinnedExtensions: string[]
  /** Claude model alias for restyling sites. */
  restyleAgent: RestyleAgent
  restyleModel: string
  restyleCodexModel: string
  /** Profile for links from other apps and new tabs when nothing else decides. */
  defaultProfile: string
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
