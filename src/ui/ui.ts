import { cssEase } from '../shared/ease'
import { engineOf, isSearchUrl, SEARCH_ENGINES, suggestUrlFor } from '../shared/engines'
import { urlMatcher } from '../shared/patterns'
import { awayFromHome, displayName, folderThreads, isAsleep, isFolder, isPinned, keptThreads, numberedThreads, sections, threadsOf, type AppView, type FolderView, type KeptItem, type ThreadView } from '../shared/threads'
import { ACTIONS, shortcutFromKey, shortcutLabel, type ActionId } from '../shared/shortcuts'
import { dragDivider, PANE_GAP, paneSpans, splitOf } from '../shared/split'
import { DAY_MS, esc, HOUR_MS, icon, since } from './markup'
import type { LayoutHost, OpenIn, Outcome, SuggestLayout } from './suggest/layout'
import { LAYOUTS, layoutPictureHtml, URL_BAR_LAYOUTS } from './suggest/layouts'
import { isEmpty, suggestModel, type Item, type SuggestModel, type VisitItem } from './suggest/model'
import { initWelcome } from './welcome'
import { THEMES, type AnimMessage, type AppEntry, type CertInfo, type CompletionView, type DeviceKind, type DownloadInfo, type ExtensionShortcut, type ExtensionView, type Prefs, type Profile, type SearchReply, type SiteInfoReply, type SuggestReply, type TabRecord, type UiState, type UiTab, type UpdateView, type UrlBarStyle, type VisitView } from '../shared/types'
import { afterRender, beforeRender, downloadsChanged, flourish, setWhimsy } from './whimsy'

declare global {
  interface Window {
    jbrow: {
      on(channel: string, listener: (data: any) => void): void
      send(channel: string, data?: unknown): void
    }
  }
}

document.querySelectorAll<HTMLElement>('[data-icon]').forEach((el) => (el.innerHTML = icon(el.dataset.icon!)))

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T
const root = $('root')
const omnibox = $<HTMLInputElement>('omnibox')
const suggest = $('suggest')
const threadsEl = $('threads')
const sidebarEl = $('sidebar')
const pinsEl = $('pins')
const pinDivider = $('pinDivider')
const actions = $('actions')
const extPop = $('extPop')
const restylePane = $('restylePane')
const restylePrompt = $<HTMLTextAreaElement>('restylePrompt')
const settingsEl = $('settings')
const privateMask = $('privateMask')
const rulesPop = $('rulesPop')
const folderRules = $<HTMLTextAreaElement>('folderRules')
const certPop = $('certPop')
const devicePop = $('devicePop')
const profilePop = $('profilePop')
const send = window.jbrow.send
const welcome = initWelcome($('welcome'), send, () => syncOverlay())

let S: UiState | null = null
let renaming: string | null = null
let dragId: string | null = null
let dragFolder = false
let isPrivate: (url: string) => boolean = () => false
let privateKey = ''
/** Folder whose auto-file rules are being edited. */
let rulesFor: string | null = null
/** Profile picked with Tab in the address bar, for what's typed there; null while it's the tab's own. */
let typedProfile: string | null = null
/** Settings is open as its own tab in the sidebar; settingsEl.hidden says whether it's the one showing. */
let settingsTab = false

const profile = (id: string): Profile | undefined => S?.profiles.find((p) => p.id === id)
const activeTab = () => S?.tabs.find((t) => t.id === S!.activeId)
/** The active tab's address, or the one a bad certificate or the dangerous-site lists stopped it from loading. */
const activeUrl = () => (S?.cert?.blocked ? S.cert.url : S?.danger ? S.danger.url : (activeTab()?.url ?? ''))
/** jbrow shows its own screen where the active tab's page would be: certificate, dangerous site, sign-in or crash. */
const pageCovered = () => !!(S?.cert?.blocked || S?.danger || S?.login || S?.crash)
/** The address as it may be shown on screen. */
const shownUrl = (url: string) => (isPrivate(url) ? 'Private' : url)
/** A command's key as a menu writes it, '' when it has none. */
const keyLabel = (id: ActionId) => (S?.keys[id] ? shortcutLabel(S.keys[id]) : '')
/** " (⌘T)" for a tooltip. */
const keyHint = (id: ActionId) => (keyLabel(id) ? ` (${keyLabel(id)})` : '')

/** What an asleep thread held, e.g. "4 tabs · github.com, mozilla.org +1 · 5 d". */
function sleepSummary(v: ThreadView<UiTab>, now: number): string {
  return [threadSummary(v.all), `${Math.floor((now - v.lastSeen) / DAY_MS)} d`].filter(Boolean).join(' · ')
}

/** A page's site without www, '' for an address that isn't a web page. */
function hostOf(url: string): string {
  try {
    return /^https?:/i.test(url) ? new URL(url).hostname.replace(/^www\./, '') : ''
  } catch {
    return ''
  }
}

/** How many tabs and which sites a thread holds, e.g. "4 tabs · github.com, mozilla.org +1". */
function threadSummary(all: TabRecord[]): string {
  const hosts = new Map<string, number>()
  for (const t of all) {
    const site = hostOf(t.url)
    const host = site && isPrivate(t.url) ? 'Private' : site
    if (host) hosts.set(host, (hosts.get(host) ?? 0) + 1)
  }
  const top = [...hosts].sort((a, b) => b[1] - a[1]).map(([h]) => h)
  const sites = top.slice(0, 2).join(', ') + (top.length > 2 ? ` +${top.length - 2}` : '')
  const tabs = all.length > 1 ? `${all.length} tabs` : ''
  return [tabs, sites].filter(Boolean).join(' · ')
}

/** An archived thread as the Archived list shows and searches it. */
interface ArchivedThread {
  root: TabRecord
  all: TabRecord[]
  /** When it was archived. */
  at: number
  /** Sites of its tabs, without www. */
  hosts: string[]
  /** Names, titles and addresses of its tabs in lower case, for the search. */
  text: string
}

/** Tabs of archived threads. Main sends them on their own, only when they change: there can be thousands. */
let archived: TabRecord[] = []
let archivedById = new Map<string, TabRecord>()
/** The same as threads, most recently archived first. */
let archivedList: ArchivedThread[] = []
/** Bumped with each new list, so the Archived list knows to render again. */
let archivedRev = 0

function setArchived(tabs: TabRecord[]) {
  archived = tabs
  archivedById = new Map(tabs.map((t) => [t.id, t]))
  archivedList = threadsOf(tabs)
    .map(({ root, all }) => ({
      root,
      all,
      at: root.archivedAt ?? 0,
      hosts: [...new Set(all.map((t) => hostOf(t.url)).filter(Boolean))],
      text: all.map((t) => `${displayName(t)} ${t.title} ${t.url}`).join(' ').toLowerCase(),
    }))
    .sort((a, b) => b.at - a.at || b.root.lastSeen - a.root.lastSeen)
  archivedRev++
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
  renderProfileBand()
  const reload = $('reload')
  const reloadIcon = S.nav.loading ? 'close' : 'reload'
  if (reload.dataset.icon !== reloadIcon) {
    reload.dataset.icon = reloadIcon
    reload.innerHTML = icon(reloadIcon)
    reload.setAttribute('aria-label', S.nav.loading ? 'Stop' : 'Reload')
  }
  reload.title = S.nav.loading ? 'Stop' : `Reload${keyHint('reload')}, ⇧-click without the cache${keyHint('hardReload')}`
  $('back').title = `Back${keyHint('back')}`
  $('forward').title = `Forward${keyHint('forward')}`
  $('settingsButton').title = `Settings${keyHint('settings')}`
  $('pin').setAttribute('aria-pressed', String(S.pinned))
  $('pin').title = `${S.pinned ? 'Pinned: a regular window' : 'Pin: keep as a regular window'} with a Dock icon${keyHint('pin')}`
  if (!barFocused()) showAddress()
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
  renderDanger()
  renderLogin()
  renderCrash()
  renderDevices()

  const scope = $('scope')
  scope.hidden = !S.scope
  if (S.scope) scope.innerHTML = `<span>${esc(S.scope.name)} tabs only</span><button data-unscope>Show all</button>`

  renderThreads()
  renderArchiveNotice()

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
      ['⌘1–9', 'Jump to a tab'],
      [keyLabel('previousTab'), 'Previous tab'],
      [keyLabel('splitView'), 'Split view'],
      [keyLabel('closeTab'), 'Close tab'],
      [keyLabel('reopenTab'), 'Reopen closed tab'],
      [keyLabel('pin'), 'Pin the window'],
    ]
    $('blankKeys').innerHTML = keys
      .filter(([k]) => k)
      .map(([k, what]) => `<div><dt>${esc(k)}</dt><dd>${esc(what)}</dd></div>`)
      .join('')
  }
  syncCovering()
  renderSidePanel()
  renderPanes()
}

/** The header and the space for an extension's side panel; its page is a native view main lays over it. */
const sidePanelEl = $('sidePanel')
let sideDrag: { x: number; width: number } | null = null
function renderSidePanel() {
  const side = S?.sidePanel
  sidePanelEl.hidden = !side
  if (!side) {
    root.style.removeProperty('--side')
    root.style.removeProperty('--side-w')
    return
  }
  if (!sideDrag) setSideWidth(side.width)
  $('sideName').textContent = side.name
  const img = $<HTMLImageElement>('sideIcon')
  if (!side.icon) img.removeAttribute('src')
  else if (img.getAttribute('src') !== side.icon) img.src = side.icon
}
/** --side-w is the panel, --side the room it takes from the page (with the gap). */
function setSideWidth(width: number) {
  root.style.setProperty('--side-w', `${width}px`)
  root.style.setProperty('--side', `${width + 8}px`)
}
$('sideClose').addEventListener('click', () => send('side-panel-close'))
$('sideHead').addEventListener('contextmenu', (e) => {
  e.preventDefault()
  send('side-panel-menu')
})
// Drag the gap left of the panel to resize it. macOS keeps sending the drag here even over the pages.
$('sideSplit').addEventListener('mousedown', (e) => {
  if (!S?.sidePanel || e.button !== 0) return
  e.preventDefault()
  const drag = (sideDrag = { x: e.clientX, width: S.sidePanel.width })
  $('sideSplit').classList.add('drag')
  document.body.classList.add('resizing')
  let width = drag.width
  let queued = false
  const move = (ev: MouseEvent) => {
    width = Math.max(240, drag.width + drag.x - ev.clientX)
    setSideWidth(width)
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      send('side-panel-width', { width })
    })
  }
  const up = () => {
    sideDrag = null
    $('sideSplit').classList.remove('drag')
    document.body.classList.remove('resizing')
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    send('side-panel-width', { width, done: true })
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
})

// ---------- split view ----------

const contentEl = $('content')
const paneBgs = $('paneBgs')
const panesEl = $('panes')
/** The divider you're dragging and the sizes so far, ahead of what main has. */
let paneDrag: { id: string; i: number; sizes: number[] } | null = null

const activeSplit = () => (S ? splitOf(S.splits, S.activeId) : undefined)
/** The tabs on screen: the active tab and the rest of its split. */
const shownPanes = () => activeSplit()?.tabs ?? (S?.activeId ? [S.activeId] : [])

/**
 * Around the pages main lays side by side: the room for each pane (a new tab has no page there
 * yet), the dividers in the gaps and the ring around the focused pane. The active tab's own
 * screens (new tab, certificate, crash) move into its pane through --fx and --fw.
 */
function renderPanes() {
  const split = activeSplit()
  contentEl.classList.toggle('split', !!split)
  panesEl.hidden = !split || !settingsEl.hidden
  if (!split || !S) {
    paneBgs.innerHTML = ''
    contentEl.style.removeProperty('--fx')
    contentEl.style.removeProperty('--fw')
    return
  }
  const sizes = paneDrag?.id === split.id ? paneDrag.sizes : split.sizes
  const spans = paneSpans(contentEl.clientWidth, sizes)
  const focused = Math.max(0, split.tabs.indexOf(S.activeId!))
  const f = spans[focused]
  contentEl.style.setProperty('--fx', `${f.x}px`)
  contentEl.style.setProperty('--fw', `${f.width}px`)
  paneBgs.innerHTML = split.tabs
    .map((id, i) => {
      const empty = i !== focused && !S!.tabs.find((t) => t.id === id)?.url
      return `<div class="pane" data-pane="${esc(id)}" style="left:${spans[i].x}px;width:${spans[i].width}px">${empty ? '<span>New tab</span>' : ''}</div>`
    })
    .join('')
  panesEl.innerHTML =
    `<div class="pane-ring" style="left:${f.x}px;width:${f.width}px"></div>` +
    spans
      .map((s, i) => `<button class="pane-x" data-close-pane="${esc(split.tabs[i])}" style="left:${s.x + s.width}px" title="Take out of split view" aria-label="Take out of split view">${icon('close')}</button>`)
      .join('') +
    spans
      .slice(1)
      .map((s, i) => `<div class="pane-split${paneDrag?.i === i ? ' drag' : ''}" data-divider="${i}" style="left:${s.x - PANE_GAP}px" title="Drag to resize"></div>`)
      .join('')
}
new ResizeObserver(() => renderPanes()).observe(contentEl)
// A pane without a page is jbrow's; clicking it focuses its tab. Panes with a page focus themselves.
paneBgs.addEventListener('mousedown', (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('[data-pane]')?.dataset.pane
  if (id && id !== S?.activeId) send('activate', { id })
})
panesEl.addEventListener('click', (e) => {
  const id = (e.target as HTMLElement).closest<HTMLElement>('[data-close-pane]')?.dataset.closePane
  if (id) send('close-pane', { id })
})
// Drag a gap between panes to resize them, as with the side panel.
panesEl.addEventListener('mousedown', (e) => {
  const divider = (e.target as HTMLElement).closest<HTMLElement>('[data-divider]')
  const split = activeSplit()
  if (!divider || !split || e.button !== 0) return
  e.preventDefault()
  const drag = (paneDrag = { id: split.id, i: Number(divider.dataset.divider), sizes: split.sizes })
  document.body.classList.add('resizing')
  let queued = false
  const move = (ev: MouseEvent) => {
    drag.sizes = dragDivider(contentEl.clientWidth, drag.sizes, drag.i, ev.clientX - contentEl.getBoundingClientRect().left)
    renderPanes()
    if (queued) return
    queued = true
    requestAnimationFrame(() => {
      queued = false
      send('split-sizes', { id: drag.id, sizes: drag.sizes })
    })
  }
  const up = () => {
    paneDrag = null
    document.body.classList.remove('resizing')
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
    // The new sizes come back with the state main sends once it has saved them.
    send('split-sizes', { id: drag.id, sizes: drag.sizes, done: true })
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
})

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

/** The address bar's profile: the tab's own, or the one Tab picked for what's being typed. */
function renderProfileBand() {
  const active = activeTab()
  const p = active && profile(typedProfile ?? active.profile)
  const band = $('profileBand')
  const name = $('profileName')
  const shown = !!p && S!.profiles.length > 1
  band.classList.toggle('on', shown)
  name.hidden = !shown
  if (!p) return
  const other = !!typedProfile && typedProfile !== active.profile && !!active.url
  name.textContent = p.name
  band.style.setProperty('--pc', p.color || '#8a93a1')
  band.classList.toggle('typed', other)
  const others = S!.profiles.filter((x) => x.id !== p.id)
  const pick = others.length === 1 ? others[0].name : 'another profile'
  name.title =
    document.activeElement !== omnibox ? `This tab is in the ${p.name} profile. Click to reload it in ${pick}`
    : other ? `Opens in a new tab in ${p.name} (Tab to switch)`
    : `Opens in ${p.name} (Tab to switch)`
  if (!profilePop.hidden) renderProfilePop()
}

/**
 * The profile in the address bar, clicked: with two profiles, the other one; with more, a menu.
 * While you type, it picks where what's typed opens, as Tab does. Otherwise the tab itself moves,
 * its page loading again in the profile picked.
 */
function pickProfile(id: string) {
  const active = activeTab()
  if (!S || !active) return
  setProfilePop(false)
  if (document.activeElement === omnibox) setTypedProfile(id)
  else send('set-profile', { profile: id })
}

function renderProfilePop() {
  const active = activeTab()
  if (!S || !active) return setProfilePop(false)
  const cur = typedProfile ?? active.profile
  profilePop.innerHTML = S.profiles
    .map(
      (p) =>
        `<button class="pop-item" role="menuitemradio" aria-checked="${p.id === cur}" data-profile="${esc(p.id)}" style="--pc:${esc(p.color || '#8a93a1')}"><span class="dot"></span>${esc(p.name)}</button>`,
    )
    .join('')
}

function setProfilePop(open: boolean) {
  if (open === !profilePop.hidden) return
  profilePop.hidden = !open
  $('profileName').setAttribute('aria-expanded', String(open))
  if (open) renderProfilePop()
  syncOverlay()
}

$('profileName').addEventListener('mousedown', (e) => e.preventDefault())
$('profileName').addEventListener('click', () => {
  const active = activeTab()
  if (!S || !active) return
  if (S.profiles.length > 2) return setProfilePop(!!profilePop.hidden)
  const other = S.profiles.find((p) => p.id !== (typedProfile ?? active.profile))
  if (other) pickProfile(other.id)
})
profilePop.addEventListener('mousedown', (e) => e.preventDefault())
profilePop.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-profile]')
  if (b?.dataset.profile) pickProfile(b.dataset.profile)
})
document.addEventListener('mousedown', (e) => {
  if (!profilePop.hidden && !(e.target as HTMLElement).closest('#profilePop, #profileName')) setProfilePop(false)
})

/** Tab and ⇧Tab in the address bar step through the profiles what's typed will open in. */
function cycleTypedProfile(step: number) {
  const active = activeTab()
  if (!S || !active) return
  const ids = S.profiles.map((p) => p.id)
  const i = ids.indexOf(typedProfile ?? active.profile)
  setTypedProfile(ids[(i + step + ids.length) % ids.length])
}

/** Picks the profile what's typed in the address bar opens in. */
function setTypedProfile(id: string) {
  const active = activeTab()
  if (!active) return
  typedProfile = id
  // An empty tab has nothing to lose, so it moves over right away.
  if (!active.url) send('set-profile', { profile: id })
  render()
  // The other profile has its own history, so the suggestions and any completion change too.
  if (typed && !untouched) {
    mayComplete ||= !!completion()
    requestSuggestions()
  }
  if (!suggest.hidden) showSuggestions()
}

/** Fills the address bar while it isn't being edited, masking private addresses. */
function showAddress() {
  const url = activeUrl()
  const masked = isPrivate(url)
  omnibox.value = masked ? '' : url
  omnibox.placeholder = masked ? '' : 'Search or type a tab name'
  privateMask.hidden = !masked
}

function renderThreads() {
  // Not while dragging: the dragged row has to stay in the page for its dragend to arrive.
  if (!S || dragId) return
  // Keep a rename in progress across re-renders (titles and loading states update often).
  const renameInput = document.getElementById('ren') as HTMLInputElement | null
  const draft = renameInput ? { value: renameInput.value, start: renameInput.selectionStart, end: renameInput.selectionEnd } : null

  const appNames = Object.fromEntries(Object.entries(S.apps).map(([k, l]) => [k, l.name]))
  const s = sections(S.tabs, { filter: S.filter, scope: S.scope?.key ?? null, activeId: S.activeId, now: S.now, folders: S.folders, appNames, earlierAfterMs: S.prefs.earlierAfterHours * HOUR_MS, newTabsAt: S.prefs.newTabsAt })
  const numbered = new Map(numberedThreads(s, { from: S.prefs.numberFrom, openApps: S.prefs.openApps }).map((v, i) => [v.root.id, i + 1]))
  // As in Arc, a split view is one row, where the first of its tabs comes in the sidebar; its
  // other tabs don't show again further down. Pinned tabs stay icons.
  const listed = new Map([...keptThreads(s), ...s.today, ...s.apps.flatMap((a) => [...a.threads, ...a.earlier]), ...s.earlier].map((v) => [v.root.id, v]))
  const drawn = new Set<string>()
  const tile = (v: ThreadView<UiTab>, showApp: boolean) => {
    if (drawn.has(v.root.id)) return ''
    const panes = (splitOf(S!.splits, v.root.id)?.tabs ?? []).map((id) => listed.get(id)).filter((p) => !!p)
    if (panes.length < 2) return row(v.root, v, numbered.get(v.root.id), showApp)
    for (const p of panes) drawn.add(p.root.id)
    return `<div class="split-row">${panes.map((p) => row(p.root, p, numbered.get(p.root.id), showApp)).join('')}</div>`
  }
  const block = (v: ThreadView<UiTab>) => tile(v, true)
  // Under its app's heading a tab doesn't need the app's name again.
  const appBlock = (v: ThreadView<UiTab>) => tile(v, false)
  // While filtered to a profile or an app, folders with nothing to show stay out of the way.
  const narrowed = S.filter !== 'all' || !!S.scope
  const animated = [threadsEl, pinsEl]
  beforeRender(animated)
  renderPins(s.pinned, numbered)
  let html = settingsTab
    ? `<div class="row set-row ${settingsEl.hidden ? '' : 'cur'}" role="button" tabindex="0" data-settings>
        <span class="fav">${icon('settings')}</span><span class="t">Settings</span>
        <span class="end"><button class="act" data-close-settings title="Close" aria-label="Close settings">${icon('close')}</button></span>
      </div>`
    : ''
  // A pinned tab being renamed shows as a row under the icons.
  const pinOpen = s.pinned.find((v) => renaming === v.root.id)
  if (pinOpen) html += `<div class="pin-open">${row(pinOpen.root, pinOpen)}</div>`
  // Kept has no heading: it's the top section. The strip under it takes drops to keep a thread at its bottom.
  const kept = s.top.filter((i) => !isFolder(i) || keptFolderShown(i, narrowed)).map((i) => (isFolder(i) ? folderRow(i, block, narrowed) : block(i))).join('')
  html += `<div id="kept" class="kept">${kept}</div><div class="keep-zone"></div>`
  html += `<div class="head" data-head="today">${recentLabel(S.prefs.earlierAfterHours)}</div>`
  html += s.today.map(block).join('') || `<div class="empty">Nothing here yet</div>`
  // Earlier sits at the bottom of the sidebar, away from what's current, with the way to archived
  // threads under it. Apps' sections come last, collapsed until opened.
  const archivedLink = archivedList.length
    ? `<button class="archived-link" data-show-archived title="Archived tabs">${icon('archive')}${archivedList.length.toLocaleString()} archived</button>`
    : ''
  let bottom = s.earlier.length ? `<div class="earlier-sec"><div class="head" data-head="today">Earlier</div><div class="earlier">${s.earlier.map(block).join('')}</div>${archivedLink}</div>` : archivedLink
  bottom += s.apps.map((a) => appSection(a, appBlock)).join('')
  if (bottom) html += `<div class="bottom-sec">${bottom}</div>`
  threadsEl.innerHTML = html
  afterRender(animated, {
    tabIds: S.tabs.map((t) => t.id),
    activeId: S.activeId,
    filter: `${S.filter}|${S.scope?.key ?? ''}`,
    clip: sidebarEl.getBoundingClientRect(),
  })
  revealNewTab()

  const input = document.getElementById('ren') as HTMLInputElement | null
  if (input) {
    if (draft) {
      input.value = draft.value
      input.setSelectionRange(draft.start, draft.end)
    } else input.select()
    input.focus()
  }
}

/** Tab IDs as of the last sidebar render, to tell which tabs just opened. */
let renderedTabs: Set<string> | null = null

/**
 * Scrolls the sidebar to a tab that just opened, in front or in the background, when it lands
 * above or below what's in view: beside its opener, or at the top or bottom of Today.
 */
function revealNewTab() {
  const ids = S!.tabs.map((t) => t.id)
  const fresh = renderedTabs ? ids.filter((id) => !renderedTabs!.has(id)) : []
  renderedTabs = new Set(ids)
  const id = fresh.includes(S!.activeId ?? '') ? S!.activeId! : fresh.at(-1)
  const row = id && threadsEl.querySelector<HTMLElement>(`.row[data-id="${CSS.escape(id)}"]`)
  if (!row) return
  // From the row's middle, as it may be scaling in.
  const box = threadsEl.getBoundingClientRect()
  const r = row.getBoundingClientRect()
  const top = r.top + r.height / 2 - row.offsetHeight / 2 - box.top
  const bottom = top + row.offsetHeight - threadsEl.clientHeight
  const by = top < 0 ? top : bottom > 0 ? bottom : 0
  if (by) threadsEl.scrollBy({ top: by, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' })
}

// ---------- pinned tabs ----------

const PIN_GAP = 4
/** Smallest and tallest an icon's tile gets. Tiles share a row's width, so more of them are smaller. */
const PIN_MIN = 22
const PIN_MAX = 40
/** Rows while the line under the icons is being dragged, ahead of what main has. */
let pinRowsDraft: number | null = null
let pinCount = 0

/** Columns, tile height and rows for `n` icons spread over `rows` rows, as wide as the sidebar. */
function pinLayout(n: number, rows: number) {
  const width = pinsEl.clientWidth || 240
  const maxCols = Math.max(1, Math.floor((width + PIN_GAP) / (PIN_MIN + PIN_GAP)))
  const cols = Math.max(1, Math.min(maxCols, Math.ceil(n / Math.max(1, rows))))
  const tile = (width - PIN_GAP * (cols - 1)) / cols
  const height = Math.round(Math.max(PIN_MIN, Math.min(PIN_MAX, tile)))
  const shownRows = Math.ceil(n / cols)
  return { cols, height, rows: shownRows, total: shownRows * height + (shownRows - 1) * PIN_GAP }
}

const pinRows = () => Math.max(1, Math.min(pinCount, pinRowsDraft ?? S?.prefs.pinnedRows ?? 1))

function layoutPins() {
  const l = pinLayout(pinCount, pinRows())
  pinsEl.style.setProperty('--pin-cols', String(l.cols))
  pinsEl.style.setProperty('--pin-h', `${l.height}px`)
  pinsEl.style.setProperty('--pin-icon', `${Math.round(Math.max(12, Math.min(20, l.height * 0.5)))}px`)
}

/** Pinned threads as icons above the list, sharing as many rows as the line under them was dragged to. */
function renderPins(pinned: ThreadView<UiTab>[], numbered: Map<string, number>) {
  pinCount = pinned.length
  pinDivider.hidden = !pinned.length
  pinsEl.innerHTML = pinned
    .map((v) => {
      const t = v.root
      const open = holdsActive(v)
      const n = numbered.get(t.id)
      const classes = [
        'pin-tile',
        open && settingsEl.hidden ? 'cur' : '',
        v.all.some((x) => x.loading) ? 'loading' : '',
        v.all.some((x) => x.unread) ? 'unread' : '',
        t.crashed ? 'crashed' : '',
      ].join(' ')
      const shown = open ? t : v.last
      const fav = shown.favicon || t.favicon
      const letter = esc((hostOf(t.url) || displayName(t)).charAt(0).toUpperCase())
      const away = awayFromHome(t)
      const title = `${away ? `${t.home!.title || t.home!.url} / ` : ''}${displayName(t)}${n ? ` (⌘${n})` : ''}${away && open ? '\nClick to go back to the pinned page' : ''}`
      return `<button class="${classes}" role="listitem" draggable="true" data-id="${t.id}" data-target="${open ? t.id : v.last.id}"${away ? ' data-away' : ''}
        title="${esc(title)}" aria-label="${esc(displayName(t))}" style="--pc:${esc(profile(t.profile)?.color ?? '')}">${
          fav ? `<img class="fav" src="${esc(fav)}" alt="">` : `<span class="fav letter">${letter}</span>`
        }</button>`
    })
    .join('')
  layoutPins()
}

pinsEl.addEventListener('click', (e) => {
  const tile = (e.target as HTMLElement).closest<HTMLElement>('.pin-tile')
  if (!tile) return
  showSettings(false)
  // Clicking the pinned tab you're on, once it's wandered off, takes it back to its pinned page.
  if (tile.classList.contains('cur') && tile.hasAttribute('data-away')) send('go-home', { id: tile.dataset.id })
  else send('activate', { id: tile.dataset.target })
})
pinsEl.addEventListener('contextmenu', (e) => {
  const tile = (e.target as HTMLElement).closest<HTMLElement>('.pin-tile')
  if (!tile) return
  e.preventDefault()
  send('thread-menu', { id: tile.dataset.id })
})
pinsEl.addEventListener('dragstart', (e) => {
  const tile = (e.target as HTMLElement).closest<HTMLElement>('.pin-tile')
  if (!tile) return
  startDrag(tile.dataset.id!, false, e)
})

/** Where a drag over the icons would land: beside an icon, by which half it's over, or after the last. */
function pinDrop(e: DragEvent): { el: HTMLElement; target: string | null; after: boolean } | null {
  if (!dragId || dragFolder) return null
  const tile = (e.target as HTMLElement).closest<HTMLElement>('.pin-tile')
  if (!tile) return { el: pinsEl, target: null, after: true }
  if (tile.dataset.id === dragId) return null
  const box = tile.getBoundingClientRect()
  return { el: tile, target: tile.dataset.id!, after: e.clientX > box.left + box.width / 2 }
}

pinsEl.addEventListener('dragover', (e) => {
  const at = pinDrop(e)
  if (!at) return clearDrop()
  e.preventDefault()
  const mark = !at.target ? 'dz' : at.after ? 'ins-right' : 'ins-left'
  if (!at.el.classList.contains(mark)) {
    clearDrop()
    at.el.classList.add(mark)
  }
})
pinsEl.addEventListener('drop', (e) => {
  const at = pinDrop(e)
  const id = dragId
  if (!id) return
  e.preventDefault()
  endDrag()
  if (at) send('pin-tab', { id, target: at.target, after: at.after })
})
pinsEl.addEventListener('dragend', () => endDrag())

// Dragging the line under the icons sets how many rows they share: the count whose height is nearest the pointer.
let pinDrag: { y: number; height: number } | null = null
pinDivider.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return
  pinDrag = { y: e.clientY, height: pinLayout(pinCount, pinRows()).total }
  pinRowsDraft = pinRows()
  pinDivider.setPointerCapture(e.pointerId)
  pinDivider.classList.add('dragging')
})
pinDivider.addEventListener('pointermove', (e) => {
  if (!pinDrag) return
  const want = pinDrag.height + e.clientY - pinDrag.y
  let best = 1
  for (let r = 1; r <= pinCount; r++) {
    if (Math.abs(pinLayout(pinCount, r).total - want) < Math.abs(pinLayout(pinCount, best).total - want)) best = r
  }
  if (best !== pinRowsDraft) {
    pinRowsDraft = best
    layoutPins()
  }
})
const endPinDrag = () => {
  if (!pinDrag) return
  pinDrag = null
  pinDivider.classList.remove('dragging')
  setPinnedRows(pinRowsDraft ?? 1)
}
pinDivider.addEventListener('pointerup', endPinDrag)
pinDivider.addEventListener('pointercancel', endPinDrag)
pinDivider.addEventListener('dblclick', () => setPinnedRows(1))

function setPinnedRows(rows: number) {
  pinRowsDraft = null
  if (S && S.prefs.pinnedRows !== rows) {
    S.prefs.pinnedRows = rows
    sendPrefs({ pinnedRows: rows })
  }
  layoutPins()
}

/** "Archived 3 threads · Undo" after archiving, until jbrow hides once you've seen it. */
function renderArchiveNotice() {
  const roots = S?.archiveNotice ?? null
  const el = $('archiveNotice')
  el.hidden = !roots
  if (!roots || !S) return
  $('archiveNoticeText').textContent = `Archived ${roots.length} ${roots.length === 1 ? 'tab' : 'tabs'}`
  el.title = roots.flatMap((id) => archivedById.get(id) ?? []).map(displayName).join('\n')
}

/** Heading for threads seen within the Earlier cutoff. */
function recentLabel(hours: number): string {
  if (hours <= 24) return 'Today'
  if (hours < 168) return `Last ${Math.round(hours / 24)} days`
  return 'This week'
}

/** An app's section: its heading toggles it, and collapsed it still shows the thread you're on. */
function appSection(a: AppView<UiTab>, block: (v: ThreadView<UiTab>) => string): string {
  const open = !!S?.prefs.openApps.includes(a.scope)
  const count = a.threads.length + a.earlier.length
  const icons = (S?.apps[a.scope]?.icons ?? []).map((src) => `<img src="${esc(src)}" alt="">`).join('')
  let html = `<div class="head app-head" role="button" tabindex="0" aria-expanded="${open}" data-app-head="${esc(a.scope)}" title="${esc(a.name)}">
    <span class="chev">${icon('forward')}</span>${icons ? `<span class="app-icons">${icons}</span>` : ''}<span class="app-name">${esc(a.name)}</span><span class="meta">${count}</span>
  </div>`
  const shown = (v: ThreadView<UiTab>) => open || holdsActive(v)
  html += a.threads.filter(shown).map(block).join('')
  const earlier = a.earlier.filter(shown)
  if (earlier.length) html += `<div class="earlier">${earlier.map(block).join('')}</div>`
  return html
}

function toggleApp(scope: string) {
  if (!S) return
  const open = S.prefs.openApps
  S.prefs.openApps = open.includes(scope) ? open.filter((k) => k !== scope) : [...open, scope]
  sendPrefs({ openApps: S.prefs.openApps })
  renderThreads()
}

/** A folder's row and, when open, the folders and threads inside it. */
function folderRow(v: FolderView<UiTab>, block: (v: ThreadView<UiTab>) => string, narrowed: boolean): string {
  const f = v.folder
  const count = folderThreads(v).length
  const open = !f.collapsed
  const name =
    renaming === f.id
      ? `<input class="ren" id="ren" value="${esc(f.name)}" aria-label="Folder name">`
      : `<span class="t">${esc(f.name)}</span>`
  const html = `<div class="row frow" role="button" tabindex="0" draggable="true" aria-expanded="${open}" data-folder="${f.id}">
    <span class="fav">${icon(open ? 'folderOpen' : 'folder')}</span>${name}<span class="end"><span class="meta">${count || ''}</span></span>
  </div>`
  // A collapsed folder still shows the thread you're on, and the folders down to it.
  const shown = (i: KeptItem<UiTab>) =>
    isFolder(i) ? keptFolderShown(i, narrowed) && (open || folderThreads(i).some(holdsActive)) : open || holdsActive(i)
  const body = v.items.filter(shown).map((i) => (isFolder(i) ? folderRow(i, block, narrowed) : block(i))).join('')
  return body ? `${html}<div class="folder-body">${body}</div>` : html
}

/** The thread holds the active tab, or another pane of its split. */
const holdsActive = (t: ThreadView<UiTab>) => {
  const shown = shownPanes()
  return t.all.some((x) => shown.includes(x.id))
}

/** Whether a folder shows: while narrowed to a profile or an app, only with threads to show. */
const keptFolderShown = (v: FolderView<UiTab>, narrowed: boolean) => !narrowed || folderThreads(v).length > 0

const toggleFolder = (id: string) => {
  const f = S?.folders.find((x) => x.id === id)
  if (f) send('folder', { id, collapsed: !f.collapsed })
}

function row(t: UiTab, thread: ThreadView<UiTab>, number?: number, showApp = true): string {
  if (!S) return ''
  const open = holdsActive(thread)
  const asleep = !open && isAsleep(thread.all, { now: S.now, afterMs: S.prefs.summarizeAfterDays * DAY_MS, activeId: S.activeId })
  const meta = showApp && t.scope && !S.scope ? (S.apps[t.scope]?.name ?? t.scopeName ?? '') : ''
  const key = number ? `⌘${number}` : ''
  // A kept tab on another page than its pinned one shows a slash before the title, as in Arc, and
  // its favicon turns into a way back on hover.
  const away = awayFromHome(t)
  const img = t.favicon ? `<img class="fav" src="${esc(t.favicon)}" alt="">` : `<span class="fav none"></span>`
  const fav = away
    ? `<span class="fav-home" data-home="${t.id}" title="${esc(`Back to ${t.home!.title || t.home!.url}`)}">${img}${icon('undo')}</span>`
    : img
  const name =
    renaming === t.id
      ? `<input class="ren" id="ren" value="${esc(displayName(t))}" aria-label="Tab name">`
      : `<span class="t" title="${esc(isPrivate(t.url) ? displayName(t) : t.url)}">${away ? '<span class="away">/</span>' : ''}${esc(displayName(t))}</span>`
  // A kept tab whose page is closed and back home has nothing to close.
  const closable = !t.kept || t.loaded || away
  const classes = [
    'row',
    t.id === S.activeId && settingsEl.hidden ? 'cur' : '',
    t.id !== S.activeId && settingsEl.hidden && shownPanes().includes(t.id) ? 'beside' : '',
    t.loading ? 'loading' : '',
    t.unread ? 'unread' : '',
    t.crashed ? 'crashed' : '',
    asleep ? 'asleep' : '',
  ].join(' ')
  const color = profile(t.profile)?.color ?? ''
  // A tab in a split view whose other tabs show elsewhere (an icon, or out of view) says so.
  const split = splitOf(S.splits, t.id)
  const partners = split?.tabs.filter((id) => id !== t.id).map((id) => S!.tabs.find((x) => x.id === id)).filter((x) => !!x) ?? []
  const mark = split ? `<span class="split-mark" title="${esc(`Split view with ${partners.map(displayName).join(', ')}`)}">${icon('columns')}</span>` : ''
  return `<div class="${classes}" role="button" tabindex="0" draggable="true" data-id="${t.id}" data-target="${t.id}" style="--pc:${esc(color)}">
    ${fav}${name}<span class="end">${mark}<span class="meta">${esc(meta || key)}</span>${closable ? `<button class="act" data-close="${t.id}" title="Close" aria-label="Close">${icon('close')}</button>` : ''}</span>
    ${asleep ? `<span class="sum">${esc(sleepSummary(thread, S.now))}</span>` : ''}
  </div>`
}

// ---------- suggestions ----------
// What the address bar offers is built in suggest/model.ts and drawn by the layout picked in
// settings (suggest/layout.ts); this part keeps the address bar: focus, typing, the completion,
// main's answers, and what picking something does.

/** What was typed in the address bar, without the completion added after it. */
let typed = ''
/** The text is still the address the bar showed when it got focus, so nothing counts as typed. */
let untouched = false
/** The site the address bar completed `typed` to, its rest selected after the caret. */
let completed: CompletionView | null = null
/** The last key typed at the end of the text, so a completion may follow. Deleting never completes. */
let mayComplete = false
/** Bumped with each request to main, so answers for older text are dropped. */
let suggestSeq = 0
/** Main's answers: history pages for `typed`, and the search engine's suggestions for recent text. */
let visitHits: VisitView[] = []
let searchHits: SearchReply | null = null
/** What the suggestions show now, and the layout showing it. */
let model: SuggestModel | null = null
let layout: SuggestLayout | null = null
let layoutId: UrlBarStyle | null = null

/** The profile what's typed opens in, whose history the suggestions come from. */
const typedIn = () => typedProfile ?? activeTab()?.profile
/** The completion, while it's still there as the address bar added it. Accepting it with → keeps it. */
const completion = () => (completed && omnibox.value.toLowerCase() === completed.text.toLowerCase() ? completed : null)

function requestSuggestions() {
  send('suggest', { input: typed, profile: typedIn(), seq: ++suggestSeq })
}

/** The layout settings picked, made anew when that changes. */
function suggestLayout(): SuggestLayout {
  const id = S?.prefs.urlBarStyle && LAYOUTS[S.prefs.urlBarStyle] ? S.prefs.urlBarStyle : 'columns'
  if (!layout || id !== layoutId) {
    layout = LAYOUTS[id](layoutHost)
    layoutId = id
  }
  return layout
}
const layoutHost: LayoutHost = {
  askSite: (url, profile, seq) => send('site-info', { url, profile: profile ?? typedIn(), seq }),
  focusText: () => omnibox.focus(),
}
/** The keyboard is in the address bar: its text, or a field of the layout's own in the suggestions. */
const barFocused = () => document.activeElement === omnibox || suggest.contains(document.activeElement)
/** Focus moving between the text and the suggestions' own fields, which keeps the address bar open. */
const withinBar = (to: EventTarget | null) => to instanceof Node && (to === omnibox || suggest.contains(to))

/** Draws the suggestions for what's there now. The layout keeps its selection on the same item where it can. */
function showSuggestions() {
  if (!S) return
  model = suggestModel({
    typed,
    untouched,
    completion: completion(),
    tabs: S.tabs,
    archived,
    profiles: S.profiles,
    opensIn: typedIn(),
    visits: visitHits,
    searchReply: searchHits,
    searchSuggestions: S.prefs.searchSuggestions,
    searchUrl: S.prefs.searchUrl,
    isPrivate,
  })
  if (isEmpty(model)) return hideSuggestions()
  const l = suggestLayout()
  suggest.dataset.layout = layoutId!
  l.render(suggest, model)
  suggest.hidden = false
  syncOverlay()
}
function hideSuggestions() {
  suggest.hidden = true
  syncOverlay()
}

/**
 * Completes what's typed to the site main found, Chrome's inline autocompletion: "git" becomes
 * "github.com" with "hub.com" selected, so typing on replaces it and Backspace removes it. "you"
 * means youtube.com's front page even with a YouTube tab open; that tab is a row further down.
 * Only a name you gave a tab beats it, so Return still goes to the tab you're typing the name of.
 */
function applyCompletion(c: CompletionView | null) {
  const q = typed.trim().toLowerCase()
  const named = !!q && !!S?.tabs.some((t) => t.url && t.name?.toLowerCase().split(/\s+/).some((w) => w.startsWith(q)))
  const fits = !!c && !named && c.text.toLowerCase().startsWith(typed.toLowerCase()) && c.text.length > typed.length
  completed = fits ? c : null
  const value = fits ? typed + c!.text.slice(typed.length) : typed
  if (omnibox.value !== value) omnibox.value = value
  if (fits) omnibox.setSelectionRange(typed.length, value.length)
}

/** ⇧Delete on a history page, or its ×: the page leaves the history and the suggestions. */
function forgetVisit(v: VisitItem) {
  send('forget-visit', { profile: typedIn(), url: v.url })
  visitHits = visitHits.filter((x) => x.url !== v.url)
  // The layout keeps the selection where it was, on the page that moved up.
  showSuggestions()
}

/** The page hides while anything of jbrow's own covers it; see Panel.setOverlay. */
let overlaySent = false
function syncOverlay() {
  const on = !suggest.hidden || !extPop.hidden || !dlPop.hidden || !certPop.hidden || !devicePop.hidden || !profilePop.hidden || !settingsEl.hidden || welcome.isOpen
  if (on !== overlaySent) {
    overlaySent = on
    send('overlay', { on })
  }
  syncCovering()
}

/** While jbrow's UI is above a live page, the page area turns clear so the page shows through. */
function syncCovering() {
  root.classList.toggle('covering', overlaySent && !!activeTab()?.url && !pageCovered())
}
/** Takes the keyboard out of the address bar, from its text or a field in the suggestions. */
function leaveBar() {
  if (barFocused()) (document.activeElement as HTMLElement).blur()
}
/** Does what Return does with an item. Null: what's typed, as it's typed. With `open`, opens it somewhere else instead. */
function pick(item: Item | null, open?: OpenIn) {
  const text = omnibox.value
  const opensIn = typedProfile ?? undefined
  const from = typedIn()
  const next = model?.nextProfile?.id
  hideSuggestions()
  leaveBar()
  if (item || text.trim()) showSettings(false)
  if (item && open) {
    // An open tab goes beside the active one itself; anything else opens its page.
    if (open === 'split' && item.kind === 'tab') return send('split-with', { id: item.id })
    const input = item.kind === 'address' ? item.input : item.kind === 'search' ? item.query : item.url
    const profile = open === 'profile' ? next : item.kind === 'tab' ? (item.profile?.id ?? from) : from
    return send('navigate', { input, profile, search: item.kind === 'search', open: open === 'profile' ? undefined : open })
  }
  if (item?.kind === 'tab') send('activate', { id: item.id })
  else if (item?.kind === 'archived') send('restore', { id: item.id })
  else if (item?.kind === 'site' || item?.kind === 'visit') send('navigate', { input: item.url, profile: opensIn })
  else if (item?.kind === 'address') send('navigate', { input: item.input, profile: opensIn })
  else if (item?.kind === 'search') send('navigate', { input: item.query, profile: opensIn, search: true })
  else if (text.trim()) send('navigate', { input: text, profile: opensIn })
}
/** Acts on what the layout made of a key or a click. */
function suggestOutcome(out: Outcome) {
  if (out.do === 'moved' && model) layout?.render(suggest, model)
  else if (out.do === 'pick') pick(out.item, out.open)
  else if (out.do === 'forget') forgetVisit(out.item)
  else if (out.do === 'copy') {
    hideSuggestions()
    leaveBar()
    send('copy-link', { url: out.item.url })
  }
}

omnibox.addEventListener('focus', (e) => {
  // Back from a field in the suggestions: everything stays as it was.
  if (withinBar(e.relatedTarget)) return
  // Clicking the address bar is how a private address is revealed.
  omnibox.value = activeUrl()
  omnibox.placeholder = 'Search or type a tab name'
  privateMask.hidden = true
  typedProfile = null
  renderProfileBand()
  omnibox.select()
  typed = omnibox.value
  untouched = true
  completed = null
  mayComplete = false
  visitHits = []
  searchHits = null
  suggestLayout().reset()
  requestSuggestions()
  showSuggestions()
})
omnibox.addEventListener('input', (e) => {
  const ie = e as InputEvent
  typed = omnibox.value
  untouched = false
  completed = null
  // Only typing at the end completes. Pasting doesn't, and deleting doesn't, or Backspace could
  // never take a completion away.
  mayComplete = ie.inputType === 'insertText' && !ie.isComposing && omnibox.selectionEnd === typed.length
  suggestLayout().reset()
  requestSuggestions()
  showSuggestions()
})
omnibox.addEventListener('blur', (e) => {
  if (!withinBar(e.relatedTarget)) closeBar()
})
/** The keyboard left the address bar: the suggestions go, and it shows the page's address again. */
function closeBar() {
  send('suggest-cancel')
  completed = null
  hideSuggestions()
  showAddress()
  if (typedProfile) {
    typedProfile = null
    render()
  } else renderProfileBand()
}
omnibox.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') return omnibox.blur()
  // The layout has the keys first: moving through the suggestions, Return on what's selected.
  const out = model && !suggest.hidden ? suggestLayout().key(e, model) : { do: 'none' as const }
  if (out.do !== 'none') {
    e.preventDefault()
    return suggestOutcome(out)
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    pick(null)
  } else if (e.key === 'Tab' && !e.metaKey && !e.ctrlKey && !e.altKey && (S?.profiles.length ?? 0) > 1) {
    e.preventDefault()
    cycleTypedProfile(e.shiftKey ? -1 : 1)
  }
})
// Clicks keep the keyboard in the text, except on a field of the layout's own.
suggest.addEventListener('mousedown', (e) => {
  if (!(e.target instanceof HTMLInputElement)) e.preventDefault()
})
suggest.addEventListener('click', (e) => {
  if (model) suggestOutcome(suggestLayout().click(e.target as HTMLElement, model))
})
// A field of the layout's own (preview's search field) passes its keys to the layout as the text does.
suggest.addEventListener('keydown', (e) => {
  if (!(e.target instanceof HTMLInputElement)) return
  if (e.key === 'Escape') return e.target.blur()
  const out = model ? suggestLayout().key(e, model) : { do: 'none' as const }
  if (out.do !== 'none') {
    e.preventDefault()
    suggestOutcome(out)
  }
})
suggest.addEventListener('focusout', (e) => {
  if (!withinBar(e.relatedTarget)) closeBar()
})

// ---------- sidebar interaction ----------

threadsEl.addEventListener('click', (e) => {
  const el = e.target as HTMLElement
  if (el.closest('#ren')) return
  const closeBtn = el.closest<HTMLElement>('[data-close]')
  if (closeBtn) return send('close', { id: closeBtn.dataset.close })
  const home = el.closest<HTMLElement>('[data-home]')
  if (home) {
    showSettings(false)
    return send('go-home', { id: home.dataset.home })
  }
  if (el.closest('[data-show-archived]')) return showArchived()
  if (el.closest('[data-close-settings]')) return setSettings(false)
  if (el.closest('[data-settings]')) return showSettings(true)
  const folder = el.closest<HTMLElement>('.frow')
  if (folder) return void (!renaming && toggleFolder(folder.dataset.folder!))
  const appHead = el.closest<HTMLElement>('[data-app-head]')
  if (appHead) return toggleApp(appHead.dataset.appHead!)
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
  const r = (e.target as HTMLElement).closest<HTMLElement>('.row')
  if ((e.target as HTMLElement).closest('#ren')) return
  if (r?.hasAttribute('data-settings')) return
  e.preventDefault()
  if (!r) send('sidebar-menu')
  else if (r.dataset.folder) send('folder-menu', { id: r.dataset.folder })
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
  if ((e.key === 'Enter' || e.key === ' ') && el.dataset.appHead) {
    e.preventDefault()
    return toggleApp(el.dataset.appHead)
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
  // A re-render replaces the field, which blurs it too; the new one carries on.
  const field = e.target as HTMLElement
  if (field.id === 'ren') setTimeout(() => renaming && field.isConnected && commitRename(), 0)
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
  leaveBar()
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
  startDrag(r.dataset.id ?? r.dataset.folder!, !!r.dataset.folder, e)
})

/** A row or a pinned icon starts moving; it can land in the list or among the icons. */
function startDrag(id: string, folder: boolean, e: DragEvent) {
  dragId = id
  dragFolder = folder
  threadsEl.classList.add('dragging')
  sidebarEl.classList.add('dragging')
  e.dataTransfer!.effectAllowed = 'move'
  e.dataTransfer!.setData('text/plain', id)
}

/**
 * Where a drag over the sidebar would land. In Kept, the top or bottom half of a tab's row places
 * the item before or after it, and the middle of a folder's row files it into the folder. Dropped
 * on a row or heading outside Kept, a tab leaves Kept. Folders only move within Kept, and never
 * into themselves.
 */
function dropTarget(e: DragEvent): { el: HTMLElement; where: 'before' | 'after' | 'into' | 'keep' } | null {
  const el = (e.target as HTMLElement).closest<HTMLElement>('.row:not([data-settings]), .head:not(.app-head), .keep-zone, #kept')
  if (!el || el.dataset.id === dragId || el.dataset.folder === dragId) return null
  const dragged = dragFolder ? threadsEl.querySelector(`[data-folder="${dragId}"]`)?.nextElementSibling : null
  if (dragged?.classList.contains('folder-body') && dragged.contains(el)) return null
  if (el.matches('.keep-zone, #kept')) return { el: threadsEl.querySelector<HTMLElement>('.keep-zone')!, where: 'keep' }
  if (!el.matches('#kept .row')) return dragFolder ? null : { el, where: 'into' }
  const box = el.getBoundingClientRect()
  const y = (e.clientY - box.top) / box.height
  // An open folder's bottom edge is its first item's top, so a drop there goes into the folder.
  const openFolder = !!el.dataset.folder && !!el.nextElementSibling?.classList.contains('folder-body')
  // Only a folder takes things into it; a tab's row is all above or below.
  const edge = el.dataset.folder ? 0.25 : 0.5
  if (y < edge) return { el, where: 'before' }
  if (y > 1 - edge && !openFolder) return { el, where: 'after' }
  return { el, where: el.dataset.folder ? 'into' : 'after' }
}

const DROP_MARKS = ['dz', 'ins-before', 'ins-after', 'ins-left', 'ins-right']
const clearDrop = () => sidebarEl.querySelectorAll(DROP_MARKS.map((m) => `.${m}`).join(', ')).forEach((x) => x.classList.remove(...DROP_MARKS))

function endDrag() {
  dragId = null
  dragFolder = false
  threadsEl.classList.remove('dragging')
  sidebarEl.classList.remove('dragging')
  clearDrop()
  renderThreads()
}

threadsEl.addEventListener('dragover', (e) => {
  if (!dragId) return
  const at = dropTarget(e)
  if (!at) return clearDrop()
  e.preventDefault()
  const mark = at.where === 'before' ? 'ins-before' : at.where === 'after' ? 'ins-after' : 'dz'
  if (!at.el.classList.contains(mark)) {
    clearDrop()
    at.el.classList.add(mark)
  }
})
threadsEl.addEventListener('drop', (e) => {
  if (!dragId) return
  e.preventDefault()
  const at = dropTarget(e)
  const id = dragId
  const movingFolder = dragFolder
  endDrag()
  if (!at) return
  const { el, where } = at
  if (where === 'keep') send('place', { id, target: null })
  else if (where !== 'into') send('place', { id, target: el.dataset.id ?? el.dataset.folder, after: where === 'after' })
  else if (movingFolder) send('move-folder', { id, parent: el.dataset.folder })
  else if (el.dataset.folder) send('move', { id, kept: true, folder: el.dataset.folder })
  else send('move', { id, kept: false })
})
threadsEl.addEventListener('dragend', () => endDrag())

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
// ⇧-click reloads past the cache, as in Chrome.
$('reload').addEventListener('click', (e) => {
  if (!S?.nav.loading) flourish($('reload'), 'spin')
  send('nav', S?.nav.loading ? { action: 'stop' } : { action: 'reload', hard: e.shiftKey })
})
$('pin').addEventListener('click', () => send('pin'))
$('newTab').addEventListener('click', () => {
  flourish($('newTab').querySelector('svg'), 'twirl')
  send('new')
})

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
$('manageExtensions').addEventListener('click', () => {
  setExtensions(false)
  setSettings(true, 'extensions')
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
  // Only while restyling is on and the agent it uses is installed.
  button.hidden = !S.prefs.restyleEnabled || !S.restyleAgents[S.prefs.restyleAgent]
  if (button.hidden) return setRestyle(false)
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
    const { startedAt, agent, doing } = r.running
    const tick = () => ($('restyleRunText').textContent = `${agent} is ${doing} · ${Math.round((Date.now() - startedAt) / 1000)} s`)
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
  if (open && (!S?.restyle || $('restyleButton').hidden)) return
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
const zoomRemember = $<HTMLInputElement>('zoomRemember')
const zoomSitesEl = $('zoomSites')
const pinWindow = $<HTMLInputElement>('pinWindow')
const pipOnlySites = $<HTMLTextAreaElement>('pipOnlySites')
const pipExceptSites = $<HTMLTextAreaElement>('pipExceptSites')
const quietLinks = $<HTMLInputElement>('quietLinks')
const whimsy = $<HTMLInputElement>('whimsy')
const autoUpdate = $<HTMLInputElement>('autoUpdate')
const keepLoadedPinned = $<HTMLInputElement>('keepLoadedPinned')
const keepLoadedKept = $<HTMLInputElement>('keepLoadedKept')
const dangerousSites = $<HTMLInputElement>('dangerousSites')
const blockCookies = $<HTMLInputElement>('blockThirdPartyCookies')
/** The profile Clear data… clears, or 'all'. */
let clearFrom = 'all'
const settingsSearch = $<HTMLInputElement>('settingsSearch')
const shortcutSearch = $<HTMLInputElement>('shortcutSearch')
const SECTION_NAMES: Record<string, string> = {
  general: 'General',
  appearance: 'Appearance',
  profiles: 'Profiles',
  extensions: 'Extensions',
  threads: 'Tabs',
  archived: 'Archived',
  apps: 'Apps',
  miniPlayer: 'Mini player',
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
  // So your key for closing a tab closes settings while it's the one showing.
  send('settings-shown', { on: show })
  renderThreads()
  renderPanes()
  if (show) {
    setExtensions(false)
    focusUi()
    settingsEl.focus()
    renderSettings(true)
    send('shortcuts')
    send('extensions')
    send('apps')
    send('default-browser')
    send('updates')
    // You may have installed or removed claude or codex since jbrow looked.
    send('restyle-check')
  } else {
    stopRecording()
    savePrivateUrls()
    savePipSites()
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
 * Hides what doesn't match a query. Shortcut and extension lists match row by row, keeping the extension and
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
  seg('appearance', S.prefs.appearance)
  seg('themes', S.prefs.theme)
  seg('profileStyle', S.prefs.profileStyle)
  seg('animStyle', animation.style)
  seg('animEase', animation.ease)
  seg('summarizeAfter', String(S.prefs.summarizeAfterDays))
  seg('archiveAfter', String(S.prefs.archiveAfterDays))
  seg('earlierAfter', String(S.prefs.earlierAfterHours))
  seg('numberFrom', S.prefs.numberFrom)
  seg('newTabsAt', S.prefs.newTabsAt)
  const found = S.restyleAgents
  const any = found.claude || found.codex
  restyleEnabled.checked = S.prefs.restyleEnabled
  // Can't be turned on without claude or codex, but can always be turned off.
  restyleEnabled.disabled = !S.prefs.restyleEnabled && !any
  $('restyleFound').textContent =
    found.claude === null || found.codex === null
      ? 'Looking for Claude Code and Codex…'
      : !any
        ? 'Install Claude Code (the claude command) or Codex (the codex command) and sign in to turn this on.'
        : `Found ${[found.claude && 'Claude Code', found.codex && 'Codex'].filter(Boolean).join(' and ')}.`
  $('restyleOptions').hidden = !S.prefs.restyleEnabled
  $('restyleAgent').querySelectorAll<HTMLButtonElement>('[data-value]').forEach((b) => {
    const there = found[b.dataset.value as Prefs['restyleAgent']] !== false
    b.disabled = !there
    b.title = there ? '' : 'Not installed'
  })
  seg('restyleAgent', S.prefs.restyleAgent)
  seg('restyleModel', S.prefs.restyleModel)
  const codex = S.prefs.restyleAgent === 'codex'
  $('restyleClaudeModel').hidden = codex
  $('restyleCodexModelField').hidden = !codex
  if (all || document.activeElement !== restyleCodexModel) restyleCodexModel.value = S.prefs.restyleCodexModel
  renderStyledSites()
  seg('zoomDefault', String(S.prefs.zoom.defaultPercent))
  zoomRemember.checked = S.prefs.zoom.remember
  renderZoomSites()
  renderArchived()
  renderProfiles()
  if (all || document.activeElement !== animSpeed) animSpeed.value = String(animation.durationMs)
  $('animSpeedOut').textContent = `${animSpeed.value} ms`
  for (const id of ['animSpeed', 'animEase', 'animPreview']) $(id).closest('.field')!.classList.toggle('off', animation.style === 'off')
  if (all || document.activeElement !== privateUrls) privateUrls.value = S.prefs.privateUrls.join('\n')
  hideCapture.checked = hideFromScreenCapture
  dangerousSites.checked = S.prefs.dangerousSites
  blockCookies.checked = S.prefs.blockThirdPartyCookies
  // The switch is read at launch, so a change shows until jbrow restarts.
  const pending = S.prefs.blockThirdPartyCookies !== S.thirdPartyCookiesBlocked
  $('cookiesRestart').hidden = $('restartJbrow').hidden = !pending
  const lists = S.dangerLists
  $('dangerLists').textContent = lists.updated
    ? `${lists.hosts.toLocaleString()} sites on the lists, updated ${since(lists.updated)}. From malware-filter, built from OpenPhish, PhishTank and URLhaus.`
    : "The lists haven't downloaded yet. jbrow tries again every hour."
  if (clearFrom !== 'all' && !profile(clearFrom)) clearFrom = 'all'
  const clearSeg = [{ id: 'all', name: 'All profiles', color: '' }, ...S.profiles]
    .map((x) => {
      const dot = x.color ? `<span class="dot" style="background:${esc(x.color)}"></span>` : ''
      return `<button data-value="${esc(x.id)}" aria-pressed="${x.id === clearFrom}">${dot}${esc(x.name)}</button>`
    })
    .join('')
  if ($('clearProfile').innerHTML !== clearSeg) $('clearProfile').innerHTML = clearSeg
  const mp = S.prefs.miniPlayer
  $<HTMLInputElement>('pipOnHide').checked = mp.onHide
  $<HTMLInputElement>('pipOnTabSwitch').checked = mp.onTabSwitch
  $<HTMLInputElement>('pipMutedToo').checked = mp.mutedToo
  seg('pipSites', mp.sites)
  pipOnlySites.hidden = mp.sites !== 'only'
  pipExceptSites.hidden = mp.sites !== 'except'
  $('pipSitesHelp').hidden = mp.sites === 'all'
  if (all || document.activeElement !== pipOnlySites) pipOnlySites.value = mp.onlySites.join('\n')
  if (all || document.activeElement !== pipExceptSites) pipExceptSites.value = mp.exceptSites.join('\n')
  pinWindow.checked = S.pinned
  quietLinks.checked = S.prefs.quietLinks
  whimsy.checked = S.prefs.whimsy
  autoUpdate.checked = S.prefs.autoUpdate
  keepLoadedPinned.checked = S.prefs.keepLoaded.pinned
  keepLoadedKept.checked = S.prefs.keepLoaded.kept
  renderSearchEngine(all)
  renderUrlBarStyle()
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
// The real thing: the window plays its show animation again where it is.
$('animPreview').addEventListener('click', () => send('anim-preview'))

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
function pipPrefs(change: Partial<Prefs['miniPlayer']>) {
  if (S) sendPrefs({ miniPlayer: { ...S.prefs.miniPlayer, ...change } })
}
$('pipOnHide').addEventListener('change', (e) => pipPrefs({ onHide: (e.target as HTMLInputElement).checked }))
$('pipOnTabSwitch').addEventListener('change', (e) => pipPrefs({ onTabSwitch: (e.target as HTMLInputElement).checked }))
$('pipMutedToo').addEventListener('change', (e) => pipPrefs({ mutedToo: (e.target as HTMLInputElement).checked }))
$('pipSites').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-value]')
  if (b) pipPrefs({ sites: b.dataset.value as Prefs['miniPlayer']['sites'] })
})
let pipTimer: number | undefined
function savePipSites() {
  clearTimeout(pipTimer)
  const lines = (el: HTMLTextAreaElement) => el.value.split('\n').map((l) => l.trim()).filter(Boolean)
  const onlySites = lines(pipOnlySites)
  const exceptSites = lines(pipExceptSites)
  const mp = S?.prefs.miniPlayer
  if (mp && (onlySites.join('\n') !== mp.onlySites.join('\n') || exceptSites.join('\n') !== mp.exceptSites.join('\n')))
    pipPrefs({ onlySites, exceptSites })
}
for (const el of [pipOnlySites, pipExceptSites]) {
  el.addEventListener('input', () => {
    clearTimeout(pipTimer)
    pipTimer = window.setTimeout(savePipSites, 400)
  })
  el.addEventListener('blur', savePipSites)
}
$('summarizeAfter').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-value]')
  if (b) sendPrefs({ summarizeAfterDays: Number(b.dataset.value) })
})
$('archiveAfter').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-value]')
  if (b) sendPrefs({ archiveAfterDays: Number(b.dataset.value) })
})
$('themes').innerHTML = THEMES.map(
  (t) => `<button class="theme" data-value="${t.id}" data-theme="${t.id}"><span class="theme-preview"></span>${t.name}</button>`,
).join('')
$('themes').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-value]')
  if (b) sendPrefs({ theme: b.dataset.value as Prefs['theme'] })
})
$('profileStyle').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-value]')
  if (b) sendPrefs({ profileStyle: b.dataset.value as Prefs['profileStyle'] })
})
$('appearance').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-value]')
  if (b) sendPrefs({ appearance: b.dataset.value as Prefs['appearance'] })
})
$('numberFrom').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-value]')
  if (b) sendPrefs({ numberFrom: b.dataset.value as Prefs['numberFrom'] })
})
$('newTabsAt').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-value]')
  if (b) sendPrefs({ newTabsAt: b.dataset.value as Prefs['newTabsAt'] })
})
$('earlierAfter').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-value]')
  if (b) sendPrefs({ earlierAfterHours: Number(b.dataset.value) })
})
const restyleEnabled = $<HTMLInputElement>('restyleEnabled')
restyleEnabled.addEventListener('change', () => sendPrefs({ restyleEnabled: restyleEnabled.checked }))
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
zoomRemember.addEventListener('change', () => S && sendPrefs({ zoom: { ...S.prefs.zoom, remember: zoomRemember.checked } }))
$('zoomDefault').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-value]')
  if (b && S) sendPrefs({ zoom: { ...S.prefs.zoom, defaultPercent: Number(b.dataset.value) } })
})
function renderZoomSites() {
  if (!S) return
  const next = S.zoomSites
    .map(
      ({ site, percent }) => `<div class="check"><span>${esc(site)}<em>${percent}%</em></span>
        <button class="link" data-zoom-site="${esc(site)}">Reset</button></div>`,
    )
    .join('')
  if (zoomSitesEl.innerHTML !== next) zoomSitesEl.innerHTML = next
}
zoomSitesEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-zoom-site]')
  if (b) send('zoom-reset', { site: b.dataset.zoomSite })
})

// ---------- archived ----------

const archivedListEl = $('archivedList')
const archSearch = $<HTMLInputElement>('archSearch')
const archSite = $<HTMLSelectElement>('archSite')
const archFrom = $<HTMLInputElement>('archFrom')
const archTo = $<HTMLInputElement>('archTo')
const archAll = $<HTMLInputElement>('archAll')
/** Rows added at a time, at first and as you scroll near the end. */
const ARCH_CHUNK = 150

type ArchWhen = 'any' | 'today' | 'week' | 'month' | 'older' | 'range'
/** What the Archived list shows: words that must all match, when it was archived, profile and site. */
const archFilter = { q: '', when: 'any' as ArchWhen, from: '', to: '', profile: 'all', site: '' }
/** Threads that match, newest first, and the date heading each one goes under. */
let archMatches: ArchivedThread[] = []
let archGroups: string[] = []
let archGroupCounts = new Map<string, number>()
/** Root IDs of the selected threads, all of them among the matches. */
const archSel = new Set<string>()
/** The row the arrows are on, and the one a ⇧-click selects from. Root IDs. */
let archCursor: string | null = null
let archAnchor: string | null = null
/** How many matches have rows so far. */
let archShown = 0
/** What the list was last rendered from, so state pushes that change none of it cost nothing. */
let archKey = ''
let archFilterKey = ''
let archSearchTimer: number | undefined

/** Local midnight of a `<input type=date>` value, `days` later. */
function dayStart(value: string, days = 0): number {
  const [y, m, d] = value.split('-').map(Number)
  return new Date(y, m - 1, d + days).getTime()
}

/** When a thread must have been archived to show, [from, until). */
function archRange(): [number, number] {
  const today = new Date().setHours(0, 0, 0, 0)
  const daysAgo = (n: number) => new Date(today).setDate(new Date(today).getDate() - n)
  switch (archFilter.when) {
    case 'today':
      return [today, Infinity]
    case 'week':
      return [daysAgo(6), Infinity]
    case 'month':
      return [daysAgo(29), Infinity]
    case 'older':
      return [0, daysAgo(29)]
    case 'range':
      return [archFilter.from ? dayStart(archFilter.from) : 0, archFilter.to ? dayStart(archFilter.to, 1) : Infinity]
    default:
      return [0, Infinity]
  }
}

/** The heading a thread archived at `at` goes under: Today, Yesterday, This week, then by month. */
function archGroup(at: number, today: Date): string {
  const midnight = new Date(today).setHours(0, 0, 0, 0)
  const back = (n: number) => new Date(midnight).setDate(new Date(midnight).getDate() - n)
  if (at >= midnight) return 'Today'
  if (at >= back(1)) return 'Yesterday'
  if (at >= back(6)) return 'This week'
  const d = new Date(at)
  return d.toLocaleDateString(undefined, { month: 'long', ...(d.getFullYear() !== today.getFullYear() && { year: 'numeric' }) })
}

/** "14:32" for today and yesterday, "Mon 14:32" this week, "12 Oct" before. */
function archTime(at: number): string {
  const d = new Date(at)
  const time = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const ago = Date.now() - at
  if (ago < 2 * DAY_MS) return time
  if (ago < 7 * DAY_MS) return `${d.toLocaleDateString(undefined, { weekday: 'short' })} ${time}`
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...(d.getFullYear() !== new Date().getFullYear() && { year: 'numeric' }) })
}

function archRow({ root, all, at }: ArchivedThread): string {
  const fav = root.favicon ? `<img class="fav" src="${esc(root.favicon)}" alt="">` : `<span class="fav none"></span>`
  const urls = all.map((t) => shownUrl(t.url)).join('\n')
  const color = profile(root.profile)?.color ?? ''
  return `<div class="arch-row" data-arch="${esc(root.id)}" style="--pc:${esc(color)}"><span class="arch-pick" data-pick role="checkbox" aria-checked="false" aria-label="Select" title="Select">${fav}${icon('check')}</span><span class="arch-t" title="${esc(urls)}">${esc(displayName(root))}<small>${esc(threadSummary(all))}</small></span><span class="arch-when" title="Archived ${esc(new Date(at).toLocaleString())}">${esc(archTime(at))}</span><span class="arch-acts"><button class="icon sm" data-unarchive title="Restore" aria-label="Restore">${icon('undo')}</button><button class="icon sm" data-forget title="Forget" aria-label="Forget">${icon('trash')}</button></span></div>`
}

/** Rows for matches `start` up to `end`, each date's heading before its first row. */
function archRows(start: number, end: number): string {
  let html = ''
  for (let i = start; i < Math.min(end, archMatches.length); i++) {
    const g = archGroups[i]
    if (i === 0 || archGroups[i - 1] !== g) html += `<div class="arch-head"><span>${esc(g)}</span><em>${archGroupCounts.get(g)!.toLocaleString()}</em></div>`
    html += archRow(archMatches[i])
  }
  return html
}

/**
 * The Archived list in settings: what matches the search and filters, under date headings, with
 * rows added as you scroll. Renders again only when the archived threads or the filters change.
 */
function renderArchived() {
  if (!S) return
  if (archFilter.profile !== 'all' && !profile(archFilter.profile)) archFilter.profile = 'all'
  const today = new Date()
  const filterKey = JSON.stringify(archFilter)
  const key = [archivedRev, filterKey, privateKey, today.toDateString(), S.profiles.map((p) => `${p.id}:${p.name}:${p.color}`).join()].join('|')
  if (key === archKey) return
  archKey = key
  const refiltered = filterKey !== archFilterKey
  archFilterKey = filterKey

  const cursorAt = archMatches.findIndex((a) => a.root.id === archCursor)
  const words = archFilter.q.toLowerCase().split(/\s+/).filter(Boolean)
  const [from, until] = archRange()
  const base = archivedList.filter(
    (a) => a.at >= from && a.at < until && (archFilter.profile === 'all' || a.root.profile === archFilter.profile) && words.every((w) => a.text.includes(w)),
  )
  archMatches = archFilter.site ? base.filter((a) => a.hosts.includes(archFilter.site)) : base
  archGroups = archMatches.map((a) => archGroup(a.at, today))
  archGroupCounts = new Map()
  for (const g of archGroups) archGroupCounts.set(g, (archGroupCounts.get(g) ?? 0) + 1)
  const ids = new Set(archMatches.map((a) => a.root.id))
  for (const id of archSel) if (!ids.has(id)) archSel.delete(id)
  // A row restored or forgotten from under the cursor hands it to the one that took its place.
  if (archCursor && !ids.has(archCursor)) archCursor = refiltered || cursorAt < 0 ? null : (archMatches[Math.min(cursorAt, archMatches.length - 1)]?.root.id ?? null)

  // The sites in what the other filters leave, most threads first; private ones stay out.
  const sites = new Map<string, number>()
  for (const a of base) for (const h of a.hosts) sites.set(h, (sites.get(h) ?? 0) + 1)
  const top = [...sites].filter(([h]) => !isPrivate(`https://${h}/`)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 40)
  if (archFilter.site && !sites.has(archFilter.site)) top.unshift([archFilter.site, 0])
  archSite.innerHTML =
    `<option value="">All sites</option>` +
    top.map(([h, n]) => `<option value="${esc(h)}"${h === archFilter.site ? ' selected' : ''}>${esc(h)} (${n.toLocaleString()})</option>`).join('')

  const profiles = $('archProfile')
  profiles.hidden = S.profiles.length < 2
  profiles.innerHTML = [{ id: 'all', name: 'All', color: '' }, ...S.profiles]
    .map((x) => {
      const dot = x.color ? `<span class="dot" style="background:${esc(x.color)}"></span>` : ''
      return `<button data-value="${esc(x.id)}" aria-pressed="${x.id === archFilter.profile}">${dot}${esc(x.name)}</button>`
    })
    .join('')
  $('archWhen').querySelectorAll<HTMLElement>('[data-value]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.value === archFilter.when)))
  $('archRange').hidden = archFilter.when !== 'range'

  // A new search starts at the top; a thread restored or forgotten leaves the rest where they were.
  archShown = refiltered ? ARCH_CHUNK : Math.max(ARCH_CHUNK, archShown)
  archivedListEl.innerHTML = archMatches.length
    ? archRows(0, archShown)
    : `<p class="help">${archivedList.length ? 'No archived tab matches.' : 'Nothing archived.'}</p>`
  if (refiltered && settingsEl.querySelector('.set-section.cur[data-section="archived"]')) $('setBody').scrollTop = 0
  syncArchSelection()
  moreArchived()
}

/** Adds rows while the end of the list is near the bottom of the screen. */
function moreArchived() {
  const body = $('setBody')
  if (!archivedListEl.offsetParent) return
  while (archShown < archMatches.length && archivedListEl.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom < 1000) {
    archivedListEl.insertAdjacentHTML('beforeend', archRows(archShown, archShown + ARCH_CHUNK))
    archShown += ARCH_CHUNK
    syncArchSelection()
  }
}
$('setBody').addEventListener('scroll', moreArchived, { passive: true })

/** Marks the selected rows and the cursor's, and updates the count and what acts on the selection. */
function syncArchSelection() {
  for (const el of archivedListEl.querySelectorAll<HTMLElement>('.arch-row')) {
    const on = archSel.has(el.dataset.arch!)
    el.classList.toggle('sel', on)
    el.classList.toggle('cur', el.dataset.arch === archCursor)
    el.firstElementChild!.setAttribute('aria-checked', String(on))
  }
  archivedListEl.classList.toggle('picking', archSel.size > 0)
  const n = archMatches.length
  const total = archivedList.length
  const threads = (k: number) => `${k.toLocaleString()} ${k === 1 ? 'tab' : 'tabs'}`
  $('archCount').textContent = archSel.size
    ? `${archSel.size.toLocaleString()} of ${threads(n)} selected`
    : n === total
      ? threads(total)
      : `${n.toLocaleString()} of ${threads(total)}`
  $('archSelActs').hidden = !archSel.size
  archAll.hidden = !n
  archAll.checked = !!n && archSel.size === n
  archAll.indeterminate = archSel.size > 0 && archSel.size < n
}

/** Replaces the selection (root IDs). */
function selectArchived(ids: string[]) {
  archSel.clear()
  for (const id of ids) archSel.add(id)
  syncArchSelection()
}

/** Adds the matches from one row to another, both included. */
function selectArchRange(from: string, to: string) {
  const a = archMatches.findIndex((m) => m.root.id === from)
  const b = archMatches.findIndex((m) => m.root.id === to)
  if (a < 0 || b < 0) return
  for (const m of archMatches.slice(Math.min(a, b), Math.max(a, b) + 1)) archSel.add(m.root.id)
}

/** Moves the cursor by `delta` rows; with ⇧ the rows it passes get selected. */
function moveArchCursor(delta: number, extend: boolean) {
  if (!archMatches.length) return
  const at = archMatches.findIndex((m) => m.root.id === archCursor)
  const next = at < 0 ? (delta > 0 ? 0 : archMatches.length - 1) : Math.max(0, Math.min(archMatches.length - 1, at + delta))
  archCursor = archMatches[next].root.id
  if (extend) selectArchRange(archAnchor ?? archCursor, archCursor)
  else archAnchor = archCursor
  if (next >= archShown) {
    archivedListEl.insertAdjacentHTML('beforeend', archRows(archShown, next + ARCH_CHUNK))
    archShown = next + ARCH_CHUNK
  }
  syncArchSelection()
  const row = archivedListEl.querySelector<HTMLElement>(`[data-arch="${CSS.escape(archCursor)}"]`)
  // Clear of the filters, which stay at the top as the list scrolls.
  if (row) row.style.scrollMarginTop = `${$('archBar').offsetHeight + 8}px`
  row?.scrollIntoView({ block: 'nearest' })
}

/** The search box, after a pause in typing: there can be thousands of threads to look through. */
function searchArchived(now = true) {
  clearTimeout(archSearchTimer)
  const run = () => {
    archFilter.q = archSearch.value.trim()
    renderArchived()
  }
  if (now) run()
  else archSearchTimer = window.setTimeout(run, 150)
}

/** ↑↓ move, ⇧ selects as it goes, Return opens. The list itself also has Space, ⌘A and Delete. */
function archivedKey(e: KeyboardEvent, inList: boolean) {
  const plain = !e.metaKey && !e.ctrlKey && !e.altKey
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && plain) moveArchCursor(e.key === 'ArrowDown' ? 1 : -1, e.shiftKey)
  else if (e.key === 'Enter' && plain && !e.isComposing) {
    if (archCursor) send('restore', { id: archCursor })
    else if (archMatches.length) moveArchCursor(1, false)
  } else if (!inList) return
  else if (e.key === ' ' && plain && archCursor) {
    if (!archSel.delete(archCursor)) archSel.add(archCursor)
    archAnchor = archCursor
    syncArchSelection()
  } else if (e.key === 'a' && e.metaKey) selectArchived(archMatches.map((m) => m.root.id))
  else if ((e.key === 'Backspace' || e.key === 'Delete') && plain) {
    const ids = archSel.size ? [...archSel] : archCursor ? [archCursor] : []
    if (ids.length) send('forget-archived', { ids })
  } else return
  e.preventDefault()
}

archivedListEl.addEventListener('click', (e) => {
  const el = e.target as HTMLElement
  const id = el.closest<HTMLElement>('[data-arch]')?.dataset.arch
  if (!id) return
  if (el.closest('[data-unarchive]')) return send('unarchive', { ids: [id] })
  if (el.closest('[data-forget]')) return send('forget-archived', { ids: [id] })
  // The box, ⌘-click, or any click once something is selected, picks a row; ⇧-click picks up to it.
  if (e.shiftKey && archAnchor) selectArchRange(archAnchor, id)
  else if (el.closest('[data-pick]') || e.metaKey || archSel.size) {
    if (!archSel.delete(id)) archSel.add(id)
    archAnchor = id
  } else archAnchor = id
  archCursor = id
  syncArchSelection()
})
archivedListEl.addEventListener('dblclick', (e) => {
  const el = e.target as HTMLElement
  const id = el.closest<HTMLElement>('[data-arch]')?.dataset.arch
  if (id && !el.closest('button, [data-pick]')) send('restore', { id })
})
archivedListEl.addEventListener('keydown', (e) => archivedKey(e, true))
archSearch.addEventListener('keydown', (e) => archivedKey(e, false))
archSearch.addEventListener('input', () => searchArchived(false))
archSite.addEventListener('change', () => {
  archFilter.site = archSite.value
  renderArchived()
})
$('archWhen').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-value]')
  if (!b) return
  archFilter.when = b.dataset.value as ArchWhen
  renderArchived()
  if (archFilter.when === 'range' && !archFilter.from && !archFilter.to) archFrom.focus()
})
$('archProfile').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-value]')
  if (!b) return
  archFilter.profile = b.dataset.value!
  renderArchived()
})
for (const input of [archFrom, archTo])
  input.addEventListener('change', () => {
    archFilter.from = archFrom.value
    archFilter.to = archTo.value
    renderArchived()
  })
archAll.addEventListener('change', () => selectArchived(archAll.checked ? archMatches.map((m) => m.root.id) : []))
$('archRestoreSel').addEventListener('click', () => send('unarchive', { ids: [...archSel] }))
$('archForgetSel').addEventListener('click', () => send('forget-archived', { ids: [...archSel] }))
// Typing anywhere in the Archived list goes to its search.
settingsEl.addEventListener('keydown', (e) => {
  if (section !== 'archived' || settingsSearch.value || e.metaKey || e.ctrlKey || e.altKey || e.key.length !== 1) return
  const target = e.target as HTMLElement
  if (target.closest('input, textarea, select') || (e.key === ' ' && target === archivedListEl)) return
  archSearch.focus()
})

/** ⌘F in settings: the Archived list's search while it's showing, otherwise the settings search. */
function focusSettingsSearch() {
  const box = section === 'archived' && !settingsSearch.value ? archSearch : settingsSearch
  focusUi()
  box.focus()
  box.select()
}

/** Opens settings at the Archived list, ready to search. */
function showArchived() {
  setSettings(true, 'archived')
  archSearch.focus()
  moreArchived()
}

$('undoArchive').addEventListener('click', () => send('undo-archive'))
$('dismissNotice').addEventListener('click', () => send('dismiss-archive-notice'))
hideCapture.addEventListener('change', () => sendPrefs({ hideFromScreenCapture: hideCapture.checked }))
pinWindow.addEventListener('change', () => send('pin', { on: pinWindow.checked }))
$('resetWindow').addEventListener('click', () => send('window-reset'))
$('showWelcome').addEventListener('click', () => welcome.open(false))
quietLinks.addEventListener('change', () => sendPrefs({ quietLinks: quietLinks.checked }))
// Turning it on shows what it's like straight away.
whimsy.addEventListener('change', () => {
  setWhimsy(whimsy.checked)
  sendPrefs({ whimsy: whimsy.checked })
})
autoUpdate.addEventListener('change', () => sendPrefs({ autoUpdate: autoUpdate.checked }))
keepLoadedPinned.addEventListener('change', () => sendPrefs({ keepLoaded: { ...S!.prefs.keepLoaded, pinned: keepLoadedPinned.checked } }))
keepLoadedKept.addEventListener('change', () => sendPrefs({ keepLoaded: { ...S!.prefs.keepLoaded, kept: keepLoadedKept.checked } }))
dangerousSites.addEventListener('change', () => sendPrefs({ dangerousSites: dangerousSites.checked }))
blockCookies.addEventListener('change', () => sendPrefs({ blockThirdPartyCookies: blockCookies.checked }))
$('restartJbrow').addEventListener('click', () => send('restart'))
$('clearProfile').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-value]')
  if (!b) return
  clearFrom = b.dataset.value!
  renderSettings()
})
const clearHistory = $<HTMLInputElement>('clearHistory')
const clearCookies = $<HTMLInputElement>('clearCookies')
const clearCache = $<HTMLInputElement>('clearCache')
const syncClearButton = () => ($<HTMLButtonElement>('clearData').disabled = !clearHistory.checked && !clearCookies.checked && !clearCache.checked)
clearHistory.addEventListener('change', syncClearButton)
clearCookies.addEventListener('change', syncClearButton)
clearCache.addEventListener('change', syncClearButton)
$('clearData').addEventListener('click', () =>
  send('clear-data', { profile: clearFrom, history: clearHistory.checked, cookies: clearCookies.checked, cache: clearCache.checked }),
)

// ---------- search engine ----------

const searchCustom = $<HTMLInputElement>('searchCustom')
const searchSuggestionsBox = $<HTMLInputElement>('searchSuggestions')
/** Custom was picked but no address saved yet, so the field shows even though the engine is still a listed one. */
let searchCustomOpen = false

function renderSearchEngine(all: boolean) {
  if (!S) return
  const url = S.prefs.searchUrl
  const engine = engineOf(url)
  const custom = !engine || searchCustomOpen
  const seg = [...SEARCH_ENGINES.map((e) => ({ id: e.id, name: e.name })), { id: 'custom', name: 'Custom' }]
    .map((e) => `<button data-value="${e.id}" aria-pressed="${custom ? e.id === 'custom' : e.id === engine?.id}">${esc(e.name)}</button>`)
    .join('')
  if ($('searchEngine').innerHTML !== seg) $('searchEngine').innerHTML = seg
  $('searchCustomField').hidden = !custom
  if (all || document.activeElement !== searchCustom) searchCustom.value = engine ? '' : url
  searchSuggestionsBox.checked = S.prefs.searchSuggestions
  const suggests = !!suggestUrlFor(url)
  $('searchEngineName').textContent = engine?.name ?? (suggests ? 'that site' : 'the search engine')
  searchSuggestionsBox.disabled = !suggests
  $('searchHelp').textContent = suggests ? '' : "This search address has no suggestions jbrow knows of, so nothing you type is sent until you press Return."
  $('searchHelp').hidden = suggests
}
$('searchEngine').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-value]')
  if (!b) return
  const engine = SEARCH_ENGINES.find((x) => x.id === b.dataset.value)
  searchCustomOpen = !engine
  if (engine) sendPrefs({ searchUrl: engine.url })
  else {
    renderSettings()
    searchCustom.focus()
  }
})
searchCustom.addEventListener('change', () => {
  const url = searchCustom.value.trim()
  if (!url) return
  if (!isSearchUrl(url)) return void showToast('A search address starts with https:// and has %s where the search goes.')
  searchCustomOpen = false
  sendPrefs({ searchUrl: url })
})
searchSuggestionsBox.addEventListener('change', () => sendPrefs({ searchSuggestions: searchSuggestionsBox.checked }))

/** The address bar's layouts as pictures to pick from. */
function renderUrlBarStyle() {
  if (!S) return
  const html = URL_BAR_LAYOUTS.map(
    (l) => `<button class="layout-pick" data-value="${l.id}" aria-pressed="${l.id === S!.prefs.urlBarStyle}">
      <span class="art">${layoutPictureHtml(l.id)}</span>
      <span class="t">${esc(l.name)}</span><span class="d">${esc(l.about)}</span>
    </button>`,
  ).join('')
  if ($('urlBarStyle').innerHTML !== html) $('urlBarStyle').innerHTML = html
}
$('urlBarStyle').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-value]')
  if (b) sendPrefs({ urlBarStyle: b.dataset.value as UrlBarStyle })
})
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

// ---------- updates ----------

let updateReady = false
window.jbrow.on('updates', (u: UpdateView) => {
  const checked = u.checkedAt ? ` Checked ${since(u.checkedAt)}.` : ''
  const status: Record<UpdateView['state'], string> = {
    source: `This is jbrow ${u.version} running from source, which doesn't update itself. Pull and run it again.`,
    local: `This is jbrow ${u.version}, built on this Mac, which doesn't update itself: it would replace your build with the release. Releases from GitHub do.`,
    idle: `This is jbrow ${u.version}.`,
    checking: `This is jbrow ${u.version}. Checking for a newer one…`,
    downloading: `Downloading jbrow ${u.newVersion}… ${u.percent}%`,
    ready: `jbrow ${u.newVersion} is ready. It installs when you quit, or restart now.`,
    latest: `jbrow ${u.version} is the latest.${checked}`,
    error: `This is jbrow ${u.version}. The check failed: ${u.error}`,
  }
  $('updateStatus').textContent = status[u.state]
  const button = $<HTMLButtonElement>('updateButton')
  updateReady = u.state === 'ready'
  button.hidden = u.state === 'source' || u.state === 'local' || u.state === 'downloading'
  button.disabled = u.state === 'checking'
  button.textContent = updateReady ? 'Restart to update' : 'Check now'
  autoUpdate.disabled = u.state === 'source' || u.state === 'local'
})
$('updateButton').addEventListener('click', () => send(updateReady ? 'install-update' : 'check-updates'))

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
      const count = e.threads ? `<em>${e.threads} ${e.threads === 1 ? 'tab' : 'tabs'}</em>` : ''
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

// ---------- extensions ----------

const extListEl = $('extList')
let extList: { profiles: Profile[]; extensions: ExtensionView[] } = { profiles: [], extensions: [] }

function renderExtensionList() {
  const { profiles, extensions } = extList
  const used = profiles.filter((p) => extensions.some((x) => x.profile === p.id))
  if (!used.length) {
    extListEl.innerHTML = `<p class="help">No extensions yet. Add them from the Chrome Web Store.</p>`
    return applySearch()
  }
  let html = ''
  for (const p of used) {
    if (used.length > 1) html += `<div class="ext-profile sc-profile"><span class="dot" style="background:${esc(p.color)}"></span>${esc(p.name)}</div>`
    for (const x of extensions.filter((x) => x.profile === p.id)) {
      const img = x.icon ? `<img src="${esc(x.icon)}" alt="">` : `<span class="no-icon">${esc(x.name.slice(0, 1))}</span>`
      const meta = [x.version, x.unpacked ? 'from a folder' : ''].filter(Boolean).join(' · ')
      html += `<div class="ext-row sc-row${x.enabled ? '' : ' off'}" data-ext="${esc(x.id)}" data-ext-profile="${esc(p.id)}" data-keywords="${esc(`${x.name} ${p.name}`)}">
        <span class="ext-icon">${img}</span>
        <span class="ext-name" title="${esc(x.description)}">${esc(x.name)}<small>${esc(meta)}</small></span>
        <span class="ext-acts"><button class="icon sm" data-ext-remove title="Remove" aria-label="Remove ${esc(x.name)}">${icon('trash')}</button></span>
        <input type="checkbox" data-ext-on ${x.enabled ? 'checked' : ''} title="${x.enabled ? 'Turn off' : 'Turn on'}" aria-label="${esc(x.name)} on">
      </div>`
    }
  }
  extListEl.innerHTML = html
  applySearch()
}

extListEl.addEventListener('change', (e) => {
  const box = (e.target as HTMLElement).closest<HTMLInputElement>('[data-ext-on]')
  const r = box?.closest<HTMLElement>('[data-ext]')
  if (box && r) send('extension-enabled', { profile: r.dataset.extProfile, id: r.dataset.ext, on: box.checked })
})
extListEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-ext-remove]')
  const r = b?.closest<HTMLElement>('[data-ext]')
  if (r) send('remove-extension', { profile: r.dataset.extProfile, id: r.dataset.ext })
})

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
    fixed('Jump to a tab', '⌘1–9') +
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
  const search = e.target === settingsSearch || e.target === shortcutSearch || e.target === archSearch ? (e.target as HTMLInputElement) : null
  if (search?.value) {
    search.value = ''
    if (search === archSearch) searchArchived()
    else applySearch()
  } else if (!rulesPop.hidden) closeRules()
  else if (!devicePop.hidden) answerDevice(null)
  else if (!profilePop.hidden) setProfilePop(false)
  else if (!certPop.hidden) setCert(false)
  else if (!restylePane.hidden) setRestyle(false)
  else if (!extPop.hidden) setExtensions(false)
  else if (dlOpen) setDownload(null)
  else if (!settingsEl.hidden && archSel.size) selectArchived([])
  else if (!settingsEl.hidden) setSettings(false)
})

// ---------- find in page ----------

const findBar = $('find')
const findInput = $<HTMLInputElement>('findInput')
const findCount = $('findCount')

/** Searches for what's typed: a new query from the first match, the same one a match further on. */
function find(forward = true) {
  send('find', { text: findInput.value, forward })
}

function showFindCount(matches: number, active: number) {
  findCount.textContent = findInput.value ? `${active} of ${matches}` : ''
  findBar.classList.toggle('none', !!findInput.value && matches === 0)
}

/** ⌘F: opens the bar with the last query selected and found again, or selects it if it's open. */
function openFind() {
  const reopen = findBar.hidden
  findBar.hidden = false
  focusUi()
  findInput.focus()
  findInput.select()
  if (reopen && findInput.value) find()
}

/** Closes the bar and clears the highlight; the query stays for next time. */
function closeFind(focusPage = true) {
  if (findBar.hidden) return
  findBar.hidden = true
  findCount.textContent = ''
  findBar.classList.remove('none')
  send('find-stop')
  if (focusPage) send('focus-page')
}

findInput.addEventListener('input', () => find())
findInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.isComposing) {
    e.preventDefault()
    find(!e.shiftKey)
  } else if (e.key === 'Escape') {
    // Only the bar closes, not a popover or settings behind it.
    e.stopPropagation()
    closeFind()
  }
})
$('findPrev').addEventListener('click', () => find(false))
$('findNext').addEventListener('click', () => find(true))
$('findClose').addEventListener('click', () => closeFind())

window.jbrow.on('find', (m: { open?: boolean; step?: 1 | -1; close?: boolean; matches?: number; active?: number }) => {
  // ⌘F over settings searches settings instead, or the Archived list there.
  if (m.open) {
    if (!settingsEl.hidden) focusSettingsSearch()
    else if (activeTab()?.url) openFind()
  } else if (m.step && !findBar.hidden) find(m.step === 1)
  else if (m.close) closeFind(false)
  else if (m.matches !== undefined && !findBar.hidden) showFindCount(m.matches, m.active ?? 0)
})

// ---------- sign-in (HTTP auth) ----------

const loginUser = $<HTMLInputElement>('loginUser')
const loginPass = $<HTMLInputElement>('loginPass')
/** The question the form shows, so a new one starts empty and takes focus. */
let loginShown = 0
function renderLogin() {
  const l = S?.login
  $('loginWarn').hidden = !l
  if (!l) return void (loginShown = 0)
  const realm = l.realm ? ` It says: “${esc(l.realm)}”` : ''
  $('loginText').innerHTML = `${l.proxy ? 'The proxy ' : ''}<b>${esc(l.host)}</b> wants a username and password.${realm}`
  $('loginError').hidden = !l.retry
  if (loginShown === l.id) return
  loginShown = l.id
  // After a wrong try, keep the username and retype the password.
  if (!l.retry) loginUser.value = ''
  loginPass.value = ''
  // Main hands jbrow's UI the keyboard (focusActive); this picks the field.
  ;(l.retry && loginUser.value ? loginPass : loginUser).focus()
}
$('loginForm').addEventListener('submit', (e) => {
  e.preventDefault()
  if (S?.login) send('login', { id: S.login.id, username: loginUser.value, password: loginPass.value })
  loginPass.value = ''
})
const cancelLogin = () => {
  if (S?.login) send('login', { id: S.login.id })
  loginPass.value = ''
}
$('loginCancel').addEventListener('click', cancelLogin)
$('loginForm').addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  // Esc cancels the sign-in and nothing else.
  e.stopPropagation()
  cancelLogin()
})

// ---------- crashed pages ----------

/** Why a page's process went away, from render-process-gone. */
const CRASH_REASONS: Record<string, string> = {
  crashed: 'Its process crashed.',
  oom: 'It ran out of memory.',
  killed: 'Its process was stopped, possibly by macOS to free memory.',
  'abnormal-exit': 'Its process quit unexpectedly.',
  'launch-failed': "Its process couldn't start.",
  'integrity-failure': 'Its process failed a code integrity check.',
  'memory-eviction': 'It was unloaded to free memory.',
}
function renderCrash() {
  const c = S?.crash
  $('crashWarn').hidden = !c
  if (!c) return
  const reload = keyLabel('reload') ? ` (${keyLabel('reload')})` : ''
  $('crashTitle').textContent = c.hung ? "This page isn't responding" : 'This page crashed'
  $('crashText').textContent = c.hung
    ? `You can wait for it, or reload it${reload}. Reloading loses anything you haven't saved on it.`
    : `${CRASH_REASONS[c.reason] ?? `Its process ended (${c.reason}).`} Reload to try again${reload}.`
  $('crashWait').hidden = !c.hung
}
$('crashReload').addEventListener('click', () => send('crash', { action: 'reload' }))
$('crashWait').addEventListener('click', () => send('crash', { action: 'wait' }))

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
  // Plain http has no certificate, but the button says so and still clears the site.
  const insecure = !c && S.insecure
  const button = $<HTMLButtonElement>('certButton')
  button.hidden = !c && !insecure
  $('certWarn').hidden = !c?.blocked
  if (!c) {
    if (!insecure) return setCert(false)
    return renderInsecure(button)
  }
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
  $('clearSite').hidden = c.blocked
  const key = c.chain.map((x) => x.sha256).join()
  if (key !== certPopShown) {
    certPopShown = key
    $('certChain').innerHTML = certChainHtml(c.chain)
  }
}

/** The address bar's button for a page that came over plain http. */
function renderInsecure(button: HTMLButtonElement) {
  if (button.dataset.icon !== 'warn') {
    button.dataset.icon = 'warn'
    button.innerHTML = icon('warn')
  }
  button.classList.add('bad')
  const label = "Not secure: this connection isn't encrypted"
  button.title = label
  button.setAttribute('aria-label', label)
  if (certPop.hidden) return
  let host = ''
  try {
    host = new URL(activeUrl()).host
  } catch {}
  $('certHead').textContent = `Not secure · ${host}`
  $('certStatus').textContent =
    "This page came over plain http, so anyone on the network can read or change it, including what you type into it. Don't enter passwords or card numbers here."
  $('certDistrustRow').hidden = true
  $('clearSite').hidden = false
  if (certPopShown) {
    certPopShown = ''
    $('certChain').innerHTML = ''
  }
}

function setCert(open: boolean) {
  if (open === !certPop.hidden) return
  if (open && !S?.cert && !S?.insecure) return
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
$('clearSite').addEventListener('click', () => {
  setCert(false)
  send('clear-site-data')
})
$('certBack').addEventListener('click', () => send('cert', { action: 'back' }))
$('certProceed').addEventListener('click', () => send('cert', { action: 'proceed' }))
document.addEventListener('mousedown', (e) => {
  if (!certPop.hidden && !(e.target as HTMLElement).closest('#certPop, #certButton')) setCert(false)
})

// ---------- device chooser ----------

const DEVICE_WANTS: Record<DeviceKind, string> = {
  usb: 'a USB device',
  hid: 'a HID device',
  serial: 'a serial port',
  bluetooth: 'a Bluetooth device',
}
const DEVICE_ICON: Record<DeviceKind, string> = { usb: 'usb', hid: 'keyboard', serial: 'usb', bluetooth: 'bluetooth' }

/** The list is redrawn only when it changes, so keyboard focus on a row survives. */
let devicesShown = ''
function renderDevices() {
  const d = S?.devices ?? null
  const wasOpen = !devicePop.hidden
  devicePop.hidden = !d
  if (!d) {
    devicesShown = ''
    if (wasOpen) syncOverlay()
    return
  }
  if (!wasOpen) {
    // It's anchored where the certificate details open, so they make way.
    setCert(false)
    setExtensions(false)
    syncOverlay()
  }
  $('deviceHead').innerHTML =
    `<b>${esc(d.host || 'This page')}</b>${d.embedder ? `, inside ${esc(d.embedder)},` : ''} wants to connect to ${DEVICE_WANTS[d.kind]}`
  const key = JSON.stringify([d.id, d.devices])
  if (key !== devicesShown) {
    devicesShown = key
    $('deviceList').innerHTML = d.devices
      .map(
        (c) => `<button class="pop-item" role="option" data-device="${esc(c.id)}" title="Connect">
          <span>${icon(DEVICE_ICON[d.kind])}</span>
          <span><span class="device-name">${esc(c.name)}</span>${c.detail ? `<span class="device-detail">${esc(c.detail)}</span>` : ''}</span>
        </button>`,
      )
      .join('')
  }
  const help = $('deviceHelp')
  help.hidden = d.devices.length > 0 && d.kind !== 'bluetooth'
  help.textContent =
    d.kind === 'bluetooth'
      ? d.devices.length ? 'Still looking for devices…' : 'Looking for devices…'
      : 'No compatible devices found. Connect one and it shows up here.'
  if (d.id !== deviceShownId) {
    // Focus goes to Cancel, not a device, and nothing connects for a moment: a page could time
    // the chooser, or swap a new request into one already open, to catch a click or a Return
    // you meant for something else.
    deviceShownId = d.id
    deviceOpenedAt = Date.now()
    focusUi()
    $('deviceCancel').focus()
  }
}
let deviceShownId = 0
let deviceOpenedAt = 0

/** Connects the device, or with null closes the chooser and the page's request fails. */
function answerDevice(device: string | null) {
  if (device && Date.now() - deviceOpenedAt < 600) return
  if (S?.devices) send('device', { id: S.devices.id, device })
}
$('deviceList').addEventListener('click', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-device]')
  if (row) answerDevice(row.dataset.device!)
})
devicePop.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  e.preventDefault()
  const rows = [...devicePop.querySelectorAll<HTMLElement>('[data-device]')]
  const at = rows.indexOf(document.activeElement as HTMLElement)
  rows[(at + (e.key === 'ArrowDown' ? 1 : -1) + rows.length) % rows.length]?.focus()
})
$('deviceCancel').addEventListener('click', () => answerDevice(null))
// Clicking anywhere else closes it, as in Chrome.
document.addEventListener('mousedown', (e) => {
  if (!devicePop.hidden && !(e.target as HTMLElement).closest('#devicePop')) answerDevice(null)
})

// ---------- dangerous sites ----------

let dangerShown = ''
function renderDanger() {
  if (!S) return
  const d = S.danger
  $('dangerWarn').hidden = !d
  if (!d) return
  const phishing = d.kind === 'phishing'
  $('dangerTitle').textContent = phishing ? 'Deceptive site ahead' : 'Dangerous site ahead'
  $('dangerText').innerHTML =
    `<b>${esc(d.host)}</b> ` +
    (phishing
      ? 'is on a list of phishing sites. Sites like it pose as banks, shops or sign-in pages to get your passwords or card numbers.'
      : 'is on a list of sites that spread malware. It could try to put software on your Mac that steals your information.')
  $('dangerBack').textContent = 'Back to safety'
  $('dangerMore').textContent =
    `jbrow found ${d.host} on malware-filter's ${phishing ? 'phishing list, built from OpenPhish and PhishTank' : 'malware list, built from URLhaus'}. ` +
    "If you're sure the site is safe, you can go ahead. jbrow won't warn you about it again until it quits."
  $('dangerProceed').textContent = `Go to ${d.host} anyway`
  // A new warning starts with the way past it folded away.
  if (dangerShown !== d.url) {
    dangerShown = d.url
    $<HTMLDetailsElement>('dangerDetails').open = false
  }
}
$('dangerBack').addEventListener('click', () => send('danger', { action: 'back' }))
$('dangerProceed').addEventListener('click', () => send('danger', { action: 'proceed' }))

// ---------- messages from main ----------

let toastTimer: number | undefined
window.jbrow.on('archived', setArchived)
window.jbrow.on('state', (state: UiState) => {
  // Another tab coming to the front (a new tab, ⌘1–9, a link) takes over from settings.
  if (S && S.activeId !== state.activeId) showSettings(false)
  // The find bar searches the page it opened on, so it goes when another tab comes up.
  if (S && S.activeId !== state.activeId) closeFind(false)
  if (S && !S.pinned && state.pinned) flourish($('pin').querySelector('svg'), 'wiggle')
  setWhimsy(state.prefs.whimsy)
  S = state
  document.documentElement.dataset.theme = state.prefs.theme
  document.documentElement.dataset.profileStyle = state.prefs.profileStyle
  render()
  // Another layout picked in settings takes over the open suggestions right away.
  if (!suggest.hidden && state.prefs.urlBarStyle !== layoutId) showSuggestions()
})
window.jbrow.on('suggestions', (r: SuggestReply) => {
  if (r.seq !== suggestSeq || !barFocused()) return
  visitHits = r.visits
  // Only while the text is still what was typed (or what was typed plus the last completion).
  if (mayComplete && (omnibox.value === typed || completion())) applyCompletion(r.completion)
  showSuggestions()
})
window.jbrow.on('search-suggestions', (r: SearchReply) => {
  if (r.seq !== suggestSeq || !barFocused()) return
  searchHits = r
  showSuggestions()
})
window.jbrow.on('site-info', (r: SiteInfoReply) => {
  if (layout?.siteInfo?.(r) && model && !suggest.hidden) layout.render(suggest, model)
})
window.jbrow.on('focus-omnibox', () => {
  omnibox.focus()
  omnibox.select()
})
function showToast(text: string) {
  const el = $('toast')
  el.textContent = text
  el.hidden = false
  clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => (el.hidden = true), 5000)
}
window.jbrow.on('toast', showToast)
let copiedTimer: number | undefined
window.jbrow.on('url-copied', () => {
  const el = $('copied')
  const omni = el.closest('.omni')!
  clearTimeout(copiedTimer)
  // Shown again from the start, so copying twice in a row still pops.
  el.hidden = true
  el.classList.remove('out')
  void el.offsetWidth
  el.hidden = false
  omni.classList.add('copied-flash')
  copiedTimer = window.setTimeout(() => {
    el.classList.add('out')
    omni.classList.remove('copied-flash')
    copiedTimer = window.setTimeout(() => (el.hidden = true), 250)
  }, 1200)
})
window.jbrow.on('settings', ({ open, section }: { open?: boolean; section?: string }) => setSettings(open ?? !!settingsEl.hidden, section))
window.jbrow.on('rename-tab', (id: string) => startRename(id))
window.jbrow.on('extensions', (data: typeof extList) => {
  extList = data
  renderExtensionList()
})
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
  downloadsChanged(list, (id) => dlList.querySelector(`[data-dl="${CSS.escape(id)}"]`))
})

let playRun = 0

/**
 * The main process moves, sizes and fades the window, page and all; the UI's own part is
 * materialize's blur. It starts on the first frame the window paints and tells the main process,
 * which starts moving the window then.
 */
function playIn(m: AnimMessage) {
  const run = ++playRun
  root.dataset.style = m.style
  root.style.setProperty('--dur', `${m.durationMs}ms`)
  root.style.setProperty('--ease', cssEase(m.ease))
  root.classList.add('pre')
  root.classList.remove('shown')
  void root.offsetWidth
  requestAnimationFrame(() => {
    if (run !== playRun) return
    root.classList.remove('pre')
    root.classList.add('shown')
    send('anim-start')
  })
}

window.jbrow.on('anim', (m: AnimMessage) => {
  if (m.phase === 'in') {
    // Hiding drops the overlay in the main process; settings left open needs it back.
    overlaySent = false
    syncOverlay()
    return playIn(m)
  }
  playRun++
  root.dataset.style = m.style
  root.style.setProperty('--dur', `${m.durationMs}ms`)
  root.style.setProperty('--ease', 'cubic-bezier(.4,0,1,1)')
  root.classList.remove('shown')
  // Left focused, the address bar would take focus again when the window does on the next show,
  // revealing a private address and opening the suggestions.
  omnibox.blur()
  hideSuggestions()
  setExtensions(false)
  setDownload(null)
  setRestyle(false)
  setCert(false)
  stopRecording()
  // The box only holds the list while settings is open; saving it otherwise would clear the list.
  if (!settingsEl.hidden) savePrivateUrls()
  closeRules()
  if (renaming) commitRename()
})

send('ready')
