import { urlMatcher } from '../shared/patterns'
import { childrenOf, displayName, numberedThreads, sections, type FolderView, type ThreadView } from '../shared/threads'
import type { AnimMessage, Prefs, Profile, UiState, UiTab } from '../shared/types'

declare global {
  interface Window {
    jbrow: {
      on(channel: string, listener: (data: any) => void): void
      send(channel: string, data?: unknown): void
    }
  }
}

const EASE: Record<AnimMessage['ease'], string> = {
  spring: 'cubic-bezier(.34,1.45,.64,1)',
  snappy: 'cubic-bezier(.2,.9,.2,1)',
  smooth: 'cubic-bezier(.45,0,.2,1)',
}

/** 24×24 stroke icons. The puzzle, pin, eye-off, folder and store paths are from Lucide (ISC). */
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
const settingsEl = $('settings')
const privateMask = $('privateMask')
const rulesPop = $('rulesPop')
const folderRules = $<HTMLTextAreaElement>('folderRules')
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

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
const profile = (id: string): Profile | undefined => S?.profiles.find((p) => p.id === id)
const activeTab = () => S?.tabs.find((t) => t.id === S!.activeId)
/** The address as it may be shown on screen. */
const shownUrl = (url: string) => (isPrivate(url) ? 'Private' : url)

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
  const pill = $('profilePill')
  pill.hidden = !p || S.profiles.length < 2
  if (p) {
    pill.textContent = p.name
    pill.style.setProperty('--pc', p.color || 'var(--muted)')
    pill.title = `This tab is in the ${p.name} profile`
  }
  const reload = $('reload')
  const reloadIcon = S.nav.loading ? 'close' : 'reload'
  if (reload.dataset.icon !== reloadIcon) {
    reload.dataset.icon = reloadIcon
    reload.innerHTML = icon(reloadIcon)
    reload.title = S.nav.loading ? 'Stop' : 'Reload (⌘R)'
    reload.setAttribute('aria-label', S.nav.loading ? 'Stop' : 'Reload')
  }
  $('pin').setAttribute('aria-pressed', String(S.pinned))
  $('pin').title = S.pinned ? 'Pinned: a regular window with a Dock icon (⇧⌘P)' : 'Pin: keep as a regular window with a Dock icon (⇧⌘P)'
  if (document.activeElement !== omnibox) showAddress()
  $('extHead').textContent = `Extensions · ${p?.name ?? ''}`
  $('newTab').title = `New tab${S.filter !== 'all' ? ` in ${profile(S.filter)?.name ?? S.filter}` : ''} (⌘T)`
  renderSettings()

  if (S.activePartition) actions.setAttribute('partition', S.activePartition)
  if (S.activeWebContentsId != null) actions.setAttribute('tab', String(S.activeWebContentsId))
  else actions.removeAttribute('tab')
  renderPinnedActions()

  const scope = $('scope')
  scope.hidden = !S.scope
  if (S.scope) scope.innerHTML = `<span>${esc(S.scope.name)} tabs only</span><button data-unscope>Show all</button>`

  renderThreads()

  const blank = !active?.url
  $('blank').hidden = !blank
  if (blank) {
    $('blankProfile').innerHTML = S.profiles
      .map((x) => `<button data-profile="${esc(x.id)}" aria-pressed="${x.id === active?.profile}">${dot(x)}${esc(x.name)}</button>`)
      .join('')
  }
  snapshot.hidden = blank || snapshotTab !== S.activeId
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
function showAddress() {
  const url = activeTab()?.url ?? ''
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

  const s = sections(S.tabs, { filter: S.filter, scope: S.scope?.key ?? null, activeId: S.activeId, now: S.now, folders: S.folders })
  const numbered = new Map(numberedThreads(s).map((v, i) => [v.root.id, i + 1]))
  const block = (v: ThreadView<UiTab>) => row(v.root, 0, v, numbered.get(v.root.id))
  // While filtered to a profile or an app, folders with nothing to show stay out of the way.
  const narrowed = S.filter !== 'all' || !!S.scope
  const folders = s.folders.filter((f) => f.threads.length || !narrowed)
  let html = `<div class="head" data-head="kept"><span>Kept</span><button class="head-act" data-new-folder title="New folder" aria-label="New folder">${icon('folderPlus')}</button></div>`
  html += folders.map((f) => folderRow(f, block)).join('') + s.kept.map(block).join('')
  if (!folders.length && !s.kept.length) html += `<div class="empty">Drag a thread here to keep it</div>`
  html += `<div class="head" data-head="today">Today</div>`
  html += s.today.length ? s.today.map(block).join('') : `<div class="empty">Nothing here yet</div>`
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

function folderRow(v: FolderView<UiTab>, block: (v: ThreadView<UiTab>) => string): string {
  const f = v.folder
  const open = !f.collapsed
  const name =
    renaming === f.id
      ? `<input class="ren" id="ren" value="${esc(f.name)}" aria-label="Folder name">`
      : `<span class="t">${esc(f.name)}</span>`
  const html = `<div class="row frow" role="button" tabindex="0" aria-expanded="${open}" data-folder="${f.id}">
    <span class="fav">${icon(open ? 'folderOpen' : 'folder')}</span>${name}<span class="end"><span class="meta">${v.threads.length || ''}</span></span>
  </div>`
  return open && v.threads.length ? `${html}<div class="folder-body">${v.threads.map(block).join('')}</div>` : html
}

const toggleFolder = (id: string) => {
  const f = S?.folders.find((x) => x.id === id)
  if (f) send('folder', { id, collapsed: !f.collapsed })
}

function row(t: UiTab, depth: number, thread: ThreadView<UiTab> | null, number?: number): string {
  if (!S) return ''
  const kids = childrenOf(S.tabs, t.id)
  const open = thread ? thread.all.some((x) => x.id === S!.activeId) : true
  const target = thread && !open ? thread.last.id : t.id
  const count = thread && !open && thread.all.length > 1 ? String(thread.all.length) : ''
  const app = depth === 0 && t.scopeName && !S.scope ? t.scopeName : ''
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
    t.id === S.activeId ? 'cur' : '',
    thread && open ? 'open' : '',
    t.loading ? 'loading' : '',
    t.unread ? 'unread' : '',
  ].join(' ')
  const color = profile(t.profile)?.color ?? ''
  let html = `<div class="${classes}" role="button" tabindex="0" draggable="true" data-id="${t.id}" data-target="${target}" style="--d:${depth};--pc:${esc(color)}">
    ${fav}${name}<span class="end"><span class="meta">${esc(meta || key)}</span><button class="act" data-close="${t.id}" title="Close" aria-label="Close">${icon('close')}</button></span>
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
  const on = !suggest.hidden || !extPop.hidden || !settingsEl.hidden
  if (on !== overlaySent) {
    overlaySent = on
    send('overlay', { on })
  }
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
  if (s?.kind === 'tab' && s.id) send('activate', { id: s.id })
  else if (s?.kind === 'archived' && s.id) send('restore', { id: s.id })
  else if (text.trim()) send('navigate', { input: text })
}

omnibox.addEventListener('focus', () => {
  // Clicking the address bar is how a private address is revealed.
  omnibox.value = activeTab()?.url ?? ''
  omnibox.placeholder = 'Search or type a tab name'
  privateMask.hidden = true
  omnibox.select()
  showSuggestions()
})
omnibox.addEventListener('input', showSuggestions)
omnibox.addEventListener('blur', () => {
  hideSuggestions()
  showAddress()
})
omnibox.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') (e.preventDefault(), moveHighlight(1))
  else if (e.key === 'ArrowUp') (e.preventDefault(), moveHighlight(-1))
  else if (e.key === 'Enter') {
    e.preventDefault()
    // With no suggestion chosen by the arrows, Enter on a typed address or query navigates.
    pick(current[highlighted])
  } else if (e.key === 'Escape') omnibox.blur()
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
  const folder = el.closest<HTMLElement>('.frow')
  if (folder) return void (!renaming && toggleFolder(folder.dataset.folder!))
  const r = el.closest<HTMLElement>('.row')
  if (r && !renaming) send('activate', { id: r.dataset.target })
})
threadsEl.addEventListener('dblclick', (e) => {
  const r = (e.target as HTMLElement).closest<HTMLElement>('.row')
  if (r && !(e.target as HTMLElement).closest('#ren')) startRename(r.dataset.id ?? r.dataset.folder!)
})
threadsEl.addEventListener('contextmenu', (e) => {
  const r = (e.target as HTMLElement).closest<HTMLElement>('.row')
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
    else send('activate', { id: el.dataset.target })
  }
  if (e.key === 'F2' && el.classList.contains('row')) startRename(el.dataset.id ?? el.dataset.folder!)
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
  const t = (e.target as HTMLElement).closest<HTMLElement>('.row, .head')
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
  const t = (e.target as HTMLElement).closest<HTMLElement>('.row, .head')
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

// ---------- settings ----------

const animSpeed = $<HTMLInputElement>('animSpeed')
const privateUrls = $<HTMLTextAreaElement>('privateUrls')
const hideCapture = $<HTMLInputElement>('hideCapture')

function setSettings(open: boolean) {
  if (open === !settingsEl.hidden) return
  settingsEl.hidden = !open
  $('settingsButton').setAttribute('aria-pressed', String(open))
  if (open) {
    setExtensions(false)
    focusUi()
    settingsEl.focus()
    renderSettings(true)
  } else {
    savePrivateUrls()
    send('focus-page')
  }
  syncOverlay()
}

/** Updates the controls from state, leaving alone whichever one is being edited. */
function renderSettings(all = false) {
  if (!S || settingsEl.hidden) return
  const { animation, hideFromScreenCapture } = S.prefs
  const seg = (id: string, value: string) =>
    $(id).querySelectorAll<HTMLElement>('[data-value]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === value)))
  seg('animStyle', animation.style)
  seg('animEase', animation.ease)
  seg('archiveAfter', String(S.prefs.archiveAfterDays))
  if (all || document.activeElement !== animSpeed) animSpeed.value = String(animation.durationMs)
  $('animSpeedOut').textContent = `${animSpeed.value} ms`
  for (const id of ['animSpeed', 'animEase', 'animPreview']) $(id).closest('.field')!.classList.toggle('off', animation.style === 'off')
  if (all || document.activeElement !== privateUrls) privateUrls.value = S.prefs.privateUrls.join('\n')
  hideCapture.checked = hideFromScreenCapture
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
  if (S) playIn({ phase: 'in', ...S.prefs.animation })
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
$('archiveAfter').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-value]')
  if (b) sendPrefs({ archiveAfterDays: Number(b.dataset.value) })
})
hideCapture.addEventListener('change', () => sendPrefs({ hideFromScreenCapture: hideCapture.checked }))
$('openSettingsFile').addEventListener('click', () => send('open-settings-file'))
$('settingsButton').addEventListener('click', () => setSettings(!!settingsEl.hidden))
$('closeSettings').addEventListener('click', () => setSettings(false))
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || renaming || e.target === omnibox) return
  if (!rulesPop.hidden) closeRules()
  else if (!extPop.hidden) setExtensions(false)
  else if (!settingsEl.hidden) setSettings(false)
})

// ---------- messages from main ----------

let toastTimer: number | undefined
window.jbrow.on('state', (state: UiState) => {
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
window.jbrow.on('settings', ({ open }: { open?: boolean }) => setSettings(open ?? !!settingsEl.hidden))
window.jbrow.on('rename-tab', (id: string) => startRename(id))
window.jbrow.on('folder-rules', (id: string) => openRules(id))

function playIn(m: AnimMessage) {
  root.dataset.style = m.style
  root.style.setProperty('--dur', `${m.durationMs}ms`)
  root.style.setProperty('--ease', EASE[m.ease])
  root.classList.add('pre')
  root.classList.remove('shown')
  void root.offsetWidth
  root.classList.remove('pre')
  root.classList.add('shown')
}

window.jbrow.on('anim', (m: AnimMessage) => {
  if (m.phase === 'in') return playIn(m)
  root.dataset.style = m.style
  root.style.setProperty('--dur', `${m.durationMs}ms`)
  root.style.setProperty('--ease', 'cubic-bezier(.4,0,1,1)')
  root.classList.remove('shown')
  hideSuggestions()
  setExtensions(false)
  setSettings(false)
  closeRules()
  if (renaming) commitRename()
})

send('ready')
