import { cssEase } from '../shared/ease'
import { urlMatcher } from '../shared/patterns'
import { childrenOf, displayName, folderThreads, isAsleep, numberedThreads, sections, type AppView, type FolderView, type ThreadView } from '../shared/threads'
import { ACTIONS, shortcutFromKey, shortcutLabel, type ActionId } from '../shared/shortcuts'
import type { AnimMessage, AppEntry, CertInfo, DownloadInfo, ExtensionShortcut, Prefs, Profile, UiState, UiTab } from '../shared/types'

declare global {
  interface Window {
    jbrow: {
      on(channel: string, listener: (data: any) => void): void
      send(channel: string, data?: unknown): void
    }
  }
}

/** 24×24 stroke icons. The puzzle, pin, eye, eye-off, folder, store, open, copy, wand, undo, trash, lock, warn, search, user, archive, grid, sparkles, shield and keyboard paths are from Lucide (ISC). */
const ICONS: Record<string, string> = {
  back: '<path d="m15 18-6-6 6-6"/>',
  forward: '<path d="m9 18 6-6-6-6"/>',
  reload: '<path d="M21 12a9 9 0 1 1-2.64-6.36L21 8"/><path d="M21 3v5h-5"/>',
  close: '<path d="M18 6 6 18M6 6l12 12"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  pin: '<path d="M12 17v5"/><path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z"/>',
  puzzle:
    '<path d="M15.39 4.39a1 1 0 0 0 1.68-.474 2.5 2.5 0 1 1 3.014 3.015 1 1 0 0 0-.474 1.68l1.683 1.682a2.414 2.414 0 0 1 0 3.414L19.61 15.39a1 1 0 0 1-1.68-.474 2.5 2.5 0 1 0-3.014 3.015 1 1 0 0 1 .474 1.68l-1.683 1.682a2.414 2.414 0 0 1-3.414 0L8.61 19.61a1 1 0 0 0-1.68.474 2.5 2.5 0 1 1-3.014-3.015 1 1 0 0 0 .474-1.68l-1.683-1.682a2.414 2.414 0 0 1 0-3.414L4.39 8.61a1 1 0 0 1 1.68.474 2.5 2.5 0 1 0 3.014-3.015 1 1 0 0 1-.474-1.68l1.683-1.682a2.414 2.414 0 0 1 3.414 0z"/>',
  settings: '<path d="M20 7h-9M14 17H5"/><circle cx="17" cy="17" r="3"/><circle cx="7" cy="7" r="3"/>',
  eyeOff:
    '<path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.53 13.53 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><path d="m2 2 20 20"/><path d="M14.12 14.12a3 3 0 1 1-4.24-4.24"/>',
  folderPlus:
    '<path d="M12 10v6M9 13h6"/><path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
  folderOpen:
    '<path d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2"/>',
  store: '<path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><path d="M3 6h18"/><path d="M16 10a4 4 0 0 1-8 0"/>',
  pause: '<rect x="14" y="4" width="4" height="16" rx="1"/><rect x="6" y="4" width="4" height="16" rx="1"/>',
  play: '<path d="M6 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L7.5 3.64A1 1 0 0 0 6 4.5z"/>',
  open: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  alert: '<circle cx="12" cy="12" r="10"/><path d="M12 8v4M12 16h.01"/>',
  wand:
    '<path d="m21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72"/><path d="m14 7 3 3"/><path d="M5 6v4"/><path d="M19 14v4"/><path d="M10 2v2"/><path d="M7 8H3"/><path d="M21 16h-4"/><path d="M11 3H9"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  eye: '<path d="M2.06 12.35a1 1 0 0 1 0-.7 10.75 10.75 0 0 1 19.88 0 1 1 0 0 1 0 .7 10.75 10.75 0 0 1-19.88 0"/><circle cx="12" cy="12" r="3"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  warn: '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
  user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  archive: '<rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  grid: '<rect width="7" height="7" x="3" y="3" rx="1"/><rect width="7" height="7" x="14" y="3" rx="1"/><rect width="7" height="7" x="14" y="14" rx="1"/><rect width="7" height="7" x="3" y="14" rx="1"/>',
  sparkles:
    '<path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z"/>',
  shield:
    '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/>',
  keyboard: '<path d="M10 8h.01M12 12h.01M14 8h.01M16 12h.01M18 8h.01M6 8h.01M7 16h10M8 12h.01"/><rect width="20" height="16" x="2" y="4" rx="2"/>',
}
const icon = (name: string) => `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`
document.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => (el.innerHTML = icon(el.dataset.icon!)))

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const root = $('root')
const omnibox = $<HTMLInputElement>('omnibox')
const suggest = $('suggest')
const threadsEl = $('threads')
const snapshot = $<HTMLImageElement>('snapshot')
const actions = $('actions')
const extPop = $('extPop')
const restylePane = $('restylePane')
const restylePrompt = $<HTMLTextAreaElement>('restylePrompt')
const settingsEl = $('settings')
const privateMask = $('privateMask')
const rulesPop = $('rulesPop')
const folderRules = $<HTMLTextAreaElement>('folderRules')
const certPop = $('certPop')
const send = window.jbrow.send

let S: UiState | null = null
let renaming: string | null = null
let dragId: string | null = null
let snapshotTab: string | null = null
let highlighted = 0
let isPrivate: (url: string) => boolean = () => false
let privateKey = ''
/** Folder whose auto-file rules are being edited. */
let rulesFor: string | null = null
/** Profile picked with Tab in the address bar, for what's typed there; null while it's the tab's own. */
let typedProfile: string | null = null
/** Settings is open as its own tab in the sidebar; settingsEl.hidden says whether it's the one showing. */
let settingsTab = false

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const profile = (id: string): Profile | undefined => S?.profiles.find((p) => p.id === id)
const activeTab = () => S?.tabs.find((t) => t.id === S!.activeId)
/** The active tab's address, or the one a bad certificate stopped it from loading. */
const activeUrl = () => (S?.cert?.blocked ? S.cert.url : (activeTab()?.url ?? ''))
/** The address as it may be shown on screen. */
const shownUrl = (url: string) => (isPrivate(url) ? 'Private' : url)
const DAY_MS = 24 * 60 * 60 * 1000
/** A command's key as a menu writes it, '' when it has none. */
const keyLabel = (id: ActionId) => (S?.keys[id] ? shortcutLabel(S.keys[id]) : '')
/** " (⌘T)" for a tooltip. */
const keyHint = (id: ActionId) => (keyLabel(id) ? ` (${keyLabel(id)})` : '')

/** What an asleep thread held, e.g. "4 tabs · github.com, mozilla.org +1 · 5 d". */
function sleepSummary(v: ThreadView<UiTab>, now: number): string {
  const hosts = new Map<string, number>()
  for (const t of v.all) {
    let host = ''
    try {
      if (/^https?:/i.test(t.url)) host = isPrivate(t.url) ? 'Private' : new URL(t.url).hostname.replace(/^www\./, '')
    } catch {}
    if (host) hosts.set(host, (hosts.get(host) ?? 0) + 1)
  }
  const top = [...hosts].sort((a, b) => b[1] - a[1]).map(([h]) => h)
  const sites = top.slice(0, 2).join(', ') + (top.length > 2 ? ` +${top.length - 2}` : '')
  const tabs = v.all.length > 1 ? `${v.all.length} tabs` : ''
  return [tabs, sites, `${Math.floor((now - v.lastSeen) / DAY_MS)} d`].filter(Boolean).join(' · ')
}

// ---------- render ----------

function render() {
  if (!S) return
  const active = activeTab()

  // The dots double as the legend for the colored bars on tab rows.
  const dot = (p: { color?: string }) => (p.color ? `<span class="dot" style="background:${esc(p.color)}"></span>` : '')
  $('filter').innerHTML = [{ id: 'all', name: 'All', color: '' }, ...S.profiles]
    .map((p) => `<button data-filter="${esc(p.id)}" aria-pressed="${S!.filter === p.id}">${dot(p)}${esc(p.name)}</button>`)
    .join('')

  const key = S.prefs.privateUrls.join('\n')
  if (key !== privateKey) {
    privateKey = key
    isPrivate = urlMatcher(S.prefs.privateUrls)
  }

  const p = active && profile(active.profile)
  $<HTMLButtonElement>('back').disabled = !S.nav.canGoBack
  // Forward is rarely possible, so it only takes room when it is.
  $('forward').hidden = !S.nav.canGoForward
  renderProfilePill()
  const reload = $('reload')
  const reloadIcon = S.nav.loading ? 'close' : 'reload'
  if (reload.dataset.icon !== reloadIcon) {
    reload.dataset.icon = reloadIcon
    reload.innerHTML = icon(reloadIcon)
    reload.setAttribute('aria-label', S.nav.loading ? 'Stop' : 'Reload')
  }
  reload.title = S.nav.loading ? 'Stop' : `Reload${keyHint('reload')}`
  $('back').title = `Back${keyHint('back')}`
  $('forward').title = `Forward${keyHint('forward')}`
  $('settingsButton').title = `Settings${keyHint('settings')}`
  $('pin').setAttribute('aria-pressed', String(S.pinned))
  $('pin').title = `${S.pinned ? 'Pinned: a regular window' : 'Pin: keep as a regular window'} with a Dock icon${keyHint('pin')}`
  if (document.activeElement !== omnibox) showAddress()
  $('extHead').textContent = `Extensions · ${p?.name ?? ''}`
  $('newTab').title = `New tab${S.filter !== 'all' ? ` in ${profile(S.filter)?.name ?? S.filter}` : ''}${keyHint('newTab')}, right-click for a profile`
  renderSettings()
  renderDownloadPop()

  if (S.activePartition) actions.setAttribute('partition', S.activePartition)
  if (S.activeWebContentsId != null) actions.setAttribute('tab', String(S.activeWebContentsId))
  else actions.removeAttribute('tab')
  renderPinnedActions()
  renderRestyle()
  renderCert()

  const scope = $('scope')
  scope.hidden = !S.scope
  if (S.scope) scope.innerHTML = `<span>${esc(S.scope.name)} tabs only</span><button data-unscope>Show all</button>`

  renderThreads()

  const blank = !active?.url
  $('blank').hidden = !blank
  if (blank) {
    const opensIn = typedProfile ?? active?.profile
    $('blankProfile').innerHTML = S.profiles
      .map((x) => `<button data-profile="${esc(x.id)}" aria-pressed="${x.id === opensIn}">${dot(x)}${esc(x.name)}</button>`)
      .join('')
    const keys: [string, string][] = [
      [keyLabel('newTab'), 'New tab'],
      [keyLabel('newTabNextProfile'), 'New tab in the next profile'],
      ['Tab', 'Switch the profile a typed address opens in'],
      ['⌘1–9', 'Jump to a thread'],
      [keyLabel('previousTab'), 'Previous tab'],
      [keyLabel('closeTab'), 'Close tab'],
      [keyLabel('pin'), 'Pin the window'],
    ]
    $('blankKeys').innerHTML = keys
      .filter(([k]) => k)
      .map(([k, what]) => `<div><dt>${esc(k)}</dt><dd>${esc(what)}</dd></div>`)
      .join('')
  }
  snapshot.hidden = blank || snapshotTab !== S.activeId || !!S.cert?.blocked
  syncCovering()
}

/**
 * Pinned extensions, as <browser-action> buttons in the toolbar. Only those the current profile
 * has show. The buttons draw from the state the popover's <browser-action-list> loads.
 */
const pinnedEl = $('pinnedActions')
function renderPinnedActions() {
  if (!S) return
  const ids = S.prefs.pinnedExtensions.filter((id) => S!.activeExtensions.includes(id))
  const tab = S.activeWebContentsId != null ? String(S.activeWebContentsId) : '-1'
  const partition = S.activePartition ?? ''
  const current = [...pinnedEl.children].map((b) => b.id)
  if (current.join() !== ids.join()) {
    pinnedEl.innerHTML = ids
      .map((id) => `<button is="browser-action" class="pinned-action" id="${esc(id)}" alignment="bottom left"></button>`)
      .join('')
  }
  pinnedEl.hidden = !ids.length
  for (const b of pinnedEl.children) {
    if (b.getAttribute('partition') !== partition) b.setAttribute('partition', partition)
    if (b.getAttribute('tab') !== tab) b.setAttribute('tab', tab)
  }
}
/** Redraws pinned buttons when an extension changes its icon or badge. */
function refreshPinnedActions() {
  for (const b of pinnedEl.children) b.setAttribute('tab', b.getAttribute('tab') ?? '-1')
}
;(window as unknown as { browserAction?: { addEventListener(name: string, fn: () => void): void } }).browserAction?.addEventListener(
  'update',
  () => queueMicrotask(refreshPinnedActions),
)

/** Fills the address bar while it isn't being edited, masking private addresses. */
/** The address bar's profile: the tab's own, or the one Tab picked for what's being typed. */
function renderProfilePill() {
  const active = activeTab()
  const p = active && profile(typedProfile ?? active.profile)
  const pill = $('profilePill')
  pill.hidden = !p || S!.profiles.length < 2
  if (!p) return
  const other = !!typedProfile && typedProfile !== active.profile && !!active.url
  pill.textContent = p.name
  pill.style.setProperty('--pc', p.color || 'var(--muted)')
  pill.classList.toggle('typed', other)
  pill.title =
    document.activeElement !== omnibox ? `This tab is in the ${p.name} profile`
    : other ? `Opens in a new tab in ${p.name} (Tab to switch)`
    : `Opens in ${p.name} (Tab to switch)`
}

/** Tab and ⇧Tab in the address bar step through the profiles what's typed will open in. */
function cycleTypedProfile(step: number) {
  const active = activeTab()
  if (!S || !active) return
  const ids = S.profiles.map((p) => p.id)
  const i = ids.indexOf(typedProfile ?? active.profile)
  typedProfile = ids[(i + step + ids.length) % ids.length]
  // An empty tab has nothing to lose, so it moves over right away.
  if (!active.url) send('set-profile', { profile: typedProfile })
  render()
}

function showAddress() {
  const url = activeUrl()
  const masked = isPrivate(url)
  omnibox.value = masked ? '' : url
  omnibox.placeholder = masked ? '' : 'Search or type a tab name'
  privateMask.hidden = !masked
}

function renderThreads() {
  if (!S) return
  // Keep a rename in progress across re-renders (titles and loading states update often).
  const renameInput = document.getElementById('ren') as HTMLInputElement | null
  const draft = renameInput ? { value: renameInput.value, start: renameInput.selectionStart, end: renameInput.selectionEnd } : null

  const appNames = Object.fromEntries(Object.entries(S.apps).map(([k, l]) => [k, l.name]))
  const s = sections(S.tabs, { filter: S.filter, scope: S.scope?.key ?? null, activeId: S.activeId, now: S.now, folders: S.folders, appNames })
  const numbered = new Map(numberedThreads(s).map((v, i) => [v.root.id, i + 1]))
  const block = (v: ThreadView<UiTab>) => row(v.root, 0, v, numbered.get(v.root.id))
  // Under its app's heading a thread doesn't need the app's name again.
  const appBlock = (v: ThreadView<UiTab>) => row(v.root, 0, v, numbered.get(v.root.id), false)
  // While filtered to a profile or an app, folders with nothing to show stay out of the way.
  const narrowed = S.filter !== 'all' || !!S.scope
  const folders = s.folders.filter((f) => folderThreads(f).length || !narrowed)
  let html = settingsTab
    ? `<div class="row set-row ${settingsEl.hidden ? '' : 'cur'}" role="button" tabindex="0" data-settings>
        <span class="fav">${icon('settings')}</span><span class="t">Settings</span>
        <span class="end"><button class="act" data-close-settings title="Close" aria-label="Close settings">${icon('close')}</button></span>
      </div>`
    : ''
  html += `<div class="head" data-head="kept"><span>Kept</span><button class="head-act" data-new-folder title="New folder" aria-label="New folder">${icon('folderPlus')}</button></div>`
  html += folders.map((f) => folderRow(f, block, narrowed)).join('') + s.kept.map(block).join('')
  if (!folders.length && !s.kept.length) html += `<div class="empty">Drag a thread here to keep it</div>`
  html += `<div class="head" data-head="today">Today</div>`
  html += s.today.length ? s.today.map(block).join('') : `<div class="empty">Nothing here yet</div>`
  html += s.apps.map((a) => appSection(a, appBlock)).join('')
  if (s.earlier.length) html += `<div class="head" data-head="today">Earlier · unseen 12 h+</div><div class="earlier">${s.earlier.map(block).join('')}</div>`
  threadsEl.innerHTML = html

  const input = document.getElementById('ren') as HTMLInputElement | null
  if (input) {
    if (draft) {
      input.value = draft.value
      input.setSelectionRange(draft.start, draft.end)
    } else input.select()
    input.focus()
  }
}

function appSection(a: AppView<UiTab>, block: (v: ThreadView<UiTab>) => string): string {
  const icons = (S?.apps[a.scope]?.icons ?? []).map((src) => `<img src="${esc(src)}" alt="">`).join('')
  let html = `<div class="head app-head" title="${esc(a.name)}">${icons ? `<span class="app-icons">${icons}</span>` : ''}<span>${esc(a.name)}</span></div>`
  html += a.threads.map(block).join('')
  if (a.earlier.length) html += `<div class="earlier">${a.earlier.map(block).join('')}</div>`
  return html
}

/** A folder's row and, when open, the folders and threads inside it. */
function folderRow(v: FolderView<UiTab>, block: (v: ThreadView<UiTab>) => string, narrowed: boolean): string {
  const f = v.folder
  const count = folderThreads(v).length
  const inner = v.folders.filter((c) => folderThreads(c).length || !narrowed)
  const open = !f.collapsed
  const name =
    renaming === f.id
      ? `<input class="ren" id="ren" value="${esc(f.name)}" aria-label="Folder name">`
      : `<span class="t">${esc(f.name)}</span>`
  const html = `<div class="row frow" role="button" tabindex="0" aria-expanded="${open}" data-folder="${f.id}">
    <span class="fav">${icon(open ? 'folderOpen' : 'folder')}</span>${name}<span class="end"><span class="meta">${count || ''}</span></span>
  </div>`
  const body = inner.map((c) => folderRow(c, block, narrowed)).join('') + v.threads.map(block).join('')
  return open && body ? `${html}<div class="folder-body">${body}</div>` : html
}

const toggleFolder = (id: string) => {
  const f = S?.folders.find((x) => x.id === id)
  if (f) send('folder', { id, collapsed: !f.collapsed })
}

function row(t: UiTab, depth: number, thread: ThreadView<UiTab> | null, number?: number, showApp = true): string {
  if (!S) return ''
  const kids = childrenOf(S.tabs, t.id)
  const open = thread ? thread.all.some((x) => x.id === S!.activeId) : true
  const target = thread && !open ? thread.last.id : t.id
  const asleep = !!thread && isAsleep(thread.all, { now: S.now, afterMs: S.prefs.summarizeAfterDays * DAY_MS, activeId: S.activeId })
  const count = thread && !open && !asleep && thread.all.length > 1 ? String(thread.all.length) : ''
  const app = showApp && depth === 0 && t.scope && !S.scope ? (S.apps[t.scope]?.name ?? t.scopeName ?? '') : ''
  const meta = [app, count].filter(Boolean).join(' · ')
  const key = number ? `⌘${number}` : ''
  const fav = t.favicon ? `<img class="fav" src="${esc(t.favicon)}" alt="">` : `<span class="fav none"></span>`
  const name =
    renaming === t.id
      ? `<input class="ren" id="ren" value="${esc(displayName(t))}" aria-label="Thread name">`
      : `<span class="t" title="${esc(isPrivate(t.url) ? displayName(t) : t.url)}">${esc(displayName(t))}</span>`
  const classes = [
    'row',
    depth > 0 ? 'sub' : '',
    t.id === S.activeId && settingsEl.hidden ? 'cur' : '',
    thread && open ? 'open' : '',
    t.loading ? 'loading' : '',
    t.unread ? 'unread' : '',
    asleep ? 'asleep' : '',
  ].join(' ')
  const color = profile(t.profile)?.color ?? ''
  let html = `<div class="${classes}" role="button" tabindex="0" draggable="true" data-id="${t.id}" data-target="${target}" style="--d:${depth};--pc:${esc(color)}">
    ${fav}${name}<span class="end"><span class="meta">${esc(meta || key)}</span><button class="act" data-close="${t.id}" title="Close" aria-label="Close">${icon('close')}</button></span>
    ${asleep ? `<span class="sum">${esc(sleepSummary(thread!, S.now))}</span>` : ''}
  </div>`
  if (open) html += kids.map((k) => row(k, depth + 1, null)).join('')
  return html
}

// ---------- suggestions ----------

interface Suggestion {
  kind: 'tab' | 'archived' | 'go'
  id?: string
  title: string
  sub: string
  tag: string
  favicon?: string
}

function suggestions(query: string): Suggestion[] {
  if (!S) return []
  const q = query.trim().toLowerCase()
  const tabs = [...S.tabs]
    .filter((t) => t.url && (!q || `${displayName(t)} ${t.title} ${t.url}`.toLowerCase().includes(q)))
    .sort((a, b) => b.lastSeen - a.lastSeen)
    .slice(0, q ? 6 : 8)
    .map<Suggestion>((t) => ({
      kind: 'tab',
      id: t.id,
      title: displayName(t),
      sub: shownUrl(t.url),
      tag: profile(t.profile)?.name ?? t.profile,
      favicon: t.favicon,
    }))
  // Archived threads only turn up when searched for.
  const archived = !q
    ? []
    : S.archived
        .filter((t) => t.url && `${displayName(t)} ${t.title} ${t.url}`.toLowerCase().includes(q))
        .sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
        .slice(0, 4)
        .map<Suggestion>((t) => ({ kind: 'archived', id: t.id, title: displayName(t), sub: shownUrl(t.url), tag: 'archived', favicon: t.favicon }))
  const go: Suggestion[] = q ? [{ kind: 'go', title: looksLikeUrl(q) ? `Go to ${query.trim()}` : `Search for "${query.trim()}"`, sub: '', tag: 'web' }] : []
  // A typed address goes first; a typed word goes after matching tabs.
  return looksLikeUrl(q) ? [...go, ...tabs, ...archived] : [...tabs, ...archived, ...go]
}

const looksLikeUrl = (q: string) => /^[a-z][a-z0-9+.-]*:\/\//i.test(q) || (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/i.test(q) && !q.includes(' '))

let current: Suggestion[] = []
function showSuggestions() {
  current = suggestions(omnibox.value)
  highlighted = 0
  if (!current.length) return hideSuggestions()
  suggest.innerHTML =
    current
      .map(
        (s, i) => `<button class="sg ${i === highlighted ? 'hi' : ''}" data-sg="${i}">
        ${s.favicon ? `<img src="${esc(s.favicon)}" alt="">` : '<span class="fav"></span>'}
        <span class="sg-t">${esc(s.title)}</span><span class="sg-s">${esc(s.sub)}</span><span class="sg-tag">${esc(s.tag)}</span>
      </button>`,
      )
      .join('')
  suggest.hidden = false
  syncOverlay()
}
function hideSuggestions() {
  suggest.hidden = true
  syncOverlay()
}

/** The page hides while anything of jbrow's own covers it; see Panel.setOverlay. */
let overlaySent = false
function syncOverlay() {
  const on = !suggest.hidden || !extPop.hidden || !dlPop.hidden || !certPop.hidden || !settingsEl.hidden
  if (on !== overlaySent) {
    overlaySent = on
    send('overlay', { on })
  }
  syncCovering()
}

/** While jbrow's UI is above a live page, the page area turns clear so the page shows through. */
function syncCovering() {
  root.classList.toggle('covering', overlaySent && !!activeTab()?.url && !S?.cert?.blocked)
}
function moveHighlight(delta: number) {
  if (!current.length) return
  highlighted = (highlighted + delta + current.length) % current.length
  suggest.querySelectorAll('.sg').forEach((el, i) => el.classList.toggle('hi', i === highlighted))
}
function pick(s: Suggestion | undefined) {
  const text = omnibox.value
  hideSuggestions()
  omnibox.blur()
  if (s || text.trim()) showSettings(false)
  if (s?.kind === 'tab' && s.id) send('activate', { id: s.id })
  else if (s?.kind === 'archived' && s.id) send('restore', { id: s.id })
  else if (text.trim()) send('navigate', { input: text, profile: typedProfile ?? undefined })
}

omnibox.addEventListener('focus', () => {
  // Clicking the address bar is how a private address is revealed.
  omnibox.value = activeUrl()
  omnibox.placeholder = 'Search or type a tab name'
  privateMask.hidden = true
  typedProfile = null
  renderProfilePill()
  omnibox.select()
  showSuggestions()
})
omnibox.addEventListener('input', showSuggestions)
omnibox.addEventListener('blur', () => {
  hideSuggestions()
  showAddress()
  if (typedProfile) {
    typedProfile = null
    render()
  } else renderProfilePill()
})
omnibox.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') (e.preventDefault(), moveHighlight(1))
  else if (e.key === 'ArrowUp') (e.preventDefault(), moveHighlight(-1))
  else if (e.key === 'Enter') {
    e.preventDefault()
    // With no suggestion chosen by the arrows, Enter on a typed address or query navigates.
    pick(current[highlighted])
  } else if (e.key === 'Escape') omnibox.blur()
  else if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey && (S?.profiles.length ?? 0) > 1) {
    e.preventDefault()
    cycleTypedProfile(e.shiftKey ? -1 : 1)
  }
})
suggest.addEventListener('mousedown', (e) => e.preventDefault())
suggest.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>('[data-sg]')
  if (el) pick(current[Number(el.dataset.sg)])
})

// ---------- sidebar interaction ----------

threadsEl.addEventListener('click', (e) => {
  const el = e.target as HTMLElement
  if (el.closest('#ren')) return
  const closeBtn = el.closest<HTMLElement>('[data-close]')
  if (closeBtn) return send('close', { id: closeBtn.dataset.close })
  if (el.closest('[data-new-folder]')) return send('new-folder')
  if (el.closest('[data-close-settings]')) return setSettings(false)
  if (el.closest('[data-settings]')) return showSettings(true)
  const folder = el.closest<HTMLElement>('.frow')
  if (folder) return void (!renaming && toggleFolder(folder.dataset.folder!))
  const r = el.closest<HTMLElement>('.row')
  if (r && !renaming) {
    showSettings(false)
    send('activate', { id: r.dataset.target })
  }
})
threadsEl.addEventListener('dblclick', (e) => {
  const r = (e.target as HTMLElement).closest<HTMLElement>('.row:not([data-settings])')
  if (r && !(e.target as HTMLElement).closest('#ren')) startRename(r.dataset.id ?? r.dataset.folder!)
})
threadsEl.addEventListener('contextmenu', (e) => {
  const r = (e.target as HTMLElement).closest<HTMLElement>('.row:not([data-settings])')
  if (!r || (e.target as HTMLElement).closest('#ren')) return
  e.preventDefault()
  if (r.dataset.folder) send('folder-menu', { id: r.dataset.folder })
  else send('thread-menu', { id: r.dataset.id })
})
threadsEl.addEventListener('keydown', (e) => {
  const el = e.target as HTMLElement
  if (el.id === 'ren') {
    if (e.key === 'Enter') commitRename()
    if (e.key === 'Escape') {
      renaming = null
      renderThreads()
    }
    return
  }
  if ((e.key === 'Enter' || e.key === ' ') && el.classList.contains('row')) {
    e.preventDefault()
    if (el.dataset.folder) toggleFolder(el.dataset.folder)
    else if (el.hasAttribute('data-settings')) showSettings(true)
    else {
      showSettings(false)
      send('activate', { id: el.dataset.target })
    }
  }
  if (e.key === 'F2' && el.classList.contains('row') && !el.hasAttribute('data-settings')) startRename(el.dataset.id ?? el.dataset.folder!)
})
threadsEl.addEventListener('focusout', (e) => {
  if ((e.target as HTMLElement).id === 'ren') setTimeout(() => renaming && commitRename(), 0)
})

function startRename(id: string) {
  renaming = id
  // Clicking a row hands focus to its page; typing a name needs it back here.
  focusUi()
  renderThreads()
}

/**
 * Takes keyboard focus back from the page. The address bar must not be what gets it: refocusing
 * it would reveal a private address and open the suggestions.
 */
function focusUi() {
  if (document.activeElement === omnibox) omnibox.blur()
  send('focus-ui')
}
function commitRename() {
  const input = document.getElementById('ren') as HTMLInputElement | null
  const id = renaming
  renaming = null
  if (input && id) {
    if (S?.folders.some((f) => f.id === id)) send('folder', { id, name: input.value })
    else send('rename', { id, name: input.value })
  }
  renderThreads()
}

threadsEl.addEventListener('dragstart', (e) => {
  const r = (e.target as HTMLElement).closest<HTMLElement>('.row')
  if (!r) return
  dragId = r.dataset.id!
  e.dataTransfer!.effectAllowed = 'move'
  e.dataTransfer!.setData('text/plain', dragId)
})
threadsEl.addEventListener('dragover', (e) => {
  if (!dragId) return
  const t = (e.target as HTMLElement).closest<HTMLElement>('.row:not([data-settings]), .head:not(.app-head)')
  if (!t) return
  e.preventDefault()
  if (!t.classList.contains('dz')) {
    threadsEl.querySelectorAll('.dz').forEach((x) => x.classList.remove('dz'))
    t.classList.add('dz')
  }
})
threadsEl.addEventListener('drop', (e) => {
  if (!dragId) return
  e.preventDefault()
  const t = (e.target as HTMLElement).closest<HTMLElement>('.row:not([data-settings]), .head:not(.app-head)')
  const id = dragId
  dragId = null
  threadsEl.querySelectorAll('.dz').forEach((x) => x.classList.remove('dz'))
  if (!t) return
  if (t.classList.contains('head')) send('move', { id, parent: null, kept: t.dataset.head === 'kept' })
  else if (t.dataset.folder) send('move', { id, parent: null, kept: true, folder: t.dataset.folder })
  else if (t.dataset.id !== id) send('move', { id, parent: t.dataset.id })
})
threadsEl.addEventListener('dragend', () => {
  dragId = null
  threadsEl.querySelectorAll('.dz').forEach((x) => x.classList.remove('dz'))
})

// ---------- folder rules popover ----------

function openRules(id: string) {
  const f = S?.folders.find((x) => x.id === id)
  if (!f) return
  closeRules()
  rulesFor = id
  $('rulesHead').textContent = `Auto-file into ${f.name}`
  folderRules.value = f.rules.join('\n')
  // Just under the folder's row, but never off the bottom.
  const sidebar = $('sidebar')
  const folderEl = threadsEl.querySelector(`[data-folder="${id}"]`)
  const top = folderEl ? folderEl.getBoundingClientRect().bottom - sidebar.getBoundingClientRect().top + 4 : 8
  rulesPop.hidden = false
  rulesPop.style.top = `${Math.max(8, Math.min(top, sidebar.clientHeight - rulesPop.offsetHeight - 8))}px`
  focusUi()
  folderRules.focus()
}
function saveRules() {
  const f = S?.folders.find((x) => x.id === rulesFor)
  const rules = folderRules.value.split('\n').map((l) => l.trim()).filter(Boolean)
  if (f && rules.join('\n') !== f.rules.join('\n')) send('folder', { id: f.id, rules })
}
function closeRules() {
  if (rulesPop.hidden) return
  saveRules()
  rulesPop.hidden = true
  rulesFor = null
}
let rulesTimer: number | undefined
folderRules.addEventListener('input', () => {
  clearTimeout(rulesTimer)
  rulesTimer = window.setTimeout(saveRules, 400)
})
document.addEventListener('mousedown', (e) => {
  if (!rulesPop.hidden && !(e.target as HTMLElement).closest('.rules-pop')) closeRules()
})

// ---------- toolbar ----------

$('filter').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-filter]')
  if (b) send('filter', { filter: b.dataset.filter })
})
$('scope').addEventListener('click', (e) => {
  if ((e.target as HTMLElement).closest('[data-unscope]')) send('unscope')
})
$('blankProfile').addEventListener('mousedown', (e) => e.preventDefault())
$('blankProfile').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-profile]')
  if (!b) return
  typedProfile = null
  send('set-profile', { profile: b.dataset.profile })
  omnibox.focus()
})
$('newTab').addEventListener('contextmenu', (e) => {
  e.preventDefault()
  send('new-tab-menu')
})
$('back').addEventListener('click', () => send('nav', { action: 'back' }))
$('forward').addEventListener('click', () => send('nav', { action: 'forward' }))
$('reload').addEventListener('click', () => send('nav', { action: S?.nav.loading ? 'stop' : 'reload' }))
$('pin').addEventListener('click', () => send('pin'))
$('newTab').addEventListener('click', () => send('new'))

// ---------- extensions popover ----------

function setExtensions(open: boolean) {
  if (open === !extPop.hidden) return
  extPop.hidden = !open
  $('extButton').setAttribute('aria-expanded', String(open))
  if (open) {
    focusUi()
    const count = actions.shadowRoot?.querySelectorAll('.action').length ?? 0
    $('extEmpty').hidden = count > 0
  }
  syncOverlay()
}
$('extButton').addEventListener('click', () => setExtensions(!!extPop.hidden))
// An action opens its popup from where its button is; the popover can close right after.
actions.addEventListener('click', () => setExtensions(false))
$('addExtension').addEventListener('click', () => {
  setExtensions(false)
  send('add-extension')
})
$('openStore').addEventListener('click', () => {
  setExtensions(false)
  send('open-store')
})
document.addEventListener('mousedown', (e) => {
  if (!extPop.hidden && !(e.target as HTMLElement).closest('.ext')) setExtensions(false)
})

// ---------- downloads ----------

const dlList = $('dlList')
const dlPop = $('dlPop')
let downloads: DownloadInfo[] = []
let dlOpen: string | null = null

/** Sizes as Finder shows them: 1 KB is 1000 bytes. */
function bytes(n: number): string {
  if (n < 1000) return `${n} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n / 1000
  let i = 0
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i++
  }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`
}

function duration(seconds: number): string {
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} s`
  if (seconds < 3600) return `${Math.round(seconds / 60)} min`
  const h = Math.floor(seconds / 3600)
  const m = Math.round((seconds % 3600) / 60)
  return m ? `${h} h ${m} min` : `${h} h`
}

const finished = (d: DownloadInfo) => d.state === 'completed' || d.state === 'failed'
const fraction = (d: DownloadInfo) => (d.state === 'completed' ? 1 : d.total ? Math.min(1, d.received / d.total) : 0)

/** "12 MB of 40 MB", or just what's arrived when the size is unknown. */
function amount(d: DownloadInfo): string {
  if (d.state === 'completed') return bytes(d.received)
  return d.total ? `${bytes(d.received)} of ${bytes(d.total)}` : bytes(d.received)
}

/** Speed and time left, or how it ended. */
function pace(d: DownloadInfo): string {
  if (d.state === 'completed') return 'Done'
  if (d.state === 'failed') return 'Failed'
  if (d.state === 'paused') return 'Paused'
  if (d.state === 'interrupted') return 'Connection lost'
  if (!d.bytesPerSecond) return 'Starting…'
  const speed = `${bytes(Math.round(d.bytesPerSecond))}/s`
  return d.total ? `${speed} · ${duration((d.total - d.received) / d.bytesPerSecond)} left` : speed
}

function renderDownloads() {
  $('downloads').hidden = !downloads.length
  const ids = new Set(downloads.map((d) => d.id))
  for (const b of [...dlList.children] as HTMLElement[]) if (!ids.has(b.dataset.dl!)) b.remove()
  // Updated in place, so the pies fill smoothly and a click isn't lost to a redraw.
  for (const d of downloads) {
    let b = dlList.querySelector<HTMLButtonElement>(`[data-dl="${d.id}"]`)
    if (!b) {
      b = document.createElement('button')
      b.className = 'icon dl'
      b.dataset.dl = d.id
      dlList.append(b)
    }
    const kind = d.state === 'completed' ? 'check' : d.state === 'failed' ? 'alert' : 'pie'
    if (b.dataset.kind !== kind) {
      b.dataset.kind = kind
      b.innerHTML = kind === 'pie' ? '<span class="pie"></span>' : icon(kind)
    }
    b.dataset.state = d.state
    b.classList.toggle('unknown', kind === 'pie' && !d.total)
    b.style.setProperty('--p', String(fraction(d)))
    const percent = d.total && !finished(d) ? `${Math.floor(fraction(d) * 100)}% · ` : ''
    b.title = `${d.filename} — ${percent}${pace(d)}`
    b.setAttribute('aria-label', b.title)
    b.setAttribute('aria-expanded', String(dlOpen === d.id))
  }
  if (dlOpen && !ids.has(dlOpen)) setDownload(null)
  else renderDownloadPop()
}

function renderDownloadPop() {
  const d = downloads.find((x) => x.id === dlOpen)
  if (!d) return
  dlPop.dataset.state = d.state
  $('dlName').textContent = d.filename
  $('dlBar').style.width = `${(d.total || finished(d) ? fraction(d) : 0) * 100}%`
  $('dlProgress').textContent = amount(d)
  $('dlEta').textContent = pace(d)
  const where = $('dlPath')
  where.textContent = d.path.replace(/^\/Users\/[^/]+/, '~').replace(/\/[^/]*$/, '') || '/'
  where.title = `Show ${d.path} in Finder`
  const from = $('dlFrom')
  from.textContent = shownUrl(d.url)
  from.title = isPrivate(d.url) ? '' : d.url
  $('dlProfile').textContent = profile(d.profile)?.name ?? d.profile
  const running = !finished(d)
  const pause = $('dlPause')
  pause.hidden = !running
  const stopped = d.state === 'paused' || d.state === 'interrupted'
  const pauseIcon = stopped ? 'play' : 'pause'
  if (pause.dataset.icon !== pauseIcon) {
    pause.dataset.icon = pauseIcon
    pause.innerHTML = icon(pauseIcon)
    pause.title = stopped ? 'Resume' : 'Pause'
    pause.setAttribute('aria-label', pause.title)
  }
  $('dlCancel').hidden = !running
  $('dlRetry').hidden = d.state !== 'failed'
  // Apps and scripts only get Show in Finder, so running one is a deliberate step.
  $('dlOpen').hidden = d.state !== 'completed' || !d.openable
}

function setDownload(id: string | null) {
  if (id === dlOpen) return
  // Looking at a finished download is what takes it off the toolbar.
  const prev = downloads.find((d) => d.id === dlOpen)
  if (prev && finished(prev)) send('download', { id: prev.id, action: 'dismiss' })
  dlOpen = id
  dlPop.hidden = !id
  if (id) focusUi()
  renderDownloads()
  syncOverlay()
}

const downloadAction = (action: string) => dlOpen && send('download', { id: dlOpen, action })
dlList.addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('[data-dl]')?.dataset.dl
  if (id) setDownload(dlOpen === id ? null : id)
})
$('dlPause').addEventListener('click', () => downloadAction($('dlPause').dataset.icon === 'play' ? 'resume' : 'pause'))
$('dlCancel').addEventListener('click', () => downloadAction('cancel'))
$('dlRetry').addEventListener('click', () => downloadAction('retry'))
$('dlShow').addEventListener('click', () => downloadAction('show'))
$('dlPath').addEventListener('click', () => downloadAction('show'))
$('dlCopy').addEventListener('click', () => downloadAction('copy-link'))
$('dlOpen').addEventListener('click', () => {
  downloadAction('open')
  setDownload(null)
})
document.addEventListener('mousedown', (e) => {
  if (dlOpen && !(e.target as HTMLElement).closest('.downloads')) setDownload(null)
})

// ---------- restyle pane ----------

let restyleTimer: number | undefined
let restyleShown = ''

const agentName = () => (S?.prefs.restyleAgent === 'codex' ? 'Codex' : 'Claude')

/** The wand's look, and the sidebar pane while it's open. */
function renderRestyle() {
  if (!S) return
  const r = S.restyle
  const button = $<HTMLButtonElement>('restyleButton')
  button.disabled = !r
  button.classList.toggle('styled', !!r && r.enabled && r.changes.length > 0)
  button.classList.toggle('busy', !!r?.running)
  button.title = !r ? 'Restyle: only for websites' : r.running ? `${r.running.agent} is restyling ${r.host}…` : `Restyle ${r.host} with ${agentName()}`
  if (!r) return setRestyle(false)
  if (restylePane.hidden) return
  $('restyleHead').textContent = `Restyle ${r.host}`
  $('restyleHelp').textContent = `↩ sends it to ${agentName()} with a screenshot and an outline of the page. ⇧↩ for a new line.`
  restylePrompt.disabled = !!r.running
  $('restyleRunning').hidden = !r.running
  clearInterval(restyleTimer)
  if (r.running) {
    const { startedAt, prompt, agent } = r.running
    const tick = () => ($('restyleRunText').textContent = `${agent} is working on “${prompt}” · ${Math.round((Date.now() - startedAt) / 1000)} s`)
    tick()
    restyleTimer = window.setInterval(tick, 1000)
  }
  $('restyleHistory').hidden = !r.changes.length
  $('restyleHistory').classList.toggle('off', !r.enabled)
  const list = $('restylePrompts')
  const html = r.changes.map((c) => `<li>${esc(c.prompt)}${c.note ? `<small>${esc(c.note)}</small>` : ''}</li>`).join('')
  // Only on change, so a selection in it survives other updates.
  if (html !== restyleShown) {
    restyleShown = html
    list.innerHTML = html
    list.scrollTop = 1e6
  }
  const toggle = $('restyleToggle')
  toggle.setAttribute('aria-pressed', String(!r.enabled))
  toggle.title = r.enabled ? 'Show the original' : 'Show restyled'
  toggle.setAttribute('aria-label', toggle.title)
}

function setRestyle(open: boolean) {
  if (open === !restylePane.hidden) return
  if (open && !S?.restyle) return
  restylePane.hidden = !open
  $('sidebar').classList.toggle('restyling', open)
  $('restyleButton').setAttribute('aria-expanded', String(open))
  if (open) {
    closeRules()
    renderRestyle()
    focusUi()
    restylePrompt.focus()
  } else {
    clearInterval(restyleTimer)
    restyleShown = ''
  }
}

const restyleSite = (action: 'undo' | 'reset' | 'on' | 'off' | 'cancel') => {
  if (S?.restyle) send('restyle-site', { host: S.restyle.host, action })
}
$('restyleButton').addEventListener('click', () => setRestyle(!!restylePane.hidden))
$('restyleClose').addEventListener('click', () => {
  setRestyle(false)
  send('focus-page')
})
restylePrompt.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.shiftKey || e.isComposing) return
  e.preventDefault()
  const prompt = restylePrompt.value.trim()
  if (!prompt || S?.restyle?.running) return
  restylePrompt.value = ''
  // The pane stays open beside the page, so you can watch it change.
  send('focus-page')
  send('restyle', { prompt })
})
$('restyleCancel').addEventListener('click', () => restyleSite('cancel'))
$('restyleUndo').addEventListener('click', () => restyleSite('undo'))
$('restyleToggle').addEventListener('click', () => restyleSite(S?.restyle?.enabled ? 'off' : 'on'))
$('restyleReset').addEventListener('click', () => restyleSite('reset'))

// ---------- settings ----------

const animSpeed = $<HTMLInputElement>('animSpeed')
const privateUrls = $<HTMLTextAreaElement>('privateUrls')
const hideCapture = $<HTMLInputElement>('hideCapture')
const pinWindow = $<HTMLInputElement>('pinWindow')
const settingsSearch = $<HTMLInputElement>('settingsSearch')
const shortcutSearch = $<HTMLInputElement>('shortcutSearch')
const SECTION_NAMES: Record<string, string> = {
  general: 'General',
  profiles: 'Profiles',
  threads: 'Threads',
  apps: 'Apps',
  animation: 'Animation',
  restyling: 'Restyling',
  privacy: 'Privacy',
  shortcuts: 'Shortcuts',
}
let section = 'general'

/** Opens settings as a tab and shows it, or closes the tab. With a section, opens that one. */
function setSettings(open: boolean, to?: string) {
  if (to) showSection(to)
  settingsTab = open
  if (open === !settingsEl.hidden) renderThreads()
  else showSettings(open)
}

/** Switches between the settings tab and the page, keeping the tab in the sidebar. */
function showSettings(show: boolean) {
  if (show === !settingsEl.hidden || (show && !settingsTab)) return
  settingsEl.hidden = !show
  $('settingsButton').setAttribute('aria-pressed', String(show))
  renderThreads()
  if (show) {
    setExtensions(false)
    focusUi()
    settingsEl.focus()
    renderSettings(true)
    send('shortcuts')
    send('apps')
    send('default-browser')
  } else {
    stopRecording()
    savePrivateUrls()
    send('focus-page')
  }
  syncOverlay()
}

/** Shows one section of settings, ending a search. */
function showSection(id: string) {
  if (!SECTION_NAMES[id]) return
  section = id
  settingsSearch.value = ''
  applySearch()
  $('setBody').scrollTop = 0
}

const matches = (el: Element, q: string) => `${el.textContent} ${(el as HTMLElement).dataset.keywords ?? ''}`.toLowerCase().includes(q)

/**
 * Hides what doesn't match a query. Shortcut lists match row by row, keeping the extension and
 * profile names above any row that's left; the rest match a whole block at a time.
 */
function filterItem(item: HTMLElement, q: string): boolean {
  const rows = [...item.querySelectorAll<HTMLElement>('.sc-row')]
  if (!rows.length || !q) {
    item.querySelectorAll<HTMLElement>('.sc-row, .sc-ext, .sc-profile').forEach((el) => (el.hidden = false))
    item.hidden = !!q && !matches(item, q)
    return !item.hidden
  }
  const head = [...item.querySelectorAll('h3, .help')].map((el) => el.textContent).join(' ')
  const all = `${head} ${item.dataset.keywords ?? ''}`.toLowerCase().includes(q)
  for (const r of rows) r.hidden = !all && !matches(r, q)
  // A heading stays while any row up to the next heading of its rank or higher does.
  const heads = [...item.querySelectorAll<HTMLElement>('.sc-ext, .sc-profile')]
  for (const h of heads) {
    let shown = false
    for (let el = h.nextElementSibling as HTMLElement | null; el; el = el.nextElementSibling as HTMLElement | null) {
      if (el.classList.contains('sc-profile') || (h.classList.contains('sc-ext') && el.classList.contains('sc-ext'))) break
      if (el.classList.contains('sc-row') && !el.hidden) {
        shown = true
        break
      }
    }
    h.hidden = !shown
  }
  item.hidden = !rows.some((r) => !r.hidden)
  return !item.hidden
}

/** Shows the current section, or every match for what's typed in the search. */
function applySearch() {
  const q = settingsSearch.value.trim().toLowerCase()
  const local = shortcutSearch.value.trim().toLowerCase()
  settingsEl.classList.toggle('searching', !!q)
  let first = true
  let any = false
  for (const sec of settingsEl.querySelectorAll<HTMLElement>('.set-section')) {
    const id = sec.dataset.section!
    // Without a search, the shortcuts section's own box narrows its lists.
    const query = q || (id === 'shortcuts' ? local : '')
    let hit = false
    for (const item of sec.querySelectorAll<HTMLElement>('.set-item')) if (filterItem(item, query)) hit = true
    sec.classList.toggle('cur', !q && id === section)
    sec.classList.toggle('match', hit)
    sec.classList.toggle('first', !!q && hit && first)
    if (q && hit) first = false
    any ||= hit
    const nav = $('setNav').querySelector<HTMLElement>(`[data-section="${id}"]`)!
    nav.classList.toggle('dim', !!q && !hit)
    if (!q && id === section) nav.setAttribute('aria-current', 'page')
    else nav.removeAttribute('aria-current')
  }
  $('setTitle').textContent = q ? 'Search' : SECTION_NAMES[section]
  const none = $('setNoMatch')
  none.hidden = !(q ? !any : section === 'shortcuts' && local && !settingsEl.querySelector('.set-section.cur .set-item:not([hidden])'))
  if (!none.hidden) none.textContent = `Nothing matches “${(q ? settingsSearch : shortcutSearch).value.trim()}”.`
}

$('setNav').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-section]')
  if (b) showSection(b.dataset.section!)
})
settingsSearch.addEventListener('input', applySearch)
shortcutSearch.addEventListener('input', applySearch)
// ↩ in the search goes to the first section with a match.
settingsSearch.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return
  const hit = settingsEl.querySelector<HTMLElement>('.set-section.first')
  if (hit) showSection(hit.dataset.section!)
})
applySearch()

/** Updates the controls from state, leaving alone whichever one is being edited. */
function renderSettings(all = false) {
  if (!S || settingsEl.hidden) return
  const { animation, hideFromScreenCapture } = S.prefs
  const seg = (id: string, value: string) =>
    $(id).querySelectorAll<HTMLElement>('[data-value]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === value)))
  seg('animStyle', animation.style)
  seg('animEase', animation.ease)
  seg('summarizeAfter', String(S.prefs.summarizeAfterDays))
  seg('archiveAfter', String(S.prefs.archiveAfterDays))
  seg('restyleAgent', S.prefs.restyleAgent)
  seg('restyleModel', S.prefs.restyleModel)
  const codex = S.prefs.restyleAgent === 'codex'
  $('restyleClaudeModel').hidden = codex
  $('restyleCodexModelField').hidden = !codex
  if (all || document.activeElement !== restyleCodexModel) restyleCodexModel.value = S.prefs.restyleCodexModel
  renderStyledSites()
  renderProfiles()
  if (all || document.activeElement !== animSpeed) animSpeed.value = String(animation.durationMs)
  $('animSpeedOut').textContent = `${animSpeed.value} ms`
  for (const id of ['animSpeed', 'animEase', 'animPreview']) $(id).closest('.field')!.classList.toggle('off', animation.style === 'off')
  if (all || document.activeElement !== privateUrls) privateUrls.value = S.prefs.privateUrls.join('\n')
  hideCapture.checked = hideFromScreenCapture
  pinWindow.checked = S.pinned
  $('showHotkey').textContent = keyLabel('show') || 'its hotkey'
  $('appHotkey').textContent = keyLabel('showApp') || 'The app hotkey'
  renderActionKeys()
}

const sendPrefs = (prefs: Partial<Prefs>) => send('prefs', prefs)
function animPrefs(change: Partial<Prefs['animation']>) {
  if (S) sendPrefs({ animation: { ...S.prefs.animation, ...change } })
}
$('animStyle').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-value]')
  if (b) animPrefs({ style: b.dataset.value as Prefs['animation']['style'] })
})
$('animEase').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-value]')
  if (b) animPrefs({ ease: b.dataset.value as Prefs['animation']['ease'] })
})
animSpeed.addEventListener('input', () => ($('animSpeedOut').textContent = `${animSpeed.value} ms`))
animSpeed.addEventListener('change', () => animPrefs({ durationMs: Number(animSpeed.value) }))
$('animPreview').addEventListener('click', () => {
  if (S) playIn({ phase: 'in', ...S.prefs.animation }, false)
})

let privateTimer: number | undefined
function savePrivateUrls() {
  clearTimeout(privateTimer)
  const list = privateUrls.value.split('\n').map((l) => l.trim()).filter(Boolean)
  if (S && list.join('\n') !== S.prefs.privateUrls.join('\n')) sendPrefs({ privateUrls: list })
}
privateUrls.addEventListener('input', () => {
  clearTimeout(privateTimer)
  privateTimer = window.setTimeout(savePrivateUrls, 400)
})
privateUrls.addEventListener('blur', savePrivateUrls)
$('summarizeAfter').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-value]')
  if (b) sendPrefs({ summarizeAfterDays: Number(b.dataset.value) })
})
$('archiveAfter').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-value]')
  if (b) sendPrefs({ archiveAfterDays: Number(b.dataset.value) })
})
$('restyleAgent').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-value]')
  if (b) sendPrefs({ restyleAgent: b.dataset.value as Prefs['restyleAgent'] })
})
const restyleCodexModel = $<HTMLInputElement>('restyleCodexModel')
restyleCodexModel.addEventListener('change', () => sendPrefs({ restyleCodexModel: restyleCodexModel.value.trim() }))
$('restyleModel').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-value]')
  if (b) sendPrefs({ restyleModel: b.dataset.value })
})

const styledSitesEl = $('styledSites')
function renderStyledSites() {
  if (!S) return
  const html = S.styledSites
    .map(
      (site) => `<label class="check"><input type="checkbox" data-site="${esc(site.host)}" ${site.enabled ? 'checked' : ''}>
        <span>${esc(site.host)}<em>${site.changes} ${site.changes === 1 ? 'change' : 'changes'}</em></span>
        <button class="link" data-remove-site="${esc(site.host)}">Remove</button></label>`,
    )
    .join('')
  const next = html || `<p class="help">No restyled sites yet.</p>`
  if (styledSitesEl.innerHTML !== next) styledSitesEl.innerHTML = next
}
styledSitesEl.addEventListener('change', (e) => {
  const box = e.target as HTMLInputElement
  if (box.dataset.site) send('restyle-site', { host: box.dataset.site, action: box.checked ? 'on' : 'off' })
})
styledSitesEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-remove-site]')
  if (!b) return
  e.preventDefault()
  send('restyle-site', { host: b.dataset.removeSite, action: 'reset' })
})
hideCapture.addEventListener('change', () => sendPrefs({ hideFromScreenCapture: hideCapture.checked }))
pinWindow.addEventListener('change', () => send('pin', { on: pinWindow.checked }))
$('openSettingsFile').addEventListener('click', () => send('open-settings-file'))
$('settingsButton').addEventListener('click', () => setSettings(!!settingsEl.hidden))
$('closeSettings').addEventListener('click', () => setSettings(false))
// ---------- profiles ----------

const profileListEl = $('profileList')
/** A profile to rename once its row shows: a new one arrives in the state after the request to rename it. */
let renameProfile: string | null = null

function renderProfiles() {
  if (!S) return
  const counts = new Map<string, number>()
  for (const t of S.tabs) if (t.url) counts.set(t.profile, (counts.get(t.profile) ?? 0) + 1)
  const rows = [...profileListEl.querySelectorAll<HTMLElement>('[data-profile]')]
  // Rebuilt only when profiles come or go, so a name being typed isn't replaced under you.
  if (rows.map((r) => r.dataset.profile).join() !== S.profiles.map((p) => p.id).join()) {
    profileListEl.innerHTML = S.profiles
      .map(
        (p) => `<div class="profile-row" data-profile="${esc(p.id)}">
          <label class="swatch" title="Color"><input type="color" aria-label="Color of ${esc(p.name)}"></label>
          <input class="name" spellcheck="false" aria-label="Name">
          <em></em>
        </div>`,
      )
      .join('')
  }
  for (const p of S.profiles) {
    const row = profileListEl.querySelector<HTMLElement>(`[data-profile="${CSS.escape(p.id)}"]`)!
    const name = row.querySelector<HTMLInputElement>('.name')!
    const color = row.querySelector<HTMLInputElement>('input[type=color]')!
    if (document.activeElement !== name) name.value = p.name
    if (document.activeElement !== color) color.value = p.color
    row.querySelector<HTMLElement>('.swatch')!.style.background = color.value
    const n = counts.get(p.id) ?? 0
    const notes = [n ? `${n} ${n === 1 ? 'tab' : 'tabs'}` : 'no tabs', p.id === S.prefs.defaultProfile ? 'default' : '']
    row.querySelector('em')!.textContent = notes.filter(Boolean).join(' · ')
    if (renameProfile === p.id) {
      renameProfile = null
      name.focus()
      name.select()
    }
  }
}

const profileOf = (el: EventTarget | null) => (el as HTMLElement | null)?.closest<HTMLElement>('[data-profile]')?.dataset.profile
function saveProfileName(input: HTMLInputElement) {
  const id = profileOf(input)
  const cur = S?.profiles.find((p) => p.id === id)
  const name = input.value.trim()
  if (!cur) return
  if (!name) input.value = cur.name
  else if (name !== cur.name) send('profile', { id, name })
}
profileListEl.addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement
  if (input.classList.contains('name')) saveProfileName(input)
  else if (input.type === 'color') send('profile', { id: profileOf(input), color: input.value })
})
// The color well updates live while you pick, and is saved when the picker closes.
profileListEl.addEventListener('input', (e) => {
  const input = e.target as HTMLInputElement
  if (input.type === 'color') (input.parentElement as HTMLElement).style.background = input.value
})
profileListEl.addEventListener('keydown', (e) => {
  const input = e.target as HTMLInputElement
  if (!input.classList.contains('name')) return
  if (e.key === 'Enter') input.blur()
  else if (e.key === 'Escape') {
    e.stopPropagation()
    input.value = S?.profiles.find((p) => p.id === profileOf(input))?.name ?? input.value
    input.blur()
  }
})
profileListEl.addEventListener('contextmenu', (e) => {
  const id = profileOf(e.target)
  if (!id) return
  e.preventDefault()
  send('profile-menu', { id })
})
$('addProfile').addEventListener('click', () => send('add-profile'))
window.jbrow.on('rename-profile', (id: string) => {
  renameProfile = id
  setSettings(true, 'profiles')
  renderProfiles()
})

window.jbrow.on('default-browser', (status: 'yes' | 'no' | 'dev') => {
  $('defaultBrowser').innerHTML =
    status === 'yes'
      ? 'jbrow is your default browser. Links from other apps open in the profile set for that app under <b>Apps</b>, else in the default profile, in that app\'s section of the sidebar.'
      : status === 'no'
        ? 'Links from other apps open in another browser. Make jbrow the default and they open here, in the profile set for that app under <b>Apps</b>, else in the default profile.'
        : 'Only the installed app can be the default browser, not jbrow running from source. Build it with <code>npm run dist</code>.'
  $('makeDefault').hidden = status !== 'no'
})
$('makeDefault').addEventListener('click', () => send('make-default-browser'))

// ---------- apps ----------

const appListEl = $('appList')
let appList: { entries: AppEntry[]; profiles: Profile[] } = { entries: [], profiles: [] }

function renderApps() {
  const { entries, profiles } = appList
  if (!entries.length) {
    const via = keyLabel('showApp') ? `Open jbrow with ${esc(keyLabel('showApp'))} from an app, or add one.` : 'Add one.'
    appListEl.innerHTML = `<p class="help">No apps yet. ${via}</p>`
    return
  }
  const options = [{ id: '', name: 'Auto', color: '' }, ...profiles]
  appListEl.innerHTML = entries
    .map((e) => {
      const icons = e.apps
        .map((a) => (a.icon ? `<img src="${esc(a.icon)}" alt="">` : `<span class="no-icon">${esc(a.name.slice(0, 1))}</span>`))
        .join('')
      const name = e.apps.map((a) => a.name).join(' + ')
      const ids = e.apps.map((a) => a.bundleId).join(', ')
      const count = e.threads ? `<em>${e.threads} ${e.threads === 1 ? 'thread' : 'threads'}</em>` : ''
      const seg = options
        .map((p) => {
          const dot = p.color ? `<span class="dot" style="background:${esc(p.color)}"></span>` : ''
          const title = p.id ? `New tabs open in ${p.name}` : 'New tabs open in the profile of the tab you were on'
          return `<button data-app-profile="${esc(p.id)}" aria-pressed="${e.profile === p.id}" title="${esc(title)}">${dot}${esc(p.name)}</button>`
        })
        .join('')
      return `<div class="app-row" data-app="${esc(e.key)}">
        <span class="app-icons">${icons}</span><span class="app-name" title="${esc(ids)}">${esc(name)}${count}</span>
        <div class="seg" role="group" aria-label="Profile for ${esc(name)}">${seg}</div>
      </div>`
    })
    .join('')
}

appListEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-app-profile]')
  const r = b?.closest<HTMLElement>('[data-app]')
  if (b && r) send('app-profile', { key: r.dataset.app, profile: b.dataset.appProfile })
})
appListEl.addEventListener('contextmenu', (e) => {
  const r = (e.target as HTMLElement).closest<HTMLElement>('[data-app]')
  if (!r) return
  e.preventDefault()
  send('app-menu', { key: r.dataset.app })
})
$('addApp').addEventListener('click', () => send('add-app'))

// ---------- shortcuts ----------

const actionKeysEl = $('actionKeys')
const shortcutsEl = $('shortcuts')
let shortcuts: { profiles: Profile[]; commands: ExtensionShortcut[] } = { profiles: [], commands: [] }
/** The shortcut being recorded: `action <id>` for jbrow's own, else an extension command's key. */
let recording: string | null = null
const commandKey = (c: ExtensionShortcut) => `${c.profile} ${c.extensionId} ${c.name}`

/** A shortcut you click to record a new one. */
function keyButton(rec: string, shortcut: string): string {
  const now = recording === rec
  const label = now ? 'Press keys…' : shortcut ? shortcutLabel(shortcut) : 'Not set'
  return `<button class="chip sc-key${shortcut || now ? '' : ' none'}" data-rec="${esc(rec)}" aria-pressed="${now}">${esc(label)}</button>`
}

let actionKeysHtml = ''
function renderActionKeys() {
  if (!S) return
  const fixed = (label: string, keys: string) =>
    `<div class="sc-row"><span>${label}</span><span class="chip sc-key fixed" title="This one can't change">${keys}</span></div>`
  const html =
    ACTIONS.map((a) => {
      const note = 'global' in a ? '<em>works in any app</em>' : ''
      return `<div class="sc-row"><span title="${esc(a.label)}">${esc(a.label)}${note}</span>${keyButton(`action ${a.id}`, S!.keys[a.id])}</div>`
    }).join('') +
    fixed('Jump to a thread', '⌘1–9') +
    fixed('Zoom in, out, reset', '⌘+ ⌘− ⌘0')
  // State arrives often; rebuilding the same rows would only cost a repaint.
  if (html !== actionKeysHtml) {
    actionKeysEl.innerHTML = actionKeysHtml = html
    applySearch()
  }
}

function renderShortcuts() {
  const { profiles, commands } = shortcuts
  const used = profiles.filter((p) => commands.some((c) => c.profile === p.id))
  if (!used.length) {
    shortcutsEl.innerHTML = `<p class="help">None of your extensions have commands.</p>`
    return applySearch()
  }
  let html = ''
  for (const p of used) {
    if (used.length > 1) html += `<div class="sc-profile"><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}</div>`
    let ext = ''
    for (const c of commands.filter((c) => c.profile === p.id)) {
      if (c.extensionId !== ext) {
        ext = c.extensionId
        html += `<div class="sc-ext">${esc(c.extensionName)}</div>`
      }
      html += `<div class="sc-row" data-keywords="${esc(`${c.extensionName} ${p.name}`)}"><span title="${esc(c.description)}">${esc(c.description)}${c.global ? '<em>works while jbrow is hidden</em>' : ''}</span>
        ${keyButton(commandKey(c), c.shortcut)}</div>`
    }
  }
  shortcutsEl.innerHTML = html
  applySearch()
}

function renderRecording() {
  renderActionKeys()
  renderShortcuts()
}

function stopRecording() {
  if (!recording) return
  recording = null
  send('recording-shortcut', { on: false })
  renderRecording()
}

function saveShortcut(rec: string, shortcut: string) {
  if (rec.startsWith('action ')) send('set-action-key', { id: rec.slice(7), shortcut })
  else {
    const c = shortcuts.commands.find((c) => commandKey(c) === rec)
    if (c) send('set-shortcut', { profile: c.profile, extensionId: c.extensionId, name: c.name, shortcut })
  }
  stopRecording()
}

settingsEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-rec]')
  if (!b) return
  if (recording === b.dataset.rec) return stopRecording()
  if (!recording) send('recording-shortcut', { on: true })
  // Until it's done, key presses come here instead of running jbrow's or an extension's shortcuts.
  recording = b.dataset.rec!
  renderRecording()
})
// Capture phase, so Esc cancels recording without also closing settings.
document.addEventListener(
  'keydown',
  (e) => {
    if (!recording) return
    e.preventDefault()
    e.stopImmediatePropagation()
    const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
    if (e.key === 'Escape' && plain) return stopRecording()
    if ((e.key === 'Backspace' || e.key === 'Delete') && plain) return saveShortcut(recording, '')
    const shortcut = shortcutFromKey({ key: e.key, code: e.code, command: e.metaKey, control: e.ctrlKey, alt: e.altKey, shift: e.shiftKey })
    // A modifier on its own, or a key without ⌘, ⌃ or ⌥: keep listening.
    if (shortcut) saveShortcut(recording, shortcut)
  },
  true,
)
window.addEventListener('blur', stopRecording)
document.addEventListener('mousedown', (e) => {
  if (recording && !(e.target as HTMLElement).closest('[data-rec]')) stopRecording()
})

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || renaming || e.target === omnibox) return
  const search = e.target === settingsSearch || e.target === shortcutSearch ? (e.target as HTMLInputElement) : null
  if (search?.value) {
    search.value = ''
    applySearch()
  } else if (!rulesPop.hidden) closeRules()
  else if (!certPop.hidden) setCert(false)
  else if (!restylePane.hidden) setRestyle(false)
  else if (!extPop.hidden) setExtensions(false)
  else if (dlOpen) setDownload(null)
  else if (!settingsEl.hidden) setSettings(false)
})

// ---------- certificates ----------

/** What each certificate error means, finishing "…sent a certificate jbrow can't trust:". */
const CERT_PROBLEMS: Record<string, string> = {
  CERT_AUTHORITY_INVALID: "it isn't signed by an authority your Mac trusts. It may be self-signed.",
  CERT_COMMON_NAME_INVALID: 'it was issued for a different site.',
  CERT_DATE_INVALID: "it has expired, or isn't valid yet. Check your Mac's clock too.",
  CERT_REVOKED: 'whoever issued it has revoked it.',
  CERT_INVALID: "it couldn't be read.",
  CERT_WEAK_SIGNATURE_ALGORITHM: 'it is signed with an algorithm too weak to rely on.',
  CERT_WEAK_KEY: 'its key is too weak to rely on.',
  CERT_NAME_CONSTRAINT_VIOLATION: 'it names a site its issuer may not issue for.',
  CERT_VALIDITY_TOO_LONG: 'it is valid for longer than certificates may be.',
  CERT_NON_UNIQUE_NAME: "it is for a name that isn't unique on the internet.",
  CERT_SYMANTEC_LEGACY: 'its issuer is no longer trusted.',
  CERT_KNOWN_INTERCEPTION_BLOCKED: 'software that intercepts connections issued it.',
  CERTIFICATE_TRANSPARENCY_REQUIRED: "it wasn't publicly logged, as it must be.",
  SSL_PINNED_KEY_NOT_IN_CERT_CHAIN: "it isn't one this site is known to use.",
}
const certProblem = (error: string) => CERT_PROBLEMS[error] ?? `Chromium refused it (${error}).`

const certDate = (ms: number) => new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })

/** The site's certificate, then each one that signed it. */
function certChainHtml(chain: CertInfo[]): string {
  const now = Date.now()
  const who = (name: string, org: string) => `${esc(name)}${org ? ` <small>${esc(org)}</small>` : ''}`
  return chain
    .map((c, i) => {
      const role = i === 0 ? 'Site' : i === chain.length - 1 && c.subject === c.issuer ? 'Root' : 'Intermediate'
      const dated = now < c.validFrom || now > c.validTo
      const rows: [string, string, string?][] = [
        ['Issued to', who(c.subject, c.subjectOrg)],
        ['Issued by', who(c.issuer, c.issuerOrg)],
        ['Valid', `${certDate(c.validFrom)} – ${certDate(c.validTo)}`, dated ? 'bad' : ''],
      ]
      if (i === 0 && c.names.length) rows.push(['Names', c.names.map(esc).join(', ')])
      rows.push(['Serial', esc(c.serial), 'mono'], ...(c.sha256 ? [['SHA-256', esc(c.sha256), 'mono'] as [string, string, string]] : []))
      const dl = rows.map(([dt, dd, cls]) => `<dt>${dt}</dt><dd${cls ? ` class="${cls}"` : ''}>${dd}</dd>`).join('')
      return `<div class="cert"><div class="cert-role">${role}</div><dl class="cert-meta">${dl}</dl></div>`
    })
    .join('')
}

/** Chains are redrawn only when they change, so a selection or an open <details> survives. */
let certShown = ''
let certPopShown = ''
function renderCert() {
  if (!S) return
  const c = S.cert
  const button = $<HTMLButtonElement>('certButton')
  button.hidden = !c
  $('certWarn').hidden = !c?.blocked
  if (!c) return setCert(false)
  const bad = !!c.error
  const iconName = bad ? 'warn' : 'lock'
  if (button.dataset.icon !== iconName) {
    button.dataset.icon = iconName
    button.innerHTML = icon(iconName)
  }
  button.classList.toggle('bad', bad)
  const label = !bad ? 'Secure connection: certificate details' : c.trusted ? 'Not secure: you chose to trust this certificate' : 'Not secure: certificate details'
  button.title = label
  button.setAttribute('aria-label', label)

  if (c.blocked) {
    $('certWarnText').innerHTML =
      `<b>${esc(c.host)}</b> sent a certificate jbrow can't trust: ${esc(certProblem(c.error))} ` +
      (c.fatal ? "You can't go ahead to this site." : 'Someone could be posing as the site to read what you send it, such as passwords or card numbers.')
    $('certBack').textContent = S.nav.canGoBack ? 'Go back' : 'Close tab'
    $('certProceed').hidden = c.fatal
    $('certProceed').textContent = `Go to ${c.host} anyway`
    const key = c.chain.map((x) => x.sha256).join()
    if (key !== certShown) {
      certShown = key
      $('certWarnChain').innerHTML = certChainHtml(c.chain)
    }
  }

  if (certPop.hidden) return
  $('certHead').textContent = `Certificate · ${c.host}`
  $('certStatus').textContent =
    !bad ? 'The connection is encrypted and the certificate is valid.'
    : c.trusted ? `Not secure: ${certProblem(c.error)} You chose to go ahead anyway, until jbrow quits.`
    : `Not trusted: ${certProblem(c.error)}`
  $('certDistrustRow').hidden = !c.trusted
  const key = c.chain.map((x) => x.sha256).join()
  if (key !== certPopShown) {
    certPopShown = key
    $('certChain').innerHTML = certChainHtml(c.chain)
  }
}

function setCert(open: boolean) {
  if (open === !certPop.hidden) return
  if (open && !S?.cert) return
  certPop.hidden = !open
  $('certButton').setAttribute('aria-expanded', String(open))
  if (open) {
    setExtensions(false)
    renderCert()
    focusUi()
  } else certPopShown = ''
  syncOverlay()
}
$('certButton').addEventListener('mousedown', (e) => e.preventDefault())
$('certButton').addEventListener('click', () => setCert(!!certPop.hidden))
$('certDistrust').addEventListener('click', () => {
  setCert(false)
  send('cert', { action: 'distrust' })
})
$('certBack').addEventListener('click', () => send('cert', { action: 'back' }))
$('certProceed').addEventListener('click', () => send('cert', { action: 'proceed' }))
document.addEventListener('mousedown', (e) => {
  if (!certPop.hidden && !(e.target as HTMLElement).closest('#certPop, #certButton')) setCert(false)
})

// ---------- messages from main ----------

let toastTimer: number | undefined
window.jbrow.on('state', (state: UiState) => {
  // Another tab coming to the front (a new tab, ⌘1–9, a link) takes over from settings.
  if (S && S.activeId !== state.activeId) showSettings(false)
  S = state
  render()
})
window.jbrow.on('snapshot', ({ dataUrl, tabId }: { dataUrl: string; tabId: string }) => {
  snapshot.src = dataUrl
  snapshotTab = tabId
  render()
})
window.jbrow.on('focus-omnibox', () => {
  omnibox.focus()
  omnibox.select()
})
window.jbrow.on('toast', (text: string) => {
  const el = $('toast')
  el.textContent = text
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (el.hidden = true), 5000)
})
window.jbrow.on('settings', ({ open, section }: { open?: boolean; section?: string }) => setSettings(open ?? !!settingsEl.hidden, section))
window.jbrow.on('rename-tab', (id: string) => startRename(id))
window.jbrow.on('shortcuts', (data: typeof shortcuts) => {
  shortcuts = data
  renderShortcuts()
})
// An extension's popup shortcut: open it from its pinned button, or else from the puzzle icon.
window.jbrow.on('run-action', (extensionId: string) => {
  const pinned = [...pinnedEl.children].find((b) => b.id === extensionId) as HTMLElement | undefined
  if (pinned && !pinnedEl.hidden) return pinned.click()
  const r = $('extButton').getBoundingClientRect()
  send('action-popup', { extensionId, anchorRect: { x: r.x, y: r.y, width: r.width, height: r.height } })
})
window.jbrow.on('apps', (data: typeof appList) => {
  appList = data
  renderApps()
})
window.jbrow.on('folder-rules', (id: string) => openRules(id))
window.jbrow.on('downloads', (list: DownloadInfo[]) => {
  downloads = list
  renderDownloads()
})

let playRun = 0

/**
 * Starts the show animation on the first frame the window paints, then tells the main process
 * when it started and ended so the window fade and the live page keep in step with it.
 * The settings preview passes `report = false`.
 */
function playIn(m: AnimMessage, report = true) {
  const run = ++playRun
  root.dataset.style = m.style
  root.style.setProperty('--dur', `${m.durationMs}ms`)
  root.style.setProperty('--ease', cssEase(m.ease))
  root.classList.add('pre')
  root.classList.remove('shown')
  void root.offsetWidth
  const moves = m.style !== 'fade' && m.style !== 'off' && !matchMedia('(prefers-reduced-motion: reduce)').matches
  requestAnimationFrame(() => {
    if (run !== playRun) return
    root.classList.remove('pre')
    root.classList.add('shown')
    if (!report) return
    send('anim-start')
    if (!moves) return send('anim-end')
    const end = (e: TransitionEvent) => {
      if (e.target !== root || e.propertyName !== 'transform') return
      root.removeEventListener('transitionend', end)
      if (run === playRun) send('anim-end')
    }
    root.addEventListener('transitionend', end)
  })
}

window.jbrow.on('anim', (m: AnimMessage) => {
  if (m.phase === 'in') return playIn(m)
  playRun++
  root.dataset.style = m.style
  root.style.setProperty('--dur', `${m.durationMs}ms`)
  root.style.setProperty('--ease', 'cubic-bezier(.4,0,1,1)')
  root.classList.remove('shown')
  hideSuggestions()
  setExtensions(false)
  setDownload(null)
  setRestyle(false)
  setCert(false)
  stopRecording()
  savePrivateUrls()
  closeRules()
  if (renaming) commitRename()
})

send('ready')
