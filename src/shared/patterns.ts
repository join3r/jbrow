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
  let best: { profile: string; length: number } | undefined
  for (const [profile, patterns] of Object.entries(sites)) {
    for (const raw of patterns) {
      const p = raw.trim().replace(/^[a-z]+:\/\//i, '')
      if (!p || (best && p.length <= best.length) || !siteRegExp(p).test(/^[^/]*:/.test(p) ? withPort : target)) continue
      best = { profile, length: p.length }
    }
  }
  return best?.profile
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
