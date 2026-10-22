import type { Folder, TabRecord } from './types'

/** Threads unseen this long move to the Earlier section. */
export const EARLIER_AFTER_MS = 12 * 60 * 60 * 1000

export interface ThreadView<T extends TabRecord> {
  root: T
  /** Every tab in the thread, root first, depth-first. */
  all: T[]
  lastSeen: number
  /** Most recently seen tab in the thread. */
  last: T
}

export function childrenOf<T extends TabRecord>(tabs: T[], id: string): T[] {
  return tabs.filter((t) => t.parent === id).sort((a, b) => a.createdAt - b.createdAt)
}

export function subtree<T extends TabRecord>(tabs: T[], tab: T): T[] {
  return [tab, ...childrenOf(tabs, tab.id).flatMap((c) => subtree(tabs, c))]
}

export function rootOf<T extends TabRecord>(tabs: T[], tab: T): T {
  const byId = new Map(tabs.map((t) => [t.id, t]))
  let r = tab
  while (r.parent && byId.has(r.parent)) r = byId.get(r.parent)!
  return r
}

export function isRoot(tabs: TabRecord[], tab: TabRecord): boolean {
  return !tab.parent || !tabs.some((t) => t.id === tab.parent)
}

export interface FolderView<T extends TabRecord> {
  folder: Folder
  threads: ThreadView<T>[]
}

export interface AppView<T extends TabRecord> {
  /** Scope key: a bundle ID, or a linked group. */
  scope: string
  name: string
  threads: ThreadView<T>[]
  /** Threads unseen 12 h+, shown dimmed at the end of the app's section. */
  earlier: ThreadView<T>[]
}

export interface Sections<T extends TabRecord> {
  /** Folders in the Kept section, oldest first. */
  folders: FolderView<T>[]
  /** Kept threads outside any folder. */
  kept: ThreadView<T>[]
  today: ThreadView<T>[]
  /** One section per app, by name, for threads that aren't kept. Empty while showing one app. */
  apps: AppView<T>[]
  earlier: ThreadView<T>[]
}

/**
 * Threads in sidebar order. The order is stable (by creation time) so that
 * ⌘1–9 don't shift as you switch. The active thread never counts as Earlier.
 * `appNames` names app sections by scope key; main and the UI must pass the same names, as
 * they order the sections and so the ⌘ numbers.
 */
export function sections<T extends TabRecord>(
  tabs: T[],
  opts: {
    filter: string
    scope: string | null
    activeId: string | null
    now: number
    folders: Folder[]
    appNames?: Record<string, string>
  },
): Sections<T> {
  const views = tabs
    .filter((t) => isRoot(tabs, t))
    .filter((r) => opts.filter === 'all' || r.profile === opts.filter)
    .filter((r) => !opts.scope || r.scope === opts.scope)
    .map((root) => {
      const all = subtree(tabs, root)
      const last = all.reduce((a, b) => (b.lastSeen > a.lastSeen ? b : a))
      return { root, all, last, lastSeen: last.lastSeen }
    })
    .sort((a, b) => a.root.createdAt - b.root.createdAt)
  const isActive = (v: ThreadView<T>) => v.all.some((t) => t.id === opts.activeId)
  const old = (v: ThreadView<T>) => opts.now - v.lastSeen > EARLIER_AFTER_MS && !isActive(v)
  const folderIds = new Set(opts.folders.map((f) => f.id))
  const inFolder = (v: ThreadView<T>) => !!v.root.folder && folderIds.has(v.root.folder)
  // Showing one app, its threads are the whole list; otherwise each app gets its own section.
  const inApp = (v: ThreadView<T>) => !opts.scope && !!v.root.scope
  const loose = views.filter((v) => !v.root.kept && !inApp(v))
  const apps = new Map<string, AppView<T>>()
  for (const v of views.filter((v) => !v.root.kept && inApp(v))) {
    const key = v.root.scope!
    let app = apps.get(key)
    if (!app) apps.set(key, (app = { scope: key, name: opts.appNames?.[key] || v.root.scopeName || key, threads: [], earlier: [] }))
    ;(old(v) ? app.earlier : app.threads).push(v)
  }
  return {
    folders: [...opts.folders]
      .sort((a, b) => a.createdAt - b.createdAt)
      .map((folder) => ({ folder, threads: views.filter((v) => v.root.kept && v.root.folder === folder.id) })),
    kept: views.filter((v) => v.root.kept && !inFolder(v)),
    today: loose.filter((v) => !old(v)),
    apps: [...apps.values()].sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope)),
    earlier: loose.filter((v) => old(v)),
  }
}

/** Thread roots in the order ⌘1–9 address them. Threads in collapsed folders don't count. */
export function numberedThreads<T extends TabRecord>(s: Sections<T>): ThreadView<T>[] {
  const foldered = s.folders.filter((f) => !f.folder.collapsed).flatMap((f) => f.threads)
  return [...foldered, ...s.kept, ...s.today, ...s.apps.flatMap((a) => a.threads)].slice(0, 9)
}

export const displayName = (t: TabRecord) => t.name || t.title || (t.url ? t.url : 'New tab')
