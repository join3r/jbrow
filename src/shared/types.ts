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
  pinned: boolean
  nav: { canGoBack: boolean; canGoForward: boolean; loading: boolean }
  prefs: Prefs
  now: number
}

/** The settings the settings screen edits. Everything else stays in settings.json. */
export interface Prefs {
  animation: { style: AnimMessage['style']; durationMs: number; ease: AnimMessage['ease'] }
  /** Addresses matching one of these show as "Private" until clicked. `*` matches anything. */
  privateUrls: string[]
  hideFromScreenCapture: boolean
  /** Threads unseen this many days are archived. 0 never archives. */
  archiveAfterDays: number
  pinnedExtensions: string[]
}

export interface AnimMessage {
  phase: 'in' | 'out'
  style: 'materialize' | 'slide' | 'scale' | 'fade' | 'off'
  durationMs: number
  ease: 'spring' | 'snappy' | 'smooth'
}
