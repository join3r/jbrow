import { app, net } from 'electron'
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { DangerKind, DangerView } from '../shared/types'

/**
 * Lists of phishing and malware hosts from malware-filter, which builds them from OpenPhish,
 * PhishTank and URLhaus and leaves out popular sites so a hacked page on a big host doesn't block
 * the host. They're downloaded whole and checked here, so the addresses you visit never leave your
 * Mac, unlike Google Safe Browsing's lookups.
 */
const LISTS: { kind: DangerKind; url: string; file: string }[] = [
  { kind: 'phishing', url: 'https://malware-filter.gitlab.io/malware-filter/phishing-filter-hosts.txt', file: 'phishing.txt' },
  { kind: 'malware', url: 'https://malware-filter.gitlab.io/malware-filter/urlhaus-filter-hosts.txt', file: 'malware.txt' },
]

/** The lists say they expire after 12 hours. */
const REFRESH_MS = 12 * 60 * 60 * 1000
/** After a failed download, try again sooner. */
const RETRY_MS = 60 * 60 * 1000

const dir = () => path.join(app.getPath('userData'), 'blocklists')

/** "0.0.0.0 evil.example" lines, as in a hosts file. */
function parse(text: string): Set<string> {
  const hosts = new Set<string>()
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue
    const host = line.trim().split(/\s+/)[1]
    if (host) hosts.add(host.toLowerCase())
  }
  return hosts
}

const hostOf = (url: string) => {
  try {
    const u = new URL(url)
    return /^https?:$/.test(u.protocol) ? u.hostname.toLowerCase().replace(/\.$/, '') : ''
  } catch {
    return ''
  }
}

interface Blocked {
  url: string
  host: string
  kind: DangerKind
}

/**
 * Warns before a tab opens a site on the phishing or malware lists, the way Chrome's Safe
 * Browsing does: the page doesn't load, and jbrow's warning takes its place.
 */
export class DangerousSites {
  private hosts = new Map<DangerKind, Set<string>>()
  private updated: number | null = null
  /** Tabs a warning stopped. */
  private blocked = new Map<string, Blocked>()
  /** Profile and host you chose to visit anyway. Forgotten on quit, as in Chrome. */
  private allowed = new Set<string>()
  private timer: NodeJS.Timeout | undefined

  constructor(
    private deps: {
      enabled: () => boolean
      onChange: () => void
    },
  ) {}

  /** Loads the lists kept from last time, and downloads new ones when they're old. */
  start() {
    let oldest = Infinity
    for (const list of LISTS) {
      try {
        const file = path.join(dir(), list.file)
        this.hosts.set(list.kind, parse(readFileSync(file, 'utf8')))
        oldest = Math.min(oldest, statSync(file).mtimeMs)
      } catch {
        oldest = 0
      }
    }
    if (oldest !== Infinity && oldest > 0) this.updated = oldest
    const due = oldest + REFRESH_MS - Date.now()
    this.schedule(Math.max(due, 5000))
  }

  private schedule(ms: number) {
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.refresh(), ms)
  }

  private async refresh() {
    let failed = false
    mkdirSync(dir(), { recursive: true })
    for (const list of LISTS) {
      try {
        const res = await net.fetch(list.url, { cache: 'no-store' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const text = await res.text()
        const hosts = parse(text)
        // A truncated or wrong response would quietly turn the warnings off.
        if (hosts.size < 100) throw new Error(`only ${hosts.size} hosts`)
        const file = path.join(dir(), list.file)
        writeFileSync(`${file}.tmp`, text)
        renameSync(`${file}.tmp`, file)
        this.hosts.set(list.kind, hosts)
      } catch (error) {
        failed = true
        console.error(`[dangerous] ${list.url}:`, error)
      }
    }
    if (!failed) this.updated = Date.now()
    console.log(`[dangerous] lists: ${this.size()} hosts${failed ? ', some failed to update' : ''}`)
    this.deps.onChange()
    this.schedule(failed ? RETRY_MS : REFRESH_MS)
  }

  private size() {
    let n = 0
    for (const set of this.hosts.values()) n += set.size
    return n
  }

  /** Which list has the host, or one of the domains it's under. */
  private match(host: string): DangerKind | null {
    for (let h = host; h.includes('.'); h = h.slice(h.indexOf('.') + 1)) {
      for (const list of LISTS) if (this.hosts.get(list.kind)?.has(h)) return list.kind
    }
    return null
  }

  /**
   * A tab is starting to load an address. Returns true if it's on a list, in which case the tab
   * should stop and show the warning.
   */
  check(tabId: string, profileId: string, url: string): boolean {
    const kind = this.listed(profileId, url)
    if (!kind) return false
    const host = hostOf(url)
    console.log(`[dangerous] stopped ${host} (${kind})`)
    this.blocked.set(tabId, { url, host, kind })
    this.deps.onChange()
    return true
  }

  /** Whether a warning would stop the address, without recording anything. */
  listed(profileId: string, url: string): DangerKind | null {
    if (!this.deps.enabled()) return null
    const host = hostOf(url)
    if (!host || this.allowed.has(`${profileId}\n${host}`)) return null
    return this.match(host)
  }

  /** The tab is going somewhere new, or its page is gone. */
  clear(tabId: string) {
    if (this.blocked.delete(tabId)) this.deps.onChange()
  }

  isBlocked(tabId: string) {
    return this.blocked.has(tabId)
  }

  /** You chose to visit the site anyway. Returns the address to load again. */
  proceed(tabId: string, profileId: string): string | null {
    const b = this.blocked.get(tabId)
    if (!b) return null
    this.allowed.add(`${profileId}\n${b.host}`)
    this.blocked.delete(tabId)
    this.deps.onChange()
    return b.url
  }

  view(tabId: string): DangerView | null {
    const b = this.blocked.get(tabId)
    return b ? { ...b } : null
  }

  /** For settings: how many hosts the lists hold and when they were last downloaded. */
  status() {
    return { hosts: this.size(), updated: this.updated }
  }
}
