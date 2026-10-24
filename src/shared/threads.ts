import type { Folder, TabRecord } from './types'

/** Threads unseen this long move to the Earlier section, unless settings say otherwise. */
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

export function isRoot(tabs: TabRecord[], tab: TabRecord): boolean {
  return !tab.parent || !tabs.some((t) => t.id === tab.parent)
}

/**
 * Every thread in `tabs`, each with its tabs root first and depth-first as `subtree` gives them.
 * One pass over the list, for lists too long to search once per thread (thousands of archived tabs).
 */
export function threadsOf<T extends TabRecord>(tabs: T[]): { root: T; all: T[] }[] {
  const ids = new Set(tabs.map((t) => t.id))
  const kids = new Map<string, T[]>()
  for (const t of tabs) {
    if (!t.parent || !ids.has(t.parent)) continue
    const list = kids.get(t.parent)
    if (list) list.push(t)
    else kids.set(t.parent, [t])
  }
  const walk = (t: T): T[] => [t, ...(kids.get(t.id) ?? []).sort((a, b) => a.createdAt - b.createdAt).flatMap(walk)]
  return tabs.filter((t) => !t.parent || !ids.has(t.parent)).map((root) => ({ root, all: walk(root) }))
}

/**
 * Lifts every tab out of the thread it was in, for tabs saved while tabs nested under the tab that
 * opened them. Each takes its thread's app section and, in Kept, a place right after its thread's
 * first tab, in the same folder. A pinned thread's other tabs go to the bottom of Kept, as a pinned
 * tab is an icon of its own. Returns whether anything changed.
 */
export function flatten<T extends TabRecord>(tabs: T[]): boolean {
  let changed = false
  for (const { root, all } of threadsOf(tabs)) {
    const rest = all.slice(1)
    rest.forEach((t, i) => {
      t.parent = undefined
      t.scope = root.scope
      t.scopeName = root.scopeName
      t.app = root.app
      t.kept = root.kept
      t.folder = root.pinned ? undefined : root.folder
      t.order = root.kept && !root.pinned && root.order !== undefined ? root.order + (i + 1) / (rest.length + 1) : undefined
      t.pinned = undefined
      changed = true
    })
    if (root.parent) {
      root.parent = undefined
      changed = true
    }
  }
  return changed
}

export interface FolderView<T extends TabRecord> {
  folder: Folder
  threads: ThreadView<T>[]
  /** Folders inside this one. */
  folders: FolderView<T>[]
  /** Its folders and threads together, in the order they were arranged. */
  items: KeptItem<T>[]
}

/** A folder or thread in Kept. */
export type KeptItem<T extends TabRecord> = FolderView<T> | ThreadView<T>

export const isFolder = <T extends TabRecord>(item: KeptItem<T>): item is FolderView<T> => 'folder' in item

/** Sorts Kept items by their place. Items without one yet go last, in the order they came. */
export const byOrder = (a: { order?: number }, b: { order?: number }) => (a.order ?? Number.MAX_VALUE) - (b.order ?? Number.MAX_VALUE)

const placeOf = <T extends TabRecord>(item: KeptItem<T>) => (isFolder(item) ? item.folder : item.root)

/** Folders and threads in the order they were arranged; folders first where neither has a place yet. */
const arranged = <T extends TabRecord>(folders: FolderView<T>[], threads: ThreadView<T>[]): KeptItem<T>[] =>
  [...folders, ...threads].sort((a, b) => byOrder(placeOf(a), placeOf(b)))

/**
 * The folder a folder sits in, or undefined at the top of Kept. A folder whose parent is gone, or
 * that would end up inside itself, sits at the top.
 */
export function parentFolder(folders: Folder[], f: Folder): string | undefined {
  return f.parent && folders.some((x) => x.id === f.parent) && !isInFolder(folders, f.parent, f.id) ? f.parent : undefined
}

/** A folder and every folder inside it, parents before children. */
export function flatFolders<T extends TabRecord>(views: FolderView<T>[]): FolderView<T>[] {
  return views.flatMap((v) => [v, ...flatFolders(v.folders)])
}

/** Threads in a folder and every folder inside it. */
export function folderThreads<T extends TabRecord>(v: FolderView<T>): ThreadView<T>[] {
  return flatFolders([v]).flatMap((f) => f.threads)
}

/** Whether `id` is `ancestor` or sits somewhere inside it. */
export function isInFolder(folders: Folder[], id: string, ancestor: string): boolean {
  const seen = new Set<string>()
  for (let f = folders.find((x) => x.id === id); f && !seen.has(f.id); f = folders.find((x) => x.id === f!.parent)) {
    if (f.id === ancestor) return true
    seen.add(f.id)
  }
  return false
}

export interface AppView<T extends TabRecord> {
  /** Scope key: a bundle ID, or a linked group. */
  scope: string
  name: string
  threads: ThreadView<T>[]
  /** Threads unseen for a while, shown dimmed at the end of the app's section. */
  earlier: ThreadView<T>[]
}

export interface Sections<T extends TabRecord> {
  /** Pinned threads, the icons at the top of the sidebar, in their order. They show whichever app the list is narrowed to. */
  pinned: ThreadView<T>[]
  /** Top-level folders in the Kept section. */
  folders: FolderView<T>[]
  /** Kept threads outside any folder. */
  kept: ThreadView<T>[]
  /** The top of Kept: its folders and threads together, in the order they were arranged. */
  top: KeptItem<T>[]
  today: ThreadView<T>[]
  /** One section per app, by name, for threads that aren't kept. Empty while showing one app. */
  apps: AppView<T>[]
  earlier: ThreadView<T>[]
}

/**
 * Threads in sidebar order. Each is a single tab now; the name stays from when tabs nested. Outside
 * Kept the newest tab comes first, as in Arc, and the order is by creation time so that ⌘1–9
 * don't shift as you switch. The active thread never counts as Earlier.
 * `appNames` names app sections by scope key; main and the UI must pass the same names and
 * `earlierAfterMs`, as they order the sections and so the ⌘ numbers.
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
    /** Threads unseen this long move to Earlier. Main and the UI must pass the same value, as it orders the ⌘ numbers. */
    earlierAfterMs?: number
  },
): Sections<T> {
  const views = tabs
    .filter((t) => isRoot(tabs, t))
    .filter((r) => opts.filter === 'all' || r.profile === opts.filter)
    .filter((r) => !opts.scope || r.scope === opts.scope || isPinned(r))
    .map((root) => {
      const all = subtree(tabs, root)
      const last = all.reduce((a, b) => (b.lastSeen > a.lastSeen ? b : a))
      return { root, all, last, lastSeen: last.lastSeen }
    })
    .sort((a, b) => a.root.createdAt - b.root.createdAt)
  const isActive = (v: ThreadView<T>) => v.all.some((t) => t.id === opts.activeId)
  const old = (v: ThreadView<T>) => opts.now - v.lastSeen > (opts.earlierAfterMs ?? EARLIER_AFTER_MS) && !isActive(v)
  const folderIds = new Set(opts.folders.map((f) => f.id))
  const inFolder = (v: ThreadView<T>) => !!v.root.folder && folderIds.has(v.root.folder)
  // Showing one app, its threads are the whole list; otherwise each app gets its own section.
  const inApp = (v: ThreadView<T>) => !opts.scope && !!v.root.scope
  const newest = [...views].reverse()
  const loose = newest.filter((v) => !v.root.kept && !inApp(v))
  const kept = views.filter((v) => v.root.kept && !v.root.pinned)
  const apps = new Map<string, AppView<T>>()
  for (const v of newest.filter((v) => !v.root.kept && inApp(v))) {
    const key = v.root.scope!
    let app = apps.get(key)
    if (!app) apps.set(key, (app = { scope: key, name: opts.appNames?.[key] || v.root.scopeName || key, threads: [], earlier: [] }))
    ;(old(v) ? app.earlier : app.threads).push(v)
  }
  const byAge = [...opts.folders].sort((a, b) => a.createdAt - b.createdAt)
  const folderView = (folder: Folder): FolderView<T> => {
    const threads = kept.filter((v) => v.root.folder === folder.id).sort((a, b) => byOrder(a.root, b.root))
    const folders = byAge.filter((f) => parentFolder(opts.folders, f) === folder.id).sort(byOrder).map(folderView)
    return { folder, threads, folders, items: arranged(folders, threads) }
  }
  const folders = byAge.filter((f) => !parentFolder(opts.folders, f)).sort(byOrder).map(folderView)
  const top = kept.filter((v) => !inFolder(v)).sort((a, b) => byOrder(a.root, b.root))
  return {
    pinned: views.filter((v) => isPinned(v.root)).sort((a, b) => byOrder(a.root, b.root)),
    folders,
    kept: top,
    top: arranged(folders, top),
    today: loose.filter((v) => !old(v)),
    apps: [...apps.values()].sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope)),
    earlier: loose.filter((v) => old(v)),
  }
}

/** Kept threads in sidebar order, those in folders included. With `skipCollapsed`, not those in collapsed folders. */
export function keptThreads<T extends TabRecord>(s: Sections<T>, { skipCollapsed = false } = {}): ThreadView<T>[] {
  const shown = (items: KeptItem<T>[]): ThreadView<T>[] =>
    items.flatMap((i) => (!isFolder(i) ? [i] : skipCollapsed && i.folder.collapsed ? [] : shown(i.items)))
  return shown(s.top)
}

/** Thread roots in the order ⌘1–9 address them, as the sidebar lists them: pinned first. Threads in collapsed folders don't count. */
export function numberedThreads<T extends TabRecord>(s: Sections<T>): ThreadView<T>[] {
  return [...s.pinned, ...keptThreads(s, { skipCollapsed: true }), ...s.today, ...s.apps.flatMap((a) => a.threads)].slice(0, 9)
}

/**
 * Whether a thread (root first, as `subtree` gives it) is asleep: unseen for `afterMs` or longer, so
 * its pages are unloaded and the sidebar shows it as a one-line summary. Kept threads and the
 * active thread never sleep; 0 turns sleeping off.
 */
export function isAsleep(all: TabRecord[], opts: { now: number; afterMs: number; activeId: string | null }): boolean {
  if (opts.afterMs <= 0 || !all.length || all[0].kept || all.some((t) => t.id === opts.activeId)) return false
  return opts.now - Math.max(...all.map((t) => t.lastSeen)) >= opts.afterMs
}

/** A pinned thread's root. Pinning keeps a thread, so one that somehow lost `kept` isn't pinned either. */
export const isPinned = (t: TabRecord) => !!t.pinned && !!t.kept

export const displayName = (t: TabRecord) => t.name || t.title || (t.url ? t.url : 'New tab')

/** For telling the same page apart from another: no #fragment or trailing slash. */
export const samePage = (url: string) => url.replace(/#.*$/, '').replace(/\/$/, '')

/** A kept or pinned tab is on another page than the one it was kept on, as Arc marks with a slash. */
export const awayFromHome = (t: TabRecord) => !!t.kept && !!t.home && !!t.url && samePage(t.url) !== samePage(t.home.url)
