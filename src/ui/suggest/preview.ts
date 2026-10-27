import type { SiteCert, SiteInfoReply } from '../../shared/types'
import { DAY_MS, esc, HOUR_MS, icon, since } from '../markup'
import { tile } from './columns'
import type { KeyInput, LayoutHost, Outcome, SuggestLayout } from './layout'
import { doesWhat, hostOf, type Item, type SearchItem, type SuggestModel } from './model'

/**
 * The preview layout: one list of everything on the left, and beside it a panel about the
 * highlighted row (or, while the caret is in the text, about what Return does): tools to open it
 * somewhere else, then what you have of it and what jbrow knows of its site.
 *
 * The selection lives in a zone: none (the caret is in the text), the list, or the panel's tools.
 * ↓ and ↑ walk the whole list across its groups; ↑ off the top row is back in the text. → from a
 * row goes into the tools, first the search field (the keyboard moves into it, so you can type
 * there), then across the buttons; ← comes back the same way to the row. Tab belongs to the text:
 * in the list and the tools it does nothing.
 */

/** The panel's tools, in the order → walks them. */
export const TOOLS = ['search', 'tab', 'profile', 'copy', 'split'] as const
export type Tool = (typeof TOOLS)[number]
type Zone = 'none' | 'list' | 'tools'

/** The list's groups, in order, each under its header. What Return does from the text has none. */
export function groups(m: SuggestModel): { head: string; items: Item[] }[] {
  const goal = m.goal ? [m.goal] : []
  return [
    { head: '', items: goal },
    { head: 'Open tabs', items: m.tabs },
    { head: 'History', items: m.visits },
    { head: 'Archived', items: m.archived },
    // The search for what's typed isn't repeated when it's the goal on top.
    { head: `Search ${m.engine}`, items: m.searches.filter((s) => s.key !== m.goal?.key) },
  ].filter((g) => g.items.length)
}

/** The list's rows in the order ↓ walks them. */
export const listItems = (m: SuggestModel): Item[] => groups(m).flatMap((g) => g.items)

/** Whether a tool does anything for the item the panel is about. An archived tab only restores, so it can't go in split view. */
export function toolFits(t: Tool, item: Item | null, m: SuggestModel): boolean {
  if (t === 'search') return true
  if (!item) return false
  if (t === 'profile') return !!m.nextProfile
  if (t === 'split') return item.kind !== 'archived'
  return true
}

/** What a tool says it does, on its tooltip and in the footer. */
function toolName(t: Tool, m: SuggestModel): string {
  if (t === 'search') return `Search ${m.engine}`
  if (t === 'tab') return 'Open in a new tab'
  if (t === 'profile') return `Open in ${m.nextProfile?.name ?? 'another profile'}`
  if (t === 'copy') return 'Copy link'
  return 'Open in split view'
}

/** The search field's search: what's in it, or else what's typed in the address bar. */
const fieldQuery = (m: SuggestModel, field: HTMLInputElement | null) => field?.value.trim() || m.searches[0]?.query || ''

/** An address that is never sent anywhere: 'Private' is shown in its place. */
const masked = (item: Item) => item.shownUrl !== item.url
/** Main can tell about the site behind an item: a web page that isn't private, and not a search. */
const askable = (item: Item) => item.kind !== 'search' && !masked(item) && /^https?:\/\//i.test(item.url)

const moved: Outcome = { do: 'moved' }
const none: Outcome = { do: 'none' }
/** How long the highlight has to rest on a row before its site is asked about, so arrowing through doesn't ask about each. */
const ASK_DELAY = 80

export function previewLayout(host?: LayoutHost): SuggestLayout & { selection(): { zone: Zone; at: number; tool: Tool } } {
  let zone: Zone = 'none'
  let at = 0
  /** Which of TOOLS is highlighted, in the tools zone. */
  let tool = 0
  /** The selected row's key, to find it again in the next model. */
  let picked = ''
  /** The box's parts that stay from one render to the next, so the search field keeps its text and focus. */
  let field: HTMLInputElement | null = null
  let panel: HTMLElement | null = null
  /** The model last drawn, for the footer to follow the search field's text. */
  let shownModel: SuggestModel | null = null
  /** The item the panel is about, by key, and what main said about its site. */
  let about = ''
  let site: SiteInfoReply | null = null
  let seq = 0
  let asking: ReturnType<typeof setTimeout> | undefined

  const selected = (m: SuggestModel): Item | null => (zone === 'none' ? null : (listItems(m)[at] ?? null))
  /** What the panel is about: the highlighted row, or what Return does from the text. */
  const shown = (m: SuggestModel): Item | null => selected(m) ?? (zone === 'none' ? m.goal : null)
  /** A narrow window hides the panel, and its tools with it. */
  const panelShown = () => !panel || panel.offsetWidth > 0

  /** Moves the selection to row `i` of the list, kept within it, or into the text. */
  function go(m: SuggestModel, z: 'none' | 'list', i = 0): Outcome {
    zone = z
    tool = 0
    at = z === 'none' ? 0 : Math.max(0, Math.min(i, listItems(m).length - 1))
    picked = selected(m)?.key ?? ''
    return moved
  }

  /** The next tool from `from` in direction `dir` that fits the item, or -1. */
  function step(m: SuggestModel, from: number, dir: 1 | -1): number {
    for (let i = from + dir; i >= 0 && i < TOOLS.length; i += dir) if (toolFits(TOOLS[i], shown(m), m)) return i
    return -1
  }

  /** Puts the selection back on the row it was on, after the model changed under it. */
  function restore(m: SuggestModel) {
    if (zone === 'none') return
    const list = listItems(m)
    const i = list.findIndex((x) => x.key === picked)
    if (i >= 0) at = i
    else if (list.length) at = Math.min(at, list.length - 1)
    else zone = 'none'
    picked = selected(m)?.key ?? ''
    if (zone === 'tools' && !toolFits(TOOLS[tool], shown(m), m)) tool = 0
  }

  /** What a tool does with the item the panel is about. */
  function use(m: SuggestModel, t: Tool): Outcome {
    if (t === 'search') {
      const q = fieldQuery(m, field)
      // Return only needs the query; ui.ts sends it to the engine.
      const item: SearchItem = { kind: 'search', key: `search:${q}`, query: q, typed: true, title: q, sub: '', url: '', shownUrl: '' }
      return q ? { do: 'pick', item } : moved
    }
    const item = shown(m)
    if (!item || !toolFits(t, item, m)) return moved
    if (t === 'copy') return { do: 'copy', item }
    return { do: 'pick', item, open: t }
  }

  function key(e: KeyInput, m: SuggestModel): Outcome {
    if (e.metaKey || e.ctrlKey || e.altKey) return none
    const list = listItems(m)
    const inField = zone === 'tools' && tool === 0
    switch (e.key) {
      case 'Enter':
        if (zone === 'tools') return use(m, TOOLS[tool])
        return { do: 'pick', item: selected(m) ?? m.goal }
      case 'ArrowDown':
        if (zone === 'none') return list.length ? go(m, 'list') : none
        return go(m, 'list', zone === 'tools' ? at : at + 1)
      case 'ArrowUp':
        if (zone === 'none') return none
        if (zone === 'tools') return go(m, 'list', at)
        return at > 0 ? go(m, 'list', at - 1) : go(m, 'none')
      case 'ArrowRight': {
        if (zone === 'none') return none
        if (zone === 'list') {
          if (panelShown()) {
            zone = 'tools'
            tool = 0
          }
          return moved
        }
        // In the search field → moves its caret, until the caret is at the end.
        if (inField && field && field.selectionEnd !== field.value.length) return none
        const next = step(m, tool, 1)
        if (next >= 0) tool = next
        return moved
      }
      case 'ArrowLeft':
        if (zone === 'none') return none
        if (zone === 'list') return moved
        if (inField) return field && (field.selectionStart !== 0 || field.selectionEnd !== 0) ? none : go(m, 'list', at)
        tool = Math.max(0, step(m, tool, -1))
        return moved
      case 'Tab':
        // The text's Tab switches profiles; in the list and the tools it stays put.
        return zone === 'none' ? none : moved
      case 'Delete':
      case 'Backspace': {
        const item = zone === 'list' ? selected(m) : null
        return e.shiftKey && item?.kind === 'visit' ? { do: 'forget', item } : none
      }
    }
    return none
  }

  /** Asks main about the site of the item the panel is about, once the highlight rests on it. */
  function ask(item: Item | null) {
    const k = item?.key ?? ''
    if (k === about) return
    about = k
    site = null
    seq++
    clearTimeout(asking)
    if (!item || !askable(item) || !host) return
    const n = seq
    const profile = item.kind === 'tab' ? item.profile?.id : undefined
    asking = setTimeout(() => host.askSite(item.url, profile, n), ASK_DELAY)
  }

  return {
    reset() {
      zone = 'none'
      at = 0
      tool = 0
      picked = ''
      if (field) field.value = ''
    },
    render(box, m) {
      restore(m)
      shownModel = m
      if (!box.querySelector('.sp')) {
        box.innerHTML = frame()
        // The footer says what Return will search for as you type it.
        box.querySelector('.sp-field')!.addEventListener('input', () => {
          const foot = box.querySelector('.sp-left > .sx-foot')
          if (foot && shownModel) foot.outerHTML = footer(shownModel, zone, tool, shown(shownModel), fieldQuery(shownModel, field))
        })
      }
      field = box.querySelector<HTMLInputElement>('.sp-field')
      panel = box.querySelector<HTMLElement>('.sp-panel')
      const item = shown(m)
      ask(item)
      box.querySelector('.sp-list')!.innerHTML = listView(m, zone, at)
      box.querySelector('.sp-left > .sx-foot')!.outerHTML = footer(m, zone, tool, item, fieldQuery(m, field))
      box.querySelector('.sp-about')!.innerHTML = item ? aboutView(item, m, site?.url === item.url ? site : null) : ''
      field!.placeholder = m.text ? `Search ${m.engine} for “${m.text}”` : `Search ${m.engine}`
      field!.setAttribute('aria-label', `Search ${m.engine}`)
      field!.closest('.sp-find')!.classList.toggle('hi', zone === 'tools' && tool === 0)
      for (const b of box.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
        const t = b.dataset.tool as Tool
        b.hidden = t === 'profile' && !m.nextProfile
        b.disabled = !toolFits(t, item, m)
        b.classList.toggle('hi', zone === 'tools' && TOOLS[tool] === t)
        b.title = toolName(t, m)
        b.setAttribute('aria-label', b.title)
      }
      // The keyboard is in the search field while it's highlighted, and in the text otherwise.
      if (zone === 'tools' && tool === 0) {
        if (document.activeElement !== field) field!.focus()
      } else if (document.activeElement === field) host?.focusText()
    },
    key,
    click(target, m) {
      const x = target.closest<HTMLElement>('[data-forget]')
      if (x) {
        const item = listItems(m)[Number(x.dataset.forget)]
        return item?.kind === 'visit' ? { do: 'forget', item } : none
      }
      if (target.closest('.sp-find')) {
        // Clicked into the search field, which has the keyboard now. From the text, the panel was about the top row.
        if (zone === 'none') at = 0
        zone = 'tools'
        tool = 0
        picked = selected(m)?.key ?? ''
        return moved
      }
      const b = target.closest<HTMLElement>('[data-tool]')
      if (b) return use(m, b.dataset.tool as Tool)
      const row = target.closest<HTMLElement>('[data-i]')
      const item = row ? listItems(m)[Number(row.dataset.i)] : undefined
      return item ? { do: 'pick', item } : none
    },
    siteInfo(reply) {
      if (reply.seq !== seq) return false
      site = reply
      return true
    },
    selection: () => ({ zone, at, tool: TOOLS[tool] }),
  }
}

// ---------- markup ----------

/** The parts render() fills in. The tools stay put between renders, so the search field keeps its text and the keyboard. */
function frame(): string {
  const btn = (t: Tool, glyph: string) => `<button class="sp-tool" data-tool="${t}" tabindex="-1">${icon(glyph)}</button>`
  return `<div class="sp">
    <div class="sp-left">
      <div class="sp-list" role="listbox" aria-label="Suggestions"></div>
      <footer class="sx-foot"></footer>
    </div>
    <aside class="sp-panel">
      <div class="sp-tools">
        <label class="sp-find">${icon('search')}<input class="sp-field" type="text" spellcheck="false" autocomplete="off"></label>
        <div class="sp-btns">${btn('tab', 'tabPlus')}${btn('profile', 'user')}${btn('copy', 'link')}${btn('split', 'columns')}</div>
      </div>
      <div class="sp-about"></div>
    </aside>
  </div>`
}

/** How long ago, as short as a row's corner needs it: "5 min", "Yesterday", "3 d". */
export function shortAgo(ms: number, now = Date.now()): string {
  const ago = now - ms
  if (ago < 60_000) return 'now'
  if (ago < HOUR_MS) return `${Math.floor(ago / 60_000)} min`
  if (ago < DAY_MS) return `${Math.floor(ago / HOUR_MS)} h`
  if (ago < 2 * DAY_MS) return 'Yesterday'
  if (ago < 14 * DAY_MS) return `${Math.floor(ago / DAY_MS)} d`
  return `${Math.floor(ago / (7 * DAY_MS))} w`
}

/** The row's right-hand corner: a tab's profile (or when it was seen), a history page's site, when a tab was archived. */
function meta(item: Item, m: SuggestModel): string {
  switch (item.kind) {
    case 'tab': {
      const p = m.nextProfile && item.profile
      return p ? `${p.color ? `<span class="dot" style="background:${esc(p.color)}"></span>` : ''}${esc(p.name)}` : esc(shortAgo(item.seen))
    }
    case 'visit':
      return masked(item) ? '' : esc(item.host)
    case 'archived':
      return item.archivedAt ? esc(shortAgo(item.archivedAt)) : ''
    case 'search':
      return item.key === m.goal?.key ? esc(`Search ${m.engine}`) : ''
    default:
      return esc(item.sub)
  }
}

function listView(m: SuggestModel, zone: Zone, at: number): string {
  let i = 0
  return groups(m)
    .map((g) => {
      const rows = g.items.map((item) => {
        const n = i++
        const hi = zone !== 'none' && at === n
        // With the caret in the text, the top row is what Return does.
        const goal = item === m.goal
        const x =
          item.kind === 'visit'
            ? `<span class="sp-x" role="button" data-forget="${n}" title="Remove from history (⇧Delete)" aria-label="Remove from history">${icon('close')}</span>`
            : ''
        const tip = item.kind === 'search' ? '' : ` title="${esc(item.shownUrl)}"`
        return `<button class="sg sp-row${hi ? ' hi' : ''}${zone === 'list' && hi ? ' cur' : ''}${goal ? ' goal' : ''}${goal && zone === 'none' ? ' now' : ''}" data-kind="${item.kind}" data-i="${n}" role="option" aria-selected="${hi}"${tip} tabindex="-1">
          ${tile(item)}<span class="sg-t">${esc(item.title)}</span><span class="sp-meta">${meta(item, m)}</span>${x}
        </button>`
      })
      return `${g.head ? `<div class="sp-head">${esc(g.head)}</div>` : ''}${rows.join('')}`
    })
    .join('')
}

const KIND_NAMES: Record<Item['kind'], string> = {
  site: 'Homepage',
  address: 'Address',
  search: 'Search',
  visit: 'History',
  tab: 'Open tab',
  archived: 'Archived tab',
}

/** One line of facts: a name on the left, what it is on the right. `value` is markup. */
const fact = (name: string, value: string, cls = '') => `<div class="sp-fact"><span>${esc(name)}</span><span class="${cls}">${value}</span></div>`

/** What you have of it: the tab, when it was archived, that it's in your history. Only what jbrow knows. */
function yours(item: Item, m: SuggestModel): string {
  const facts: string[] = []
  if (item.kind === 'tab') {
    if (m.nextProfile && item.profile) facts.push(fact('Profile', esc(item.profile.name)))
    facts.push(fact('Seen', esc(since(item.seen))))
  } else if (item.kind === 'archived') facts.push(fact('Archived', esc(item.archivedAt ? since(item.archivedAt) : 'yes')))
  else if (item.kind === 'visit') facts.push(fact('History', 'Visited before'))
  else if (item.kind === 'search') facts.push(fact('Sent to', esc(m.engine)))
  if (!facts.length) return ''
  return `<div class="sp-facts">${item.kind === 'search' ? '' : '<div class="sp-sub">Yours</div>'}${facts.join('')}</div>`
}

/** The certificate as one line, and how it should look: fine, a warning, or wrong. */
export function certLine(c: SiteCert | undefined): [string, string] {
  if (!c || c.state === 'unknown') return ['Not checked yet', '']
  if (c.state === 'none') return ['Plain http, no certificate', 'warn']
  if (c.state === 'error') return [`${c.error ?? 'Not accepted'}${c.trusted ? ' · you chose to trust it' : ''}`, 'bad']
  const d = c.daysLeft ?? 0
  return [`Valid · ${d} day${d === 1 ? '' : 's'} left`, 'ok']
}

/** What main found out about the site: its certificate and IP address. Nothing for a private address. */
function siteView(item: Item, site: SiteInfoReply | null): string {
  const block = (rows: string) => `<div class="sp-facts sp-site"><div class="sp-sub">Site</div>${rows}</div>`
  if (masked(item) || site?.private) return block('<div class="sp-note">Private address — not looked up</div>')
  if (!askable(item)) return ''
  if (!site) return block('<div class="sp-note">Looking it up…</div>')
  const [cert, tone] = certLine(site.cert)
  const where = site.local ? (/^(127\.|::1$)/.test(site.ip ?? '') ? 'this Mac' : 'local network') : ''
  return block(
    [
      fact('Certificate', `${icon(tone === 'ok' ? 'lock' : 'warn')}${esc(cert)}`, `sp-cert ${tone}`),
      site.cert?.issuer ? fact('Issued by', esc(site.cert.issuer)) : '',
      fact('IP address', site.ip ? `<span class="sp-ip">${esc(site.ip)}</span>${where ? ` <span class="sp-where">${where}</span>` : ''}` : 'Not found'),
    ].join(''),
  )
}

function aboutView(item: Item, m: SuggestModel, site: SiteInfoReply | null): string {
  const host = item.kind === 'search' ? hostOf(item.url) : ''
  return `<span class="sp-pill" data-kind="${item.kind}">${KIND_NAMES[item.kind]}</span>
    <div class="sp-id">${tile(item, true)}<div class="sp-id-text"><span class="sp-title">${esc(item.title)}</span><span class="sp-url">${esc(item.kind === 'search' ? host || item.shownUrl : item.shownUrl)}</span></div></div>
    ${yours(item, m)}
    ${item.kind === 'search' ? '' : siteView(item, site)}`
}

function footer(m: SuggestModel, zone: Zone, tool: number, item: Item | null, query: string): string {
  const t = TOOLS[tool]
  const does =
    zone === 'tools'
      ? t === 'search'
        ? query && `Search ${m.engine} for "${query}"`
        : toolName(t, m)
      : item
        ? doesWhat(item, m.engine)
        : ''
  const keys: string[] = []
  if (zone === 'none') {
    if (listItems(m).length) keys.push('<span><kbd>↓</kbd>to choose</span>')
    const p = m.nextProfile
    if (p) keys.push(`<span><kbd>Tab</kbd>to open in ${p.color ? `<span class="dot" style="background:${esc(p.color)}"></span>` : ''}${esc(p.name)}</span>`)
  } else if (zone === 'list') {
    keys.push('<span><kbd>↑</kbd><kbd>↓</kbd>to move</span>', '<span><kbd>→</kbd>tools</span>')
    if (item?.kind === 'visit') keys.push('<span><kbd>⇧⌫</kbd>to remove</span>')
    keys.push('<span><kbd>esc</kbd>to close</span>')
  } else keys.push('<span><kbd>←</kbd><kbd>→</kbd>tools</span>', '<span><kbd>↓</kbd>list</span>', '<span><kbd>esc</kbd>to close</span>')
  return `<footer class="sx-foot">${does ? `<span class="sx-enter"><kbd>↵</kbd><span class="sx-does">${esc(does)}</span></span>` : ''}<span class="sx-keys">${keys.join('')}</span></footer>`
}
