// Folders on this computer, as pages. Chromium lists a file:// folder itself, but Electron leaves
// out that list, so a folder fails to open (ERR_FILE_NOT_FOUND) and the tab stays blank. A
// handler for file:// can't step in: Electron skips it once the session has an extension that
// reaches every site, and jbrow's own does. So jbrow writes its own list over the error page.
// The tab keeps the folder's address and its place in back and forward.
//
// An error page may not open file:// links, so clicks in the list come back here, through the
// script that wrote it, and jbrow opens them. No other page can send one.
import type { WebContents } from 'electron'
import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export interface FolderEntry {
  name: string
  folder: boolean
  /** Bytes; null for folders. */
  size: number | null
  modified: number
}

/** A link clicked in the list: where to, and whether it goes to a new tab in the background (⌘-click, middle click). */
interface Click {
  url: string
  background: boolean
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

/** 1.2 MB, as Finder counts (1000s). */
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let n = bytes
  let u = -1
  while (n >= 1000 && u < units.length - 1) {
    n /= 1000
    u++
  }
  return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[u]}`
}

/** The page for a folder: its parent, then folders, then files, each by name as Finder sorts them. */
export function listingHtml(dir: string, entries: FolderEntry[], problem = ''): string {
  const sorted = [...entries].sort((a, b) => Number(b.folder) - Number(a.folder) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }))
  const date = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  const link = (to: string, folder: boolean) => esc(pathToFileURL(to).href + (folder && !to.endsWith(path.sep) ? '/' : ''))
  const row = (e: FolderEntry) =>
    `<tr${e.name.startsWith('.') ? ' class="hidden"' : ''}><td><a href="${link(path.join(dir, e.name), e.folder)}">${e.folder ? '📁' : '📄'} ${esc(e.name)}</a></td>` +
    `<td>${e.size === null ? '' : esc(formatSize(e.size))}</td><td>${esc(date(e.modified))}</td></tr>`
  const up = path.dirname(dir)
  const parent = up !== dir ? `<tr><td><a href="${link(up, true)}">↑ ${esc(path.basename(up) || up)}</a></td><td></td><td></td></tr>` : ''
  const note = problem ? `<p class="note">${esc(problem)}</p>` : sorted.length ? '' : '<p class="note">This folder is empty.</p>'
  return `<!DOCTYPE html>
<html data-jbrow-folder><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>${esc(path.basename(dir) || dir)}</title>
<style>
  body { font: 13px -apple-system, system-ui, sans-serif; margin: 24px 32px; }
  h1 { font-size: 15px; font-weight: 600; margin: 0 0 16px; word-break: break-all; }
  table { border-collapse: collapse; width: 100%; }
  th { text-align: left; font-weight: 500; opacity: .6; padding: 4px 16px 6px 0; }
  td { padding: 3px 16px 3px 0; white-space: nowrap; }
  td:first-child { width: 100%; white-space: normal; word-break: break-all; }
  td:not(:first-child) { opacity: .6; font-variant-numeric: tabular-nums; }
  a { color: inherit; text-decoration: none; }
  a:hover { text-decoration: underline; }
  tr.hidden { opacity: .5; }
  .note { opacity: .6; }
</style></head><body>
<h1>${esc(dir)}</h1>
<table><thead><tr><th>Name</th><th>Size</th><th>Modified</th></tr></thead><tbody>
${parent}${sorted.map(row).join('\n')}
</tbody></table>
${note}
</body></html>`
}

async function readFolder(dir: string): Promise<FolderEntry[]> {
  const names = await readdir(dir)
  const entries = await Promise.all(
    names.map(async (name): Promise<FolderEntry | null> => {
      try {
        // Follows links, so a link to a folder opens as one.
        const s = await stat(path.join(dir, name))
        return { name, folder: s.isDirectory(), size: s.isDirectory() ? null : s.size, modified: s.mtimeMs }
      } catch {
        return null // A broken link, or nothing there any more.
      }
    }),
  )
  return entries.filter((e): e is FolderEntry => !!e)
}

/** The folder a file:// address is, or null for a file, a missing path or any other address. */
async function folderAt(url: string): Promise<string | null> {
  if (!url.startsWith('file:')) return null
  try {
    const dir = fileURLToPath(url)
    return (await stat(dir)).isDirectory() ? dir : null
  } catch {
    return null
  }
}

/** Settles with the next click on a link in the list. */
const nextClick = `new Promise((resolve) => {
  const go = (e) => {
    const a = e.target.closest && e.target.closest('a[href]')
    if (!a || (e.type === 'auxclick' && e.button !== 1) || (e.type === 'click' && e.button !== 0)) return
    e.preventDefault()
    removeEventListener('click', go, true)
    removeEventListener('auxclick', go, true)
    resolve({ url: a.href, background: e.type === 'auxclick' || e.metaKey || e.ctrlKey })
  }
  addEventListener('click', go, true)
  addEventListener('auxclick', go, true)
})`

/** Writes the list, then waits for a click. Null if it's written already: dom-ready comes again after the write. */
const writeList = (html: string) => `(() => {
  if (document.documentElement.hasAttribute('data-jbrow-folder')) return null
  document.open()
  document.write(${JSON.stringify(html)})
  document.close()
  return ${nextClick}
})()`

export interface FolderTab {
  /** The tab shows the folder at `url`. Electron doesn't say so: to it, the page failed. */
  shown(url: string): void
  /** Opens a link ⌘-clicked in the list in a new tab, beside this one. */
  openTab(url: string): void
}

/** Lists the folders a tab opens. */
export function listFolders(wc: WebContents, tab: FolderTab) {
  wc.on('dom-ready', async () => {
    const url = wc.getURL()
    const dir = await folderAt(url)
    if (!dir || wc.isDestroyed() || wc.getURL() !== url) return
    let html: string
    try {
      html = listingHtml(dir, await readFolder(dir))
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      html = listingHtml(dir, [], code === 'EPERM' || code === 'EACCES' ? "jbrow isn't allowed to look in this folder." : `Couldn't read this folder: ${String(error)}`)
    }
    if (wc.isDestroyed() || wc.getURL() !== url) return
    tab.shown(url)
    // Each click opens one link; a background tab leaves the list here, waiting for the next.
    for (let script = writeList(html); ; script = nextClick) {
      const click = (await wc.executeJavaScript(script).catch(() => null)) as Click | null
      if (!click || wc.isDestroyed() || wc.getURL() !== url || !/^file:/i.test(click.url)) return
      if (!click.background) return void wc.loadURL(click.url).catch(() => {})
      tab.openTab(click.url)
    }
  })
}
