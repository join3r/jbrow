import { app, net } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { CompletionView, VisitView } from '../shared/types'

/** One page in the browsing history. */
interface Visit {
  url: string
  title: string
  visits: number
  /** When it was last visited, in ms. */
  last: number
}

const DAY_MS = 24 * 60 * 60 * 1000
/** Pages not visited for this long are forgotten. */
const KEEP_MS = 90 * DAY_MS
/** At most this many pages per profile; the ones with the lowest frecency go first. */
const KEEP = 5000
/** The same page again this soon (a reload, a redirect back) doesn't count as another visit. */
const REVISIT_MS = 60 * 1000

/**
 * The browsing history the address bar suggests from, per profile: each page's address, title,
 * how often and when it was last visited. Kept in visits.json next to settings.json, apart from
 * history.json, which holds the tabs' back and forward lists.
 */
const visitsPath = () => path.join(app.getPath('userData'), 'visits.json')

/**
 * Frecency, roughly as Firefox does it: visits count for less the longer ago the last one was, so
 * a site you used daily last year ranks below one you opened twice this week.
 */
function frecency(v: Visit, now: number): number {
  const days = (now - v.last) / DAY_MS
  const weight = days < 4 ? 100 : days < 14 ? 70 : days < 31 ? 50 : days < 90 ? 30 : 10
  return v.visits * weight
}

/** The host without www., with its port, e.g. github.com or localhost:3000. */
function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** The address without scheme and www., as you'd type it. */
const typedForm = (url: string) => url.replace(/^https?:\/\//i, '').replace(/^www\./i, '')

export class BrowsingHistory {
  private profiles = new Map<string, Map<string, Visit>>()
  private timer: NodeJS.Timeout | null = null

  load() {
    if (!existsSync(visitsPath())) return
    try {
      const data = JSON.parse(readFileSync(visitsPath(), 'utf8')) as Record<string, Visit[]>
      for (const [profile, list] of Object.entries(data)) {
        this.profiles.set(profile, new Map(list.filter((v) => v.url).map((v) => [v.url, v])))
      }
      this.prune()
    } catch (error) {
      console.error('[visits] could not read visits.json, starting without history:', error)
    }
  }

  /** Writes a little later, so a burst of page loads is one write. */
  private save() {
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), 5000)
  }

  flush() {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.prune()
    const data = Object.fromEntries([...this.profiles].map(([profile, map]) => [profile, [...map.values()]]))
    writeFileSync(visitsPath(), JSON.stringify(data))
  }

  /** Drops pages older than 90 days, then the lowest-ranked ones over the cap. */
  private prune() {
    const now = Date.now()
    for (const [profile, map] of this.profiles) {
      for (const [url, v] of map) if (now - v.last > KEEP_MS) map.delete(url)
      if (map.size > KEEP) {
        const keep = [...map.values()].sort((a, b) => frecency(b, now) - frecency(a, now)).slice(0, KEEP)
        this.profiles.set(profile, new Map(keep.map((v) => [v.url, v])))
      }
      if (!map.size) this.profiles.delete(profile)
    }
  }

  /** A tab's page committed a navigation. Only web pages are remembered. */
  record(profile: string, url: string, title: string) {
    if (!/^https?:/i.test(url)) return
    let map = this.profiles.get(profile)
    if (!map) this.profiles.set(profile, (map = new Map()))
    const now = Date.now()
    const v = map.get(url)
    if (!v) map.set(url, { url, title, visits: 1, last: now })
    else {
      if (now - v.last > REVISIT_MS) v.visits++
      v.last = now
      if (title) v.title = title
    }
    this.save()
  }

  /** The page's title arrived after it loaded. */
  setTitle(profile: string, url: string, title: string) {
    const v = this.profiles.get(profile)?.get(url)
    if (v && title && v.title !== title) {
      v.title = title
      this.save()
    }
  }

  /** Removes one page, as ⇧Delete on a suggestion does. */
  forget(profile: string, url: string) {
    if (this.profiles.get(profile)?.delete(url)) this.flush()
  }

  /** Clears one profile's history, or every profile's with 'all'. */
  clear(profile: string) {
    if (profile === 'all') this.profiles.clear()
    else this.profiles.delete(profile)
    this.flush()
  }

  /**
   * Pages whose address or title contains every word typed. Pages whose host starts with what's
   * typed come first, then ones where a word of the title does, each by frecency.
   */
  search(profile: string, query: string, limit: number): VisitView[] {
    const q = query.trim().toLowerCase()
    const map = this.profiles.get(profile)
    if (!q || !map) return []
    const words = q.split(/\s+/)
    const now = Date.now()
    const hits: { v: Visit; tier: number; score: number }[] = []
    for (const v of map.values()) {
      const address = typedForm(v.url).toLowerCase()
      const title = v.title.toLowerCase()
      const text = `${address} ${title}`
      if (!words.every((w) => text.includes(w))) continue
      const tier = address.startsWith(q) || hostOf(v.url).startsWith(q) ? 0 : title.startsWith(q) || title.includes(` ${words[0]}`) ? 1 : 2
      hits.push({ v, tier, score: frecency(v, now) })
    }
    return hits
      .sort((a, b) => a.tier - b.tier || b.score - a.score || a.v.url.length - b.v.url.length)
      .slice(0, limit)
      .map(({ v }) => ({ url: v.url, title: v.title }))
  }

  /**
   * The site to complete what's typed to in the address bar, Chrome's inline autocompletion:
   * the host starting with it that you visit most. Only for a host prefix with nothing after it,
   * and never a private address, which would show it on screen.
   */
  completion(profile: string, typed: string, isPrivate: (url: string) => boolean): CompletionView | null {
    const t = typed.toLowerCase()
    const map = this.profiles.get(profile)
    if (!t || !map || /[\s/?#]/.test(t)) return null
    const www = t.startsWith('www.')
    const now = Date.now()
    const hosts = new Map<string, { score: number; best: Visit; bestScore: number }>()
    for (const v of map.values()) {
      if (isPrivate(v.url)) continue
      const host = hostOf(v.url)
      const shown = www ? `www.${host}` : host
      if (!shown.startsWith(t) || shown === t) continue
      const score = frecency(v, now)
      const h = hosts.get(host)
      if (!h) hosts.set(host, { score, best: v, bestScore: score })
      else {
        h.score += score
        if (score > h.bestScore) Object.assign(h, { best: v, bestScore: score })
      }
    }
    let pick: [string, { score: number; best: Visit }] | undefined
    // On a tie the shorter host wins: "gi" means github.com before gist.github.com.
    for (const entry of hosts) {
      if (!pick || entry[1].score > pick[1].score || (entry[1].score === pick[1].score && entry[0].length < pick[0].length)) pick = entry
    }
    if (!pick) return null
    const [host, { best }] = pick
    // The site's front page, over the scheme it was visited with: http stays http.
    const url = `${new URL(best.url).protocol}//${new URL(best.url).host}/`
    return { text: www ? `www.${host}` : host, url }
  }
}

/**
 * Asks the search engine what people search for starting with `query`. Empty when it answers with
 * something else; rejects when the request fails or is aborted.
 */
export async function fetchSearchSuggestions(suggestUrl: string, query: string, signal: AbortSignal): Promise<string[]> {
  const res = await net.fetch(suggestUrl.replace('%s', encodeURIComponent(query)), {
    signal,
    // No cookies of any kind: the suggestions shouldn't know who's asking.
    credentials: 'omit',
    cache: 'no-store',
  })
  if (!res.ok) return []
  const data = (await res.json()) as unknown
  if (!Array.isArray(data) || !Array.isArray(data[1])) return []
  return (data[1] as unknown[]).filter((s): s is string => typeof s === 'string' && !!s.trim())
}
