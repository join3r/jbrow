import { app, dialog, type BrowserWindow, type Session, type WebContents } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Profile } from '../shared/types'

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

/**
 * Only http(s) sites get remembered decisions. Others (data:, file:, sandboxed frames, whose
 * origin is "null") would share one entry with every page like them, so they're asked each time.
 */
const isRememberable = (origin: string) => /^https?:\/\//.test(origin)

/**
 * Camera and microphone arrive as one "media" request; jbrow asks and remembers them separately.
 * Opening another app is asked and remembered per link scheme, so allowing zoommtg: doesn't allow
 * every other app too.
 */
function expand(permission: string, details: { mediaTypes?: string[]; externalURL?: string }): string[] {
  if (permission === 'openExternal') {
    const scheme = details.externalURL?.match(/^([a-z][a-z0-9+.-]*):/i)?.[1]?.toLowerCase()
    return scheme ? [`openExternal:${scheme}`] : ['openExternal']
  }
  if (permission !== 'media') return [permission]
  const types = details.mediaTypes?.length ? details.mediaTypes : ['audio', 'video']
  return types.map((t) => (t === 'video' ? 'camera' : 'microphone'))
}

/** What the prompt says the site wants to do. */
function describe(permission: string): string | undefined {
  const [base, scheme] = permission.split(':')
  if (base === 'openExternal' && scheme) return `open ${scheme}: links in another app`
  return ASK[permission]
}

export class SitePermissions {
  private store: Store = {}
  /** Open prompts, so a site asking twice gets one dialog. */
  private pending = new Map<string, Promise<boolean>>()
  /** What you blocked on pages whose decisions aren't remembered, for as long as the page lives. */
  private blockedOnPage = new WeakMap<WebContents, Set<string>>()

  constructor(private window: () => BrowserWindow | null) {
    if (!existsSync(storePath())) return
    try {
      this.store = JSON.parse(readFileSync(storePath(), 'utf8')) as Store
    } catch (error) {
      console.error('[permissions] permissions.json is not valid JSON, starting over:', error)
    }
  }

  /** Denies by default; asks for what's in ASK and remembers the answer for the profile. */
  attach(sess: Session, profile: Profile) {
    const profileId = profile.id
    sess.setPermissionRequestHandler((wc, permission, callback, details) => {
      const origin = originOf(details.requestingUrl)
      if (ALWAYS.has(permission) || isExtension(origin)) return callback(true)
      const wanted = expand(permission, details as { mediaTypes?: string[]; externalURL?: string })
      if (!wanted.every((p) => describe(p))) return callback(false)
      // The name is read when asking, so a profile renamed in settings asks under its new name.
      void this.ask(wc, profileId, profile.name, origin, wanted).then(callback)
    })
    sess.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
      const origin = originOf(requestingOrigin)
      if (ALWAYS.has(permission) || isExtension(origin)) return true
      if (!isRememberable(origin)) return false
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

  /** Forgets every decision made in a deleted profile. */
  forgetProfile(profileId: string) {
    delete this.store[profileId]
    this.save()
  }

  /** Forgets every decision for the site, so it asks again. */
  reset(profileId: string, url: string) {
    delete this.store[profileId]?.[originOf(url)]
    this.save()
  }

  private async ask(wc: WebContents, profileId: string, profileName: string, origin: string, wanted: string[]): Promise<boolean> {
    const remembers = isRememberable(origin)
    const decided = (remembers && this.store[profileId]?.[origin]) || {}
    const blocked = this.blockedOnPage.get(wc)
    if (wanted.some((p) => decided[p] === false || blocked?.has(p))) return false
    const open = wanted.filter((p) => decided[p] !== true)
    if (!open.length) return true

    // Pages that share the "null" origin get one prompt per page, not one shared between them.
    const key = `${profileId} ${remembers ? origin : `page ${wc.id}`} ${open.join(',')}`
    let prompt = this.pending.get(key)
    if (!prompt) {
      prompt = this.prompt(profileName, origin, open, remembers).then(({ allow, remember }) => {
        if (remember) {
          const site = ((this.store[profileId] ??= {})[origin] ??= {})
          for (const p of open) site[p] = allow
          this.save()
        } else if (!remembers && !allow) {
          let set = this.blockedOnPage.get(wc)
          if (!set) this.blockedOnPage.set(wc, (set = new Set()))
          for (const p of open) set.add(p)
        }
        return allow
      })
      prompt.finally(() => this.pending.delete(key))
      this.pending.set(key, prompt)
    }
    return prompt
  }

  private async prompt(profileName: string, origin: string, permissions: string[], remembers: boolean) {
    const what = permissions.map(describe)
    const list = what.length > 1 ? `${what.slice(0, -1).join(', ')} and ${what.at(-1)}` : what[0]
    const host = remembers ? origin.replace(/^https?:\/\//, '') : 'This page'
    const options: Electron.MessageBoxOptions = {
      type: 'question',
      message: `${host} wants to ${list}`,
      detail: `In the ${profileName} profile.`,
      buttons: ['Block', 'Allow'],
      // Enter blocks for pages jbrow can't name, so a page can't count on you pressing it.
      defaultId: remembers ? 1 : 0,
      cancelId: 0,
      ...(remembers && { checkboxLabel: 'Remember for this site', checkboxChecked: true }),
    }
    const win = this.window()
    const { response, checkboxChecked } =
      win && !win.isDestroyed() ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
    return { allow: response === 1, remember: remembers && checkboxChecked }
  }

  private save() {
    writeFileSync(storePath(), JSON.stringify(this.store, null, 2))
  }
}
