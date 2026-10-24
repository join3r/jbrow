import type { CompletionView } from '../shared/types'
import list from './top-sites.json'

/**
 * Popular sites, worldwide and in Slovakia, most popular first, each with its CrUX bucket (1000
 * for the top 1k, else 5000). scripts/top-sites.mjs makes the list; run `npm run top-sites` to
 * refresh it.
 */
const SITES = (list as [string, number][]).map(([host, bucket]) => ({ host, bare: host.replace(/^www\./, ''), bucket }))

/** Fewer letters than this never complete to a site you haven't been to. */
const MIN_TYPED = 3

/**
 * The site to complete what's typed to when your history has none: "youtu" is youtube.com before
 * you've ever been there. Three letters only complete to a top 1k site, four or more to any on the
 * list, so a short word you meant to search for rarely turns into an address.
 */
export function topSiteCompletion(typed: string, isPrivate: (url: string) => boolean): CompletionView | null {
  const t = typed.toLowerCase()
  if (/[\s/?#:]/.test(t)) return null
  const www = t.startsWith('www.')
  const bare = www ? t.slice(4) : t
  if (bare.length < MIN_TYPED) return null
  const bucket = bare.length === MIN_TYPED ? 1000 : Infinity
  for (const s of SITES) {
    if (s.bucket > bucket || !s.bare.startsWith(bare) || s.bare === bare) continue
    const url = `https://${s.host}/`
    if (isPrivate(url)) continue
    return { text: www ? `www.${s.bare}` : s.bare, url }
  }
  return null
}
