import { esc, icon } from '../markup'
import type { KeyInput, Outcome, SuggestLayout } from './layout'
import { doesWhat, type Item, type SuggestModel } from './model'

/**
 * The columns layout: a card for what Return does, a row of searches under it, then History and
 * Your tabs side by side.
 *
 * The selection lives in a zone: none (the caret is in the text), the card, the searches, or a
 * column. ↓ and ↑ walk card → searches → column and back, and down a column; ← and → move between
 * searches, and across the columns. Once in the menu, Tab and ⇧Tab jump between sections; in the
 * text, Tab is the address bar's (it switches the profile what's typed opens in). Empty sections
 * are skipped every way.
 */

const SECTIONS = ['card', 'search', 'history', 'tabs'] as const
type Section = (typeof SECTIONS)[number]
type Zone = 'none' | Section

/** The searches, unless the card is already the search for what's typed and the engine adds nothing. */
const searchRow = (m: SuggestModel) => (m.goal?.kind === 'search' && m.goal.typed && m.searches.length < 2 ? [] : m.searches)

/** A section's items, in the order the keys walk them. */
export function sectionItems(m: SuggestModel, z: Section): Item[] {
  if (z === 'card') return m.goal ? [m.goal] : []
  if (z === 'search') return searchRow(m)
  if (z === 'history') return m.visits
  return [...m.tabs, ...m.archived]
}

const moved: Outcome = { do: 'moved' }
const none: Outcome = { do: 'none' }

export function columnsLayout(): SuggestLayout & { selection(): { zone: Zone; at: number } } {
  let zone: Zone = 'none'
  let at = 0
  /** The search ↓ from the card comes back to: the one last used. */
  let chip = 0
  /** The selected item's key, to find it again in the next model. */
  let picked = ''

  const present = (m: SuggestModel) => SECTIONS.filter((z) => sectionItems(m, z).length)
  const selected = (m: SuggestModel): Item | null => (zone === 'none' ? null : (sectionItems(m, zone)[at] ?? null))

  /** Moves the selection to item `i` of zone `z`, kept within it. */
  function go(m: SuggestModel, z: Zone, i = 0): Outcome {
    if (zone === 'search') chip = at
    zone = z
    const n = z === 'none' ? 0 : sectionItems(m, z).length
    at = Math.max(0, Math.min(i, n - 1))
    picked = selected(m)?.key ?? ''
    return moved
  }
  /** Into a section from another one: the search last used, or a column's top row. Nowhere is back in the text. */
  const into = (m: SuggestModel, z: Section | undefined) => (!z ? go(m, 'none') : z === 'search' ? go(m, 'search', chip) : go(m, z))

  /** Puts the selection back on the item it was on, after the model changed under it. */
  function restore(m: SuggestModel) {
    if (zone === 'none') return
    const list = sectionItems(m, zone)
    const i = list.findIndex((x) => x.key === picked)
    const elsewhere = i < 0 ? SECTIONS.find((z) => sectionItems(m, z).some((x) => x.key === picked)) : undefined
    if (i >= 0) at = i
    else if (elsewhere) {
      zone = elsewhere
      at = sectionItems(m, elsewhere).findIndex((x) => x.key === picked)
    } else if (list.length) at = Math.min(at, list.length - 1)
    else zone = 'none'
    picked = selected(m)?.key ?? ''
  }

  function key(e: KeyInput, m: SuggestModel): Outcome {
    if (e.metaKey || e.ctrlKey || e.altKey) return none
    const here = present(m)
    const column = zone === 'history' || zone === 'tabs'
    switch (e.key) {
      case 'Enter':
        return { do: 'pick', item: selected(m) ?? m.goal }
      case 'ArrowDown': {
        if (zone === 'none') return here.length ? into(m, here[0]) : none
        if (column) return go(m, zone, at + 1)
        // Card, searches, then History, or Your tabs when History is empty.
        const below = here.filter((z) => SECTIONS.indexOf(z) > SECTIONS.indexOf(zone as Section))
        return below.length ? into(m, below[0]) : moved
      }
      case 'ArrowUp': {
        if (zone === 'none') return none
        if (column && at > 0) return go(m, zone, at - 1)
        // A column's top row goes up to the searches, never across to the other column.
        const above = here.filter((z) => (z === 'card' || z === 'search') && SECTIONS.indexOf(z) < SECTIONS.indexOf(zone as Section))
        return into(m, above.at(-1))
      }
      case 'ArrowRight':
        if (zone === 'search') return go(m, 'search', at + 1)
        if (zone === 'history') return here.includes('tabs') ? go(m, 'tabs', at) : moved
        return column ? moved : none
      case 'ArrowLeft':
        if (zone === 'search') return go(m, 'search', at - 1)
        if (zone === 'tabs') return here.includes('history') ? go(m, 'history', at) : moved
        return column ? moved : none
      case 'Tab': {
        if (zone === 'none') return none
        const i = here.indexOf(zone)
        return into(m, here[(i + (e.shiftKey ? -1 : 1) + here.length) % here.length])
      }
      case 'Delete':
      case 'Backspace': {
        const item = selected(m)
        return e.shiftKey && item?.kind === 'visit' ? { do: 'forget', item } : none
      }
    }
    return none
  }

  return {
    reset() {
      zone = 'none'
      at = 0
      chip = 0
      picked = ''
    },
    render(box, m) {
      restore(m)
      box.innerHTML = view(m, zone, at)
    },
    key,
    click(target, m) {
      const x = target.closest<HTMLElement>('[data-forget]')
      if (x) {
        const item = m.visits[Number(x.dataset.forget)]
        return item ? { do: 'forget', item } : none
      }
      const el = target.closest<HTMLElement>('[data-zone]')
      if (!el) return none
      const item = sectionItems(m, el.dataset.zone as Section)[Number(el.dataset.i)]
      return item ? { do: 'pick', item } : none
    },
    selection: () => ({ zone, at }),
  }
}

// ---------- markup ----------

/** A favicon, or the first letter of the site, or an icon. */
export function tile(item: Item, big = false): string {
  const cls = `sx-tile${big ? ' big' : ''}`
  if (item.favicon) return `<span class="${cls}"><img src="${esc(item.favicon)}" alt=""></span>`
  if (item.kind === 'search') return `<span class="${cls}">${icon('search')}</span>`
  const from = item.kind === 'site' || item.kind === 'address' || item.kind === 'visit' ? item.host || item.title : item.title
  const letter = from.match(/[\p{L}\p{N}]/u)?.[0]?.toUpperCase()
  return `<span class="${cls}">${letter ? esc(letter) : icon('clock')}</span>`
}

/** Shown on each section once the selection is in the menu, the current one brighter: Tab moves on. */
const switchHint = (on: boolean) => `<span class="sx-switch${on ? ' on' : ''}"><kbd>Tab</kbd>to switch</span>`

function cardView(g: Item, m: SuggestModel, hi: boolean, hint: string): string {
  const title = g.kind === 'address' || (g.kind === 'search' && g.typed) ? doesWhat(g, m.engine) : g.title
  const sub = g.kind === 'tab' ? `Your tab · ${g.sub}` : g.kind === 'search' ? '' : g.sub
  const go = g.kind === 'tab' ? 'Switch' : g.kind === 'search' ? 'Search' : 'Go'
  return `<div class="sg sx-card${hi ? ' hi' : ''}" data-kind="${g.kind}" data-zone="card" data-i="0" role="option" aria-selected="${hi}">
    ${tile(g, true)}
    <span class="sx-card-text"><span class="sg-t">${esc(title)}</span>${sub ? `<span class="sx-s">${esc(sub)}</span>` : ''}</span>
    <span class="sx-card-end">${hint}<span class="sx-go">${go}${icon('enter')}</span></span>
  </div>`
}

function rowView(item: Item, i: number, z: Section, hi: boolean): string {
  const tab = item.kind === 'tab' ? item : null
  const dot = tab?.profile?.color && tab.sub.startsWith(tab.profile.name) ? `<span class="dot" style="background:${esc(tab.profile.color)}"></span>` : ''
  const end =
    item.kind === 'visit'
      ? `<span class="sx-x" role="button" data-forget="${i}" title="Remove from history (⇧Delete)" aria-label="Remove from history">${icon('close')}</span>`
      : item.kind === 'archived'
        ? `<span class="sx-end" title="Archived">${icon('archive')}</span>`
        : ''
  const url = item.kind === 'tab' || item.kind === 'archived' ? item.shownUrl : ''
  return `<button class="sg sx-row${hi ? ' hi' : ''}" data-kind="${item.kind}" data-zone="${z}" data-i="${i}" role="option" aria-selected="${hi}"${url ? ` title="${esc(url)}"` : ''}>
    ${tile(item)}<span class="sg-t">${esc(item.title)}</span><span class="sx-s">${dot}${esc(item.sub)}</span>${end}
  </button>`
}

function view(m: SuggestModel, zone: Zone, at: number): string {
  const here = SECTIONS.filter((z) => sectionItems(m, z).length)
  const menu = zone !== 'none'
  const hint = (z: Section) => (menu && here.length > 1 ? switchHint(zone === z) : '')
  const parts: string[] = []
  if (m.goal) parts.push(cardView(m.goal, m, zone === 'card', hint('card')))

  const searches = searchRow(m)
  if (searches.length)
    parts.push(`<div class="sx-search${zone === 'search' ? ' cur' : ''}">
      <span class="sx-label">Search ${esc(m.engine)}</span>
      ${searches
        .map(
          (s, i) =>
            `<button class="sg sx-chip${zone === 'search' && at === i ? ' hi' : ''}" data-kind="search" data-zone="search" data-i="${i}" role="option" aria-selected="${zone === 'search' && at === i}">${icon('search')}<span class="sg-t">${esc(s.title)}</span></button>`,
        )
        .join('')}
      ${hint('search')}
    </div>`)

  const column = (z: 'history' | 'tabs', name: string, glyph: string) => {
    const list = sectionItems(m, z)
    if (!list.length) return ''
    return `<section class="sx-col${zone === z ? ' cur' : ''}" data-col="${z}">
      <header class="sx-head">${icon(glyph)}<span>${name}</span>${hint(z)}</header>
      ${list.map((item, i) => rowView(item, i, z, zone === z && at === i)).join('')}
    </section>`
  }
  const cols = [column('history', 'History', 'clock'), column('tabs', 'Your tabs', 'copy')].filter(Boolean)
  if (cols.length) parts.push(`<div class="sx-cols${cols.length === 1 ? ' one' : ''}">${cols.join('')}</div>`)

  parts.push(footer(m, zone, here.length, zone === 'none' ? null : (sectionItems(m, zone)[at] ?? null)))
  return `<div class="sx-columns${menu ? ' in-menu' : ''}" role="listbox" aria-label="Suggestions">${parts.join('')}</div>`
}

function footer(m: SuggestModel, zone: Zone, sections: number, sel: Item | null): string {
  const does = sel ?? (zone === 'none' ? m.goal : null)
  const keys: string[] = []
  if (zone === 'none') {
    if (sections) keys.push('<span><kbd>↓</kbd>to choose</span>')
    const p = m.nextProfile
    if (p) keys.push(`<span><kbd>Tab</kbd>to open in ${p.color ? `<span class="dot" style="background:${esc(p.color)}"></span>` : ''}${esc(p.name)}</span>`)
  } else {
    keys.push('<span><kbd>↑</kbd><kbd>↓</kbd><kbd>←</kbd><kbd>→</kbd>to move</span>')
    if (sel?.kind === 'visit') keys.push('<span><kbd>⇧⌫</kbd>to remove</span>')
    keys.push('<span><kbd>esc</kbd>to close</span>')
  }
  return `<footer class="sx-foot">${does ? `<span class="sx-enter"><kbd>↵</kbd><span class="sx-does">${esc(doesWhat(does, m.engine))}</span></span>` : ''}<span class="sx-keys">${keys.join('')}</span></footer>`
}
