/**
 * Opens a connection to a site you're about to go to, so DNS, TCP and TLS are done before you
 * press Return or click. Chrome does this from its own browser layer, which Electron leaves out;
 * jbrow asks the profile's session (session.preconnect) when there's a strong sign of where you're
 * going: the address bar's completion or highlighted suggestion, the search engine as the address
 * bar opens, a sleeping tab under the pointer in the sidebar.
 *
 * A connection tells the site's DNS and server that someone may be coming, so private addresses
 * never get one, and only http(s) origins do. Each origin gets one at most every few seconds: Chromium
 * keeps an idle preconnected socket for about ten, and asking again before then does nothing useful.
 */

/** How long after preconnecting an origin it isn't asked for again. */
export const REPEAT_MS = 5000

export class Preconnector {
  private last = new Map<string, number>()

  constructor(
    private connect: (profile: string, origin: string) => void,
    private enabled: () => boolean,
    private isPrivate: (url: string) => boolean,
    private now: () => number = Date.now,
  ) {}

  /** Preconnects to `url`'s origin in `profile`'s session, unless it mustn't or just did. Returns whether it did. */
  to(profile: string, url: string): boolean {
    if (!this.enabled()) return false
    const origin = originOf(url)
    if (!origin || this.isPrivate(url) || this.isPrivate(origin)) return false
    const key = `${profile} ${origin}`
    const t = this.now()
    if (t - (this.last.get(key) ?? -Infinity) < REPEAT_MS) return false
    this.last.set(key, t)
    if (this.last.size > 200) for (const [k, at] of this.last) if (t - at >= REPEAT_MS) this.last.delete(k)
    this.connect(profile, origin)
    return true
  }
}

/** The http(s) origin of `url`, or null for anything else. */
export function originOf(url: string): string | null {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null
  } catch {
    return null
  }
}
