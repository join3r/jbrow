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
