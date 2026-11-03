/**
 * Matches addresses against a list of patterns, as used for private addresses and folder
 * auto-file rules. A pattern matches anywhere in the address, ignoring case, and `*` stands for
 * any run of characters: `*.corp.example` matches https://wiki.corp.example/page.
 */
export function urlMatcher(patterns: string[]): (url: string) => boolean {
  const res = patterns
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => new RegExp(p.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*'), 'i'))
  return (url) => !!url && res.some((re) => re.test(url))
}

/**
 * The profile a web address belongs in, by each profile's sites: `youtube.com` covers
 * youtube.com and every site under it, `*.corp.example` only the sites under corp.example, and a
 * path narrows it: `github.com/acme` covers acme's repositories and nothing else on GitHub.
 * Unlike urlMatcher, a site has to be the address's own, so a search for youtube.com isn't
 * YouTube. When two profiles' sites match, the longer one wins, so `github.com/acme` beats
 * `github.com`.
 */
export function siteProfile(sites: Record<string, string[]>, url: string): string | undefined {
  return siteRule(sites, url)?.profile
}

/** The profile an address belongs in, as siteProfile, with the site in its list that decided it. */
export function siteRule(sites: Record<string, string[]>, url: string): { profile: string; pattern: string } | undefined {
  let target: string
  let withPort: string
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return undefined
    target = u.hostname + u.pathname
    // `localhost:3000` is only that port; `localhost` is any.
    withPort = u.host + u.pathname
  } catch {
    return undefined
  }
  let best: { profile: string; pattern: string; length: number } | undefined
  for (const [profile, patterns] of Object.entries(sites)) {
    for (const raw of patterns) {
      const p = raw.trim().replace(/^[a-z]+:\/\//i, '')
      if (!p || (best && p.length <= best.length) || !siteRegExp(p).test(/^[^/]*:/.test(p) ? withPort : target)) continue
      best = { profile, pattern: raw.trim(), length: p.length }
    }
  }
  return best && { profile: best.profile, pattern: best.pattern }
}

/** The domain a web address is on, as the URL bar saves it to a profile's sites: its host without www. '' for anything else. */
export function siteDomain(url: string): string {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.hostname.toLowerCase().replace(/^www\./, '') : ''
  } catch {
    return ''
  }
}

/** A site as written in a list, reduced to compare with a domain: no scheme, no www, no trailing slash. */
export const bareSite = (p: string) => p.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').replace(/\/+$/, '')

/** The profile whose sites list has exactly this domain. */
export function domainProfile(sites: Record<string, string[]>, domain: string): string | undefined {
  return Object.entries(sites).find(([, list]) => list.some((p) => bareSite(p) === domain))?.[0]
}

/**
 * The sites lists with `domain` in `profile`'s list only, or in nobody's with null. Every other
 * line stays as it was, so what was written by hand in settings is kept.
 */
export function withDomain(sites: Record<string, string[]>, domain: string, profile: string | null): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const [id, list] of Object.entries(sites)) {
    const kept = list.filter((p) => bareSite(p) !== domain)
    if (kept.length) out[id] = kept
  }
  if (profile) out[profile] = [...(out[profile] ?? []), domain]
  return out
}

const escape = (s: string, star: string) => s.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join(star)

function siteRegExp(pattern: string): RegExp {
  const slash = pattern.indexOf('/')
  const host = slash < 0 ? pattern : pattern.slice(0, slash)
  // A path covers what's under it: github.com/acme covers github.com/acme/app but not
  // github.com/acme-evil. A bare site covers all of it.
  const rest = pattern.slice(slash)
  const path = slash < 0 ? '(?:/.*)?' : `${escape(rest, '.*')}${/[/*]$/.test(rest) ? '.*' : '(?:/.*)?'}`
  return new RegExp(`^(?:[^/]*\\.)?${escape(host, '[^/]*')}${path}$`, 'i')
}
