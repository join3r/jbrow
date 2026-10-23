import type { WebContents } from 'electron'
import type { Settings } from './settings'

/** Chrome's zoom steps, in percent. ⌘+ and ⌘− move between them. */
export const ZOOM_STEPS = [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500]

/** The site a zoom belongs to: the hostname without www. Only web pages have one. */
export function zoomSite(url: string): string | null {
  try {
    const u = new URL(url)
    return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, '') : null
  } catch {
    return null
  }
}

/**
 * Page zoom per site. Chromium already zooms every tab of a site together; this adds a default
 * for sites you haven't zoomed and, if you want, remembers each site's zoom across restarts in
 * settings.json. Otherwise a site's zoom lasts until jbrow quits.
 */
export class Zoom {
  /** Sites zoomed since launch, used while zoom isn't remembered. */
  private session: Record<string, number> = {}

  constructor(private settings: () => Settings, private save: () => void) {}

  private sites() {
    const { zoom } = this.settings()
    return zoom.remember ? zoom.sites : this.session
  }

  /** The zoom a page of this address gets, in percent. */
  percentFor(url: string): number {
    const site = zoomSite(url)
    return (site && this.sites()[site]) || this.settings().zoom.defaultPercent
  }

  /** Gives a page its site's zoom. Called when a page loads and when the settings change. */
  apply(wc: WebContents) {
    if (wc.isDestroyed() || !zoomSite(wc.getURL())) return
    const factor = this.percentFor(wc.getURL()) / 100
    if (Math.abs(wc.getZoomFactor() - factor) > 0.001) wc.setZoomFactor(factor)
  }

  /** ⌘+ (1), ⌘− (−1) or ⌘0 (0, back to the default). Returns the new zoom in percent. */
  step(wc: WebContents, direction: -1 | 0 | 1): number {
    const current = Math.round(wc.getZoomFactor() * 100)
    const next =
      direction === 0 ? this.settings().zoom.defaultPercent
      : direction > 0 ? (ZOOM_STEPS.find((s) => s > current) ?? ZOOM_STEPS.at(-1)!)
      : ([...ZOOM_STEPS].reverse().find((s) => s < current) ?? ZOOM_STEPS[0])
    wc.setZoomFactor(next / 100)
    const site = zoomSite(wc.getURL())
    if (site) {
      const sites = this.sites()
      if (next === this.settings().zoom.defaultPercent) delete sites[site]
      else sites[site] = next
      if (this.settings().zoom.remember) this.save()
    }
    return next
  }

  /**
   * Called before `remember` changes. Turned on, it keeps what you zoomed since launch; turned off,
   * the remembered zooms last until jbrow quits and leave settings.json.
   */
  setRemember(remember: boolean) {
    const { zoom } = this.settings()
    if (remember === zoom.remember) return
    if (remember) {
      zoom.sites = { ...zoom.sites, ...this.session }
      this.session = {}
    } else {
      this.session = { ...zoom.sites }
      zoom.sites = {}
    }
    zoom.remember = remember
  }

  /** Zoomed sites, for the settings screen. */
  list(): { site: string; percent: number }[] {
    return Object.entries(this.sites())
      .map(([site, percent]) => ({ site, percent }))
      .sort((a, b) => a.site.localeCompare(b.site))
  }

  /** Puts a site back to the default zoom. */
  forget(site: string) {
    delete this.sites()[site]
    if (this.settings().zoom.remember) this.save()
  }
}
