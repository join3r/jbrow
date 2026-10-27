import { app, dialog, type BrowserWindow, type Session, type WebContents } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Profile } from '../shared/types'
import { thirdPartyCookiesBlocked } from './third-party-cookies'

/** Granted without asking, as Chrome does. display-capture asks with its own menu (see screenshare.ts). */
const ALWAYS = new Set([
  'clipboard-sanitized-write',
  'fullscreen',
  'pointerLock',
  'keyboardLock',
  'speaker-selection',
  'display-capture',
])

/**
 * Storage access lets an embedded site (Google sign-in, YouTube, comment widgets) use its cookies.
 * Never asked: with third-party cookies allowed it already can, and while they're blocked a grant
 * wouldn't give them back (see third-party-cookies.ts). Refusing tells the site to sign in some
 * other way, usually a popup, instead of carrying on as if it had them.
 */
const STORAGE_ACCESS = new Set(['storage-access', 'top-level-storage-access'])

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
  openExternal: 'open another app',
}

/** Decisions per profile, then origin, then permission. USB, HID and serial devices you picked are kept here too, as `device:…` keys. */
type Store = Record<string, Record<string, Record<string, boolean>>>

/** The web APIs that ask for a device through jbrow's chooser (see devices.ts). */
export type DeviceApi = 'usb' | 'hid' | 'serial'

type AnyDevice = { vendorId?: number | string; productId?: number | string; serialNumber?: string; portName?: string; deviceId?: string; portId?: string }

/**
 * How a device you picked is remembered: by vendor, product and serial number, so it's the same
 * device after it's unplugged or the Mac restarts, as in Chrome. A serial port without USB IDs
 * (built in, or Bluetooth) goes by its name.
 */
export function deviceKey(api: DeviceApi, d: AnyDevice): string {
  const id = (n: number | string | undefined) => (typeof n === 'number' ? n.toString(16).padStart(4, '0') : (n ?? ''))
  const which = d.serialNumber || (api === 'serial' && !d.vendorId ? d.portName : '') || ''
  return `device:${api}:${id(d.vendorId)}:${id(d.productId)}:${which}`
}

/**
 * Whether a device can be told apart from others like it after it's unplugged. One without a
 * serial number is allowed only until jbrow quits, so a second one of its kind isn't allowed too.
 */
export const isLasting = (api: DeviceApi, d: AnyDevice) => !!d.serialNumber || (api === 'serial' && !d.vendorId)

/**
 * A device allowed only until jbrow quits goes by the ID Chromium gave it while it's plugged in.
 * Vendor and product alone would let in every device of that model, and built-in ones, which often
 * have neither, would all look like the same device.
 */
const sessionKey = (api: DeviceApi, d: AnyDevice) => {
  const runtime = d.deviceId || d.portId
  return runtime ? `${deviceKey(api, d)}:${runtime}` : null
}

const storePath = () => path.join(app.getPath('userData'), 'permissions.json')

function originOf(url: string): string {
  try {
    const u = new URL(url)
    // URL gives schemes it doesn't know, chrome-extension: included, the origin "null".
    return u.protocol === 'chrome-extension:' ? `chrome-extension://${u.host}` : u.origin
  } catch {
    return url
  }
}

const isExtension = (origin: string) => origin.startsWith('chrome-extension://')

/**
 * The web permissions an extension gets by listing them in its manifest, as in Chrome. Everything
 * else it's asked for like a site: camera, microphone, other apps, and these when it didn't list them.
 */
const MANIFEST: Record<string, string> = {
  geolocation: 'geolocation',
  notifications: 'notifications',
  'clipboard-read': 'clipboardRead',
}

/** The installed extension an origin belongs to, if it is one. */
function extensionOf(sess: Session, origin: string): Electron.Extension | undefined {
  return isExtension(origin) ? sess.extensions.getExtension(origin.slice('chrome-extension://'.length)) ?? undefined : undefined
}

/** Whether the extension behind `origin` listed `permission` in its manifest. */
function listed(sess: Session, origin: string, permission: string): boolean {
  const key = MANIFEST[permission]
  const declared: unknown = key && extensionOf(sess, origin)?.manifest?.permissions
  return Array.isArray(declared) && declared.includes(key)
}

/**
 * Only http(s) sites and extensions get remembered decisions. Others (data:, file:, sandboxed
 * frames, whose origin is "null") would share one entry with every page like them, so they're
 * asked each time.
 */
const isRememberable = (origin: string) => /^(https?|chrome-extension):\/\//.test(origin)

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
  /** Devices allowed until jbrow quits (see isLasting), by profile and origin, then device key. */
  private sessionDevices = new Map<string, Set<string>>()

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
      const wanted = expand(permission, details as { mediaTypes?: string[]; externalURL?: string })
      if (ALWAYS.has(permission) || wanted.every((p) => listed(sess, origin, p))) return callback(true)
      if (STORAGE_ACCESS.has(permission)) return callback(!thirdPartyCookiesBlocked())
      if (!wanted.every((p) => describe(p))) return callback(false)
      // The name is read when asking, so a profile renamed in settings asks under its new name.
      void this.ask(wc, profileId, profile.name, origin, wanted, extensionOf(sess, origin)?.name).then(callback)
    })
    sess.setPermissionCheckHandler((_wc, permission, requestingOrigin, details) => {
      const origin = originOf(requestingOrigin)
      if (ALWAYS.has(permission) || listed(sess, origin, permission)) return true
      if (STORAGE_ACCESS.has(permission)) return !thirdPartyCookiesBlocked()
      // A site may ask for a USB, HID or serial device. It sees only the ones you pick in the chooser.
      if (permission === 'usb' || permission === 'hid' || permission === 'serial') return true
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
    // WebUSB, WebHID and Web Serial: with this handler set, Electron leaves every device grant to
    // jbrow, so a page sees only the devices picked for its site in the chooser.
    sess.setDevicePermissionHandler(
      (details) => isExtension(details.origin) || this.hasDevice(profileId, details.origin, details.deviceType, details.device),
    )
  }

  /**
   * Lets the site use a device you picked for it. Only web sites get devices: pages without an
   * origin of their own (files, data: and sandboxed pages) would all share one grant.
   */
  grantDevice(profileId: string, url: string, api: DeviceApi, device: AnyDevice) {
    const origin = originOf(url)
    if (!isRememberable(origin)) return
    if (isLasting(api, device)) {
      ;((this.store[profileId] ??= {})[origin] ??= {})[deviceKey(api, device)] = true
      return this.save()
    }
    const key = sessionKey(api, device)
    if (!key) return
    const id = `${profileId} ${origin}`
    let set = this.sessionDevices.get(id)
    if (!set) this.sessionDevices.set(id, (set = new Set()))
    set.add(key)
  }

  /** The page gave a device up (device.forget()). */
  revokeDevice(profileId: string, url: string, api: DeviceApi, device: AnyDevice) {
    const origin = originOf(url)
    const key = deviceKey(api, device)
    const runtime = sessionKey(api, device)
    if (runtime) this.sessionDevices.get(`${profileId} ${origin}`)?.delete(runtime)
    const site = this.store[profileId]?.[origin]
    if (site && key in site) {
      delete site[key]
      if (!Object.keys(site).length) delete this.store[profileId][origin]
      this.save()
    }
  }

  private hasDevice(profileId: string, origin: string, api: DeviceApi, device: AnyDevice): boolean {
    origin = originOf(origin)
    if (!isRememberable(origin)) return false
    const runtime = sessionKey(api, device)
    return (!!runtime && !!this.sessionDevices.get(`${profileId} ${origin}`)?.has(runtime)) || this.store[profileId]?.[origin]?.[deviceKey(api, device)] === true
  }

  /** Whether the site has remembered decisions or devices in the profile, to offer resetting them. */
  has(profileId: string, url: string): boolean {
    const origin = originOf(url)
    return Object.keys(this.store[profileId]?.[origin] ?? {}).length > 0 || !!this.sessionDevices.get(`${profileId} ${origin}`)?.size
  }

  /** Forgets every decision made in a deleted profile. */
  forgetProfile(profileId: string) {
    delete this.store[profileId]
    for (const id of this.sessionDevices.keys()) if (id.startsWith(`${profileId} `)) this.sessionDevices.delete(id)
    this.save()
  }

  /** Forgets every decision for the site, and the devices it may use, so it asks again. */
  reset(profileId: string, url: string) {
    const origin = originOf(url)
    delete this.store[profileId]?.[origin]
    this.sessionDevices.delete(`${profileId} ${origin}`)
    this.save()
  }

  /** `name` is the extension's, for an extension: its origin is only an ID. */
  private async ask(wc: WebContents, profileId: string, profileName: string, origin: string, wanted: string[], name?: string): Promise<boolean> {
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
      prompt = this.prompt(profileName, name ?? origin, open, remembers).then(({ allow, remember }) => {
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

  private async prompt(profileName: string, who: string, permissions: string[], remembers: boolean) {
    const what = permissions.map(describe)
    const list = what.length > 1 ? `${what.slice(0, -1).join(', ')} and ${what.at(-1)}` : what[0]
    const host = remembers ? who.replace(/^https?:\/\//, '') : 'This page'
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
