import type { WebContents, WebFrameMain } from 'electron'

const debug = (...args: unknown[]) => process.env.JBROW_DEBUG && console.log('[pip]', ...args)

/** The page's biggest video that is playing with sound, by area; 0 when there isn't one. */
const PROBE = `(() => {
  if (!document.pictureInPictureEnabled || document.pictureInPictureElement) return 0
  const v = [...document.querySelectorAll('video')].filter(
    (v) => !v.paused && !v.ended && !v.muted && v.volume > 0 && v.readyState > 2 && !v.disablePictureInPicture,
  )
  return Math.max(0, ...v.map((v) => v.clientWidth * v.clientHeight))
})()`

const ENTER = `(async () => {
  const v = [...document.querySelectorAll('video')]
    .filter((v) => !v.paused && !v.ended && !v.muted && v.volume > 0 && v.readyState > 2 && !v.disablePictureInPicture)
    .sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0]
  if (!v) return false
  await v.requestPictureInPicture()
  return true
})()`

/**
 * Resolves when the video leaves picture-in-picture, with whether it is still playing. The PiP
 * window's close button pauses the video; its "back to tab" button doesn't.
 */
const WATCH = `new Promise((resolve) =>
  document.addEventListener('leavepictureinpicture', (e) => setTimeout(() => resolve(!e.target.paused), 150), { once: true }),
)`

const EXIT = `document.pictureInPictureElement ? document.exitPictureInPicture().then(() => true) : false`

/**
 * Moves the active tab's playing video into Chromium's picture-in-picture window while jbrow
 * is out of sight, and back when it returns. Only jbrow's own PiP is undone; one a page or
 * extension opened stays.
 */
export class MiniPlayer {
  private frame: WebFrameMain | null = null

  /** `backToTab` runs when the PiP window's "back to tab" button closes it. */
  constructor(private backToTab: () => void) {}

  get active() {
    return this.frame !== null
  }

  async enter(wc: WebContents | null) {
    if (this.frame || !wc || wc.isDestroyed() || wc.isAudioMuted()) return
    const frames = wc.mainFrame.framesInSubtree
    const sizes = await Promise.all(frames.map((f) => f.executeJavaScript(PROBE).catch(() => 0) as Promise<number>))
    const best = sizes.indexOf(Math.max(...sizes))
    if (best < 0 || !sizes[best]) return
    const frame = frames[best]
    try {
      // A user gesture: Chromium only opens PiP in response to one.
      if (!(await frame.executeJavaScript(ENTER, true))) return
    } catch (err) {
      debug('enter failed', err)
      return
    }
    debug('entered', frame.url)
    this.frame = frame
    void (frame.executeJavaScript(WATCH) as Promise<boolean>)
      .then((playing) => {
        if (this.frame !== frame) return
        this.frame = null
        debug('left; playing =', playing)
        if (playing) this.backToTab()
      })
      .catch(() => {
        if (this.frame === frame) this.frame = null
      })
  }

  exit() {
    const frame = this.frame
    this.frame = null
    if (!frame) return
    debug('exit')
    void frame.executeJavaScript(EXIT).catch(() => {})
  }
}
