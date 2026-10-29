import { addressUrl, engineOf, forcedSearch } from '../../shared/engines'
import { displayName, samePage } from '../../shared/threads'
import type { CompletionView, Profile, SearchReply, TabRecord, VisitView } from '../../shared/types'
import { since } from '../markup'

/**
 * What the address bar has to offer for what's typed, sorted into groups but not laid out: each
 * layout (see layout.ts) draws the same model its own way.
 */

interface Shown {
  /** Names the item across renders, so a selection can stay on it while answers arrive. */
  key: string
  title: string
  /** A second line: an address, a profile, when. Private addresses are already masked. */
  sub: string
  favicon?: string
  /** The page it opens: a search's is the engine's results page. Never shown as it is: see shownUrl. */
  url: string
  /** `url` as it may be shown on screen: 'Private' for a private address. */
  shownUrl: string
}
/** The site the address bar completed what's typed to: "you" → youtube.com, its front page. */
export interface SiteItem extends Shown {
  kind: 'site'
  host: string
}
/** What's typed is an address, and Return goes there as typed. */
export interface AddressItem extends Shown {
  kind: 'address'
  input: string
  host: string
}
/** A search with the search engine: the typed text itself, or one of the engine's suggestions. */
export interface SearchItem extends Shown {
  kind: 'search'
  query: string
  /** The typed text, rather than a suggestion. */
  typed: boolean
}
/** A page from the history of the profile what's typed opens in. */
export interface VisitItem extends Shown {
  kind: 'visit'
  host: string
}
/** An open tab, which Return switches to. */
export interface TabItem extends Shown {
  kind: 'tab'
  id: string
  profile?: Profile
  seen: number
}
/** An archived tab, which Return restores with its thread. */
export interface ArchivedItem extends Shown {
  kind: 'archived'
  id: string
  archivedAt: number
}
export type Item = SiteItem | AddressItem | SearchItem | VisitItem | TabItem | ArchivedItem

export interface SuggestModel {
  /** What's typed, trimmed. '' when nothing is, which includes the address as it was when the bar was focused. */
  text: string
  /** The search engine as "Search <engine>" names it. */
  engine: string
  /**
   * What Return does while the caret is still in the text: the completed site, the typed address,
   * a ?search, an open tab the words match (so a tab's name finds it), or else a search for the
   * text. Null with nothing typed.
   */
  goal: Item | null
  /** A search for exactly what's typed, then the engine's suggestions. Empty with nothing typed. */
  searches: SearchItem[]
  /** History, leaving out pages already open, archived or the goal. Empty with nothing typed. */
  visits: VisitItem[]
  /** Open tabs that match, most recently seen first, leaving out the goal; the recent ones with nothing typed. */
  tabs: TabItem[]
  /** Archived tabs that match. Empty with nothing typed: they only turn up when searched for. */
  archived: ArchivedItem[]
  /** With more than one profile, the one Tab in the text sends what's typed to next. */
  nextProfile: Profile | null
}

/** What the UI knows when it builds the model. */
export interface ModelInput {
  /** The address bar's text without the completion added after it. */
  typed: string
  /** The text is still the address the bar showed when it got focus: nothing is typed yet. */
  untouched: boolean
  /** The site the text completed to, while that completion is still in the bar. */
  completion: CompletionView | null
  tabs: TabRecord[]
  archived: TabRecord[]
  profiles: Profile[]
  /** The profile what's typed opens in. */
  opensIn: string | undefined
  visits: VisitView[]
  searchReply: SearchReply | null
  searchSuggestions: boolean
  searchUrl: string
  isPrivate: (url: string) => boolean
}

const tabMatches = (t: TabRecord, q: string) => `${displayName(t)} ${t.title} ${t.url}`.toLowerCase().includes(q)
/** A page's host without www, '' for what isn't a web address. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** The search engine's name, or a custom engine's host. */
export function engineName(searchUrl: string): string {
  return engineOf(searchUrl)?.name ?? (hostOf(searchUrl.replace('%s', '')) || 'the web')
}

export function suggestModel(m: ModelInput): SuggestModel {
  const text = m.untouched ? '' : m.typed.trim()
  const q = text.toLowerCase()
  const shown = (url: string) => (m.isPrivate(url) ? 'Private' : url)
  const engine = engineName(m.searchUrl)
  const comp = q ? m.completion : null
  // Favicons of open and archived tabs stand in for a site's or a history page's, which main doesn't send.
  const favicons = new Map<string, string>()
  for (const t of [...m.archived, ...m.tabs]) if (t.favicon && t.url) favicons.set(hostOf(t.url), t.favicon)
  const multi = m.profiles.length > 1

  const openTabs = [...m.tabs].filter((t) => t.url && (!q || tabMatches(t, q))).sort((a, b) => b.lastSeen - a.lastSeen)
  const tabItem = (t: TabRecord): TabItem => {
    const p = m.profiles.find((x) => x.id === t.profile)
    return {
      kind: 'tab',
      key: `tab:${t.id}`,
      id: t.id,
      url: t.url,
      shownUrl: shown(t.url),
      title: displayName(t),
      sub: [multi ? p?.name : '', `seen ${since(t.lastSeen)}`].filter(Boolean).join(' · '),
      favicon: t.favicon,
      profile: p,
      seen: t.lastSeen,
    }
  }

  // Asks what Return will do with the text, so nothing says search where it navigates.
  const forced = forcedSearch(text)
  const query = forced ?? text
  const address = forced === undefined && !!addressUrl(text)
  const searchFor = (s: string, typed: boolean): SearchItem => {
    const url = m.searchUrl.replace('%s', encodeURIComponent(s))
    return { kind: 'search', key: `search:${s}`, query: s, typed, title: s, sub: '', url, shownUrl: shown(url) }
  }
  let goal: Item | null = null
  if (comp) {
    const host = hostOf(comp.url)
    goal = { kind: 'site', key: `site:${comp.url}`, url: comp.url, shownUrl: shown(comp.url), host, title: comp.text, sub: 'Homepage', favicon: favicons.get(host) }
  } else if (address) {
    const url = addressUrl(text)!
    const host = hostOf(url)
    goal = { kind: 'address', key: `address:${text}`, input: text, url, shownUrl: shown(url), host, title: text, sub: 'Go to this address', favicon: favicons.get(host) }
  } else if (q && forced === undefined && openTabs.length) goal = tabItem(openTabs[0])
  else if (query) goal = { ...searchFor(query, true), sub: `Search ${engine}` }

  // Older search suggestions stay while you type on, as long as they still fit what's typed.
  const sq = query.toLowerCase()
  const sh = m.searchReply
  const asked = sh ? (forcedSearch(sh.input) ?? sh.input.trim()).toLowerCase() : ''
  const exact = asked === sq
  const suggested =
    !sq || !sh || !m.searchSuggestions || !sq.startsWith(asked)
      ? []
      : sh.searches
          .filter((s) => s.toLowerCase() !== sq && (exact || s.toLowerCase().startsWith(sq)))
          .slice(0, 4)
          .map((s) => searchFor(s, false))
  const searches = query ? [searchFor(query, true), ...suggested] : []

  const goalTab = goal?.kind === 'tab' ? goal.id : ''
  const tabs = openTabs
    .filter((t) => t.id !== goalTab)
    .slice(0, q ? 5 : 8)
    .map(tabItem)
  // Archived threads only turn up when searched for.
  const archivedTabs = !q ? [] : m.archived.filter((t) => t.url && tabMatches(t, q)).sort((a, b) => (b.archivedAt ?? 0) - (a.archivedAt ?? 0))
  const archived = archivedTabs.slice(0, 3).map<ArchivedItem>((t) => ({
    kind: 'archived',
    key: `archived:${t.id}`,
    id: t.id,
    url: t.url,
    shownUrl: shown(t.url),
    title: displayName(t),
    sub: t.archivedAt ? `Archived ${since(t.archivedAt)}` : 'Archived',
    favicon: t.favicon,
    archivedAt: t.archivedAt ?? 0,
  }))
  // History leaves out pages already open or archived: their own rows bring them back as they were.
  const seen = new Set([...m.tabs, ...archivedTabs].map((t) => samePage(t.url)))
  if (comp) seen.add(samePage(comp.url))
  const visits = !q
    ? []
    : m.visits
        .filter((v) => !seen.has(samePage(v.url)) && !!seen.add(samePage(v.url)))
        .slice(0, 5)
        .map<VisitItem>((v) => {
          const host = hostOf(v.url)
          return {
            kind: 'visit',
            key: `visit:${v.url}`,
            url: v.url,
            shownUrl: shown(v.url),
            host,
            title: v.title || (m.isPrivate(v.url) ? 'Private' : v.url.replace(/^https?:\/\/(www\.)?/, '')),
            sub: shown(v.url),
            favicon: m.isPrivate(v.url) ? undefined : favicons.get(host),
          }
        })

  const ids = m.profiles.map((p) => p.id)
  const from = m.opensIn
  const nextProfile = ids.length > 1 && from ? (m.profiles[(ids.indexOf(from) + 1) % ids.length] ?? null) : null
  return { text, engine, goal, searches, visits, tabs, archived, nextProfile }
}

/** Nothing to show at all. */
export const isEmpty = (m: SuggestModel) => !m.goal && !m.searches.length && !m.visits.length && !m.tabs.length && !m.archived.length

/** What Return does with an item, for a hint like "↵ Switch to Inbox". */
export function doesWhat(item: Item, engine: string): string {
  switch (item.kind) {
    case 'site':
      return `Go to ${item.title}`
    case 'address':
      return `Go to ${item.input}`
    case 'search':
      return `Search ${engine} for "${item.query}"`
    case 'visit':
      return `Open ${item.title}`
    case 'tab':
      return `Switch to ${item.title}`
    case 'archived':
      return `Restore ${item.title}`
  }
}
