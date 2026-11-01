import { execFile } from 'node:child_process'
import { createDecipheriv, pbkdf2Sync } from 'node:crypto'
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { promisify } from 'node:util'
import type { ImportedNode, ImportedPage, ImportKind, ImportSource } from '../shared/types'

/**
 * Reads history, bookmarks, Arc's sidebar and site logins from the other browsers on this
 * computer, for Import in settings. Nothing is written to them: their databases are copied to a
 * temporary folder first, as the browser may have them open.
 */

const DAY_MS = 24 * 60 * 60 * 1000
/** As much history as jbrow keeps (see visits.ts). */
const HISTORY_DAYS = 90
const HISTORY_PAGES = 5000
/** Chromium counts time from 1601, Safari from 2001. */
const FROM_1601_MS = 11644473600000
const FROM_2001_S = 978307200

/** A page in another browser's history, with times in ms since 1970. */
export interface HistoryPage {
  url: string
  title: string
  visits: number
  last: number
}

/** A cookie as Electron's session.cookies.set takes it. */
export interface ImportedCookie {
  url: string
  name: string
  value: string
  domain?: string
  path: string
  secure: boolean
  httpOnly: boolean
  expirationDate?: number
  sameSite: 'unspecified' | 'no_restriction' | 'lax' | 'strict'
}

export interface ImportData {
  history?: HistoryPage[]
  bookmarks?: ImportedNode[]
  /** Arc's Favorites, which become pinned tabs. */
  pinned?: ImportedPage[]
  /** Arc's spaces with their pinned tabs, which go in Kept. */
  spaces?: ImportedNode[]
  cookies?: ImportedCookie[]
  /** Parts that couldn't be read, as sentences. */
  errors: string[]
}

interface Chromium {
  key: string
  name: string
  dirs: Partial<Record<NodeJS.Platform, string>>
  /** Its Keychain item, `<name> Safe Storage`, holds the key its cookies are encrypted with. */
  keychain: string
}

const home = os.homedir()
const macDir = (p: string) => path.join(home, 'Library', 'Application Support', p)
const winDir = (p: string) => path.join(process.env.LOCALAPPDATA ?? path.join(home, 'AppData', 'Local'), p)
const linuxDir = (p: string) => path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'), p)

const CHROMIUM: Chromium[] = [
  { key: 'chrome', name: 'Chrome', keychain: 'Chrome', dirs: { darwin: macDir('Google/Chrome'), win32: winDir('Google/Chrome/User Data'), linux: linuxDir('google-chrome') } },
  { key: 'arc', name: 'Arc', keychain: 'Arc', dirs: { darwin: macDir('Arc/User Data') } },
  { key: 'brave', name: 'Brave', keychain: 'Brave', dirs: { darwin: macDir('BraveSoftware/Brave-Browser'), win32: winDir('BraveSoftware/Brave-Browser/User Data'), linux: linuxDir('BraveSoftware/Brave-Browser') } },
  { key: 'edge', name: 'Edge', keychain: 'Microsoft Edge', dirs: { darwin: macDir('Microsoft Edge'), win32: winDir('Microsoft/Edge/User Data'), linux: linuxDir('microsoft-edge') } },
  { key: 'vivaldi', name: 'Vivaldi', keychain: 'Vivaldi', dirs: { darwin: macDir('Vivaldi'), win32: winDir('Vivaldi/User Data'), linux: linuxDir('vivaldi') } },
  { key: 'chromium', name: 'Chromium', keychain: 'Chromium', dirs: { darwin: macDir('Chromium'), win32: winDir('Chromium/User Data'), linux: linuxDir('chromium') } },
]

const ARC_SIDEBAR = () => macDir('Arc/StorableSidebar.json')
const SAFARI = () => path.join(home, 'Library', 'Safari')
const FIREFOX = () =>
  process.platform === 'darwin'
    ? macDir('Firefox')
    : process.platform === 'win32'
      ? path.join(process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'Mozilla', 'Firefox')
      : path.join(home, '.mozilla', 'firefox')

const readJson = (file: string): any => JSON.parse(readFileSync(file, 'utf8'))

// ---------- finding the browsers ----------

/** Every browser profile on this computer jbrow can import from. */
export function findSources(): ImportSource[] {
  const sources: ImportSource[] = []
  for (const b of CHROMIUM) {
    const dir = b.dirs[process.platform]
    if (!dir || !existsSync(dir)) continue
    const profiles = chromiumProfiles(dir)
    const arc = b.key === 'arc' ? arcSidebar() : null
    for (const p of profiles) {
      const kinds: ImportKind[] = []
      const at = path.join(dir, p.dir)
      if (existsSync(path.join(at, 'History'))) kinds.push('history')
      if (b.key !== 'arc' && existsSync(path.join(at, 'Bookmarks'))) kinds.push('bookmarks')
      if (arc && arcProfile(arc, p.dir)) kinds.push('sidebar')
      if (process.platform === 'darwin' && cookiesFile(at)) kinds.push('logins')
      if (!kinds.length) continue
      const name = (arc && arcProfile(arc, p.dir)?.name) || p.name
      sources.push({ id: `${b.key}:${p.dir}`, browser: b.name, profile: profiles.length > 1 ? name : '', kinds })
    }
  }
  // Safari's folder can't even be listed without Full Disk Access, so it's offered on every Mac.
  if (process.platform === 'darwin') sources.push({ id: 'safari:', browser: 'Safari', profile: '', kinds: ['history', 'bookmarks'] })
  const ff = firefoxProfiles()
  for (const p of ff) sources.push({ id: `firefox:${p.path}`, browser: 'Firefox', profile: ff.length > 1 ? p.name : '', kinds: ['history', 'bookmarks'] })
  return sources
}

/** A Chromium browser's profiles: their folder (Default, Profile 1…) and name, as Local State lists them. */
function chromiumProfiles(dir: string): { dir: string; name: string }[] {
  let cache: Record<string, { name?: string }> = {}
  try {
    cache = readJson(path.join(dir, 'Local State')).profile?.info_cache ?? {}
  } catch {}
  const dirs = Object.keys(cache).length
    ? Object.keys(cache)
    : readdirSafe(dir).filter((d) => d === 'Default' || /^Profile \d+$/.test(d))
  return dirs.filter((d) => existsSync(path.join(dir, d))).map((d) => ({ dir: d, name: cache[d]?.name || d }))
}

const readdirSafe = (dir: string) => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** Newer Chromium keeps cookies in the profile's Network folder. */
function cookiesFile(profileDir: string): string | null {
  for (const f of [path.join(profileDir, 'Network', 'Cookies'), path.join(profileDir, 'Cookies')]) if (existsSync(f)) return f
  return null
}

function firefoxProfiles(): { name: string; path: string }[] {
  const dir = FIREFOX()
  let ini: string
  try {
    ini = readFileSync(path.join(dir, 'profiles.ini'), 'utf8')
  } catch {
    return []
  }
  const out: { name: string; path: string }[] = []
  for (const block of ini.split(/^\[/m)) {
    if (!/^Profile\d+\]/.test(block)) continue
    const field = (k: string) => block.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1]?.trim()
    const p = field('Path')
    if (!p) continue
    const full = field('IsRelative') === '0' ? p : path.join(dir, p)
    if (existsSync(path.join(full, 'places.sqlite'))) out.push({ name: field('Name') || path.basename(full), path: full })
  }
  return out
}

// ---------- reading them ----------

/** Reads what `kinds` asks for from one source. A part that fails says why in `errors`; the rest still come. */
export async function readSource(id: string, kinds: ImportKind[]): Promise<ImportData> {
  const [key, ...rest] = id.split(':')
  const sub = rest.join(':')
  const data: ImportData = { errors: [] }
  const tryRead = async (what: string, read: () => unknown | Promise<unknown>) => {
    try {
      await read()
    } catch (error) {
      data.errors.push(describe(key, what, error))
    }
  }
  const b = CHROMIUM.find((x) => x.key === key)
  if (b) {
    const dir = b.dirs[process.platform]
    if (!dir || sub.includes('..')) throw new Error(`No such browser profile: ${id}`)
    const at = path.join(dir, sub)
    if (kinds.includes('history')) await tryRead('history', () => (data.history = chromiumHistory(path.join(at, 'History'))))
    if (kinds.includes('bookmarks')) await tryRead('bookmarks', () => (data.bookmarks = chromiumBookmarks(path.join(at, 'Bookmarks'), b.name)))
    if (kinds.includes('sidebar')) {
      await tryRead('sidebar', () => {
        const arc = arcSidebar()
        const profile = arc && arcProfile(arc, sub)
        if (!profile) throw new Error('no spaces')
        data.pinned = profile.favorites
        data.spaces = profile.spaces
      })
    }
    if (kinds.includes('logins')) {
      await tryRead('logins', async () => {
        const file = cookiesFile(at)
        if (!file) throw new Error('no cookies')
        data.cookies = chromiumCookies(file, await keychainPassword(b.keychain))
      })
    }
  } else if (key === 'safari') {
    if (kinds.includes('history')) await tryRead('history', () => (data.history = safariHistory(path.join(SAFARI(), 'History.db'))))
    if (kinds.includes('bookmarks')) await tryRead('bookmarks', async () => (data.bookmarks = await safariBookmarks(path.join(SAFARI(), 'Bookmarks.plist'))))
  } else if (key === 'firefox') {
    if (!firefoxProfiles().some((p) => p.path === sub)) throw new Error(`No such browser profile: ${id}`)
    if (kinds.includes('history')) await tryRead('history', () => (data.history = firefoxHistory(path.join(sub, 'places.sqlite'))))
    if (kinds.includes('bookmarks')) await tryRead('bookmarks', () => (data.bookmarks = firefoxBookmarks(path.join(sub, 'places.sqlite'))))
  } else throw new Error(`No such browser: ${key}`)
  return data
}

const PART: Record<string, string> = { history: 'history', bookmarks: 'bookmarks', sidebar: 'sidebar', logins: 'site logins' }

/** A sentence for a part that couldn't be read. */
function describe(browser: string, what: string, error: unknown): string {
  const code = (error as NodeJS.ErrnoException)?.code
  const name = browser === 'safari' ? 'Safari' : (CHROMIUM.find((b) => b.key === browser)?.name ?? 'Firefox')
  if (browser === 'safari' && (code === 'EPERM' || code === 'EACCES' || /authoriz|not permitted|permission to view|SQLITE_CANTOPEN|unable to open/i.test(String(error)))) {
    return `Couldn't read Safari's ${PART[what]}: jbrow needs Full Disk Access for that, in System Settings → Privacy & Security.`
  }
  if (what === 'logins' && /SecKeychain|could not be found|User canceled|code 45|code 128/i.test(String(error))) {
    return `Didn't import ${name}'s site logins: the Keychain didn't give jbrow ${name}'s key.`
  }
  console.error(`[import] ${name} ${what}:`, error)
  return `Couldn't read ${name}'s ${PART[what]}.`
}

/** Opens a copy of a SQLite database, as the browser may hold it open, and removes the copy afterwards. */
export function withCopy<T>(file: string, read: (db: DatabaseSync) => T): T {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'jbrow-import-'))
  try {
    const copy = path.join(tmp, 'db')
    copyFileSync(file, copy)
    // Changes the browser hasn't moved into the database yet.
    if (existsSync(`${file}-wal`)) copyFileSync(`${file}-wal`, `${copy}-wal`)
    const db = new DatabaseSync(copy)
    try {
      return read(db)
    } finally {
      db.close()
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
}

const historyCutoff = () => Date.now() - HISTORY_DAYS * DAY_MS
const str = (v: unknown) => (typeof v === 'string' ? v : '')
const num = (v: unknown) => (typeof v === 'number' ? v : Number(v) || 0)

/** Times are µs since 1601, too big for a JavaScript number, so SQLite divides them first. */
export function chromiumHistory(file: string): HistoryPage[] {
  return withCopy(file, (db) =>
    db
      .prepare(
        `SELECT url, title, visit_count, last_visit_time / 1000 AS last FROM urls
         WHERE hidden = 0 AND last_visit_time / 1000 > ? ORDER BY last_visit_time DESC LIMIT ?`,
      )
      .all(historyCutoff() + FROM_1601_MS, HISTORY_PAGES)
      .map((r) => ({ url: str(r.url), title: str(r.title), visits: num(r.visit_count), last: num(r.last) - FROM_1601_MS })),
  )
}

interface ChromiumBookmark {
  type: 'url' | 'folder'
  name?: string
  url?: string
  children?: ChromiumBookmark[]
}

/**
 * The bookmarks bar, other and mobile bookmarks, in one folder named after the browser: the bar's
 * at its top, the others in folders of their own.
 */
export function chromiumBookmarks(file: string, browser: string): ImportedNode[] {
  const roots = readJson(file).roots as Record<string, ChromiumBookmark | undefined>
  const node = (b: ChromiumBookmark): ImportedNode =>
    b.type === 'url' ? { url: b.url ?? '', title: b.name ?? '' } : { title: b.name ?? '', children: (b.children ?? []).map(node) }
  const children = [
    ...(roots.bookmark_bar?.children ?? []).map(node),
    { title: 'Other bookmarks', children: (roots.other?.children ?? []).map(node) },
    { title: 'Mobile bookmarks', children: (roots.synced?.children ?? []).map(node) },
  ]
  return [{ title: `${browser} bookmarks`, children }]
}

// ---------- Arc ----------

interface ArcItem {
  id: string
  title?: string | null
  childrenIds: string[]
  data: { tab?: { savedURL?: string; savedTitle?: string } } & Record<string, unknown>
}

interface ArcSidebar {
  topApps: unknown[]
  spaces: { title?: string; profile?: unknown; containerIDs?: unknown[] }[]
  items: Map<string, ArcItem>
}

function arcSidebar(): ArcSidebar | null {
  try {
    return parseArcSidebar(readJson(ARC_SIDEBAR()))
  } catch {
    return null
  }
}

/** Arc's sidebar file: of its containers, the one with spaces. Its lists alternate IDs and objects. */
export function parseArcSidebar(json: any): ArcSidebar | null {
  const c = (json?.sidebar?.containers ?? []).find((x: any) => Array.isArray(x?.spaces))
  if (!c) return null
  const items = new Map<string, ArcItem>()
  for (const i of c.items ?? []) if (i && typeof i === 'object' && i.id) items.set(i.id, i)
  return { topApps: c.topAppsContainerIDs ?? [], spaces: (c.spaces ?? []).filter((s: unknown) => s && typeof s === 'object'), items }
}

/** The profile folder an Arc space or Favorites belongs to: `{ default: true }` or `{ custom: { _0: { directoryBasename } } }`. */
const arcDir = (spec: any): string | undefined => (spec?.default ? 'Default' : spec?.custom?._0?.directoryBasename)

/**
 * One Arc profile's Favorites and spaces. A space's pinned tabs, with their folders, go in a folder
 * named after the space; split views and tab groups give up their tabs to the folder they're in.
 */
export function arcProfile(arc: ArcSidebar, dir: string): { name: string; favorites: ImportedPage[]; spaces: ImportedNode[] } | null {
  const nodes = (id: unknown): ImportedNode[] => {
    const item = typeof id === 'string' ? arc.items.get(id) : undefined
    if (!item) return []
    const tab = item.data?.tab
    if (tab) return tab.savedURL ? [{ url: tab.savedURL, title: item.title || tab.savedTitle || '' }] : []
    const children = item.childrenIds.flatMap(nodes)
    return 'list' in item.data ? [{ title: item.title || 'Folder', children }] : children
  }
  const pages = (list: ImportedNode[]): ImportedPage[] => list.flatMap((n) => ('url' in n ? [n] : pages(n.children)))
  const favorites: ImportedPage[] = []
  for (let i = 0; i + 1 < arc.topApps.length; i += 2) if (arcDir(arc.topApps[i]) === dir) favorites.push(...pages(nodes(arc.topApps[i + 1])))
  const spaces: ImportedNode[] = []
  const names: string[] = []
  for (const s of arc.spaces) {
    if (arcDir(s.profile) !== dir) continue
    const ids = s.containerIDs ?? []
    const pinned = ids[ids.indexOf('pinned') + 1]
    names.push(s.title || 'Space')
    spaces.push({ title: s.title || 'Space', children: ids.includes('pinned') ? nodes(pinned) : [] })
  }
  if (!favorites.length && !spaces.length) return null
  return { name: names.join(', '), favorites, spaces }
}

// ---------- cookies ----------

const keychainPassword = async (name: string): Promise<string> => {
  const { stdout } = await promisify(execFile)('security', ['find-generic-password', '-w', '-s', `${name} Safe Storage`, '-a', name])
  return stdout.trim()
}

/**
 * Cookies from a Chromium cookie database on macOS. Values are encrypted with AES-128-CBC under a key
 * made from the browser's Keychain password, prefixed with "v10"; from database version 24 on the
 * plain value starts with a 32-byte hash of the cookie's domain. Expired cookies are left out.
 */
export function chromiumCookies(file: string, password: string): ImportedCookie[] {
  const key = pbkdf2Sync(password, 'saltysalt', 1003, 16, 'sha1')
  const nowS = Date.now() / 1000
  return withCopy(file, (db) => {
    const version = num((db.prepare(`SELECT value FROM meta WHERE key = 'version'`).get() as { value?: unknown } | undefined)?.value)
    const rows = db
      .prepare(
        `SELECT host_key, name, value, encrypted_value, path, expires_utc / 1000000 AS expires, is_secure, is_httponly, samesite, is_persistent FROM cookies`,
      )
      .all()
    const out: ImportedCookie[] = []
    for (const r of rows) {
      const expires = num(r.expires) - FROM_1601_MS / 1000
      const persistent = num(r.is_persistent) === 1
      if (persistent && expires < nowS) continue
      let value = str(r.value)
      const enc = r.encrypted_value instanceof Uint8Array ? Buffer.from(r.encrypted_value) : Buffer.alloc(0)
      if (!value && enc.length) {
        if (enc.subarray(0, 3).toString() !== 'v10') continue
        try {
          const d = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
          let plain = Buffer.concat([d.update(enc.subarray(3)), d.final()])
          if (version >= 24) plain = plain.subarray(32)
          value = plain.toString('utf8')
        } catch {
          continue
        }
      }
      const host = str(r.host_key)
      const secure = num(r.is_secure) === 1
      const sameSite = (['no_restriction', 'lax', 'strict'] as const)[num(r.samesite)] ?? 'unspecified'
      out.push({
        url: `${secure ? 'https' : 'http'}://${host.replace(/^\./, '')}${str(r.path) || '/'}`,
        name: str(r.name),
        value,
        // A host-only cookie is set without a domain.
        ...(host.startsWith('.') && { domain: host }),
        path: str(r.path) || '/',
        secure,
        httpOnly: num(r.is_httponly) === 1,
        ...(persistent && { expirationDate: expires }),
        sameSite,
      })
    }
    return out
  })
}

// ---------- Safari ----------

export function safariHistory(file: string): HistoryPage[] {
  return withCopy(file, (db) =>
    db
      .prepare(
        `SELECT i.url, i.visit_count, MAX(v.visit_time) AS last,
           (SELECT title FROM history_visits WHERE history_item = i.id AND title IS NOT NULL ORDER BY visit_time DESC LIMIT 1) AS title
         FROM history_items i JOIN history_visits v ON v.history_item = i.id
         GROUP BY i.id HAVING last > ? ORDER BY last DESC LIMIT ?`,
      )
      .all(historyCutoff() / 1000 - FROM_2001_S, HISTORY_PAGES)
      .map((r) => ({ url: str(r.url), title: str(r.title), visits: num(r.visit_count), last: Math.round((num(r.last) + FROM_2001_S) * 1000) })),
  )
}

/** Safari's bookmarks, from its property list turned to XML by plutil (JSON can't hold the sync data in it). */
async function safariBookmarks(file: string): Promise<ImportedNode[]> {
  const { stdout } = await promisify(execFile)('plutil', ['-convert', 'xml1', '-o', '-', file], { maxBuffer: 256 * 1024 * 1024 })
  return safariTree(parsePlist(stdout))
}

interface SafariBookmark {
  WebBookmarkType?: string
  Title?: string
  URLString?: string
  URIDictionary?: { title?: string }
  Children?: SafariBookmark[]
}

/** The favorites bar at the top of a Safari bookmarks folder, the menu and the reading list in folders of their own. */
export function safariTree(root: SafariBookmark): ImportedNode[] {
  const node = (b: SafariBookmark): ImportedNode[] => {
    if (b.WebBookmarkType === 'WebBookmarkTypeLeaf') return b.URLString ? [{ url: b.URLString, title: b.URIDictionary?.title ?? '' }] : []
    if (b.WebBookmarkType === 'WebBookmarkTypeList') return [{ title: b.Title ?? '', children: (b.Children ?? []).flatMap(node) }]
    return []
  }
  const top = root.Children ?? []
  const find = (t: string) => top.find((c) => c.Title === t)
  const kids = (b?: SafariBookmark) => (b?.Children ?? []).flatMap(node)
  const known = new Set(['BookmarksBar', 'BookmarksMenu', 'com.apple.ReadingList'])
  return [
    {
      title: 'Safari bookmarks',
      children: [
        ...kids(find('BookmarksBar')),
        { title: 'Bookmarks menu', children: kids(find('BookmarksMenu')) },
        { title: 'Reading list', children: kids(find('com.apple.ReadingList')) },
        ...top.filter((c) => !known.has(c.Title ?? '')).flatMap(node),
      ],
    },
  ]
}

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }
const unescapeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(parseInt(e.slice(e[1] === 'x' ? 2 : 1), e[1] === 'x' ? 16 : 10)) : (XML_ENTITIES[e] ?? m),
  )

/** An XML property list, as plutil writes it. Data and dates come back as their text. */
export function parsePlist(xml: string): any {
  const tokens = xml.replace(/<\?xml[^>]*\?>|<!DOCTYPE[^>]*>/g, '').match(/<[^>]+>|[^<]+/g) ?? []
  let i = 0
  const next = () => tokens[i++]
  const text = (tag: string) => {
    let s = ''
    for (let t = next(); t !== undefined && t !== `</${tag}>`; t = next()) s += t
    return unescapeXml(s)
  }
  const value = (): any => {
    let t = next()
    while (t !== undefined && !t.startsWith('<')) t = next()
    if (t === undefined) return undefined
    if (t === '<dict>') {
      const o: Record<string, any> = {}
      for (let k = next(); k !== undefined && k !== '</dict>'; k = next()) {
        if (k === '<key>') o[text('key')] = value()
        else if (k === '<key/>') o[''] = value()
      }
      return o
    }
    if (t === '<array>') {
      const a: any[] = []
      for (;;) {
        while (tokens[i] !== undefined && !tokens[i].startsWith('<')) i++
        if (tokens[i] === '</array>' || tokens[i] === undefined) {
          i++
          return a
        }
        a.push(value())
      }
    }
    if (t === '<dict/>') return {}
    if (t === '<array/>') return []
    if (t === '<true/>') return true
    if (t === '<false/>') return false
    if (t === '<string/>') return ''
    if (t === '<plist version="1.0">' || t.startsWith('<plist')) return value()
    const tag = t.slice(1, -1)
    const s = text(tag)
    return tag === 'integer' || tag === 'real' ? Number(s) : s
  }
  return value()
}

// ---------- Firefox ----------

export function firefoxHistory(file: string): HistoryPage[] {
  return withCopy(file, (db) =>
    db
      .prepare(
        `SELECT url, title, visit_count, last_visit_date / 1000 AS last FROM moz_places
         WHERE hidden = 0 AND last_visit_date / 1000 > ? ORDER BY last_visit_date DESC LIMIT ?`,
      )
      .all(historyCutoff(), HISTORY_PAGES)
      .map((r) => ({ url: str(r.url), title: str(r.title), visits: num(r.visit_count), last: num(r.last) })),
  )
}

/** The toolbar at the top of a Firefox bookmarks folder; the menu, other and mobile bookmarks in folders of their own. */
export function firefoxBookmarks(file: string): ImportedNode[] {
  return withCopy(file, (db) => {
    const rows = db
      .prepare(
        `SELECT b.id, b.type, b.parent, b.title, b.guid, p.url FROM moz_bookmarks b LEFT JOIN moz_places p ON p.id = b.fk ORDER BY b.parent, b.position`,
      )
      .all()
    const kids = new Map<number, typeof rows>()
    for (const r of rows) {
      const list = kids.get(num(r.parent))
      if (list) list.push(r)
      else kids.set(num(r.parent), [r])
    }
    const node = (r: (typeof rows)[number]): ImportedNode[] => {
      if (num(r.type) === 1) return /^https?:/i.test(str(r.url)) ? [{ url: str(r.url), title: str(r.title) }] : []
      if (num(r.type) === 2) return [{ title: str(r.title), children: (kids.get(num(r.id)) ?? []).flatMap(node) }]
      return []
    }
    const root = (guid: string) => {
      const r = rows.find((x) => x.guid === guid)
      return r ? (kids.get(num(r.id)) ?? []).flatMap(node) : []
    }
    return [
      {
        title: 'Firefox bookmarks',
        children: [
          ...root('toolbar_____'),
          { title: 'Bookmarks menu', children: root('menu________') },
          { title: 'Other bookmarks', children: root('unfiled_____') },
          { title: 'Mobile bookmarks', children: root('mobile______') },
        ],
      },
    ]
  })
}
