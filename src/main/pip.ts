import type { WebContents, WebFrameMain } from 'electron'

const debug = (...args: unknown[]) => process.env.JBROW_DEBUG && console.log('[pip]', ...args)

/** Which videos can go: playing, allowed PiP, and with sound unless muted ones may too. */
const playable = (mutedToo: boolean) =>
  `(v) => !v.paused && !v.ended && ${mutedToo ? '' : '!v.muted && v.volume > 0 && '}v.readyState > 2 && !v.disablePictureInPicture`

/** The page's biggest playable video, by area; 0 when there isn't one. */
const probe = (mutedToo: boolean) => `(() => {
  if (!document.pictureInPictureEnabled || document.pictureInPictureElement) return 0
  const v = [...document.querySelectorAll('video')].filter(${playable(mutedToo)})
  return Math.max(0, ...v.map((v) => v.clientWidth * v.clientHeight))
})()`

const enter = (mutedToo: boolean) => `(async () => {
  const v = [...document.querySelectorAll('video')]
    .filter(${playable(mutedToo)})
    .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]
  if (!v) return false
  await v.requestPictureInPicture()
  window.__jbrowPip = v
  return true
})()`

/**
 * Resolves when the video leaves picture-in-picture, with whether it is still playing. The PiP
 * window's close button pauses the video; its "back to tab" button doesn't. Only a real event
 * on the video jbrow moved counts.
 */
const WATCH = `new Promise((resolve) => {
  const v = window.__jbrowPip
  v.addEventListener('leavepictureinpicture', (e) => setTimeout(() => resolve(e.isTrusted && !v.paused), 150), { once: true })
})`

/**
 * A page's own scripts can't reach this world, so they can't fake the events or results the
 * code above sees. Electron only offers it for the main frame.
 */
const WORLD = 1077

const EXIT = `document.pictureInPictureElement ? document.exitPictureInPicture().then(() => true) : false`

/**
 * Moves a tab's playing video into Chromium's picture-in-picture window while it is out of
 * sight, and back when it returns. Only jbrow's own PiP is undone; one a page or extension
 * opened stays. Chromium has one PiP window, so a video from another tab takes its place.
 */
export class MiniPlayer {
  private frame: WebFrameMain | null = null
  private wc: WebContents | null = null

  /** `backToTab` runs with the video's page when the PiP window's "back to tab" button closes it. */
  constructor(private backToTab: (wc: WebContents) => void) {}

  get active() {
    return this.frame !== null
  }

  /** The page whose video is in PiP, if jbrow put it there. */
  get webContents() {
    return this.frame ? this.wc : null
  }

  async enter(wc: WebContents | null, mutedToo = false) {
    if (!wc || wc.isDestroyed() || (this.frame && this.wc === wc) || (!mutedToo && wc.isAudioMuted())) return
    const frames = wc.mainFrame.framesInSubtree
    const sizes = await Promise.all(frames.map((f) => f.executeJavaScript(probe(mutedToo)).catch(() => 0) as Promise<number>))
    const best = sizes.indexOf(Math.max(...sizes))
    if (best < 0 || !sizes[best]) return
    const frame = frames[best]
    // An iframe runs this among the page's own scripts, which could fake the "back to tab"
    // signal. Summoning jbrow takes keyboard focus from whatever you're typing in, so an
    // iframe's video only goes back into the page.
    const trusted = frame === wc.mainFrame
    const run = (code: string, gesture = false) =>
      trusted ? wc.executeJavaScriptInIsolatedWorld(WORLD, [{ code }], gesture) : frame.executeJavaScript(code, gesture)
    try {
      // A user gesture: Chromium only opens PiP in response to one.
      if (!(await run(enter(mutedToo), true))) return
    } catch (err) {
      debug('enter failed', err)
      return
    }
    debug('entered', frame.url)
    this.frame = frame
    this.wc = wc
    void (run(WATCH) as Promise<boolean>)
      .then((playing) => {
        if (this.frame !== frame) return
        this.frame = null
        debug('left; playing =', playing)
        if (playing && trusted) this.backToTab(wc)
      })
      .catch(() => {
        if (this.frame === frame) this.frame = null
      })
  }

  exit() {
    const { frame, wc } = this
    this.frame = null
    if (!frame || !wc || wc.isDestroyed()) return
    debug('exit')
    // The world doesn't matter here: there's nothing to trust in the result.
    void frame.executeJavaScript(EXIT).catch(() => {})
  }
}
