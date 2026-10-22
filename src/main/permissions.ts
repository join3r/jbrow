import { app, dialog, type BrowserWindow, type Session } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/** Granted without asking, as Chrome does. display-capture asks with its own menu (see screenshare.ts). */
const ALWAYS = new Set([
  'clipboard-sanitized-write',
  'fullscreen',
  'pointerLock',
  'keyboardLock',
  'speaker-selection',
  'display-capture',
])

/** Asked once per site and profile. Anything not listed here or in ALWAYS is denied. */
const ASK: Record<string, string> = {
  camera: 'use your camera',
  microphone: 'use your microphone',
  geolocation: 'know your location',
  notifications: 'show notifications',
  'clipboard-read': 'read your clipboard',
  midi: 'use your MIDI devices',
  midiSysex: 'control your MIDI devices',
  'idle-detection': 'know when you are away',
  'window-management': 'see your displays and place windows on them',
  'storage-access': 'use its cookies while embedded in other sites',
  'top-level-storage-access': 'use its cookies while embedded in other sites',
  openExternal: 'open another app',
}

/** Decisions per profile, then origin, then permission. */
type Store = Record<string, Record<string, Record<string, boolean>>>

const storePath = () => path.join(app.getPath('userData'), 'permissions.json')

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

/** Extensions already listed what they use when you installed them. */
const isExtension = (origin: string) => origin.startsWith('chrome-extension://')

/** Camera and microphone arrive as one "media" request; jbrow asks and remembers them separately. */
function expand(permission: string, mediaTypes: readonly string[] | undefined): string[] {
  if (permission !== 'media') return [permission]
  const types = mediaTypes?.length ? mediaTypes : ['audio', 'video']
  return types.map((t) => (t === 'video' ? 'camera' : 'microphone'))
}

export class SitePermissions {
  private store: Store = {}
  /** Open prompts, so a site asking twice gets one dialog. */
  private pending = new Map<string, Promise<boolean>>()

  constructor(private window: () => BrowserWindow | null) {
    if (!existsSync(storePath())) return
    try {
      this.store = JSON.parse(readFileSync(storePath(), 'utf8')) as Store
    } catch (error) {
      console.error('[permissions] permissions.json is not valid JSON, starting over:', error)
    }
  }

  /** Denies by default; asks for what's in ASK and remembers the answer for the profile. */
  attach(sess: Session, profileId: string, profileName: string) {
    sess.setPermissionRequestHandler((_wc, permission, callback, details) => {
      const origin = originOf(details.requestingUrl)
      if (ALWAYS.has(permission) || isExtension(origin)) return callback(true)
      const wanted = expand(permission, (details as { mediaTypes?: string[] }).mediaTypes)
      if (!wanted.every((p) => p in ASK)) return callback(false)
      void this.ask(profileId, profileName, origin, wanted).then(callback)
    })
    sess.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
      const origin = originOf(requestingOrigin)
      if (ALWAYS.has(permission) || isExtension(origin)) return true
      const granted = this.store[profileId]?.[origin] ?? {}
      if (permission === 'media') {
        const type = (details as { mediaType?: string }).mediaType
        if (type === 'video') return granted.camera === true
        if (type === 'audio') return granted.microphone === true
        return granted.camera === true || granted.microphone === true
      }
      return granted[permission] === true
    })
    // WebHID, Web Serial and WebUSB: jbrow has no device chooser, so pages get no devices.
    sess.setDevicePermissionHandler((details) => isExtension(details.origin))
  }

  /** Whether the site has remembered decisions in the profile, to offer resetting them. */
  has(profileId: string, url: string): boolean {
    return Object.keys(this.store[profileId]?.[originOf(url)] ?? {}).length > 0
  }

  /** Forgets every decision for the site, so it asks again. */
  reset(profileId: string, url: string) {
    delete this.store[profileId]?.[originOf(url)]
    this.save()
  }

  private async ask(profileId: string, profileName: string, origin: string, wanted: string[]): Promise<boolean> {
    const decided = this.store[profileId]?.[origin] ?? {}
    if (wanted.some((p) => decided[p] === false)) return false
    const open = wanted.filter((p) => decided[p] !== true)
    if (!open.length) return true

    const key = `${profileId} ${origin} ${open.join(',')}`
    let prompt = this.pending.get(key)
    if (!prompt) {
      prompt = this.prompt(profileName, origin, open).then(({ allow, remember }) => {
        if (remember) {
          const site = ((this.store[profileId] ??= {})[origin] ??= {})
          for (const p of open) site[p] = allow
          this.save()
        }
        return allow
      })
      prompt.finally(() => this.pending.delete(key))
      this.pending.set(key, prompt)
    }
    return prompt
  }

  private async prompt(profileName: string, origin: string, permissions: string[]) {
    const what = permissions.map((p) => ASK[p])
    const list = what.length > 1 ? `${what.slice(0, -1).join(', ')} and ${what.at(-1)}` : what[0]
    const host = origin.replace(/^https?:\/\//, '')
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      message: `${host} wants to ${list}`,
      detail: `In the ${profileName} profile.`,
      buttons: ['Block', 'Allow'],
      defaultId: 1,
      cancelId: 0,
      checkboxLabel: 'Remember for this site',
      checkboxChecked: true,
    }
    const win = this.window()
    const { response, checkboxChecked } =
      win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
    return { allow: response === 1, remember: checkboxChecked }
  }

  private save() {
    writeFileSync(storePath(), JSON.stringify(this.store, null, 2))
  }
}
