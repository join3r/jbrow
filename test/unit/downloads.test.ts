import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, mock, test, type TestContext } from 'node:test'
import { clipboard, dialog, shell, type BrowserWindow, type Session, type WebContents } from 'electron'
import { userData } from '../mocks/electron'
import { Downloads } from '../../src/main/downloads'

const downloads = path.join(userData, 'Downloads')

class Item extends EventEmitter {
  savePath = ''
  received = 0
  paused = false
  cancelled = false
  resumable = true
  constructor(public filename: string, public url = 'https://files.example/get?token=secret', public chain = [url], public total = 1000) {
    super()
  }
  getFilename = () => this.filename
  setSavePath = (p: string) => void (this.savePath = p)
  getURL = () => this.url
  getURLChain = () => this.chain
  getTotalBytes = () => this.total
  getReceivedBytes = () => this.received
  getCurrentBytesPerSecond = () => 100
  isPaused = () => this.paused
  canResume = () => this.resumable
  pause = () => void (this.paused = true)
  resume = () => void (this.paused = false)
  cancel = () => void (this.cancelled = true)
}

class Page extends EventEmitter {
  destroyed = false
  downloads: string[] = []
  constructor(public url = 'https://files.example/list') {
    super()
  }
  getURL = () => this.url
  isDestroyed = () => this.destroyed
  downloadURL = (url: string) => void this.downloads.push(url)
  /** A new document: by you (no initiator) or by the page. */
  navigate(url: string, byYou = false) {
    this.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false, initiator: byYou ? undefined : 'https://files.example' })
    this.url = url
    this.emit('did-navigate', {}, url)
  }
}

function setup({ visible = true } = {}) {
  let changes = 0
  const started: unknown[] = []
  const state = { visible }
  const d = new Downloads({
    onChange: () => void changes++,
    onStarted: (wc) => void started.push(wc),
    visible: () => state.visible,
    window: () => ({ isDestroyed: () => false }) as unknown as BrowserWindow,
  })
  const sess = Object.assign(new EventEmitter(), { urls: [] as string[], downloadURL: (url: string) => void sess.urls.push(url) })
  d.attach(sess as unknown as Session, 'p')
  const download = (item: Item, page = new Page()) => {
    sess.emit('will-download', {}, item, page)
    return d.list().at(-1)!
  }
  return { d, sess, download, started, state, changes: () => changes }
}

/** Waits for a finished download's quarantine (a real child process) to settle. */
async function until(ok: () => boolean) {
  const start = Date.now()
  while (!ok() && Date.now() - start < 10_000) await new Promise((r) => setImmediate(r))
  assert.ok(ok(), 'timed out')
}

function quiet(t: TestContext) {
  t.mock.method(console, 'log', () => {})
  t.mock.method(console, 'error', () => {})
}

beforeEach((t) => {
  rmSync(downloads, { recursive: true, force: true })
  // A finished download leaves the list after an hour, on a timer that would keep the test running.
  mock.timers.enable({ apis: ['setTimeout'] })
  quiet(t as TestContext)
})
afterEach(() => mock.timers.reset())

test('a download goes into Downloads under its own name', () => {
  const { download, started } = setup()
  const page = new Page()
  const info = download(new Item('report.pdf', 'https://cdn.example/r.pdf', ['https://files.example/r', 'https://cdn.example/r.pdf']), page)
  assert.equal(info.path, path.join(downloads, 'report.pdf'))
  assert.equal(info.filename, 'report.pdf')
  assert.equal(info.profile, 'p')
  // The address you clicked, not where it redirected.
  assert.equal(info.url, 'https://files.example/r')
  assert.equal(info.state, 'progressing')
  assert.equal(info.total, 1000)
  assert.equal(info.openable, true)
  assert.deepEqual(started, [page])
})

test('a download with no page (a retry) still finishes', async () => {
  const { sess, d, started } = setup()
  const item = new Item('again.zip')
  sess.emit('will-download', {}, item, null)
  const info = d.list().at(-1)!
  assert.equal(info.state, 'progressing')
  assert.deepEqual(started, [])
  item.emit('done', {}, 'cancelled')
  assert.equal(d.list().length, 0)
})

test('names never clash with files there or still downloading', () => {
  const { download } = setup()
  mkdirSync(downloads, { recursive: true })
  writeFileSync(path.join(downloads, 'photo.jpg'), '')
  assert.equal(download(new Item('photo.jpg')).filename, 'photo (1).jpg')
  assert.equal(download(new Item('photo.jpg')).filename, 'photo (2).jpg')
  assert.equal(download(new Item('archive.tar.gz')).filename, 'archive.tar.gz')
  assert.equal(download(new Item('archive.tar.gz')).filename, 'archive.tar (1).gz')
  assert.equal(download(new Item('README')).filename, 'README')
  assert.equal(download(new Item('README')).filename, 'README (1)')
})

test('path separators in names can’t leave the Downloads folder', () => {
  const { download } = setup()
  for (const name of ['../../evil.sh', '..\\..\\evil.bat', 'C:\\Windows\\x.dll', 'a:b.txt']) {
    const info = download(new Item(name))
    assert.equal(path.dirname(info.path), downloads, name)
    assert.doesNotMatch(info.filename, /[/\\:]/)
  }
  assert.equal(download(new Item('')).filename, 'download')
  // '..' alone is a name, not the parent folder.
  const dots = download(new Item('..'))
  assert.equal(path.dirname(dots.path), downloads)
  assert.notEqual(dots.path, userData)
})

test('files that run code aren’t openable', () => {
  const { download } = setup()
  for (const name of ['Installer.pkg', 'run.command', 'setup.EXE', 'script.sh', 'App.app', 'link.webloc', 'tool.PS1']) assert.equal(download(new Item(name)).openable, false, name)
  for (const name of ['notes.txt', 'movie.mp4', 'image.dmg', 'archive.zip', 'noext']) assert.equal(download(new Item(name)).openable, true, name)
})

test('progress is pushed a few times a second', () => {
  const { download, changes } = setup()
  const item = new Item('big.iso')
  download(item)
  const before = changes()
  for (let i = 1; i <= 10; i++) {
    item.received = i * 100
    item.emit('updated', {}, 'progressing')
  }
  assert.equal(changes(), before)
  mock.timers.tick(250)
  assert.equal(changes(), before + 1)
})

test('progress and speed follow the item', () => {
  const { download, d } = setup()
  const item = new Item('big.iso')
  download(item)
  item.received = 500
  item.emit('updated', {}, 'progressing')
  assert.equal(d.list()[0].received, 500)
  assert.equal(d.list()[0].bytesPerSecond, 100)
  item.paused = true
  item.emit('updated', {}, 'progressing')
  assert.equal(d.list()[0].state, 'paused')
  assert.equal(d.list()[0].bytesPerSecond, 0)
  item.paused = false
  item.emit('updated', {}, 'interrupted')
  assert.equal(d.list()[0].state, 'interrupted')
})

test('a cancelled download goes away', () => {
  const { download, d } = setup()
  const item = new Item('a.zip')
  download(item)
  item.emit('done', {}, 'cancelled')
  assert.deepEqual(d.list(), [])
})

test('a finished download is completed once it’s been quarantined, wherever xattr is', async (t) => {
  const notes: unknown[] = []
  const { download, d } = setup({ visible: true })
  const item = new Item('a.zip')
  download(item)
  item.received = 1000
  item.emit('done', {}, 'completed')
  await until(() => d.list()[0]?.state === 'completed')
  assert.equal(d.list()[0].received, 1000)
  assert.equal(d.list()[0].bytesPerSecond, 0)
  assert.equal(typeof d.list()[0].endedAt, 'number')
  assert.deepEqual(notes, [])
  // It stays in the list for an hour.
  mock.timers.tick(59 * 60 * 1000)
  assert.equal(d.list().length, 1)
  mock.timers.tick(60 * 1000)
  assert.deepEqual(d.list(), [])
  void t
})

test('dismiss takes a finished download away sooner', async () => {
  const { download, d } = setup()
  const item = new Item('a.zip')
  download(item)
  item.emit('done', {}, 'completed')
  await until(() => d.list()[0]?.state === 'completed')
  d.act(d.list()[0].id, 'dismiss')
  assert.deepEqual(d.list(), [])
})

test('a failed download stays in the list as failed', async () => {
  const { download, d } = setup({ visible: false })
  const item = new Item('a.zip')
  download(item)
  item.emit('done', {}, 'interrupted')
  await until(() => d.list()[0]?.state === 'failed')
})

test('actions on a running download', async (t) => {
  const { download, d, sess } = setup()
  const item = new Item('a.zip', 'https://files.example/a.zip')
  const { id } = download(item)
  d.act(id, 'pause')
  assert.equal(item.paused, true)
  assert.equal(d.list()[0].state, 'paused')
  d.act(id, 'pause')
  d.act(id, 'resume')
  assert.equal(item.paused, false)
  item.resumable = false
  item.paused = true
  d.act(id, 'resume')
  assert.equal(item.paused, true)
  // Open does nothing until it's done, and dismiss doesn't take a running one away.
  const open = t.mock.method(shell, 'openPath', async () => '')
  d.act(id, 'open')
  assert.equal(open.mock.callCount(), 0)
  d.act(id, 'dismiss')
  assert.equal(d.list().length, 1)
  d.act(id, 'copy-link')
  assert.equal(clipboard.readText(), 'https://files.example/a.zip')
  d.act(id, 'cancel')
  assert.equal(item.cancelled, true)
  d.act(id, 'retry')
  assert.deepEqual(sess.urls, ['https://files.example/a.zip'])
  assert.deepEqual(d.list(), [])
  d.act('nope', 'cancel')
})

test('open runs a finished file, but shows code in the folder instead', async (t) => {
  const { download, d } = setup()
  const opened: string[] = []
  const shown: string[] = []
  t.mock.method(shell, 'openPath', async (p: string) => void opened.push(p))
  t.mock.method(shell, 'showItemInFolder', (p: string) => void shown.push(p))
  mkdirSync(downloads, { recursive: true })
  const items = [new Item('doc.pdf'), new Item('setup.pkg'), new Item('gone.txt')]
  for (const item of items) download(item)
  writeFileSync(items[0].savePath, 'x')
  writeFileSync(items[1].savePath, 'x')
  for (const item of items) item.emit('done', {}, 'completed')
  await until(() => d.list().every((i) => i.state === 'completed'))
  for (const info of d.list()) d.act(info.id, 'open')
  assert.deepEqual(opened, [items[0].savePath])
  assert.deepEqual(shown, [items[1].savePath, items[2].savePath])
  // A finished file is never cancelled, it's on disk.
  d.act(d.list()[0].id, 'cancel')
  assert.equal(items[0].cancelled, false)
})

test('clearFinished keeps running downloads', async () => {
  const { download, d } = setup()
  const done = new Item('a.zip')
  const running = new Item('b.zip')
  download(done)
  download(running)
  done.emit('done', {}, 'completed')
  await until(() => d.list()[0].state === 'completed')
  d.clearFinished()
  assert.deepEqual(d.list().map((i) => i.filename), ['b.zip'])
})

test('a page’s second download in one load waits for you to allow it', async (t) => {
  const asked: unknown[] = []
  t.mock.method(dialog, 'showMessageBox', async (_win: unknown, options: Electron.MessageBoxOptions) => {
    asked.push(options.message)
    return { response: 1, checkboxChecked: false }
  })
  const { download } = setup()
  const page = new Page('https://files.example/list')
  const first = new Item('1.zip')
  const second = new Item('2.zip')
  const third = new Item('3.zip')
  download(first, page)
  assert.equal(first.paused, false)
  download(second, page)
  assert.equal(second.paused, true)
  download(third, page)
  await until(() => !second.paused && !third.paused)
  // One question for the page.
  assert.deepEqual(asked, ['https://files.example wants to download multiple files'])
})

test('blocked, or asked while jbrow is hidden, the extra downloads are cancelled', async (t) => {
  const showMessageBox = t.mock.method(dialog, 'showMessageBox', async () => ({ response: 0, checkboxChecked: false }))
  const { download, state } = setup()
  const page = new Page()
  download(new Item('1.zip'), page)
  const blocked = new Item('2.zip')
  download(blocked, page)
  await until(() => blocked.cancelled)
  assert.equal(showMessageBox.mock.callCount(), 1)

  state.visible = false
  const hidden = new Page('https://other.example/')
  download(new Item('a.zip'), hidden)
  const quiet = new Item('b.zip')
  download(quiet, hidden)
  await until(() => quiet.cancelled)
  assert.equal(showMessageBox.mock.callCount(), 1)
})

test('the question comes back only after you move on', async (t) => {
  t.mock.method(dialog, 'showMessageBox', async () => ({ response: 0, checkboxChecked: false }))
  const { download } = setup()
  const page = new Page('https://files.example/a')
  download(new Item('1.zip'), page)
  // The page reloading itself, or going elsewhere on its site, doesn't reset the count.
  page.navigate('https://files.example/b')
  const sneaky = new Item('2.zip')
  download(sneaky, page)
  assert.equal(sneaky.paused, true)
  // Loading it yourself does.
  page.navigate('https://files.example/a', true)
  const fresh = new Item('3.zip')
  download(fresh, page)
  assert.equal(fresh.paused, false)
  // So does the page going to another site.
  page.navigate('https://elsewhere.example/')
  const other = new Item('4.zip')
  download(other, page)
  assert.equal(other.paused, false)
})

test('a download you start from the page menu doesn’t count', () => {
  const { d, download } = setup()
  const page = new Page()
  download(new Item('1.zip'), page)
  d.start(page as unknown as WebContents, 'https://files.example/img.png')
  assert.deepEqual(page.downloads, ['https://files.example/img.png'])
  const next = new Item('img.png')
  download(next, page)
  assert.equal(next.paused, false)
})

test('a download from a page that is already gone still saves', () => {
  const { download, started } = setup()
  const page = new Page()
  page.destroyed = true
  const info = download(new Item('a.zip'), page)
  assert.equal(info.state, 'progressing')
  assert.deepEqual(started, [])
})
