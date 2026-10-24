import { powerMonitor } from 'electron'
import { libraryOf, permissionsOf } from './library'
import type { ProfileRuntime } from './profiles'

type IdleState = 'active' | 'idle' | 'locked'

/** Chrome's defaults: idle after 60 s without input, and never less than 15 s. */
const DEFAULT_INTERVAL_S = 60
const MIN_INTERVAL_S = 15
const POLL_MS = 1000

const clamp = (seconds: unknown) => Math.max(MIN_INTERVAL_S, Math.floor(Number(seconds) || DEFAULT_INTERVAL_S))

/**
 * chrome.idle, from the system's idle time (powerMonitor). Electron has no idle API for
 * extensions. While an extension with the `idle` permission is loaded, jbrow checks the state
 * every second against each extension's detection interval and sends onStateChanged when it
 * changes, as Chrome does. The extension side is in src/preload/extension-shims.ts.
 */
export class IdleWatcher {
  /** Detection interval in seconds, per profile and extension. */
  private intervals = new Map<string, number>()
  private states = new Map<string, IdleState>()
  private timer: NodeJS.Timeout | null = null
  private runtimes: ProfileRuntime[] = []

  constructor() {
    // Locking is worth telling at once, not on the next tick.
    powerMonitor.on('lock-screen', () => this.poll())
    powerMonitor.on('unlock-screen', () => this.poll())
  }

  /** Adds chrome.idle to a profile; see setupProfiles. */
  attach(rt: ProfileRuntime) {
    this.runtimes.push(rt)
    const handle = libraryOf(rt).router.apiHandler()
    const key = (ext: Electron.Extension) => `${rt.profile.id}|${ext.id}`
    handle('idle.queryState', (_event, seconds: number) => query(seconds), { permission: 'idle' })
    handle('idle.setDetectionInterval', ({ extension }, seconds: number) => void this.intervals.set(key(extension), clamp(seconds)), { permission: 'idle' })
    rt.session.extensions.on('extension-loaded', () => this.update())
    rt.session.extensions.on('extension-unloaded', () => this.update())
  }

  /** A deleted profile stops being watched. */
  forgetProfile(profile: string) {
    this.runtimes = this.runtimes.filter((rt) => rt.profile.id !== profile)
    for (const key of [...this.intervals.keys(), ...this.states.keys()]) {
      if (key.startsWith(`${profile}|`)) {
        this.intervals.delete(key)
        this.states.delete(key)
      }
    }
    this.update()
  }

  private watched(): [ProfileRuntime, Electron.Extension][] {
    return this.runtimes.flatMap((rt) =>
      rt.session.extensions.getAllExtensions().filter((e) => permissionsOf(e).includes('idle')).map((e) => [rt, e] as [ProfileRuntime, Electron.Extension]),
    )
  }

  /** Polls only while some extension can listen. */
  private update() {
    const any = this.watched().length > 0
    if (any && !this.timer) this.timer = setInterval(() => this.poll(), POLL_MS)
    else if (!any && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  private poll() {
    for (const [rt, ext] of this.watched()) {
      const key = `${rt.profile.id}|${ext.id}`
      const state = query(this.intervals.get(key) ?? DEFAULT_INTERVAL_S)
      const was = this.states.get(key) ?? 'active'
      this.states.set(key, state)
      if (state === was) continue
      if (process.env.JBROW_DEBUG) console.log(`[idle] ${rt.profile.id}: ${ext.name} → ${state}`)
      libraryOf(rt).router.sendEvent(ext.id, 'idle.onStateChanged', state)
    }
  }
}

function query(seconds: unknown): IdleState {
  const state = powerMonitor.getSystemIdleState(clamp(seconds))
  return state === 'unknown' ? 'active' : state
}
