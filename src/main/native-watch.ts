/**
 * Logs what happens between extensions and their native messaging hosts (Stem's browser control
 * is one), so a host that goes quiet leaves a trail in main.log.
 *
 * On 2026-11-03 Stem's service worker in the Personal profile stopped answering while its host
 * stayed connected: every request timed out, nothing disconnected, and no log said why. This
 * records each host opening and closing (and why), a message handed to a worker that is no
 * longer running, a request no answer came back for, the worker's own status changes, and the
 * errors it logs. The traffic comes from patches in scripts/patch-deps.mjs.
 */

/** What the patched library reports about a native host, as the `jbrow-native-host` event. */
export interface NativeHostEvent {
  kind: 'open' | 'close' | 'spawn' | 'exit' | 'fail' | 'in' | 'out'
  extensionId: string
  connectionId: string
  application: string
  /** What opened the host: an extension page, or its service worker. */
  opener: 'frame' | 'service-worker'
  /** The opening service worker's version (only when a worker opened the host). */
  versionId?: number
  /** spawn: { pid }; exit: { code, signal }; fail and close: { reason }; in/out: the message. */
  data?: unknown
}

export interface NativeWatchDeps {
  now(): number
  log(line: string): void
  /** The extension's name, for the log. */
  name(extensionId: string): string
  /** Whether a service worker of this version is running and can take a message. */
  workerRunning(versionId: number): boolean
}

/** A request with no answer after this long is logged. Stem's own deadline is 60 s at most. */
export const UNANSWERED_MS = 60_000
/** At most this many errors a minute from one extension's worker reach the log. */
const ERRORS_PER_MINUTE = 10
/** Requests remembered per host, so a host that never gets answers can't grow without bound. */
const MAX_WAITING = 200

interface Waiting {
  at: number
  type: string
  reported: boolean
}

interface Host {
  event: NativeHostEvent
  openedAt: number
  lastIn: number
  lastOut: number
  waiting: Map<string, Waiting>
  /** A message went to a worker that wasn't running; said once per host. */
  lostReported: boolean
}

export class NativeWatch {
  private hosts = new Map<string, Host>()
  private statuses = new Map<number, string>()
  private errors = new Map<string, { since: number; count: number; muted: number }>()

  constructor(
    private profile: string,
    private deps: NativeWatchDeps,
  ) {}

  /** One event from the patched library. */
  host(e: NativeHostEvent) {
    const now = this.deps.now()
    const who = `${this.deps.name(e.extensionId)} (${e.application})`
    switch (e.kind) {
      case 'open':
        this.hosts.set(e.connectionId, { event: e, openedAt: now, lastIn: 0, lastOut: 0, waiting: new Map(), lostReported: false })
        this.log(`${who}: opened from its ${e.opener === 'frame' ? 'page' : 'service worker'}`)
        return
      case 'spawn':
        this.log(`${who}: host running, pid ${pidOf(e.data)}`)
        return
      case 'exit':
      case 'fail':
        // The close that follows says it.
        return
      case 'close': {
        const h = this.hosts.get(e.connectionId)
        this.hosts.delete(e.connectionId)
        const reason = reasonOf(e.data)
        const open = h ? ` after ${span(now - h.openedAt)}` : ''
        const unanswered = h ? h.waiting.size : 0
        this.log(`${who}: closed${open}: ${reason}${unanswered ? `, ${unanswered} request(s) unanswered` : ''}`)
        return
      }
      case 'in': {
        const h = this.hosts.get(e.connectionId)
        if (!h) return
        h.lastIn = now
        const id = idOf(e.data)
        if (id) {
          h.waiting.set(id, { at: now, type: typeOf(e.data), reported: false })
          if (h.waiting.size > MAX_WAITING) h.waiting.delete(h.waiting.keys().next().value as string)
        }
        if (h.event.versionId !== undefined && !h.lostReported && !this.deps.workerRunning(h.event.versionId)) {
          h.lostReported = true
          this.log(
            `${who}: the host sent a message to a service worker that isn't running (${this.statusOf(h.event.versionId)}); ` +
              'it is lost, and so is everything after it until the host closes',
          )
        }
        return
      }
      case 'out': {
        const h = this.hosts.get(e.connectionId)
        if (!h) return
        h.lastOut = now
        const id = idOf(e.data)
        const w = id ? h.waiting.get(id) : undefined
        if (!w) return
        h.waiting.delete(id!)
        if (w.reported) this.log(`${who}: answered "${w.type}" ${short(id!)} after ${span(now - w.at)}`)
        return
      }
    }
  }

  /** A service worker's status changed. Logged for workers that hold an open host: they're kept running, so any change is news. */
  workerStatus(versionId: number, status: string) {
    this.statuses.set(versionId, status)
    for (const h of this.hosts.values()) {
      if (h.event.versionId !== versionId) continue
      this.log(`${this.deps.name(h.event.extensionId)}: its service worker is ${status}, holding ${h.event.application}`)
      return
    }
  }

  /** An error an extension's service worker logged. */
  workerError(extensionId: string, message: string, where: string) {
    const now = this.deps.now()
    let e = this.errors.get(extensionId)
    if (!e || now - e.since >= 60_000) {
      if (e?.muted) this.log(`${this.deps.name(extensionId)}: ${e.muted} more error(s) from its service worker were left out`)
      e = { since: now, count: 0, muted: 0 }
      this.errors.set(extensionId, e)
    }
    if (++e.count > ERRORS_PER_MINUTE) {
      e.muted++
      return
    }
    this.log(`${this.deps.name(extensionId)}: service worker error: ${clip(message, 500)}${where ? ` (${where})` : ''}`)
  }

  /** Logs requests that have waited past UNANSWERED_MS, once each. Run it every few seconds. */
  sweep() {
    const now = this.deps.now()
    for (const h of this.hosts.values()) {
      const late = [...h.waiting.entries()].filter(([, w]) => !w.reported && now - w.at >= UNANSWERED_MS)
      if (!late.length) continue
      for (const [, w] of late) w.reported = true
      const [id, first] = late[0]
      const worker =
        h.event.versionId === undefined
          ? 'opened from a page'
          : `service worker ${this.deps.workerRunning(h.event.versionId) ? 'running' : 'not running'} (${this.statusOf(h.event.versionId)})`
      const heard = h.lastOut ? `last message from the extension ${span(now - h.lastOut)} ago` : 'no message from the extension yet'
      this.log(
        `${this.deps.name(h.event.extensionId)} (${h.event.application}): no answer to "${first.type}" ${short(id)} for ${span(now - first.at)}` +
          `${late.length > 1 ? ` (and ${late.length - 1} more)` : ''}; ${worker}; ${heard}`,
      )
    }
  }

  private statusOf(versionId: number) {
    return `last status ${this.statuses.get(versionId) ?? 'unknown'}`
  }

  private log(line: string) {
    this.deps.log(`[native] ${this.profile}: ${line}`)
  }
}

function idOf(message: unknown): string | null {
  const id = (message as { id?: unknown } | null)?.id
  return typeof id === 'string' && id ? id : null
}

function typeOf(message: unknown): string {
  const type = (message as { type?: unknown } | null)?.type
  return typeof type === 'string' ? clip(type, 40) : 'message'
}

function pidOf(data: unknown): string {
  const pid = (data as { pid?: unknown } | null)?.pid
  return typeof pid === 'number' ? String(pid) : 'unknown'
}

function reasonOf(data: unknown): string {
  const reason = (data as { reason?: unknown } | null)?.reason
  return typeof reason === 'string' ? reason : 'no reason given'
}

function short(id: string) {
  return id.length > 12 ? `${id.slice(0, 8)}…` : id
}

function clip(s: string, n: number) {
  return s.length > n ? `${s.slice(0, n)}…` : s
}

/** 45 s, 12 min, 3 h 5 min. */
export function span(ms: number): string {
  const s = Math.round(ms / 1000)
  if (s < 90) return `${s} s`
  const m = Math.round(s / 60)
  if (m < 90) return `${m} min`
  return `${Math.floor(m / 60)} h ${m % 60} min`
}

const watches = new Map<string, NativeWatch>()
let sweeper: NodeJS.Timeout | null = null

/** Watches one profile's native hosts and extension service workers; see NativeWatch. */
export function watchNativeHosts(profileId: string, sess: Electron.Session, extensions: NodeJS.EventEmitter) {
  const workers = sess.serviceWorkers
  const watch = new NativeWatch(profileId, {
    now: () => Date.now(),
    log: (line) => console.log(line),
    name: (id) => sess.extensions.getExtension(id)?.name ?? id,
    workerRunning: (versionId) => {
      const w = workers.getWorkerFromVersionID(versionId)
      return !!w && !w.isDestroyed()
    },
  })
  watches.set(profileId, watch)
  extensions.on('jbrow-native-host', (e: NativeHostEvent) => watch.host(e))
  workers.on('running-status-changed', ({ versionId, runningStatus }) => watch.workerStatus(versionId, runningStatus))
  workers.on('console-message', (_event, d) => {
    if (d.level < 3) return
    const scope = workers.getWorkerFromVersionID(d.versionId)?.scope ?? d.sourceUrl
    const id = /^chrome-extension:\/\/([a-p]{32})\//.exec(scope)?.[1]
    if (!id) return
    const file = d.sourceUrl.replace(/^chrome-extension:\/\/[a-p]{32}\//, '')
    watch.workerError(id, d.message, file ? `${file}:${d.lineNumber}` : '')
  })
  sweeper ??= setInterval(() => {
    for (const w of watches.values()) w.sweep()
  }, 15_000)
  sweeper.unref?.()
}

/** A deleted profile's watch goes with it. */
export function forgetNativeWatch(profileId: string) {
  watches.delete(profileId)
}
