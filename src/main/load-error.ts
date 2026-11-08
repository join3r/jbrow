// A page that fails to load. Chromium shows its own error page, but Electron leaves it out, so
// the tab stays white and says nothing. jbrow writes its own page over the empty one, as it does
// for folders (folder-listing.ts): what went wrong, and a button to try again.
//
// The error page may not do anything itself, so its buttons come back here, through the script
// that wrote it. No other page can send them.
import { shell, type WebContents } from 'electron'
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Chromium's net error codes that jbrow explains. */
const NAME_NOT_RESOLVED = -105
const INTERNET_DISCONNECTED = -106
const CONNECTION_REFUSED = -102
const ADDRESS_UNREACHABLE = -109
const CONNECTION_TIMED_OUT = -118
const TIMED_OUT = -7

/** The macOS settings page where you let an app reach devices on your network. */
const LOCAL_NETWORK_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork'

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^\[|\]$/g, '')
  } catch {
    return ''
  }
}

/** A host on your own network: a .local name or a private address. */
export function isLocalHost(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '')
  if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.home.arpa')) return true
  const v4 = h.match(/^(\d+)\.(\d+)\.\d+\.\d+$/)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254)
  }
  return /^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)
}

/**
 * macOS stops an app that doesn't have Local Network access from reaching devices on your
 * network. Chromium then sees a name that doesn't resolve or an address it can't reach.
 */
export function maybeLocalNetworkBlock(url: string, code: number): boolean {
  return process.platform === 'darwin' && [NAME_NOT_RESOLVED, ADDRESS_UNREACHABLE, CONNECTION_TIMED_OUT, TIMED_OUT].includes(code) && isLocalHost(hostOf(url))
}

/** Codes a tab doesn't show a page for: it shows something of its own, or nothing went wrong. */
export function showsErrorPage(url: string, code: number): boolean {
  // -3: stopped or replaced (a download, a blocked dangerous site, another navigation).
  if (code === -3) return false
  // Certificate errors: jbrow's own warning covers the tab.
  if (code <= -200 && code > -300) return false
  if (/^file:/i.test(url)) {
    // A folder fails to load too; folder-listing.ts lists it.
    try {
      if (statSync(fileURLToPath(url)).isDirectory()) return false
    } catch {}
  }
  return /^(https?|file):/i.test(url)
}

/** What went wrong, in words. */
export function explain(url: string, code: number): { title: string; text: string } {
  const host = hostOf(url) || url
  if (maybeLocalNetworkBlock(url, code))
    return {
      title: `jbrow can't reach ${host}`,
      text: `${host} is on your local network. macOS lets jbrow reach devices there only if you allow it: turn on jbrow in System Settings › Privacy & Security › Local Network, then try again. If jbrow isn't in that list, quit and open jbrow again; macOS asks the next time a site needs it.`,
    }
  switch (code) {
    case NAME_NOT_RESOLVED:
      return { title: `jbrow can't find ${host}`, text: 'No address was found for this name. Check the spelling, or your connection.' }
    case INTERNET_DISCONNECTED:
      return { title: "You're offline", text: 'Connect to a network, then try again.' }
    case CONNECTION_REFUSED:
      return { title: `${host} refused to connect`, text: 'Nothing on that address answers. The site may be down, or on another port.' }
    case ADDRESS_UNREACHABLE:
      return { title: `jbrow can't reach ${host}`, text: 'There is no route to this address. Check your connection.' }
    case CONNECTION_TIMED_OUT:
    case TIMED_OUT:
      return { title: `${host} took too long to answer`, text: 'The site may be busy or down. Try again later.' }
    default:
      return { title: "This page didn't load", text: `${host} didn't load.` }
  }
}

/** The page for a failed load. */
export function errorHtml(url: string, code: number, description: string): string {
  const { title, text } = explain(url, code)
  const settings = maybeLocalNetworkBlock(url, code) ? '<button data-act="settings">Open Local Network settings</button>' : ''
  return `<!DOCTYPE html>
<html data-jbrow-error><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>${esc(hostOf(url) || url)}</title>
<style>
  body { font: 13px -apple-system, system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; }
  main { max-width: 480px; padding: 32px; }
  h1 { font-size: 17px; font-weight: 600; margin: 0 0 10px; word-break: break-word; }
  p { margin: 0 0 8px; line-height: 1.45; opacity: .8; }
  .code { font: 11px ui-monospace, monospace; opacity: .5; word-break: break-all; }
  .buttons { display: flex; gap: 8px; margin-top: 18px; }
  button { font: inherit; padding: 5px 14px; border-radius: 6px; border: 1px solid #8884; background: #8881; color: inherit; cursor: pointer; }
  button:hover { background: #8882; }
</style></head><body><main>
<h1>${esc(title)}</h1>
<p>${esc(text)}</p>
<p class="code">${esc(description || String(code))} · ${esc(url)}</p>
<div class="buttons"><button data-act="reload">Try again</button>${settings}</div>
</main></body></html>`
}

/** Settles with the next button clicked on the page. */
const nextAct = `new Promise((resolve) => {
  const go = (e) => {
    const b = e.target.closest && e.target.closest('button[data-act]')
    if (!b) return
    removeEventListener('click', go, true)
    resolve(b.dataset.act)
  }
  addEventListener('click', go, true)
})`

/** Writes the page if the tab still shows the empty error page, then waits for a button. */
const writePage = (html: string) => `(() => {
  if (location.protocol !== 'chrome-error:' || document.documentElement.hasAttribute('data-jbrow-error')) return null
  document.open()
  document.write(${JSON.stringify(html)})
  document.close()
  return ${nextAct}
})()`

/** Shows a page for the loads that fail in a tab. */
export function showLoadErrors(wc: WebContents, skip: (url: string, code: number) => boolean) {
  let failed: { url: string; code: number; description: string } | null = null
  const write = async () => {
    const f = failed
    if (!f || wc.isDestroyed() || wc.getURL() !== f.url) return
    for (let script = writePage(errorHtml(f.url, f.code, f.description)); ; script = nextAct) {
      const act = (await wc.executeJavaScript(script).catch(() => null)) as string | null
      if (!act || wc.isDestroyed() || wc.getURL() !== f.url) return
      if (act === 'settings') void shell.openExternal(LOCAL_NETWORK_SETTINGS)
      if (act === 'reload') return wc.reload()
    }
  }
  wc.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) failed = null
  })
  wc.on('did-fail-load', (_e, code, description, url, isMainFrame) => {
    if (!isMainFrame || !showsErrorPage(url, code) || skip(url, code)) return
    failed = { url, code, description }
    // The empty error page may come before or after this event; the script checks it's there.
    void write()
  })
  wc.on('dom-ready', () => void write())
}
