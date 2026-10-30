// Extensions bringing tabs to the front (chrome.tabs.update with active: true).
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { after, before, test } from 'node:test'
import { html, launch, removeDir, SANDBOXED, serve, sleep, tempDir, waitFor, type Jbrow, type TestServer } from './harness'
import { activate, offline, openTab, waitLoaded } from './tab-helpers'

let jb: Jbrow
let web: TestServer
let extDir: string

// What a page asks for, its extension does: bring the page to the front, as Bitwarden does when a
// page's passkey request ends; look up every tab, as Bitwarden does each time its worker starts;
// or attach the debugger to a tab, as Stem does to work in it.
const BACKGROUND = `chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.do === 'front' && sender.tab) chrome.tabs.update(sender.tab.id, { active: true })
  if (msg.do === 'get-all') chrome.tabs.query({}).then((all) => Promise.all(all.map((t) => chrome.tabs.get(t.id)))).then(reply)
  if (msg.do === 'attach') chrome.tabs.query({ url: msg.url }).then(([t]) => chrome.debugger.attach({ tabId: t.id }, '1.3')).then(() => reply(true))
  return true
})`
// The extension's worker needs electron-chrome-extensions' chrome.tabs, which only a sandboxed jbrow gives it.
const skip = !SANDBOXED && 'no sandbox here (Linux as root, or without user namespaces), so no tabs API in service workers'
const CONTENT = `window.addEventListener('message', (e) => {
  if (e.data?.do) chrome.runtime.sendMessage(e.data).then((answer) => window.postMessage({ answer }, '*'))
})`

before(async () => {
  extDir = tempDir('jbrow-ext-')
  mkdirSync(extDir, { recursive: true })
  writeFileSync(
    path.join(extDir, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Front',
      version: '1.0',
      permissions: ['tabs', 'debugger'],
      background: { service_worker: 'background.js' },
      content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'], run_at: 'document_start' }],
    }),
  )
  writeFileSync(path.join(extDir, 'background.js'), BACKGROUND)
  writeFileSync(path.join(extDir, 'content.js'), CONTENT)
  web = await serve({ '/one': html('One'), '/two': html('Two'), '/kept': html('Kept') })
  const now = Date.now()
  // A kept tab asleep since launch, and a newer one that comes up in front.
  const tabs = {
    tabs: [
      { id: 'kept', profile: 'personal', kept: true, url: `${web.url}/kept`, title: 'Kept', createdAt: now - 2000, lastSeen: now - 2000 },
      { id: 'front', profile: 'personal', url: `${web.url}/one`, title: 'One', createdAt: now - 1000, lastSeen: now - 1000 },
    ],
    activeId: 'front',
    folders: [],
    splits: [],
    archived: [],
  }
  jb = await launch({ settings: { ...offline(web), unpackedExtensions: { personal: [extDir] } }, tabs })
  await waitFor(() => jb.output.includes('loaded unpacked Front'), 'the extension to load')
})
after(async () => {
  await jb?.close()
  await web?.close()
  await removeDir(extDir)
})

/** Has the page at `url` ask its extension for `msg`; resolves with the answer. */
async function ask(url: string, msg: Record<string, unknown>) {
  const page = await jb.page(url)
  return page.eval(`new Promise((done) => {
    window.addEventListener('message', (e) => { if (e.data && 'answer' in e.data) done(e.data.answer) })
    window.postMessage(${JSON.stringify(msg)}, '*')
  })`)
}

/** Has the page ask its extension to bring it to the front. No answer comes back. */
async function askFront(url: string) {
  const page = await jb.page(url)
  await page.eval(`window.postMessage({ do: 'front' }, '*')`)
}

test('looking up a sleeping tab leaves it asleep; attaching the debugger loads it', { skip }, async () => {
  const kept = () => jb.state().then((s) => s.tabs.find((t) => t.id === 'kept')!)
  // Finished loading, not just given a page: asking it mid-load loses the answer with the old document.
  await waitLoaded(jb, 'front', `${web.url}/one`)
  assert.equal((await kept()).loaded, false)
  const all = (await ask(`${web.url}/one`, { do: 'get-all' })) as { url: string; discarded: boolean }[]
  assert.ok(all.some((t) => t.url === `${web.url}/kept` && t.discarded), 'tabs.get answers for the sleeping tab')
  await sleep(1000)
  assert.equal((await kept()).loaded, false)
  await ask(`${web.url}/one`, { do: 'attach', url: `${web.url}/kept` })
  await jb.waitForState((s) => s.tabs.find((t) => t.id === 'kept')?.loaded, 'the kept tab to load')
})

test('a background page an extension brings to the front stays where it is', { skip }, async () => {
  const one = await openTab(jb, `${web.url}/one`)
  await waitLoaded(jb, one.id, `${web.url}/one`)
  const two = await openTab(jb, `${web.url}/two`)
  // Long enough that one no longer counts as the tab just left.
  await sleep(5500)
  await askFront(`${web.url}/one`)
  await sleep(1000)
  assert.equal((await jb.state()).activeId, two.id)
})

test('an extension can give back the tab that was in front a moment ago', { skip }, async () => {
  const s = await jb.state()
  const one = s.tabs.find((t) => t.url === `${web.url}/one`)!
  const two = s.tabs.find((t) => t.url === `${web.url}/two`)!
  await activate(jb, two.id)
  await activate(jb, one.id)
  await askFront(`${web.url}/two`)
  await jb.waitForState((s) => s.activeId === two.id, 'two back in front')
})
