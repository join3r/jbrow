/**
 * Search engines the settings screen offers. `url` and `suggest` take the encoded query in place
 * of %s. Every `suggest` answers in the OpenSearch suggestions format: ["query", ["one", "two"]].
 */
export const SEARCH_ENGINES = [
  {
    id: 'google',
    name: 'Google',
    url: 'https://www.google.com/search?q=%s',
    // Without ie and oe, Google answers in Latin-1 for anything outside ASCII.
    suggest: 'https://suggestqueries.google.com/complete/search?client=firefox&ie=utf-8&oe=utf-8&q=%s',
  },
  { id: 'duckduckgo', name: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=%s', suggest: 'https://duckduckgo.com/ac/?q=%s&type=list' },
  { id: 'bing', name: 'Bing', url: 'https://www.bing.com/search?q=%s', suggest: 'https://api.bing.com/osjson.aspx?query=%s' },
  { id: 'brave', name: 'Brave', url: 'https://search.brave.com/search?q=%s', suggest: 'https://search.brave.com/api/suggest?q=%s' },
  { id: 'kagi', name: 'Kagi', url: 'https://kagi.com/search?q=%s', suggest: 'https://kagi.com/api/autosuggest?q=%s' },
  { id: 'ecosia', name: 'Ecosia', url: 'https://www.ecosia.org/search?q=%s', suggest: 'https://ac.ecosia.org/autocomplete?q=%s&type=list' },
] as const

export type SearchEngine = (typeof SEARCH_ENGINES)[number]

/** The listed engine a search address is, or undefined for a custom one. */
export const engineOf = (searchUrl: string): SearchEngine | undefined => SEARCH_ENGINES.find((e) => e.url === searchUrl)

/**
 * Where to ask for search suggestions. A custom address on a listed engine's site (Google with
 * `&hl=en`, say) still gets that engine's; any other custom address gets none.
 */
export function suggestUrlFor(searchUrl: string): string | undefined {
  const exact = engineOf(searchUrl)
  if (exact) return exact.suggest
  try {
    const host = new URL(searchUrl.replace('%s', '')).hostname
    return SEARCH_ENGINES.find((e) => new URL(e.url.replace('%s', '')).hostname === host)?.suggest
  } catch {
    return undefined
  }
}

/** A custom search address must be a web address with %s where the query goes. */
export const isSearchUrl = (url: string) => /^https?:\/\/[^\s/]+\S*$/i.test(url) && url.includes('%s')

/**
 * Text that has an address in it rather than only words to search for: a scheme, a host with a dot
 * or port, localhost, an IP, an email address or a path, anywhere in it. "intranet.corp.example
 * login" would otherwise hand the host to the search engine, so every word is checked.
 */
export function looksLikeAddress(text: string): boolean {
  const t = text.trim()
  if (/^(about|file|data|javascript|mailto|chrome|chrome-extension|view-source|blob):/i.test(t)) return true
  return t.split(/\s+/).some(
    (w) =>
      /^[a-z][a-z0-9+.-]*:\/\//i.test(w) ||
      w.startsWith('/') ||
      w.startsWith('~') ||
      /^localhost\b/i.test(w) ||
      /[\p{L}\p{N}_-]\.[\p{L}\p{N}-]*\p{L}[\p{L}\p{N}-]*(:\d+)?(\/|$)/iu.test(w) ||
      /^\[[\da-f:.]+\](:\d+)?(\/|$)/i.test(w) ||
      /:\d+/.test(w) ||
      w.includes('/') ||
      /^\d+\.\d+\.\d+/.test(w) ||
      /\S@\S/.test(w),
  )
}

/** "?node.js" in the address bar searches for "node.js", as in Chrome; undefined for anything else. */
export function forcedSearch(text: string): string | undefined {
  const m = /^\?\s*(\S.*)$/s.exec(text.trim())
  return m?.[1]
}

/**
 * The page to open for text typed in the address bar, or undefined when it's words to search for.
 * Return does what the suggestions say it will, so both ask this. A dotted host whose last label
 * has a letter (example.com, münchen.de, not v1.2.3) gets https://. Hosts that are usually on your
 * own machine or network get http://, since they rarely have a certificate: localhost, IP
 * addresses, and a bare name with a port or path (nas:5000, router/).
 */
export function addressUrl(input: string): string | undefined {
  const t = input.trim()
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(t) || /^(about|chrome-extension|file):/i.test(t)) return t
  const m = /^(\[[\da-f:.]+\]|[\p{L}\p{N}_.-]+)(:\d+)?(\/\S*)?$/iu.exec(t)
  if (!m) return undefined
  const [, host, port, path] = m
  const local =
    host.startsWith('[') ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(host) ||
    /^(.+\.)?localhost$/i.test(host) ||
    (!host.includes('.') && /\p{L}/u.test(host) && !!(port || path))
  if (local) return `http://${t}`
  const labels = host.split('.')
  if (labels.length > 1 && labels.every(Boolean) && /\p{L}/u.test(labels.at(-1)!)) return `https://${t}`
  return undefined
}
