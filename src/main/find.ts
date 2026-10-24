import type { WebContents } from 'electron'

/** What the find bar is told: open (or select its query), step through matches, show counts, or close. */
export type FindUpdate = { open: true } | { step: 1 | -1 } | { matches: number; active: number } | { close: true }

/**
 * Find in page for the active tab. The bar lives in jbrow's UI, which owns the query; this runs
 * the searches on the page and reports the counts back. A search sticks to the page it started
 * on, so switching tabs or leaving the page closes the bar instead of searching somewhere else.
 */
export class FindInPage {
  private wc: WebContents | null = null
  private text = ''
  private request = 0
  private readonly watched = new WeakSet<WebContents>()

  constructor(private readonly send: (update: FindUpdate) => void) {}

  get open() {
    return this.wc !== null
  }

  /** Searches `wc` for `text`; the same text again moves to the next (or previous) match. */
  find(wc: WebContents, text: string, forward = true) {
    if (this.wc && this.wc !== wc) this.stop()
    this.wc = wc
    this.watch(wc)
    if (!text) {
      this.text = ''
      if (!wc.isDestroyed()) wc.stopFindInPage('clearSelection')
      return this.send({ matches: 0, active: 0 })
    }
    // findNext: true starts a new search; false steps through the current one.
    this.request = wc.findInPage(text, { forward, findNext: text !== this.text })
    this.text = text
  }

  /** Clears the highlight. The bar has closed, or is about to. */
  stop() {
    const wc = this.wc
    this.wc = null
    this.text = ''
    if (wc && !wc.isDestroyed()) wc.stopFindInPage('clearSelection')
  }

  /** The bar was open but its page went away or changed: close it in the UI too. */
  private close() {
    if (!this.wc) return
    this.stop()
    this.send({ close: true })
  }

  private watch(wc: WebContents) {
    if (this.watched.has(wc)) return
    this.watched.add(wc)
    wc.on('found-in-page', (_e, result) => {
      // A reply to an older search, e.g. for what was typed one key ago, is ignored.
      if (wc !== this.wc || result.requestId < this.request || result.matches === undefined) return
      this.send({ matches: result.matches, active: result.activeMatchOrdinal })
    })
    wc.on('did-start-navigation', (details) => {
      if (wc === this.wc && details.isMainFrame && !details.isSameDocument) this.close()
    })
    wc.on('destroyed', () => {
      if (wc === this.wc) this.close()
    })
    // Esc in the page closes the bar too, as in Chrome, rather than reaching the page.
    wc.on('before-input-event', (event, input) => {
      if (wc !== this.wc || input.type !== 'keyDown' || input.key !== 'Escape') return
      if (input.meta || input.control || input.alt || input.shift) return
      event.preventDefault()
      this.close()
    })
  }
}
