import { webContents as allWebContents, type Session, type WebContents, type WebFrameMain } from 'electron'
import type { DeviceChoice, DeviceChooserView, DeviceKind } from '../shared/types'
import type { DeviceApi, SitePermissions } from './permissions'

type Device = Electron.USBDevice | Electron.HIDDevice | Electron.SerialPort | Electron.BluetoothDevice

interface Asking {
  /** Changes with each request, so a click meant for an earlier chooser doesn't answer this one. */
  id: number
  kind: DeviceKind
  wc: WebContents
  profileId: string
  /**
   * The origin that asked: the page's, or a frame's inside it. Devices are granted to it, the
   * origin Chromium checks them against, and the chooser names it.
   */
  origin: string
  /** The page's own address, to say which page a frame from another site is in. */
  url: string
  /** By the ID Electron's callback takes. */
  devices: Map<string, Device>
  /** The device's ID, or '' to cancel. */
  answer: (deviceId: string) => void
}

export interface DeviceHooks {
  /** The tab a page belongs to. Pages outside tabs (popup windows, extension pages) get no chooser. */
  tabFor: (wc: WebContents) => string | undefined
  onChange: (tabId: string) => void
}

const idOf = (d: Device) => ('portId' in d ? d.portId : d.deviceId)
const hex = (n: number) => n.toString(16).padStart(4, '0')
/** Vendor and product ID as Chrome shows them; built-in devices often have neither. */
const ids = (vendorId: number, productId: number) => (vendorId || productId ? `${hex(vendorId)}:${hex(productId)}` : '')

/** What the chooser shows for a device: its name, and what tells two of a kind apart. */
function describe(kind: DeviceKind, d: Device): Omit<DeviceChoice, 'id'> {
  switch (kind) {
    case 'usb': {
      const u = d as Electron.USBDevice
      return { name: u.productName || 'Unknown device', detail: [u.manufacturerName, ids(u.vendorId, u.productId)].filter(Boolean).join(' · ') }
    }
    case 'hid': {
      const h = d as Electron.HIDDevice
      return { name: h.name || 'Unknown device', detail: ids(h.vendorId, h.productId) }
    }
    case 'serial': {
      const s = d as Electron.SerialPort
      return { name: s.displayName || s.portName, detail: s.displayName ? s.portName : '' }
    }
    case 'bluetooth': {
      const b = d as Electron.BluetoothDevice
      return { name: b.deviceName || 'Unknown device', detail: b.deviceName ? '' : b.deviceId }
    }
  }
}

function originOf(url: string) {
  try {
    return new URL(url).origin
  } catch {
    return ''
  }
}

function hostOf(url: string) {
  try {
    return new URL(url).host
  } catch {
    return ''
  }
}

const frameContents = (frame: WebFrameMain | null) => (frame ? allWebContents.fromFrame(frame) : undefined)

/**
 * The chooser for WebUSB, WebHID, Web Serial and Web Bluetooth: "<site> wants to connect" with the
 * devices the Mac has, shown under the address bar of the tab that asked. Picking one gives the
 * site that device and no other; closing the chooser rejects the page's request.
 */
export class DeviceChooser {
  private asking = new Map<string, Asking>()
  private nextId = 1

  constructor(
    private permissions: SitePermissions,
    private hooks: DeviceHooks,
  ) {}

  attach(sess: Session, profileId: string) {
    sess.on('select-usb-device', (event, details, callback) => {
      event.preventDefault()
      this.open('usb', frameContents(details.frame), details.frame?.origin, profileId, details.deviceList, (id) => callback(id || undefined))
    })
    sess.on('select-hid-device', (event, details, callback) => {
      event.preventDefault()
      this.open('hid', frameContents(details.frame), details.frame?.origin, profileId, details.deviceList, (id) => callback(id || null))
    })
    sess.on('select-serial-port', (event, ports, wc, callback) => {
      event.preventDefault()
      // Electron doesn't say which frame asked for a port, so it goes to the page.
      this.open('serial', wc, undefined, profileId, ports, callback)
    })
    // Plugged in or out while the chooser is open.
    sess.on('usb-device-added', (_e, device, wc) => this.update(wc, 'usb', device, true))
    sess.on('usb-device-removed', (_e, device, wc) => this.update(wc, 'usb', device, false))
    sess.on('hid-device-added', (_e, d) => this.update(frameContents(d.frame), 'hid', d.device, true))
    sess.on('hid-device-removed', (_e, d) => this.update(frameContents(d.frame), 'hid', d.device, false))
    sess.on('serial-port-added', (_e, port, wc) => this.update(wc, 'serial', port, true))
    sess.on('serial-port-removed', (_e, port, wc) => this.update(wc, 'serial', port, false))
    // The page called device.forget().
    const revoke = (api: DeviceApi, origin: string | undefined, device: Electron.USBDevice | Electron.HIDDevice | Electron.SerialPort) => {
      if (origin) this.permissions.revokeDevice(profileId, origin, api, device)
    }
    sess.on('usb-device-revoked', (_e, d) => revoke('usb', d.origin, d.device))
    sess.on('hid-device-revoked', (_e, d) => revoke('hid', d.origin, d.device))
    sess.on('serial-port-revoked', (_e, d) => revoke('serial', d.origin, d.port))
  }

  /**
   * Web Bluetooth asks through the page rather than the session. Chromium keeps scanning and
   * sends the growing list again each time, with a new callback, until one is answered.
   */
  watch(wc: WebContents, profileId: string) {
    wc.on('select-bluetooth-device', (event, devices, callback) => {
      event.preventDefault()
      const tabId = this.hooks.tabFor(wc)
      const open = tabId ? this.asking.get(tabId) : undefined
      if (!tabId || open?.kind !== 'bluetooth' || open.wc !== wc) return this.open('bluetooth', wc, undefined, profileId, devices, callback)
      open.answer = callback
      open.devices = new Map(devices.map((d) => [idOf(d), d]))
      this.hooks.onChange(tabId)
    })
  }

  private open(kind: DeviceKind, wc: WebContents | undefined, origin: string | undefined, profileId: string, devices: Device[], answer: (id: string) => void) {
    const tabId = wc && !wc.isDestroyed() ? this.hooks.tabFor(wc) : undefined
    if (!wc || !tabId) return answer('')
    const url = wc.getURL()
    origin ||= originOf(url)
    // Files, data: and sandboxed pages have no origin of their own to grant a device to.
    if (!/^https?:\/\//.test(origin)) return answer('')
    // Asking again replaces what the page asked before.
    this.cancel(tabId, false)
    const asking: Asking = {
      id: this.nextId++,
      kind,
      wc,
      profileId,
      origin,
      url,
      devices: new Map(devices.map((d) => [idOf(d), d])),
      answer,
    }
    this.asking.set(tabId, asking)
    this.hooks.onChange(tabId)
  }

  private update(wc: WebContents | undefined, kind: DeviceKind, device: Device, present: boolean) {
    const tabId = wc ? this.hooks.tabFor(wc) : undefined
    const a = tabId ? this.asking.get(tabId) : undefined
    if (!tabId || !a || a.kind !== kind || a.wc !== wc) return
    if (present) a.devices.set(idOf(device), device)
    else a.devices.delete(idOf(device))
    this.hooks.onChange(tabId)
  }

  /** Connects the device you picked, or cancels with none. `id` is the chooser's, from its view. */
  answer(tabId: string, id: number, deviceId: string | null) {
    const a = this.asking.get(tabId)
    if (!a || a.id !== id) return
    const device = deviceId ? a.devices.get(deviceId) : undefined
    if (deviceId && !device) return
    this.asking.delete(tabId)
    // The grant has to be in place before the page gets the device: it's checked when the page opens it.
    if (device && a.kind !== 'bluetooth') this.permissions.grantDevice(a.profileId, a.origin, a.kind, device as Exclude<Device, Electron.BluetoothDevice>)
    try {
      a.answer(device ? idOf(device) : '')
    } catch {}
    this.hooks.onChange(tabId)
  }

  /** The tab is going somewhere new, or its page is gone: its chooser closes, and the page hears no. */
  cancel(tabId: string, notify = true) {
    const a = this.asking.get(tabId)
    if (!a) return
    this.asking.delete(tabId)
    try {
      a.answer('')
    } catch {}
    if (notify) this.hooks.onChange(tabId)
  }

  view(tabId: string): DeviceChooserView | null {
    const a = this.asking.get(tabId)
    if (!a) return null
    const host = hostOf(a.origin)
    const page = hostOf(a.url)
    return {
      id: a.id,
      kind: a.kind,
      host,
      embedder: page && page !== host ? page : undefined,
      devices: [...a.devices].map(([id, d]) => ({ id, ...describe(a.kind, d) })),
    }
  }
}
