import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { UpdateView } from '../shared/types'

/** Set by build.mjs: true only in builds made by scripts/release.sh, the ones on GitHub Releases. */
declare const JBROW_RELEASE: boolean

const CHECK_EVERY_MS = 4 * 60 * 60 * 1000
const FIRST_CHECK_MS = 30 * 1000
/** How often a downloaded update looks for a moment to restart in. */
const TRY_INSTALL_MS = 5 * 60 * 1000

/** Written before an update restarts jbrow, so it comes back the way it was: hidden or showing. */
const relaunchMarker = () => path.join(app.getPath('userData'), 'update-relaunch')

/**
 * Whether this launch is jbrow coming back from an update it installed on its own, and whether
 * its window was showing then. Read once at startup; the marker is gone after.
 */
export function takeUpdateRelaunch(): { shown: boolean } | null {
  const file = relaunchMarker()
  if (!existsSync(file)) return null
  try {
    return { shown: readFileSync(file, 'utf8').trim() === 'shown' }
  } catch {
    return null
  } finally {
    rmSync(file, { force: true })
  }
}

interface UpdateHooks {
  /** The setting: check, download and install on its own. Off, only Check now does anything. */
  enabled: () => boolean
  /** Nobody would notice a restart now: no downloads, no sound, jbrow out of the way. */
  quietMoment: () => boolean
  /** jbrow's window is on screen, for coming back the same way. */
  shown: () => boolean
  /** Last chance to save tabs and the window's place before the update quits jbrow. */
  beforeInstall: () => void
  onChange: () => void
}

/**
 * Updates from GitHub Releases through electron-updater (Squirrel.Mac underneath). A release
 * build checks at launch and every few hours and downloads in the background. A downloaded
 * update installs when jbrow quits, or on its own once jbrow has been out of the way for a while,
 * coming back with its tabs as if nothing happened. Builds made on this Mac (install.sh, npm run
 * dist) and jbrow running from source never update: they'd replace themselves with the release.
 */
export class Updates {
  private state: UpdateView['state']
  private percent = 0
  private newVersion = ''
  private error = ''
  private checkedAt = 0
  /** A check you asked for, which shows its errors and "up to date". */
  private manual = false

  constructor(private hooks: UpdateHooks) {
    this.state = !app.isPackaged ? 'source' : !JBROW_RELEASE ? 'local' : 'idle'
  }

  private get supported() {
    return this.state !== 'source' && this.state !== 'local'
  }

  start() {
    if (!this.supported) return
    autoUpdater.logger = {
      info: (m: unknown) => console.log('[updates]', m),
      warn: (m: unknown) => console.warn('[updates]', m),
      error: (m: unknown) => console.error('[updates]', m),
      debug: () => {},
    }
    autoUpdater.autoDownload = true
    // Quitting installs a downloaded update, without starting jbrow again.
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('checking-for-update', () => this.set('checking'))
    autoUpdater.on('update-not-available', () => {
      this.checkedAt = Date.now()
      this.set('latest')
    })
    autoUpdater.on('update-available', (info) => {
      this.checkedAt = Date.now()
      this.newVersion = info.version
      this.percent = 0
      this.set('downloading')
    })
    autoUpdater.on('download-progress', (p) => {
      this.percent = Math.round(p.percent)
      this.set('downloading')
    })
    autoUpdater.on('update-downloaded', (info) => {
      this.newVersion = info.version
      console.log(`[updates] ${info.version} is ready`)
      this.set('ready')
    })
    autoUpdater.on('error', (err) => {
      // Offline or GitHub being slow is no news, unless you asked. A ready update stays ready.
      console.warn('[updates] failed:', err?.message ?? err)
      if (this.state === 'ready') return
      this.error = this.manual ? (err?.message ?? String(err)).split('\n')[0] : ''
      this.set(this.manual ? 'error' : 'idle')
    })
    setTimeout(() => this.hooks.enabled() && this.check(false), FIRST_CHECK_MS)
    setInterval(() => this.hooks.enabled() && this.check(false), CHECK_EVERY_MS)
    setInterval(() => this.installIfQuiet(), TRY_INSTALL_MS)
  }

  /** Looks for a newer release and downloads it. Does nothing while one is on its way or ready. */
  check(manual = true) {
    if (!this.supported || this.state === 'checking' || this.state === 'downloading' || this.state === 'ready') return
    this.manual = manual
    this.error = ''
    autoUpdater.checkForUpdates().catch(() => {
      // Reported through the 'error' event.
    })
  }

  /** Restarts into the downloaded update now. */
  install() {
    if (this.state !== 'ready') return
    console.log(`[updates] restarting into ${this.newVersion}`)
    this.hooks.beforeInstall()
    autoUpdater.quitAndInstall()
  }

  private installIfQuiet() {
    if (this.state !== 'ready' || !this.hooks.enabled() || !this.hooks.quietMoment()) return
    try {
      writeFileSync(relaunchMarker(), this.hooks.shown() ? 'shown' : 'hidden')
    } catch {
      // Coming back shown is the worst that happens.
    }
    this.install()
  }

  view(): UpdateView {
    return {
      version: app.getVersion(),
      state: this.state,
      percent: this.percent,
      newVersion: this.newVersion,
      error: this.error,
      checkedAt: this.checkedAt,
    }
  }

  get ready() {
    return this.state === 'ready' ? this.newVersion : null
  }

  private set(state: UpdateView['state']) {
    this.state = state
    this.hooks.onChange()
  }
}
