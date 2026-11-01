import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { DatabaseSync, type SQLInputValue } from 'node:sqlite'
import type {
  HistoryQuery,
  HistoryReply,
  HistorySearch,
  HistorySite,
  HistoryTrail,
  HistoryVisit,
  HistoryWhen,
  Profile,
  VisitHow,
} from '../shared/types'

/**
 * Every visit, for the history page: when, how you got there, the trail of pages it was part of and
 * how long it was in front, with each page's text for finding it by what it said. Kept for a year
 * in history.sqlite next to settings.json. The address bar's suggestions still come from
 * visits.json (BrowsingHistory), which keeps one line per page.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const KEEP_MS = 365 * DAY_MS
/** The same page again in the same tab this soon (a reload) isn't another visit. */
const REVISIT_MS = 30 * 60 * 1000
/** A page left this soon for another, without you asking, was a redirect or a sign-in. */
const REDIRECT_MS = 3000
/** Seconds in front that count as having read a page. */
const READ_SECS = 60
/** At most this much of a page's text is kept. */
export const TEXT_CHARS = 30000

/** A tab's page now: its visit and the trail it's in. */
interface Current {
  profile: string
  visit: number
  trail: number
  url: string
  at: number
  how: VisitHow
  parent: number | null
  app?: string
  /** You clicked or typed in the page, so leaving it wasn't a redirect. */
  touched?: boolean
}

export interface HistoryLogDeps {
  /** The tab a tab was opened from, if it was. */
  openerOf: (tabId: string) => string | undefined
  /** What was searched, if `url` is a search engine's results page. */
  searchOf: (url: string) => { query: string; engine: string } | undefined
}

/** Context for a query: which pages are open or kept, by profile and address, and the profiles. */
export interface QueryContext {
  open: Set<string>
  kept: Set<string>
  profiles: Profile[]
  now?: number
}

export const pageKey = (profile: string, url: string) => `${profile}\n${url}`

const hostOf = (url: string) => {
  try {
    return new URL(url).host.replace(/^www\./, '')
  } catch {
    return ''
  }
}

/** Midnight `days` days before the one starting today, in local time. */
function dayStart(now: number, daysBack: number): number {
  const d = new Date(now)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - daysBack).getTime()
}

export function whenCutoff(when: HistoryWhen, now: number): number {
  if (when === 'today') return dayStart(now, 0)
  if (when === 'yesterday') return dayStart(now, 1)
  if (when === 'week') return dayStart(now, 6)
  if (when === 'month') return dayStart(now, 29)
  return now - KEEP_MS
}

const WHENS: HistoryWhen[] = ['today', 'yesterday', 'week', 'month', 'all']

/** A word for an FTS5 query: quoted, matching words that start with it. */
const ftsWord = (w: string) => `"${w.replace(/"/g, '""')}"*`
const likeWord = (w: string) => `%${w.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

type Row = Record<string, SQLInputValue>
type Facet = 'when' | 'profile' | 'how' | 'sites' | 'state'

export class HistoryLog {
  private db: DatabaseSync | null = null
  private current = new Map<string, Current>()
  private intents = new Map<string, { how: VisitHow; app?: string }>()

  constructor(private deps: HistoryLogDeps) {}

  open(file: string) {
    mkdirSync(path.dirname(file), { recursive: true })
    const db = new DatabaseSync(file)
    db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS visits (
        id INTEGER PRIMARY KEY,
        profile TEXT NOT NULL,
        url TEXT NOT NULL,
        title TEXT NOT NULL DEFAULT '',
        host TEXT NOT NULL,
        at INTEGER NOT NULL,
        secs INTEGER NOT NULL DEFAULT 0,
        how TEXT NOT NULL,
        app TEXT,
        query TEXT,
        engine TEXT,
        trail INTEGER,
        parent INTEGER,
        redirect INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS visits_at ON visits (at);
      CREATE INDEX IF NOT EXISTS visits_page ON visits (profile, url);
      CREATE INDEX IF NOT EXISTS visits_trail ON visits (trail);
      CREATE INDEX IF NOT EXISTS visits_parent ON visits (parent);
      CREATE VIRTUAL TABLE IF NOT EXISTS texts USING fts5 (profile UNINDEXED, url UNINDEXED, title, body, tokenize = 'unicode61 remove_diacritics 2');
    `)
    this.db = db
    this.prune()
  }

  close() {
    this.db?.close()
    this.db = null
  }

  /** Drops visits older than a year, and the text of pages with no visits left. */
  prune(now = Date.now()) {
    const db = this.db
    if (!db) return
    db.prepare('DELETE FROM visits WHERE at < ?').run(now - KEEP_MS)
    this.dropOrphanTexts()
  }

  private dropOrphanTexts() {
    this.db?.exec(`DELETE FROM texts WHERE rowid IN (
      SELECT t.rowid FROM texts t WHERE NOT EXISTS (SELECT 1 FROM visits v WHERE v.profile = t.profile AND v.url = t.url))`)
  }

  // ---------- recording ----------

  /** The next page this tab loads was typed, searched for or came from another app. */
  intend(tabId: string, how: 'typed' | 'app', app?: string) {
    this.intents.set(tabId, { how, app })
  }

  /** The tab closed. */
  forgetTab(tabId: string) {
    this.current.delete(tabId)
    this.intents.delete(tabId)
  }

  /**
   * A tab's page went to `url`. Returns the visit's ID, or null when it isn't one: not a web
   * page, or the same page again in the same tab (a reload).
   */
  visit(tabId: string, profile: string, url: string, now = Date.now()): number | null {
    const db = this.db
    if (!db || !/^https?:/i.test(url)) return null
    const cur = this.current.get(tabId)
    const intent = this.intents.get(tabId)
    this.intents.delete(tabId)
    if (!intent && cur && cur.url === url && now - cur.at < REVISIT_MS) return null
    const search = this.deps.searchOf(url)
    let how: VisitHow
    let parent: number | null = null
    let trail: number | null = null
    let intentApp = intent?.app
    if (intent) how = intent.how === 'typed' && search ? 'search' : intent.how
    else if (cur && !cur.touched && now - cur.at < REDIRECT_MS) {
      // Left within seconds for a page it went to on its own: a redirect, which hands this page
      // how it was reached and where from.
      db.prepare('UPDATE visits SET redirect = 1 WHERE id = ? AND secs < 3').run(cur.visit)
      how = cur.how
      parent = cur.parent
      trail = cur.trail
      if (cur.app) intentApp = cur.app
    } else if (cur) {
      how = 'link'
      parent = cur.visit
      trail = cur.trail
    } else {
      const from = this.deps.openerOf(tabId)
      const opener = from ? this.current.get(from) : undefined
      if (opener) {
        how = 'link'
        parent = opener.visit
        trail = opener.trail
      } else how = 'other'
    }
    const r = db
      .prepare('INSERT INTO visits (profile, url, host, at, how, app, query, engine, trail, parent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(profile, url, hostOf(url), now, how, intentApp ?? null, search?.query ?? null, search?.engine ?? null, trail, parent)
    const id = Number(r.lastInsertRowid)
    if (trail === null) {
      trail = id
      db.prepare('UPDATE visits SET trail = ? WHERE id = ?').run(id, id)
    }
    this.current.set(tabId, { profile, visit: id, trail, url, at: now, how, parent, ...(intentApp && { app: intentApp }) })
    return id
  }

  /** You clicked or typed in a tab's page. */
  touched(tabId: string) {
    const cur = this.current.get(tabId)
    if (cur) cur.touched = true
  }

  /** The visit a tab is on now. */
  currentVisit(tabId: string): number | undefined {
    return this.current.get(tabId)?.visit
  }

  /** A page's title arrived: its latest visit takes it. */
  setTitle(profile: string, url: string, title: string) {
    if (!title) return
    this.db
      ?.prepare('UPDATE visits SET title = ? WHERE id = (SELECT id FROM visits WHERE profile = ? AND url = ? ORDER BY at DESC LIMIT 1)')
      .run(title, profile, url)
    this.db?.prepare('UPDATE texts SET title = ? WHERE profile = ? AND url = ?').run(title, profile, url)
  }

  /** The tabs on screen were in front for `secs` more seconds. */
  addTime(tabIds: string[], secs: number) {
    const db = this.db
    if (!db) return
    const add = db.prepare('UPDATE visits SET secs = secs + ? WHERE id = ?')
    for (const id of tabIds) {
      const cur = this.current.get(id)
      if (cur) add.run(secs, cur.visit)
    }
  }

  /** Keeps a page's text, for finding it by what it said. One copy per page and profile. */
  saveText(profile: string, url: string, title: string, body: string) {
    const db = this.db
    if (!db) return
    db.prepare('DELETE FROM texts WHERE profile = ? AND url = ?').run(profile, url)
    // Only for a page still in the history: one forgotten while its text was being read stays forgotten.
    db.prepare('INSERT INTO texts (profile, url, title, body) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM visits WHERE profile = ? AND url = ?)').run(
      profile,
      url,
      title,
      body.slice(0, TEXT_CHARS),
      profile,
      url,
    )
  }

  /** Tabs on a forgotten page, or any page of a cleared profile, start afresh: nothing more is added to what was removed. */
  private dropCurrent(test: (c: Current) => boolean) {
    for (const [tab, c] of this.current) if (test(c)) this.current.delete(tab)
  }

  /** Pages from another browser, one visit each when they were last visited. Ones already here are left alone. */
  importPages(profile: string, pages: { url: string; title: string; last: number }[], browser: string) {
    const db = this.db
    if (!db) return
    const have = db.prepare('SELECT 1 FROM visits WHERE profile = ? AND url = ? AND at = ?')
    const add = db.prepare("INSERT INTO visits (profile, url, title, host, at, how, app) VALUES (?, ?, ?, ?, ?, 'imported', ?)")
    const setTrail = db.prepare('UPDATE visits SET trail = id WHERE trail IS NULL')
    db.exec('BEGIN')
    try {
      for (const p of pages) {
        if (!/^https?:/i.test(p.url) || have.get(profile, p.url, p.last)) continue
        add.run(profile, p.url, p.title, hostOf(p.url), p.last, browser)
      }
      setTrail.run()
      db.exec('COMMIT')
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  /** Removes a page: every visit to it and its text. */
  forgetPage(profile: string, url: string) {
    this.db?.prepare('DELETE FROM visits WHERE profile = ? AND url = ?').run(profile, url)
    this.db?.prepare('DELETE FROM texts WHERE profile = ? AND url = ?').run(profile, url)
    this.dropCurrent((c) => c.profile === profile && c.url === url)
  }

  /** Clears one profile's history, or every profile's with 'all'. */
  clear(profile: string) {
    const db = this.db
    if (!db) return
    if (profile === 'all') {
      db.exec('DELETE FROM visits; DELETE FROM texts;')
      this.current.clear()
    } else {
      db.prepare('DELETE FROM visits WHERE profile = ?').run(profile)
      db.prepare('DELETE FROM texts WHERE profile = ?').run(profile)
      this.dropCurrent((c) => c.profile === profile)
    }
  }

  /** A trail's visits that match nothing but the trail, oldest first, to reopen or keep it whole. */
  trailPages(trail: number): { profile: string; url: string; title: string }[] {
    const rows = this.db?.prepare('SELECT profile, url, title FROM visits WHERE trail = ? AND redirect = 0 ORDER BY at').all(trail) ?? []
    const seen = new Set<string>()
    return rows
      .map((r) => ({ profile: String(r.profile), url: String(r.url), title: String(r.title) }))
      .filter((r) => !seen.has(r.url) && !!seen.add(r.url))
  }

  // ---------- querying ----------

  /** The history page's answer to its search and filters. */
  query(q: HistoryQuery, ctx: QueryContext): HistoryReply {
    const db = this.db
    const now = ctx.now ?? Date.now()
    const empty: HistoryReply = {
      seq: q.seq,
      total: 0,
      secs: 0,
      trailCount: 0,
      more: false,
      facets: { when: { today: 0, yesterday: 0, week: 0, month: 0, all: 0 }, profile: {}, how: {}, sites: [], open: 0, kept: 0 },
    }
    if (!db) return empty

    const ops: { site?: string; in?: string; from?: string } = {}
    const words = q.text
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => {
        const m = w.match(/^(site|in|from):(.+)$/)
        if (m) ops[m[1] as 'site' | 'in' | 'from'] = m[2]
        return !!w && !m
      })
    const stateKeys = (s: 'open' | 'kept') => JSON.stringify([...(s === 'open' ? ctx.open : ctx.kept)])
    const inProfiles = ops.in ? ctx.profiles.filter((p) => p.name.toLowerCase().startsWith(ops.in!)).map((p) => p.id) : null

    const where = (skip?: Facet): { sql: string; args: SQLInputValue[] } => {
      const parts: string[] = []
      const args: SQLInputValue[] = []
      const add = (sql: string, ...a: SQLInputValue[]) => {
        parts.push(sql)
        args.push(...a)
      }
      if (skip !== 'when') add('at >= ?', whenCutoff(q.when, now))
      else add('at >= ?', whenCutoff('all', now))
      if (skip !== 'profile' && q.profile !== 'all') add('profile = ?', q.profile)
      if (skip !== 'how' && q.how.length) add(`how IN (${q.how.map(() => '?').join(',')})`, ...q.how)
      if (skip !== 'sites' && q.sites.length) add(`host IN (${q.sites.map(() => '?').join(',')})`, ...q.sites)
      if (skip !== 'state' && q.state !== 'any') add("(profile || char(10) || url) IN (SELECT value FROM json_each(?))", stateKeys(q.state))
      if (q.read) add('secs >= ?', READ_SECS)
      if (q.hideRedirects) add('redirect = 0')
      if (ops.site) add("host LIKE ? ESCAPE '\\'", likeWord(ops.site))
      if (inProfiles) add(`profile IN (${inProfiles.map(() => '?').join(',') || "''"})`, ...inProfiles)
      if (ops.from) add("app LIKE ? ESCAPE '\\'", `${ops.from.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)
      for (const w of words) {
        add(
          `(title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\' OR (profile || char(10) || url) IN (SELECT profile || char(10) || url FROM texts WHERE texts MATCH ?))`,
          likeWord(w),
          likeWord(w),
          ftsWord(w),
        )
      }
      return { sql: parts.join(' AND ') || '1', args }
    }

    const all = where()
    const reply: HistoryReply = { ...empty }
    const totals = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(secs), 0) AS s, COUNT(DISTINCT trail) AS t FROM visits WHERE ${all.sql}`).get(...all.args) as Row
    reply.total = Number(totals.n)
    reply.secs = Number(totals.s)
    reply.trailCount = Number(totals.t)

    const toVisit = (r: Row): HistoryVisit => {
      const key = pageKey(String(r.profile), String(r.url))
      return {
        id: Number(r.id),
        profile: String(r.profile),
        url: String(r.url),
        title: String(r.title ?? ''),
        host: String(r.host),
        at: Number(r.at),
        secs: Number(r.secs),
        how: String(r.how) as VisitHow,
        ...(r.app ? { app: String(r.app) } : {}),
        ...(r.query ? { query: String(r.query) } : {}),
        trail: Number(r.trail ?? r.id),
        ...(ctx.open.has(key) ? { state: 'open' as const } : ctx.kept.has(key) ? { state: 'kept' as const } : {}),
      }
    }
    // Where the text matched, for visits whose title and address don't hold every word.
    const snippetOf = words.length ? db.prepare("SELECT snippet(texts, 3, char(1), char(2), '…', 16) AS s FROM texts WHERE texts MATCH ? AND profile = ? AND url = ?") : null
    const anyWord = words.map(ftsWord).join(' OR ')
    let snippets = 0
    const withSnippet = (v: HistoryVisit): HistoryVisit => {
      if (!snippetOf || snippets >= 200) return v
      const seen = `${v.title} ${v.url}`.toLowerCase()
      if (words.every((w) => seen.includes(w))) return v
      snippets++
      const s = snippetOf.get(anyWord, v.profile, v.url) as Row | undefined
      return s?.s ? { ...v, snippet: String(s.s).replace(/\s+/g, ' ') } : v
    }

    if (q.view === 'pages' || q.view === 'trails') {
      const rows = db.prepare(`SELECT * FROM visits WHERE ${all.sql} ORDER BY at DESC LIMIT ?`).all(...all.args, q.limit + 1)
      reply.more = rows.length > q.limit
      const visits = rows.slice(0, q.limit).map((r) => withSnippet(toVisit(r)))
      if (q.view === 'pages') reply.pages = visits
      else reply.trails = this.trailsOf(visits)
    } else if (q.view === 'sites') {
      const rows = db
        .prepare(`SELECT host, COUNT(*) AS n, SUM(secs) AS s, MAX(at) AS last FROM visits WHERE ${all.sql} GROUP BY host ORDER BY s DESC, n DESC LIMIT ?`)
        .all(...all.args, q.limit + 1)
      reply.more = rows.length > q.limit
      const sites: HistorySite[] = rows.slice(0, q.limit).map((r) => ({ host: String(r.host), visits: Number(r.n), secs: Number(r.s), last: Number(r.last), days: [0, 0, 0, 0, 0, 0, 0] }))
      if (sites.length) {
        const from = dayStart(now, 6)
        const byHost = new Map(sites.map((s) => [s.host, s]))
        const days = db
          .prepare(`SELECT host, at FROM visits WHERE ${all.sql} AND at >= ? AND host IN (SELECT value FROM json_each(?))`)
          .all(...all.args, from, JSON.stringify(sites.map((s) => s.host)))
        for (const d of days) {
          const at = Number(d.at)
          let i = 6
          while (i > 0 && at < dayStart(now, 6 - i)) i--
          const s = byHost.get(String(d.host))
          if (s) s.days[i]++
        }
      }
      reply.sites = sites
    } else {
      const rows = db.prepare(`SELECT * FROM visits WHERE ${all.sql} AND query IS NOT NULL ORDER BY at DESC LIMIT ?`).all(...all.args, q.limit * 2 + 1)
      const led = db.prepare('SELECT url, title FROM visits WHERE parent = ? AND query IS NULL AND redirect = 0 ORDER BY at')
      const parentQuery = db.prepare('SELECT query FROM visits WHERE id = ?')
      const searches: HistorySearch[] = []
      for (const r of rows) {
        // The next page of the same search isn't another search.
        if (r.parent !== null && (parentQuery.get(r.parent) as Row | undefined)?.query === r.query) continue
        if (searches.length === q.limit) {
          reply.more = true
          break
        }
        const pages = led.all(r.id).map((p) => ({ url: String(p.url), title: String(p.title) }))
        searches.push({ id: Number(r.id), profile: String(r.profile), at: Number(r.at), query: String(r.query), engine: String(r.engine ?? ''), led: pages.slice(0, 3), more: Math.max(0, pages.length - 3) })
      }
      reply.searches = searches
    }

    // Facets: each counts with every other filter as it is.
    const count = (w: { sql: string; args: SQLInputValue[] }, extra = '', ...a: SQLInputValue[]) =>
      Number((db.prepare(`SELECT COUNT(*) AS n FROM visits WHERE ${w.sql}${extra}`).get(...w.args, ...a) as Row).n)
    const w = where('when')
    for (const k of WHENS) reply.facets.when[k] = count(w, ' AND at >= ?', whenCutoff(k, now))
    const p = where('profile')
    for (const r of db.prepare(`SELECT profile, COUNT(*) AS n FROM visits WHERE ${p.sql} GROUP BY profile`).all(...p.args)) reply.facets.profile[String(r.profile)] = Number(r.n)
    const h = where('how')
    for (const r of db.prepare(`SELECT how, COUNT(*) AS n FROM visits WHERE ${h.sql} GROUP BY how`).all(...h.args)) reply.facets.how[String(r.how)] = Number(r.n)
    const s = where('sites')
    reply.facets.sites = db
      .prepare(`SELECT host, COUNT(*) AS n FROM visits WHERE ${s.sql} GROUP BY host ORDER BY n DESC LIMIT 8`)
      .all(...s.args)
      .map((r) => ({ host: String(r.host), count: Number(r.n) }))
    const st = where('state')
    reply.facets.open = count(st, " AND (profile || char(10) || url) IN (SELECT value FROM json_each(?))", stateKeys('open'))
    reply.facets.kept = count(st, " AND (profile || char(10) || url) IN (SELECT value FROM json_each(?))", stateKeys('kept'))
    return reply
  }

  /** Groups visits, newest first, into their trails, newest first, each with its visits oldest first. */
  private trailsOf(visits: HistoryVisit[]): HistoryTrail[] {
    const db = this.db!
    const trails = new Map<number, HistoryTrail>()
    for (const v of visits) {
      let t = trails.get(v.trail)
      if (!t) trails.set(v.trail, (t = { id: v.trail, profile: v.profile, start: { how: v.how, host: v.host, title: v.title }, secs: 0, visits: [] }))
      t.visits.unshift(v)
      t.secs += v.secs
    }
    const starts = db
      .prepare('SELECT id, how, app, query, host, title FROM visits WHERE id IN (SELECT value FROM json_each(?))')
      .all(JSON.stringify([...trails.keys()]))
    for (const r of starts) {
      const t = trails.get(Number(r.id))
      if (t) t.start = { how: String(r.how) as VisitHow, host: String(r.host), title: String(r.title ?? ''), ...(r.app ? { app: String(r.app) } : {}), ...(r.query ? { query: String(r.query) } : {}) }
    }
    // A trail whose first visit was forgotten starts where its earliest visit here does.
    for (const t of trails.values()) if (!starts.some((r) => Number(r.id) === t.id)) t.start = { how: t.visits[0].how, host: t.visits[0].host, title: t.visits[0].title, ...(t.visits[0].query ? { query: t.visits[0].query } : {}) }
    return [...trails.values()]
  }
}

/**
 * What was searched, if `url` is the results page of one of `engines` (addresses with %s where the
 * query goes): same host and path, and the query in the parameter that held %s.
 */
export function searchOf(url: string, engines: { name: string; url: string }[]): { query: string; engine: string } | undefined {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return undefined
  }
  for (const e of engines) {
    let t: URL
    try {
      t = new URL(e.url.replace('%s', 'JBROWQUERY'))
    } catch {
      continue
    }
    if (t.host.replace(/^www\./, '') !== u.host.replace(/^www\./, '') || t.pathname !== u.pathname) continue
    const param = [...t.searchParams].find(([, v]) => v === 'JBROWQUERY')?.[0]
    const query = param && u.searchParams.get(param)?.trim()
    if (query) return { query, engine: e.name }
  }
  return undefined
}
