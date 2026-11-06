// Files and folders on this computer: typed as paths, listed as pages, opened from the list.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { after, before, test } from 'node:test'
import { launch, serve, waitFor, type Jbrow, type TestServer } from './harness'
import { activeTab, offline, realClick, tabById } from './tab-helpers'

let jb: Jbrow
let web: TestServer
let dir: string
const url = (...parts: string[]) => pathToFileURL(path.join(dir, ...parts)).href

before(async () => {
  // realpath: macOS's /var is a link to /private/var, and Chromium reports the real path.
  dir = realpathSync(mkdtempSync(path.join(tmpdir(), 'jbrow-files-')))
  writeFileSync(path.join(dir, 'page.html'), '<title>Local page</title><p>hello')
  writeFileSync(path.join(dir, 'notes.txt'), 'plain text')
  mkdirSync(path.join(dir, 'sub folder'))
  writeFileSync(path.join(dir, 'sub folder', 'a #1.txt'), 'inside')
  web = await serve({})
  jb = await launch({ settings: offline(web) })
})
after(async () => {
  await jb?.close()
  await web?.close()
  rmSync(dir, { recursive: true, force: true })
})

async function typed(input: string) {
  // One tab at a time, so each test finds its own page by address.
  for (const t of (await jb.state()).tabs) await jb.send('close', { id: t.id })
  await jb.send('new')
  await jb.waitForState((s) => activeTab(s) && !activeTab(s)!.url, 'an empty tab')
  await jb.send('navigate', { input })
}

const pageAt = (address: string) => jb.page((t) => t.url === address)

test('a path typed in the address bar opens the file', async () => {
  await typed(path.join(dir, 'page.html'))
  const s = await jb.waitForState((s) => activeTab(s)?.title === 'Local page', 'the local page')
  assert.equal(activeTab(s)!.url, url('page.html'))
})

test('a folder lists what is in it, folders first', async () => {
  await typed(dir)
  const s = await jb.waitForState((s) => activeTab(s)?.title === path.basename(dir), 'the folder list')
  assert.equal(activeTab(s)!.url, url())
  const page = await pageAt(url())
  const names = await waitFor(() => page.eval<string[]>('[...document.querySelectorAll("td:first-child a")].map((a) => a.textContent)'), 'the rows')
  assert.equal(names.length, 4)
  assert.match(names[0], new RegExp(`↑ ${path.basename(path.dirname(dir))}`))
  assert.deepEqual(names.slice(1), ['📁 sub folder', '📄 notes.txt', '📄 page.html'])
})

test('links in the list open folders and files, and back returns to the list', async () => {
  await typed(dir)
  const id = (await jb.waitForState((s) => activeTab(s)?.title === path.basename(dir), 'the folder list')).activeId!
  let page = await pageAt(url())
  await waitFor(() => page.eval('!!document.querySelector("a[href$=\'sub%20folder/\']")'), 'the sub folder link')
  await realClick(page, 'a[href$="sub%20folder/"]')
  await jb.waitForState((s) => tabById(s, id)?.url === url('sub folder') + '/' && tabById(s, id)?.title === 'sub folder', 'the sub folder')

  page = await pageAt(url('sub folder') + '/')
  await waitFor(() => page.eval('!!document.querySelector("a[href$=\'.txt\']")'), 'the file link')
  await realClick(page, 'a[href$=".txt"]')
  // A file without a title of its own is named after the file, not the folder it came from.
  await jb.waitForState((s) => tabById(s, id)?.url === url('sub folder', 'a #1.txt') && !tabById(s, id)?.title, 'the file')

  await jb.send('nav', { action: 'back' })
  await jb.waitForState((s) => tabById(s, id)?.url === url('sub folder') + '/' && tabById(s, id)?.title === 'sub folder', 'the sub folder again')
})

test('⌘-click opens a file from the list in a new tab, and the list stays', async () => {
  await typed(dir)
  const id = (await jb.waitForState((s) => activeTab(s)?.title === path.basename(dir), 'the folder list')).activeId!
  const page = await pageAt(url())
  await waitFor(() => page.eval('!!document.querySelector("a[href$=\'notes.txt\']")'), 'the notes link')
  await realClick(page, 'a[href$="notes.txt"]', 4 /* ⌘ */)
  const s = await jb.waitForState((s) => s.tabs.some((t) => t.url === url('notes.txt') && t.opener === id), 'a tab for notes.txt')
  assert.equal(s.activeId, id)
  assert.equal(tabById(s, id)!.url, url())
})

test('a folder typed with ~ opens from your home folder', async () => {
  await typed('~')
  await jb.waitForState((s) => activeTab(s)?.title === path.basename(homedir()) && activeTab(s)?.url === pathToFileURL(homedir()).href, 'the home folder')
})
