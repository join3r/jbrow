import type { Certificate } from 'electron'
import { BlockList, isIP } from 'node:net'
import type { SiteCert, SiteInfoReply } from '../shared/types'

/** How long a looked-up address is reused, and an address that didn't resolve. */
const IP_TTL = 60_000
const FAILED_TTL = 10_000
/** A lookup slower than this answers without the address. */
const RESOLVE_TIMEOUT = 3000
const DAY = 86_400_000

/** A certificate the profile was shown, as Certificates.seenOn returns it. */
export interface SeenCert {
  cert: Certificate
  error: string
  trusted: boolean
}

export interface SiteInfoDeps {
  /** Resolves a host with the profile's session; any of its addresses, or undefined. */
  resolve: (profile: string, host: string) => Promise<string | undefined>
  /** The certificate the host showed this run in the profile, or null. */
  cert: (profile: string, host: string) => SeenCert | null
  isPrivate: (url: string) => boolean
  /** The search engine's results page, which isn't a site to describe. */
  isSearch: (url: string) => boolean
  send: (reply: SiteInfoReply) => void
  now?: () => number
}

/** The certificate as the address bar describes it: its verdict, who signed it, and how long it has left. */
export function certSummary(seen: SeenCert | null, now: number): SiteCert {
  if (!seen) return { state: 'unknown' }
  const { cert, error, trusted } = seen
  const validTo = cert.validExpiry * 1000
  return {
    state: error ? 'error' : 'valid',
    ...(error ? { error, trusted } : {}),
    issuer: cert.issuer.commonName || cert.issuer.organizations[0] || cert.issuerName,
    validTo,
    daysLeft: Math.floor((validTo - now) / DAY),
  }
}

const local = new BlockList()
local.addSubnet('127.0.0.0', 8)
local.addSubnet('10.0.0.0', 8)
local.addSubnet('172.16.0.0', 12)
local.addSubnet('192.168.0.0', 16)
local.addSubnet('169.254.0.0', 16)
local.addAddress('::1', 'ipv6')
local.addSubnet('fc00::', 7, 'ipv6')
local.addSubnet('fe80::', 10, 'ipv6')

/** The address is this machine or the local network, not the internet. */
export function isLocalAddress(ip: string): boolean {
  const family = isIP(ip)
  return !!family && local.check(ip, family === 6 ? 'ipv6' : 'ipv4')
}

/** Whether `url` is a results page of the search address `searchUrl` (with %s for the query). */
export function isSearchPage(url: string, searchUrl: string): boolean {
  const prefix = searchUrl.split('%s')[0]
  return !!prefix && url.startsWith(prefix)
}

/**
 * Answers the address bar's questions about the site behind a suggestion: its IP address from
 * the system's DNS and the certificate it showed this run. Never connects to the site itself, and
 * leaves private addresses alone. An answer that arrives after a newer request is dropped.
 */
export class SiteInfo {
  /** The newest request's seq. Requests arrive in order, so the last one in is the one that counts. */
  private latest = NaN
  private ips = new Map<string, { at: number; ttl: number; ip: Promise<string | undefined> }>()
  private now: () => number

  constructor(private deps: SiteInfoDeps) {
    this.now = deps.now ?? Date.now
  }

  /** Looks the site up and sends the reply, unless a newer request came in meanwhile. */
  async ask(url: string, profile: string, seq: number): Promise<void> {
    this.latest = seq
    let reply: SiteInfoReply
    try {
      reply = await this.describe(url, profile, seq)
    } catch {
      reply = { seq, url, host: '', scheme: '', private: false }
    }
    if (seq === this.latest) this.deps.send(reply)
  }

  private async describe(url: string, profile: string, seq: number): Promise<SiteInfoReply> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return { seq, url, host: '', scheme: '', private: false }
    }
    const scheme = parsed.protocol.replace(/:$/, '')
    // [::1] is ::1 to the resolver and to the certificate check.
    const host = parsed.hostname.replace(/^\[(.*)\]$/, '$1')
    const reply: SiteInfoReply = { seq, url, host, scheme, private: false }
    if (this.deps.isPrivate(url)) return { ...reply, private: true }
    if ((scheme !== 'http' && scheme !== 'https') || !host || this.deps.isSearch(url)) return reply
    reply.cert = scheme === 'http' ? { state: 'none' } : certSummary(this.deps.cert(profile, host), this.now())
    const ip = isIP(host) ? host : await this.resolve(profile, host)
    if (ip) {
      reply.ip = ip
      reply.local = isLocalAddress(ip)
    }
    return reply
  }

  /** The host's address, from a lookup made in the last minute when there is one. */
  private resolve(profile: string, host: string): Promise<string | undefined> {
    const key = `${profile}\n${host}`
    const now = this.now()
    const cached = this.ips.get(key)
    if (cached && now - cached.at < cached.ttl) return cached.ip
    const entry = { at: now, ttl: IP_TTL, ip: Promise.resolve<string | undefined>(undefined) }
    entry.ip = new Promise<string | undefined>((resolve) => {
      const timer = setTimeout(() => resolve(undefined), RESOLVE_TIMEOUT)
      this.deps.resolve(profile, host).then(
        (ip) => {
          clearTimeout(timer)
          resolve(ip)
        },
        () => {
          clearTimeout(timer)
          resolve(undefined)
        },
      )
    }).then((ip) => {
      if (!ip) entry.ttl = FAILED_TTL
      return ip
    })
    this.ips.set(key, entry)
    // Keep the cache from growing forever as the highlight wanders.
    if (this.ips.size > 200) for (const [k, v] of this.ips) if (now - v.at >= v.ttl) this.ips.delete(k)
    return entry.ip
  }
}
