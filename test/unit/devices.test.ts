import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { webContents, type Session, type WebContents } from 'electron'
import { DeviceChooser } from '../../src/main/devices'
import type { SitePermissions } from '../../src/main/permissions'

class Page extends EventEmitter {
  destroyed = false
  constructor(public url: string) {
    super()
  }
  getURL() {
    return this.url
  }
  isDestroyed() {
    return this.destroyed
  }
}

const arduino = { deviceId: 'u1', vendorId: 0x2341, productId: 0x43, productName: 'Arduino Uno', manufacturerName: 'Arduino', serialNumber: 'S1' }
const builtin = { deviceId: 'u2', vendorId: 0, productId: 0, productName: '', manufacturerName: '' }

function setup() {
  const tabs = new Map<unknown, string>()
  const changed: string[] = []
  const grants: unknown[][] = []
  const revokes: unknown[][] = []
  const permissions = {
    grantDevice: (...args: unknown[]) => void grants.push(args),
    revokeDevice: (...args: unknown[]) => void revokes.push(args),
  } as unknown as SitePermissions
  const chooser = new DeviceChooser(permissions, { tabFor: (wc) => tabs.get(wc), onChange: (id) => void changed.push(id) })
  const sess = new EventEmitter()
  chooser.attach(sess as unknown as Session, 'p')
  const page = (url: string, tab?: string) => {
    const p = new Page(url)
    if (tab) tabs.set(p, tab)
    return p
  }
  /** Fires a session event as Electron does, returning what the page was answered. */
  const ask = (event: string, ...args: unknown[]) => {
    const answers: unknown[] = []
    let prevented = false
    sess.emit(event, { preventDefault: () => (prevented = true) }, ...args, (id: unknown) => answers.push(id))
    assert.equal(prevented, true)
    return answers
  }
  return { chooser, sess, page, ask, changed, grants, revokes }
}

/** The frame a WebUSB or WebHID request comes from; fromFrame maps it to its page. */
function frameIn(page: Page, origin: string) {
  const frame = { origin }
  const fromFrame = (f: unknown) => (f === frame ? page : undefined)
  ;(webContents as unknown as { fromFrame: typeof fromFrame }).fromFrame = fromFrame
  return frame
}

test('a USB request shows the chooser for its tab', () => {
  const { chooser, page, ask, changed } = setup()
  const p = page('https://board.example/flash', 't1')
  const answers = ask('select-usb-device', { frame: frameIn(p, 'https://board.example'), deviceList: [arduino, builtin] })
  assert.deepEqual(answers, [])
  assert.deepEqual(changed, ['t1'])
  const view = chooser.view('t1')
  assert.deepEqual(view, {
    id: 1,
    kind: 'usb',
    host: 'board.example',
    embedder: undefined,
    devices: [
      { id: 'u1', name: 'Arduino Uno', detail: 'Arduino · 2341:0043' },
      { id: 'u2', name: 'Unknown device', detail: '' },
    ],
  })
})

test('picking a device grants it to the asking origin first, then answers', () => {
  const { chooser, page, sess, grants, changed } = setup()
  const p = page('https://shop.example/', 't1')
  const order: string[] = []
  sess.emit('select-usb-device', { preventDefault() {} }, { frame: frameIn(p, 'https://widget.example:8443'), deviceList: [arduino] }, (id: unknown) => {
    order.push(`answer ${id}`)
    assert.equal(grants.length, 1)
  })
  assert.equal(chooser.view('t1')?.embedder, 'shop.example')
  assert.equal(chooser.view('t1')?.host, 'widget.example:8443')
  chooser.answer('t1', 1, 'u1')
  assert.deepEqual(order, ['answer u1'])
  assert.deepEqual(grants, [['p', 'https://widget.example:8443', 'usb', arduino]])
  assert.equal(chooser.view('t1'), null)
  assert.deepEqual(changed, ['t1', 't1'])
})

test('answers for an older chooser or an unknown device are ignored', () => {
  const { chooser, page, ask } = setup()
  const p = page('https://a.example/', 't1')
  ask('select-usb-device', { frame: frameIn(p, 'https://a.example'), deviceList: [arduino] })
  chooser.answer('t1', 99, 'u1')
  chooser.answer('t1', 1, 'nope')
  chooser.answer('other-tab', 1, 'u1')
  assert.ok(chooser.view('t1'))
})

test('closing the chooser answers with no device', () => {
  const { chooser, page, sess, grants } = setup()
  const p = page('https://a.example/', 't1')
  const usb: unknown[] = []
  const hid: unknown[] = []
  sess.emit('select-usb-device', { preventDefault() {} }, { frame: frameIn(p, 'https://a.example'), deviceList: [arduino] }, (id: unknown) => usb.push(id))
  chooser.answer('t1', 1, null)
  sess.emit('select-hid-device', { preventDefault() {} }, { frame: frameIn(p, 'https://a.example'), deviceList: [] }, (id: unknown) => hid.push(id))
  chooser.answer('t1', 2, null)
  // Electron wants undefined for no USB device and null for no HID device.
  assert.deepEqual(usb, [undefined])
  assert.deepEqual(hid, [null])
  assert.deepEqual(grants, [])
})

test('pages outside tabs and pages without an origin get no chooser', () => {
  const { ask, page, chooser } = setup()
  const popup = page('https://a.example/')
  assert.deepEqual(ask('select-serial-port', [], popup), [''])
  const file = page('file:///C:/Users/me/flash.html', 't2')
  assert.deepEqual(ask('select-serial-port', [], file), [''])
  const sandboxed = page('https://a.example/', 't3')
  assert.deepEqual(ask('select-usb-device', { frame: frameIn(sandboxed, 'null'), deviceList: [] }), [undefined])
  const gone = page('https://a.example/', 't4')
  gone.destroyed = true
  assert.deepEqual(ask('select-serial-port', [], gone), [''])
  assert.deepEqual(ask('select-usb-device', { frame: null, deviceList: [] }), [undefined])
  for (const t of ['t2', 't3', 't4']) assert.equal(chooser.view(t), null)
})

test('serial ports go to the page and show their names', () => {
  const { chooser, page, ask } = setup()
  const p = page('https://esp.example/', 't')
  ask('select-serial-port', [{ portId: 's1', portName: 'COM3', displayName: 'USB Serial' }, { portId: 's2', portName: '/dev/ttyUSB0', displayName: '' }], p)
  assert.deepEqual(chooser.view('t')?.devices, [
    { id: 's1', name: 'USB Serial', detail: 'COM3' },
    { id: 's2', name: '/dev/ttyUSB0', detail: '' },
  ])
})

test('HID devices show their name and IDs', () => {
  const { chooser, page, ask } = setup()
  const p = page('https://keys.example/', 't')
  ask('select-hid-device', { frame: frameIn(p, 'https://keys.example'), deviceList: [{ deviceId: 'h1', name: 'YubiKey', vendorId: 0x1050, productId: 0x407 }, { deviceId: 'h2', name: '', vendorId: 1, productId: 0 }] })
  assert.deepEqual(chooser.view('t')?.devices, [
    { id: 'h1', name: 'YubiKey', detail: '1050:0407' },
    { id: 'h2', name: 'Unknown device', detail: '0001:0000' },
  ])
})

test('devices plugged in or out while the chooser is open', () => {
  const { chooser, page, ask, sess, changed } = setup()
  const p = page('https://a.example/', 't')
  ask('select-usb-device', { frame: frameIn(p, 'https://a.example'), deviceList: [] })
  sess.emit('usb-device-added', {}, arduino, p)
  assert.deepEqual(chooser.view('t')?.devices.map((d) => d.id), ['u1'])
  sess.emit('usb-device-removed', {}, arduino, p)
  assert.deepEqual(chooser.view('t')?.devices, [])
  // Serial ports for a USB chooser, or devices for another page, change nothing.
  const before = changed.length
  sess.emit('serial-port-added', {}, { portId: 's', portName: 'COM1' }, p)
  sess.emit('usb-device-added', {}, arduino, page('https://b.example/', 'other'))
  assert.equal(changed.length, before)
})

test('asking again replaces the earlier chooser, which hears no', () => {
  const { chooser, page, sess } = setup()
  const p = page('https://a.example/', 't')
  const first: unknown[] = []
  sess.emit('select-serial-port', { preventDefault() {} }, [], p, (id: string) => first.push(id))
  sess.emit('select-serial-port', { preventDefault() {} }, [{ portId: 's', portName: 'COM1' }], p, () => {})
  assert.deepEqual(first, [''])
  assert.equal(chooser.view('t')?.id, 2)
})

test('cancel answers no and tells the UI', () => {
  const { chooser, page, ask, changed } = setup()
  const p = page('https://a.example/', 't')
  const answers = ask('select-serial-port', [], p)
  chooser.cancel('t')
  assert.deepEqual(answers, [''])
  assert.deepEqual(changed, ['t', 't'])
  chooser.cancel('t')
  assert.deepEqual(changed, ['t', 't'])
})

test('a page answer that throws doesn’t break the chooser', () => {
  const { chooser, page, sess } = setup()
  const p = page('https://a.example/', 't')
  sess.emit('select-serial-port', { preventDefault() {} }, [{ portId: 's', portName: 'COM1' }], p, () => {
    throw new Error('page gone')
  })
  chooser.answer('t', 1, 's')
  assert.equal(chooser.view('t'), null)
})

test('Web Bluetooth updates the open chooser as devices are found', () => {
  const { chooser, page } = setup()
  const p = page('https://ble.example/', 't')
  chooser.watch(p as unknown as WebContents, 'p')
  const answers: string[] = []
  const send = (devices: unknown[]) => p.emit('select-bluetooth-device', { preventDefault() {} }, devices, (id: string) => answers.push(id))
  send([{ deviceId: 'AA:BB', deviceName: '' }])
  assert.deepEqual(chooser.view('t')?.devices, [{ id: 'AA:BB', name: 'Unknown device', detail: 'AA:BB' }])
  send([{ deviceId: 'AA:BB', deviceName: 'Heart rate' }, { deviceId: 'CC:DD', deviceName: 'Scale' }])
  // Same chooser, the latest list, and only the latest callback is answered.
  assert.equal(chooser.view('t')?.id, 1)
  assert.deepEqual(chooser.view('t')?.devices.map((d) => d.name), ['Heart rate', 'Scale'])
  chooser.answer('t', 1, 'CC:DD')
  assert.deepEqual(answers, ['CC:DD'])
})

test('Bluetooth devices are not granted through site permissions', () => {
  const { chooser, page, grants } = setup()
  const p = page('https://ble.example/', 't')
  chooser.watch(p as unknown as WebContents, 'p')
  p.emit('select-bluetooth-device', { preventDefault() {} }, [{ deviceId: 'X', deviceName: 'X' }], () => {})
  chooser.answer('t', 1, 'X')
  assert.deepEqual(grants, [])
})

test('a page giving up a device revokes it for its origin', () => {
  const { sess, revokes } = setup()
  sess.emit('usb-device-revoked', {}, { origin: 'https://a.example', device: arduino })
  sess.emit('hid-device-revoked', {}, { origin: undefined, device: {} })
  sess.emit('serial-port-revoked', {}, { origin: 'https://b.example', port: { portName: 'COM1' } })
  assert.deepEqual(revokes, [
    ['p', 'https://a.example', 'usb', arduino],
    ['p', 'https://b.example', 'serial', { portName: 'COM1' }],
  ])
})
