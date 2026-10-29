import { ipcMain, WebContentsView, type Rectangle, type WebContents } from 'electron'
import path from 'node:path'
import type { PermissionAnswer, PermissionQuestion } from './permissions'
import type { PromptView } from '../shared/types'

/** The card's width, and the room around it in its view for the shadow. */
const WIDTH = 320
const PAD = { top: 6, side: 10, bottom: 22 }

interface Request {
  /** Changes with each question, so a click meant for an earlier one doesn't answer this one. */
  id: number
  question: PermissionQuestion
  resolve: (answer: PermissionAnswer) => void
}

interface Bubble {
  view: WebContentsView
  ready: boolean
  /** The card's height, once the page has measured it; it stays hidden until then. */
  height: number
  /** Whether it was on screen at the last layout, to tell the page each time it comes back. */
  shown: boolean
}

interface Asking {
  requests: Request[]
  bubble?: Bubble
  /** Stops listening to the page. */
  unwatch: () => void
}

export interface PromptHooks {
  /** The tab a page belongs to. Pages outside tabs are asked with a dialog instead. */
  tabFor: (wc: WebContents) => string | undefined
  /** Where the tab's page is in the window, or null while it isn't on screen. */
  placement: (tabId: string) => Rectangle | null
  /** Puts the prompt's view over the pages, or takes it off the window. */
  float: (view: WebContentsView, on: boolean) => void
  theme: () => string
  /** jbrow's own shortcuts, while the prompt has the keyboard. True if handled. */
  onKey: (input: Electron.Input) => boolean
  /** The prompt had the keyboard and is gone: it goes back to the page. */
  refocus: () => void
}

/**
 * Site permission prompts as a card under the address bar of the tab that asked, in a view of its
 * own over the page. Only the card covers the page, so it stays usable while the question waits;
 * it waits for as long as the page lives, and a tab that isn't on screen keeps it until it is. A
 * page that asks again while a question is open gets its questions one after another.
 */
export class PermissionPrompts {
  private asking = new Map<WebContents, Asking>()
  private nextId = 1

  constructor(private hooks: PromptHooks) {
    ipcMain.on('prompt:answer', (e, data: { id: number; allow?: boolean; remember?: boolean; dismissed?: boolean }) => {
      for (const [wc, a] of this.asking) {
        if (a.bubble?.view.webContents !== e.sender || a.requests[0]?.id !== data.id) continue
        this.answer(wc, { allow: !!data.allow && !data.dismissed, remember: !!data.remember && !data.dismissed, dismissed: !!data.dismissed })
      }
    })
    ipcMain.on('prompt:size', (e, height: unknown) => {
      if (typeof height !== 'number' || !Number.isFinite(height)) return
      for (const a of this.asking.values()) {
        if (a.bubble?.view.webContents !== e.sender) continue
        a.bubble.height = Math.ceil(height)
        this.layout()
      }
    })
  }

  /** Asks under the tab's address bar; undefined for a page outside tabs. */
  ask(wc: WebContents, question: PermissionQuestion): Promise<PermissionAnswer> | undefined {
    if (wc.isDestroyed() || !this.hooks.tabFor(wc)) return undefined
    return new Promise((resolve) => {
      let a = this.asking.get(wc)
      if (!a) this.asking.set(wc, (a = { requests: [], unwatch: this.watch(wc) }))
      a.requests.push({ id: this.nextId++, question, resolve })
      if (a.requests.length === 1) this.send(a)
      this.layout()
    })
  }

  /** Places each prompt under its page's address bar, and hides those whose page isn't on screen. */
  layout() {
    for (const [wc, a] of this.asking) {
      const tabId = this.hooks.tabFor(wc)
      const place = tabId ? this.hooks.placement(tabId) : null
      if (!place) {
        if (a.bubble?.shown) {
          a.bubble.shown = false
          a.bubble.view.setVisible(false)
        }
        continue
      }
      const b = a.bubble ?? this.open(a)
      const width = Math.min(WIDTH, place.width - 2 * PAD.side)
      // Until the card has measured itself at this width, it lays out hidden in room enough.
      const height = b.height ? b.height + PAD.top + PAD.bottom : 400
      b.view.setBounds({ x: place.x, y: place.y, width: width + 2 * PAD.side, height: Math.min(place.height, height) })
      if (!b.ready || !b.height) continue
      if (!b.shown) {
        b.shown = true
        b.view.setVisible(true)
        // Clicks count only a moment after it shows (see the page), so one you meant for the page
        // doesn't land on Allow.
        b.view.webContents.send('prompt:shown')
      }
    }
  }

  private open(a: Asking): Bubble {
    const view = new WebContentsView({
      webPreferences: { preload: path.join(__dirname, 'preload-permission-prompt.js'), sandbox: true, contextIsolation: true },
    })
    view.setBackgroundColor('#00000000')
    view.setVisible(false)
    const b: Bubble = { view, ready: false, height: 0, shown: false }
    a.bubble = b
    const ui = view.webContents
    // A file or link dropped on the card would otherwise replace it, keeping its preload.
    ui.on('will-navigate', (e) => e.preventDefault())
    ui.setWindowOpenHandler(() => ({ action: 'deny' }))
    ui.on('before-input-event', (e, input) => {
      if (this.hooks.onKey(input)) e.preventDefault()
    })
    ui.once('did-finish-load', () => {
      b.ready = true
      this.send(a)
    })
    const dir = __dirname.replace(/\.asar(?=[\\/]|$)/, '.asar.unpacked')
    void ui.loadFile(path.join(dir, 'ui', 'permission-prompt.html'), { query: { theme: this.hooks.theme(), pad: JSON.stringify(PAD) } })
    this.hooks.float(view, true)
    return b
  }

  /** Shows the page's first question in its card. */
  private send(a: Asking) {
    const r = a.requests[0]
    const b = a.bubble
    if (!r || !b?.ready) return
    const view: PromptView = { id: r.id, ...r.question }
    b.view.webContents.send('prompt:view', view)
  }

  private answer(wc: WebContents, answer: PermissionAnswer) {
    const a = this.asking.get(wc)
    const r = a?.requests.shift()
    if (!a || !r) return
    r.resolve(answer)
    if (a.requests.length) {
      this.send(a)
      // The next question shows like a new one: a click meant for the last doesn't answer it.
      if (a.bubble?.shown) a.bubble.view.webContents.send('prompt:shown')
      return
    }
    this.close(wc, a)
  }

  /** The page is gone, or another one took its place: what it asked is refused, not remembered. */
  private cancel(wc: WebContents) {
    const a = this.asking.get(wc)
    if (!a) return
    for (const r of a.requests.splice(0)) r.resolve({ allow: false, remember: false, dismissed: true })
    this.close(wc, a)
  }

  private close(wc: WebContents, a: Asking) {
    this.asking.delete(wc)
    a.unwatch()
    const b = a.bubble
    if (!b) return
    const focused = !b.view.webContents.isDestroyed() && b.view.webContents.isFocused()
    this.hooks.float(b.view, false)
    if (!b.view.webContents.isDestroyed()) b.view.webContents.close()
    if (focused) this.hooks.refocus()
  }

  /** A page that goes somewhere new, crashes or closes takes its questions with it. */
  private watch(wc: WebContents): () => void {
    const gone = () => this.cancel(wc)
    wc.on('did-navigate', gone)
    wc.on('render-process-gone', gone)
    wc.on('destroyed', gone)
    return () => {
      if (wc.isDestroyed()) return
      wc.off('did-navigate', gone)
      wc.off('render-process-gone', gone)
      wc.off('destroyed', gone)
    }
  }
}
