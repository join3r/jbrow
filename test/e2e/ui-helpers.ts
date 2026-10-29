// Helpers for the tests of jbrow's UI, settings and per-page features (not tabs and threads).
import type { UiState, UiTab } from '../../src/shared/types'
import { waitFor, type Cdp, type Jbrow, type TestServer } from './harness'

/** Settings that keep a run off the internet: searches and suggestions stay local, no phishing lists. */
export function offline(web?: TestServer): Record<string, unknown> {
  return {
    searchUrl: `${web?.url ?? 'http://127.0.0.1:9'}/search?q=%s`,
    searchSuggestions: false,
    dangerousSites: false,
  }
}

export const activeTab = (s: UiState): UiTab | undefined => s.tabs.find((t) => t.id === s.activeId)

/**
 * Keeps every message main sends the UI on `channel` (window.__msgs[channel]), from now on.
 * Returns a reader for them.
 */
export async function record<T = any>(
  jb: Jbrow,
  channel: string,
): Promise<{
  all: () => Promise<T[]>
  clear: () => Promise<void>
  /** Waits for any message since the last clear() to pass `test`. */
  waitFor: (test: (m: T) => unknown, what?: string, timeout?: number) => Promise<T>
  /** Waits for the latest message to pass `test`, for channels that send the whole list each time. */
  waitLatest: (test: (m: T) => unknown, what?: string, timeout?: number) => Promise<T>
}> {
  const ui = await jb.ui()
  await ui.eval(`(() => {
    window.__msgs ??= {}
    if (window.__msgs[${JSON.stringify(channel)}]) return
    window.__msgs[${JSON.stringify(channel)}] = []
    window.jbrow.on(${JSON.stringify(channel)}, (m) => window.__msgs[${JSON.stringify(channel)}].push(m))
  })()`)
  const all = () => ui.eval<T[]>(`window.__msgs[${JSON.stringify(channel)}]`)
  return {
    all,
    clear: () => ui.eval(`void (window.__msgs[${JSON.stringify(channel)}].length = 0)`),
    waitFor: async (test, what = `a ${channel} message`, timeout) =>
      waitFor(async () => (await all()).find((m) => test(m)), what, timeout),
    waitLatest: async (test, what = `a ${channel} message`, timeout) =>
      waitFor(async () => {
        const last = (await all()).at(-1)
        return last !== undefined && test(last) ? last : null
      }, what, timeout),
  }
}

let settleSeq = 1_000_000
/**
 * Waits until main has handled everything the UI sent so far and the UI has had its answers.
 * Main answers 'suggest' in order with the request's seq, so that answer comes after the rest.
 */
export async function settle(jb: Jbrow) {
  const replies = await record<{ seq: number }>(jb, 'suggestions')
  const seq = ++settleSeq
  await jb.send('suggest', { input: '', seq })
  await replies.waitFor((r) => r.seq === seq, 'main to catch up')
}

/** The id of what has the keyboard in the UI page, '' for nothing in particular. */
export const focusedId = (ui: Cdp) => ui.eval<string>('document.activeElement?.id ?? ""')

/** Whether an element of the UI is shown (not hidden itself or inside something hidden). */
export const isShown = (ui: Cdp, id: string) =>
  ui.call((id) => {
    const el = document.getElementById(id)
    return !!el && !el.closest('[hidden]') && el.getClientRects().length > 0
  }, id)

/** Opens a tab at `url` and waits until it's the loaded, active tab. */
export async function openTab(jb: Jbrow, url: string): Promise<UiTab> {
  const s = await jb.navigate(url, { newTab: true })
  await jb.pageFocused(activeTab(s)!.url)
  return activeTab(s)!
}

/** Opens a tab at `url` and waits until its page has been painted: Chromium finds nothing in a page before that. */
export async function openPainted(jb: Jbrow, url: string): Promise<UiTab> {
  const tab = await openTab(jb, url)
  const page = await jb.page((t) => t.url === url)
  await page.eval('new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))')
  page.close()
  return tab
}

/** A PNG's width and height, from its header. */
export function pngSize(png: Buffer): { width: number; height: number } {
  if (png.subarray(1, 4).toString('latin1') !== 'PNG') throw new Error('not a PNG')
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}
