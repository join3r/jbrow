// Downloads: a file the server sends as an attachment lands in <userData>/Downloads, and the
// UI hears about it on the 'downloads' channel; pausing, resuming, cancelling and dismissing.
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import type { ServerResponse } from 'node:http'
import path from 'node:path'
import { after, before, test } from 'node:test'
import type { DownloadInfo } from '../../src/shared/types'
import { launch, serve, waitFor, type Jbrow, type TestServer } from './harness'
import { activeTab, offline, record } from './ui-helpers'

let jb: Jbrow
let web: TestServer

const TEXT = 'hello from the test server\n'
const SIZE = 256 * 1024
const CHUNK = 64 * 1024

/** Responses held after their first chunk until the test lets them finish, by path. */
const held = new Map<string, ServerResponse>()
const holding = (name: string) => (_req: unknown, res: ServerResponse) => {
  res.writeHead(200, {
    'content-type': 'application/octet-stream',
    'content-disposition': `attachment; filename="${name}"`,
    'content-length': String(SIZE),
  })
  res.write(Buffer.alloc(CHUNK, 1))
  held.set(name, res)
}
const finish = (name: string) => held.get(name)!.end(Buffer.alloc(SIZE - CHUNK, 2))

before(async () => {
  web = await serve({
    '/hello': { headers: { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename="hello.txt"' }, body: TEXT },
    '/big': holding('big.bin'),
    '/doomed': holding('doomed.bin'),
  })
  jb = await launch({ settings: offline(web) })
})
after(async () => {
  for (const res of held.values()) res.destroy()
  await jb?.close()
  await web?.close()
})

/** Downloads `url` from a new, empty tab: a page that downloads twice would ask first, in a dialog. */
async function download(url: string) {
  await jb.send('new')
  const s = await jb.waitForState((s) => !!activeTab(s) && !activeTab(s)!.url, 'an empty tab')
  await jb.send('navigate', { input: url })
  return activeTab(s)!.id
}

const downloadsDir = () => jb.file('Downloads')

test('an attachment lands in the Downloads folder and shows as completed', async () => {
  const msgs = await record<DownloadInfo[]>(jb, 'downloads')
  await download(`${web.url}/hello`)
  const list = await msgs.waitLatest((l) => l.some((d) => d.filename === 'hello.txt' && d.state === 'completed'), 'a completed download')
  const d = list.find((d) => d.filename === 'hello.txt')!
  assert.equal(d.path, path.join(downloadsDir(), 'hello.txt'))
  assert.equal(d.url, `${web.url}/hello`)
  assert.equal(d.received, TEXT.length)
  assert.equal(d.openable, true)
  assert.equal(readFileSync(d.path, 'utf8'), TEXT)
})

test('the same name again gets a number', async () => {
  const msgs = await record<DownloadInfo[]>(jb, 'downloads')
  await msgs.clear()
  await download(`${web.url}/hello`)
  const list = await msgs.waitLatest((l) => l.some((d) => d.filename === 'hello (1).txt' && d.state === 'completed'), 'the second download')
  const d = list.find((d) => d.filename === 'hello (1).txt')!
  assert.equal(readFileSync(d.path, 'utf8'), TEXT)
  assert.equal(readFileSync(path.join(downloadsDir(), 'hello.txt'), 'utf8'), TEXT)
})

test('a download pauses, resumes and finishes', async () => {
  const msgs = await record<DownloadInfo[]>(jb, 'downloads')
  await download(`${web.url}/big`)
  const find = (l: DownloadInfo[]) => l.find((d) => d.filename === 'big.bin')
  const started = find(await msgs.waitLatest((l) => find(l)?.state === 'progressing' && find(l)!.received >= CHUNK, 'the first chunk'))!
  assert.equal(started.total, SIZE)

  await jb.send('download', { id: started.id, action: 'pause' })
  await msgs.waitLatest((l) => find(l)?.state === 'paused', 'paused')
  await jb.send('download', { id: started.id, action: 'resume' })
  await msgs.waitLatest((l) => find(l)?.state === 'progressing', 'going again')

  finish('big.bin')
  const done = find(await msgs.waitLatest((l) => find(l)?.state === 'completed', 'completed'))!
  assert.equal(done.received, SIZE)
  assert.ok(done.endedAt! >= done.startedAt)
  await waitFor(() => existsSync(done.path), 'the file')
  assert.equal(readFileSync(done.path).length, SIZE)

  // Dismissed, it leaves the list; the file stays.
  await jb.send('download', { id: done.id, action: 'dismiss' })
  await msgs.waitLatest((l) => !find(l), 'the download to leave the list')
  assert.ok(existsSync(done.path))
})

test('a cancelled download goes away and leaves no file', async () => {
  const msgs = await record<DownloadInfo[]>(jb, 'downloads')
  await msgs.clear()
  await download(`${web.url}/doomed`)
  const find = (l: DownloadInfo[]) => l.find((d) => d.filename === 'doomed.bin')
  const d = find(await msgs.waitLatest((l) => find(l)?.state === 'progressing' && find(l)!.received >= CHUNK, 'the first chunk'))!
  await jb.send('download', { id: d.id, action: 'cancel' })
  await msgs.waitLatest((l) => !find(l), 'the download to go')
  // Chromium deletes the partial file a moment after.
  await waitFor(() => !existsSync(d.path), 'the partial file to be deleted')
  // Cancelling something that's gone does nothing.
  await jb.send('download', { id: d.id, action: 'cancel' })
})

test('the UI shows a download in the toolbar', async () => {
  const ui = await jb.ui()
  await download(`${web.url}/hello`)
  await waitFor(
    () => ui.eval<boolean>('!document.getElementById("downloads").hidden && document.getElementById("dlList").children.length > 0'),
    'the downloads in the toolbar',
  )
})
