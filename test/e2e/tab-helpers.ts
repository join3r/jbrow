// Helpers shared by the tab and navigation tests (tabs, navigation, threads, split, persistence).
import type { UiState, UiTab } from '../../src/shared/types'
import { waitFor, type Jbrow, type TestServer } from './harness'

/** Settings that keep jbrow off the network: no list downloads, no search suggestions, a local search engine. */
export const offline = (web: TestServer) => ({
  dangerousSites: false,
  searchSuggestions: false,
  searchUrl: `${web.url}/search?q=%s`,
})

export const activeTab = (s: UiState): UiTab | undefined => s.tabs.find((t) => t.id === s.activeId)

export const tabById = (s: UiState, id: string): UiTab | undefined => s.tabs.find((t) => t.id === id)

/** Opens `url` in a new tab and waits for it to load; returns that tab. */
export async function openTab(jb: Jbrow, url: string): Promise<UiTab> {
  const s = await jb.navigate(url, { newTab: true })
  return activeTab(s)!
}

/** Waits until tab `id` has loaded `url` (a prefix) and stopped loading. */
export function waitLoaded(jb: Jbrow, id: string, url: string, what = `${url} to load`) {
  return jb.waitForState((s) => {
    const t = tabById(s, id)
    return t && t.url.startsWith(url) && !t.loading && t.loaded
  }, what)
}

/** Makes `id` the active tab and waits for the state to say so. */
export async function activate(jb: Jbrow, id: string) {
  await jb.send('activate', { id })
  return jb.waitForState((s) => s.activeId === id, `tab ${id} to be active`)
}

export interface SidebarRow {
  id: string
  title: string
  classes: string[]
  /** Which part of the sidebar it's in. */
  kept: boolean
  folder: string | null
}

/** The tab rows jbrow's sidebar draws, top to bottom. */
export async function sidebarRows(jb: Jbrow): Promise<SidebarRow[]> {
  const ui = await jb.ui()
  return ui.call(() =>
    [...document.querySelectorAll<HTMLElement>('#threads .row[data-id]')].map((r) => ({
      id: r.dataset.id!,
      title: r.querySelector('.t')?.textContent ?? '',
      classes: [...r.classList],
      kept: !!r.closest('#kept'),
      folder: r.closest('.folder-body')?.previousElementSibling?.getAttribute('data-folder') ?? null,
    })),
  )
}

/** Waits until the sidebar's rows pass `test`. */
export async function waitRows(jb: Jbrow, test: (rows: SidebarRow[]) => unknown, what: string) {
  let last: SidebarRow[] = []
  try {
    return await waitFor(async () => {
      last = await sidebarRows(jb)
      return test(last) ? last : null
    }, what)
  } catch (error) {
    throw new Error(`${(error as Error).message}\n  rows: ${JSON.stringify(last)}`)
  }
}

/** The pinned icons at the top of the sidebar, by tab id. */
export async function pinIcons(jb: Jbrow): Promise<string[]> {
  const ui = await jb.ui()
  return ui.call(() => [...document.querySelectorAll<HTMLElement>('#pins .pin-tile')].map((p) => p.dataset.id!))
}

/** A page whose cookie `name` is set by /set?v=… and echoed back by /get. */
export const cookieRoutes = {
  '/set': (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    const v = new URL(req.url ?? '/', 'http://x').searchParams.get('v') ?? ''
    res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': `jb=${v}; Path=/` })
    res.end(`<title>set ${v}</title>`)
  },
  '/get': (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    const m = /(?:^|;\s*)jb=([^;]*)/.exec(req.headers.cookie ?? '')
    res.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' })
    res.end(`<title>cookie ${m ? m[1] : 'none'}</title>`)
  },
}

/** A tab's page once it's on screen: jbrow shows its window a moment after launch, and real input only reaches a page laid out there. */
export async function shownPage(jb: Jbrow, url: string) {
  const page = await jb.page(url)
  await waitFor(() => page.eval('innerWidth > 0 && document.visibilityState === "visible"'), `${url} to be on screen`)
  return page
}

/** A real click (not a script's), with modifier keys, in the middle of the element `selector` matches. */
export async function realClick(page: import('./harness').Cdp, selector: string, modifiers = 0) {
  const box = await page.call((sel) => {
    const r = document.querySelector(sel)!.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  }, selector)
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1, modifiers })
  }
}

/** Makes a folder with New Folder and types its name into the field the sidebar opens for it, as you would. Returns its id. */
export async function makeFolder(jb: Jbrow, name: string): Promise<string> {
  const before = new Set((await jb.state()).folders.map((f) => f.id))
  await jb.send('new-folder')
  const s = await jb.waitForState((s) => s.folders.some((f) => !before.has(f.id)), 'a new folder')
  const folder = s.folders.find((f) => !before.has(f.id))!
  if (folder.name !== 'New folder') throw new Error(`a new folder is named ${folder.name}`)
  const ui = await jb.ui()
  await waitFor(
    () => ui.call((id) => document.activeElement?.id === 'ren' && !!document.activeElement.closest(`[data-folder="${id}"]`), folder.id),
    'the name field',
  )
  await ui.eval('document.getElementById("ren").select()')
  await ui.type(name)
  await ui.press('Enter')
  await jb.waitForState((s) => s.folders.find((f) => f.id === folder.id)?.name === name, `the folder to be named ${name}`)
  return folder.id
}
