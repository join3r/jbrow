import { app, clipboard, dialog, Notification, shell, type BrowserWindow, type DownloadItem, type Session, type WebContents } from 'electron'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import type { DownloadInfo } from '../shared/types'
import { BACKGROUND } from './background'

/** A finished download leaves the toolbar when jbrow hides, when you open its details, or after this long. */
const KEEP_FINISHED_MS = 60 * 60 * 1000
const PUSH_EVERY_MS = 250

/**
 * Files that run something when opened: apps, installers, scripts, and links that can point at
 * either. Open shows these in Finder instead, so running one is a deliberate second step.
 */
const RUNS_CODE = new Set(
  (
    'app command tool terminal sh bash zsh csh tcsh ksh fish py pyc pl rb php js jxa scpt scptd applescript ' +
    'workflow action shortcut jar pkg mpkg prefpane kext plugin bundle dylib saver qlgenerator mdimporter ' +
    'osax webloc fileloc inetloc url exe msi bat cmd ps1 vbs'
  ).split(' '),
)
const runsCode = (file: string) => RUNS_CODE.has(path.extname(file).slice(1).toLowerCase())

/** Electron leaves downloads unquarantined, so Gatekeeper would never check them. Marks the file as Chrome does. */
function quarantine(file: string, url: string): Promise<void> {
  const value = `0081;${Math.floor(Date.now() / 1000).toString(16)};jbrow;${randomUUID().toUpperCase()}`
  return new Promise((resolve) =>
    execFile('/usr/bin/xattr', ['-w', 'com.apple.quarantine', value, file], (error) => {
      if (error) console.error(`[downloads] could not quarantine ${file} from ${origin(url)}:`, error.message)
      resolve()
    }),
  )
}

/** Download URLs often carry tokens; the log gets the site only. */
function origin(url: string): string {
  try {
    const u = new URL(url)
    // URL gives chrome-extension: the origin "null", which would lump every extension together.
    return u.protocol === 'chrome-extension:' ? `chrome-extension://${u.host}` : u.origin
  } catch {
    return '(unknown)'
  }
}

export type DownloadAction = 'pause' | 'resume' | 'cancel' | 'retry' | 'open' | 'show' | 'copy-link' | 'dismiss'

export interface DownloadHooks {
  /** The list changed. Called at most every PUSH_EVERY_MS while bytes are coming in. */
  onChange: () => void
  /** A download started from this page, which may be a tab opened only to start it. */
  onStarted: (wc: WebContents) => void
  /** jbrow is on screen, so a finished download needs no notification. */
  visible: () => boolean
  /** For the question a page's second download asks. */
  window: () => BrowserWindow
}

/** A tab that has downloaded from a site, as Chrome counts it: after the first, you're asked. */
interface PageDownloads {
  origin: string
  answer?: Promise<boolean>
}

interface Entry {
  info: DownloadInfo
  item: DownloadItem
  session: Session
  expire?: NodeJS.Timeout
}

/**
 * Downloads from every profile. They go straight into ~/Downloads, as in Chrome, under a name
 * that doesn't clash with a file already there or one still downloading.
 */
export class Downloads {
  private entries = new Map<string, Entry>()
  private seq = 0
  private pushTimer: NodeJS.Timeout | null = null
  private pages = new Map<WebContents, PageDownloads>()
  private watched = new WeakSet<WebContents>()
  /** The tab's latest page load was started by you (address bar, reload, back), not by a page. */
  private yours = new WeakMap<WebContents, boolean>()

  constructor(private hooks: DownloadHooks) {}

  attach(sess: Session, profileId: string) {
    sess.on('will-download', (_event, item, wc) => this.add(sess, profileId, item, wc))
  }

  list(): DownloadInfo[] {
    return [...this.entries.values()].map((e) => e.info)
  }

  act(id: string, action: DownloadAction) {
    const e = this.entries.get(id)
    if (!e) return
    const { item, info } = e
    switch (action) {
      case 'pause':
        if (info.state === 'progressing') item.pause()
        break
      case 'resume':
        if (item.canResume()) item.resume()
        break
      case 'cancel':
        // A finished file stays on disk; this only takes a running one away.
        if (info.state !== 'completed' && info.state !== 'failed') item.cancel()
        break
      case 'retry':
        this.remove(id)
        e.session.downloadURL(info.url)
        break
      case 'open':
        if (info.state !== 'completed') break
        if (existsSync(info.path) && info.openable) void shell.openPath(info.path)
        else shell.showItemInFolder(info.path)
        break
      case 'show':
        shell.showItemInFolder(info.path)
        break
      case 'copy-link':
        clipboard.writeText(info.url)
        break
      case 'dismiss':
        if (info.state === 'completed' || info.state === 'failed') this.remove(id)
        break
    }
    this.sync(e)
    this.push(true)
  }

  /** A download you asked for from the page menu. It doesn't count toward the page's own downloads. */
  start(wc: WebContents, url: string) {
    this.pages.delete(wc)
    wc.downloadURL(url)
  }

  /** jbrow hid: you've seen what finished while it was up. */
  clearFinished() {
    const before = this.entries.size
    for (const [id, e] of this.entries) if (e.info.state === 'completed' || e.info.state === 'failed') this.remove(id)
    if (this.entries.size !== before) this.push(true)
  }

  private add(sess: Session, profile: string, item: DownloadItem, wc: WebContents) {
    const id = `d${++this.seq}`
    const dir = app.getPath('downloads')
    mkdirSync(dir, { recursive: true })
    const savePath = this.freePath(dir, item.getFilename())
    item.setSavePath(savePath)
    const e: Entry = {
      item,
      session: sess,
      info: {
        id,
        profile,
        filename: path.basename(savePath),
        path: savePath,
        url: item.getURLChain()[0] ?? item.getURL(),
        state: 'progressing',
        received: 0,
        total: item.getTotalBytes(),
        bytesPerSecond: 0,
        startedAt: Date.now(),
        openable: !runsCode(savePath),
      },
    }
    this.entries.set(id, e)
    console.log(`[downloads] ${profile}: from ${origin(item.getURL())} -> ${savePath}`)
    this.checkPage(e, wc)

    item.on('updated', (_event, state) => {
      if (!this.entries.has(id)) return
      this.sync(e, state === 'interrupted')
      this.push()
    })
    item.once('done', async (_event, state) => {
      if (!this.entries.has(id)) return
      // Cancelled is something you did, so it just goes away.
      if (state === 'cancelled') {
        this.remove(id)
        return this.push(true)
      }
      // Before it shows as done, so it can't be opened unchecked.
      if (state === 'completed') await quarantine(savePath, e.info.url)
      if (!this.entries.has(id)) return
      e.info.state = state === 'completed' ? 'completed' : 'failed'
      e.info.endedAt = Date.now()
      this.sync(e)
      e.expire = setTimeout(() => {
        this.remove(id)
        this.push(true)
      }, KEEP_FINISHED_MS)
      if (state === 'completed') app.dock?.downloadFinished(savePath)
      if (!this.hooks.visible()) this.notify(e)
      console.log(`[downloads] ${state}: ${savePath}`)
      this.push(true)
    })

    this.push(true)
    if (!wc.isDestroyed()) this.hooks.onStarted(wc)
  }

  /**
   * A page that downloads more than once in one load asks first, as in Chrome, so a site can't
   * fill your Downloads folder. The download waits, paused, for the answer.
   */
  private checkPage(e: Entry, wc: WebContents) {
    if (wc.isDestroyed()) return
    if (!this.watched.has(wc)) {
      this.watched.add(wc)
      // The question comes back only once you've moved on: a new document on another site, or one
      // you loaded yourself. Otherwise a page could reload itself, or change its URL with
      // pushState, between downloads to dodge it.
      wc.on('did-start-navigation', (details) => {
        if (details.isMainFrame && !details.isSameDocument) this.yours.set(wc, !details.initiator)
      })
      wc.on('did-navigate', (_event, url) => {
        const page = this.pages.get(wc)
        if (page && (this.yours.get(wc) || origin(url) !== page.origin)) this.pages.delete(wc)
      })
      wc.once('destroyed', () => this.pages.delete(wc))
    }
    const site = origin(wc.getURL())
    const page = this.pages.get(wc)
    if (!page || page.origin !== site) {
      this.pages.set(wc, { origin: site })
      return
    }
    page.answer ??= this.ask(wc.getURL())
    e.item.pause()
    this.sync(e)
    void page.answer.then((allowed) => {
      if (!this.entries.has(e.info.id)) return
      if (!allowed) return e.item.cancel()
      e.item.resume()
    })
  }

  private async ask(url: string): Promise<boolean> {
    const site = origin(url)
    // A dialog without the panel to hang from is app-modal on macOS and stalls jbrow, hotkeys
    // included, until answered. A page downloading over and over while you're away is blocked.
    const win = this.hooks.window()
    if (!this.hooks.visible() || win.isDestroyed()) {
      console.log(`[downloads] multiple downloads from ${site}: blocked while jbrow was hidden`)
      return false
    }
    const options = {
      type: 'question' as const,
      message: `${site} wants to download multiple files`,
      detail: 'Allow it to keep downloading until you leave the page?',
      buttons: ['Block', 'Allow'],
      defaultId: 1,
      cancelId: 0,
    }
    const { response } = await dialog.showMessageBox(win, options)
    console.log(`[downloads] multiple downloads from ${site}: ${response === 1 ? 'allowed' : 'blocked'}`)
    return response === 1
  }

  private sync(e: Entry, interrupted = false) {
    const { item, info } = e
    info.received = item.getReceivedBytes()
    info.total = item.getTotalBytes()
    if (info.state === 'completed' || info.state === 'failed') {
      info.bytesPerSecond = 0
      return
    }
    info.state = interrupted ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing'
    // Chromium's figure jumps around from one update to the next; smooth it for the time left.
    const now = info.state === 'progressing' ? item.getCurrentBytesPerSecond() : 0
    info.bytesPerSecond = info.bytesPerSecond && now ? info.bytesPerSecond * 0.7 + now * 0.3 : now
  }

  private notify(e: Entry) {
    if (BACKGROUND) return
    const ok = e.info.state === 'completed'
    const n = new Notification({
      title: ok ? 'Download finished' : 'Download failed',
      body: e.info.filename,
      silent: ok,
    })
    n.on('click', () => (ok ? shell.showItemInFolder(e.info.path) : undefined))
    n.show()
  }

  private remove(id: string) {
    const e = this.entries.get(id)
    if (e?.expire) clearTimeout(e.expire)
    this.entries.delete(id)
  }

  /** `name.ext`, else `name (1).ext`, `name (2).ext`… */
  private freePath(dir: string, filename: string): string {
    const name = filename.replace(/[/\\:]/g, '_') || 'download'
    const taken = new Set([...this.entries.values()].map((e) => e.info.path))
    const ext = path.extname(name)
    const stem = name.slice(0, name.length - ext.length)
    for (let n = 0; ; n++) {
      const candidate = path.join(dir, n ? `${stem} (${n})${ext}` : name)
      if (!taken.has(candidate) && !existsSync(candidate)) return candidate
    }
  }

  /** Byte counts tick many times a second; the UI hears about them a few times a second. */
  private push(now = false) {
    if (now) {
      if (this.pushTimer) clearTimeout(this.pushTimer)
      this.pushTimer = null
      return this.hooks.onChange()
    }
    if (this.pushTimer) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      this.hooks.onChange()
    }, PUSH_EVERY_MS)
  }
}
