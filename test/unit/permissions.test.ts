import assert from 'node:assert/strict'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { beforeEach, test, type TestContext } from 'node:test'
import { app, dialog, type Session, type WebContents } from 'electron'
import { userData } from '../mocks/electron'
import { deviceKey, isLasting, SitePermissions } from '../../src/main/permissions'

const file = path.join(userData, 'permissions.json')
const saved = () => JSON.parse(readFileSync(file, 'utf8'))

beforeEach(() => {
  rmSync(file, { force: true })
  app.commandLine.removeSwitch('test-third-party-cookie-phaseout')
})

type RequestHandler = (wc: WebContents, permission: string, callback: (granted: boolean) => void, details: Record<string, unknown>) => void
type CheckHandler = (wc: WebContents | null, permission: string, origin: string, details: Record<string, unknown>) => boolean
type DeviceHandler = (details: Record<string, unknown>) => boolean

/** An installed extension that lists geolocation and notifications in its manifest. */
const MAPS = 'abcdefghijklmnopabcdefghijklmnop'

/** A session that keeps the handlers jbrow sets, and a page to ask from. */
function setup(profile = { id: 'p', name: 'Personal', color: '#000' }) {
  const handlers = {} as { request: RequestHandler; check: CheckHandler; device: DeviceHandler }
  const installed: Record<string, { name: string; manifest: Record<string, unknown> }> = {
    [MAPS]: { name: 'Maps Helper', manifest: { permissions: ['storage', 'geolocation', 'notifications'] } },
  }
  const sess = {
    setPermissionRequestHandler: (h: RequestHandler) => void (handlers.request = h),
    setPermissionCheckHandler: (h: CheckHandler) => void (handlers.check = h),
    setDevicePermissionHandler: (h: DeviceHandler) => void (handlers.device = h),
    extensions: { getExtension: (id: string) => installed[id] ?? null },
  }
  const perms = new SitePermissions(() => null)
  perms.attach(sess as unknown as Session, profile)
  let nextId = 1
  const page = () => ({ id: nextId++, session: sess }) as unknown as WebContents
  const wc = page()
  const request = (permission: string, details: Record<string, unknown>, from = wc) =>
    new Promise<boolean>((resolve) => handlers.request(from, permission, resolve, details))
  const check = (permission: string, origin: string, details: Record<string, unknown> = {}) => handlers.check(wc, permission, origin, details)
  return { perms, handlers, request, check, page, wc }
}

/** Answers the permission dialog: Allow or Block, with "Remember" ticked or not. Returns what was asked. */
function answer(t: TestContext, allow: boolean, remember = true) {
  const asked: Electron.MessageBoxOptions[] = []
  t.mock.method(dialog as any, 'showMessageBox', async (...args: unknown[]) => {
    asked.push(args.at(-1) as Electron.MessageBoxOptions)
    return { response: allow ? 1 : 0, checkboxChecked: remember }
  })
  return asked
}

test('deviceKey uses vendor, product and serial number', () => {
  assert.equal(deviceKey('usb', { vendorId: 0x46d, productId: 0xc52b, serialNumber: 'ABC', deviceId: '7' }), 'device:usb:046d:c52b:ABC')
  assert.equal(deviceKey('hid', { vendorId: 1, productId: 2 }), 'device:hid:0001:0002:')
  // Web Serial gives IDs as strings already.
  assert.equal(deviceKey('serial', { vendorId: '2341', productId: '0043', serialNumber: 'X', portName: 'cu.usbmodem1' }), 'device:serial:2341:0043:X')
  // A serial port without USB IDs goes by its name.
  assert.equal(deviceKey('serial', { portName: 'COM3' }), 'device:serial:::COM3')
  assert.equal(deviceKey('serial', { portName: 'cu.Bluetooth-Incoming-Port' }), 'device:serial:::cu.Bluetooth-Incoming-Port')
  assert.equal(deviceKey('usb', {}), 'device:usb:::')
})

test('isLasting: a serial number, or a serial port without USB IDs', () => {
  assert.equal(isLasting('usb', { vendorId: 1, productId: 2, serialNumber: 'S' }), true)
  assert.equal(isLasting('usb', { vendorId: 1, productId: 2 }), false)
  assert.equal(isLasting('hid', { vendorId: 1, productId: 2, serialNumber: '' }), false)
  assert.equal(isLasting('serial', { portName: 'COM1' }), true)
  assert.equal(isLasting('serial', { vendorId: '2341', portName: 'COM4' }), false)
})

test('always-granted permissions, and what an extension listed in its manifest, need no prompt', async (t) => {
  const asked = answer(t, false)
  const { request, check } = setup()
  for (const p of ['fullscreen', 'pointerLock', 'clipboard-sanitized-write', 'display-capture']) {
    assert.equal(await request(p, { requestingUrl: 'https://a.com/' }), true, p)
    assert.equal(check(p, 'https://a.com'), true, p)
  }
  assert.equal(await request('geolocation', { requestingUrl: `chrome-extension://${MAPS}/bg.html` }), true)
  assert.equal(check('notifications', `chrome-extension://${MAPS}`), true)
  assert.equal(asked.length, 0)
})

test("an extension is asked like a site for what its manifest doesn't list", async (t) => {
  const asked = answer(t, false)
  const { request, check } = setup()
  // Listed geolocation, not clipboardRead.
  assert.equal(check('clipboard-read', `chrome-extension://${MAPS}`), false)
  assert.equal(await request('clipboard-read', { requestingUrl: `chrome-extension://${MAPS}/popup.html` }), false)
  assert.equal(asked.length, 1)
  assert.match(asked[0].message!, /^The extension “Maps Helper” wants to read your clipboard/)
  // An extension that isn't installed in the profile lists nothing.
  const other = 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba'
  assert.equal(check('geolocation', other), false)
  assert.equal(await request('geolocation', { requestingUrl: `${other}/bg.html` }), false)
  assert.equal(asked.length, 2)
  assert.match(asked[1].message!, /^An extension wants to know your location/)
  // What it lists in its manifest isn't anything a site may never have.
  assert.equal(await request('mediaKeySystem', { requestingUrl: `chrome-extension://${MAPS}/bg.html` }), false)
  assert.equal(asked.length, 2)
})

test('extensions are asked for the camera, the microphone and other apps, once', async (t) => {
  const asked = answer(t, true)
  const { request, check } = setup()
  const ext = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'
  assert.equal(check('media', ext, { mediaType: 'video' }), false)
  assert.equal(await request('media', { requestingUrl: `${ext}/popup.html`, mediaTypes: ['video'] }), true)
  assert.equal(asked.length, 1)
  // Remembered for that extension, like a site.
  assert.equal(check('media', ext, { mediaType: 'video' }), true)
  assert.equal(await request('media', { requestingUrl: `${ext}/popup.html`, mediaTypes: ['video'] }), true)
  assert.equal(asked.length, 1)
  // Another extension asks for itself.
  assert.equal(check('media', 'chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba', { mediaType: 'video' }), false)
  assert.equal(await request('openExternal', { requestingUrl: `${ext}/bg.html`, externalURL: 'zoommtg://x' }), true)
  assert.equal(asked.length, 2)
})

test('unknown permissions are denied without asking', async (t) => {
  const asked = answer(t, true)
  const { request, check } = setup()
  assert.equal(await request('bogus-permission', { requestingUrl: 'https://a.com/' }), false)
  assert.equal(check('bogus-permission', 'https://a.com'), false)
  assert.equal(asked.length, 0)
})

test('storage access follows the third-party cookie switch', async () => {
  const { request, check } = setup()
  assert.equal(await request('storage-access', { requestingUrl: 'https://a.com/' }), true)
  assert.equal(check('top-level-storage-access', 'https://a.com'), true)
  app.commandLine.appendSwitch('test-third-party-cookie-phaseout')
  assert.equal(await request('storage-access', { requestingUrl: 'https://a.com/' }), false)
  assert.equal(check('storage-access', 'https://a.com'), false)
})

test('an allowed and remembered permission is saved per profile and origin', async (t) => {
  const asked = answer(t, true)
  const { request, check } = setup()
  assert.equal(await request('geolocation', { requestingUrl: 'https://maps.example/route?x=1' }), true)
  assert.equal(asked.length, 1)
  assert.equal(asked[0].message, 'maps.example wants to know your location')
  assert.equal(asked[0].detail, 'In the Personal profile.')
  assert.equal(asked[0].defaultId, 1)
  assert.deepEqual(saved(), { p: { 'https://maps.example': { geolocation: true } } })
  // Asked again, it's answered from the store.
  assert.equal(await request('geolocation', { requestingUrl: 'https://maps.example/' }), true)
  assert.equal(asked.length, 1)
  assert.equal(check('geolocation', 'https://maps.example'), true)
  assert.equal(check('geolocation', 'https://maps.example:8443'), false)
  assert.equal(check('geolocation', 'http://maps.example'), false)
})

test('a blocked and remembered permission is refused from then on', async (t) => {
  const asked = answer(t, false)
  const { request } = setup()
  assert.equal(await request('notifications', { requestingUrl: 'https://spam.example/' }), false)
  assert.equal(await request('notifications', { requestingUrl: 'https://spam.example/' }), false)
  assert.equal(asked.length, 1)
  assert.deepEqual(saved(), { p: { 'https://spam.example': { notifications: false } } })
})

test('an answer not remembered asks again next time', async (t) => {
  const asked = answer(t, true, false)
  const { request } = setup()
  assert.equal(await request('clipboard-read', { requestingUrl: 'https://a.com/' }), true)
  assert.equal(await request('clipboard-read', { requestingUrl: 'https://a.com/' }), true)
  assert.equal(asked.length, 2)
})

test('camera and microphone are asked and remembered separately', async (t) => {
  const asked = answer(t, true)
  const { request, check } = setup()
  assert.equal(await request('media', { requestingUrl: 'https://meet.example/', mediaTypes: ['audio'] }), true)
  assert.equal(asked[0].message, 'meet.example wants to use your microphone')
  assert.equal(check('media', 'https://meet.example', { mediaType: 'audio' }), true)
  assert.equal(check('media', 'https://meet.example', { mediaType: 'video' }), false)
  assert.equal(check('media', 'https://meet.example', {}), true)
  // Both at once: only the camera is still open.
  assert.equal(await request('media', { requestingUrl: 'https://meet.example/', mediaTypes: ['audio', 'video'] }), true)
  assert.equal(asked[1].message, 'meet.example wants to use your camera')
  assert.deepEqual(saved().p['https://meet.example'], { microphone: true, camera: true })
})

test('media with no types asks for both', async (t) => {
  const asked = answer(t, true)
  const { request } = setup()
  await request('media', { requestingUrl: 'https://meet.example/' })
  assert.equal(asked[0].message, 'meet.example wants to use your microphone and camera')
})

test('a blocked half of a media request refuses the whole', async (t) => {
  answer(t, false)
  const { request } = setup()
  await request('media', { requestingUrl: 'https://meet.example/', mediaTypes: ['video'] })
  t.mock.restoreAll()
  const asked = answer(t, true)
  assert.equal(await request('media', { requestingUrl: 'https://meet.example/', mediaTypes: ['audio', 'video'] }), false)
  assert.equal(asked.length, 0)
})

test('opening another app is asked per link scheme', async (t) => {
  const asked = answer(t, true)
  const { request } = setup()
  assert.equal(await request('openExternal', { requestingUrl: 'https://zoom.example/', externalURL: 'ZoomMtg://join?x' }), true)
  assert.equal(asked[0].message, 'zoom.example wants to open zoommtg: links in another app')
  assert.equal(await request('openExternal', { requestingUrl: 'https://zoom.example/', externalURL: 'zoommtg://other' }), true)
  assert.equal(asked.length, 1)
  await request('openExternal', { requestingUrl: 'https://zoom.example/', externalURL: 'slack://open' })
  assert.equal(asked.length, 2)
  assert.deepEqual(saved().p['https://zoom.example'], { 'openExternal:zoommtg': true, 'openExternal:slack': true })
})

test('pages without an origin are asked each time, Enter blocks, and nothing is saved', async (t) => {
  const asked = answer(t, true, true)
  const { request, check } = setup()
  for (const url of ['file:///C:/Users/me/page.html', 'data:text/html,hi', 'null']) {
    assert.equal(await request('geolocation', { requestingUrl: url }), true, url)
  }
  assert.equal(asked.length, 3)
  assert.equal(asked[0].message, 'This page wants to know your location')
  assert.equal(asked[0].defaultId, 0)
  assert.equal(asked[0].checkboxLabel, undefined)
  assert.throws(() => saved())
  assert.equal(check('geolocation', 'null'), false)
  assert.equal(check('geolocation', 'file:///C:/x.html'), false)
})

test('a page without an origin that was blocked stays blocked for as long as it lives', async (t) => {
  answer(t, false)
  const { request, page } = setup()
  const wc = page()
  assert.equal(await request('camera', { requestingUrl: 'file:///x.html' }, wc), false)
  t.mock.restoreAll()
  const asked = answer(t, true)
  assert.equal(await request('media', { requestingUrl: 'file:///x.html', mediaTypes: ['video'] }, wc), false)
  assert.equal(asked.length, 0)
  // Another such page is asked.
  assert.equal(await request('media', { requestingUrl: 'file:///x.html', mediaTypes: ['video'] }, page()), true)
})

test("pages are told they may still ask for what you haven't decided", async (t) => {
  answer(t, false)
  const { perms, request, page, wc } = setup()
  assert.equal(perms.undecided(wc, 'https://meet.example/abc', 'microphone'), true)
  assert.equal(perms.undecided(wc, 'https://meet.example/abc', 'midiSysex'), true)
  // Not something jbrow asks about, so it's simply denied.
  assert.equal(perms.undecided(wc, 'https://meet.example/abc', 'openExternal'), false)
  assert.equal(perms.undecided(wc, 'https://meet.example/abc', 'bluetooth'), false)
  assert.equal(await request('media', { requestingUrl: 'https://meet.example/abc', mediaTypes: ['audio'] }), false)
  assert.equal(perms.undecided(wc, 'https://meet.example/', 'microphone'), false)
  assert.equal(perms.undecided(wc, 'https://meet.example/', 'camera'), true)
  // A page without an origin it was blocked on, but not another one.
  const other = page()
  assert.equal(await request('camera', { requestingUrl: 'file:///x.html' }, other), false)
  assert.equal(perms.undecided(other, 'file:///x.html', 'camera'), false)
  assert.equal(perms.undecided(page(), 'file:///x.html', 'camera'), true)
  // A session jbrow didn't attach to isn't answered.
  assert.equal(perms.undecided({ session: {} } as unknown as WebContents, 'https://meet.example/', 'camera'), false)
})

test('the same request twice at once gets one dialog', async (t) => {
  let release!: () => void
  const asked: unknown[] = []
  t.mock.method(dialog as any, 'showMessageBox', (...args: unknown[]) => {
    asked.push(args)
    return new Promise((resolve) => (release = () => resolve({ response: 1, checkboxChecked: true })))
  })
  const { request } = setup()
  const a = request('geolocation', { requestingUrl: 'https://a.com/' })
  const b = request('geolocation', { requestingUrl: 'https://a.com/x' })
  await new Promise((r) => setTimeout(r, 0))
  release()
  assert.deepEqual(await Promise.all([a, b]), [true, true])
  assert.equal(asked.length, 1)
})

test('decisions are read back from permissions.json', async () => {
  writeFileSync(file, JSON.stringify({ p: { 'https://a.com': { geolocation: true, notifications: false } } }))
  const { check, request } = setup()
  assert.equal(check('geolocation', 'https://a.com'), true)
  assert.equal(check('notifications', 'https://a.com'), false)
  assert.equal(await request('notifications', { requestingUrl: 'https://a.com/' }), false)
})

test('a corrupt permissions.json starts over', () => {
  writeFileSync(file, '{"p": ')
  const error = console.error
  console.error = () => {}
  try {
    const { check } = setup()
    assert.equal(check('geolocation', 'https://a.com'), false)
  } finally {
    console.error = error
  }
})

test('devices you picked are lasting or for the session', () => {
  const { perms, handlers, check } = setup()
  const lasting = { vendorId: 0x2341, productId: 0x43, serialNumber: 'S1', deviceId: 'd1' }
  const anonymous = { vendorId: 0x2341, productId: 0x43, deviceId: 'd2' }
  const twin = { vendorId: 0x2341, productId: 0x43, deviceId: 'd3' }
  const has = (device: object, origin = 'https://board.example') => handlers.device({ origin, deviceType: 'usb', device })
  assert.equal(check('usb', 'https://board.example'), true)
  assert.equal(has(lasting), false)

  perms.grantDevice('p', 'https://board.example/flash', 'usb', lasting)
  perms.grantDevice('p', 'https://board.example/flash', 'usb', anonymous)
  assert.equal(has(lasting), true)
  assert.equal(has(anonymous), true)
  // Another of the same model, without a serial number, isn't the one you picked.
  assert.equal(has(twin), false)
  assert.equal(has(lasting, 'https://other.example'), false)
  assert.deepEqual(saved(), { p: { 'https://board.example': { 'device:usb:2341:0043:S1': true } } })
  assert.equal(perms.has('p', 'https://board.example/'), true)

  perms.revokeDevice('p', 'https://board.example', 'usb', lasting)
  perms.revokeDevice('p', 'https://board.example', 'usb', anonymous)
  assert.equal(has(lasting), false)
  assert.equal(has(anonymous), false)
  assert.deepEqual(saved(), { p: {} })
  assert.equal(perms.has('p', 'https://board.example/'), false)
})

test('devices go only to web sites, and extensions have them all', () => {
  const { perms, handlers } = setup()
  const d = { vendorId: 1, productId: 2, serialNumber: 'S' }
  perms.grantDevice('p', 'file:///C:/flash.html', 'usb', d)
  perms.grantDevice('p', 'https://a.com/', 'hid', { vendorId: 1, productId: 2 })
  assert.throws(() => saved())
  assert.equal(handlers.device({ origin: 'file://', deviceType: 'usb', device: d }), false)
  assert.equal(handlers.device({ origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop', deviceType: 'usb', device: d }), true)
  // A device with neither a serial number nor a runtime ID can't be told apart, so it isn't kept.
  assert.equal(perms.has('p', 'https://a.com/'), false)
})

test('reset and forgetProfile forget decisions and devices', async (t) => {
  answer(t, true)
  const { perms, request } = setup()
  await request('geolocation', { requestingUrl: 'https://a.com/' })
  await request('geolocation', { requestingUrl: 'https://b.com/' })
  perms.grantDevice('p', 'https://a.com/', 'usb', { vendorId: 1, productId: 2, deviceId: 'x' })
  perms.reset('p', 'https://a.com/page')
  assert.equal(perms.has('p', 'https://a.com/'), false)
  assert.equal(perms.has('p', 'https://b.com/'), true)
  perms.grantDevice('p', 'https://c.com/', 'usb', { vendorId: 1, productId: 2, deviceId: 'y' })
  perms.forgetProfile('p')
  assert.equal(perms.has('p', 'https://b.com/'), false)
  assert.equal(perms.has('p', 'https://c.com/'), false)
  assert.deepEqual(saved(), {})
})

test('the prompt names the profile as it is called when asking', async (t) => {
  const asked = answer(t, true, false)
  const profile = { id: 'p', name: 'Work', color: '#000' }
  const { request } = setup(profile)
  profile.name = 'Office'
  await request('midi', { requestingUrl: 'https://[::1]:8080/' })
  assert.equal(asked[0].detail, 'In the Office profile.')
  assert.equal(asked[0].message, '[::1]:8080 wants to use your MIDI devices')
})

test('pages in tabs are asked in the window, and dismissing refuses once without remembering', async (t) => {
  const dialogs = answer(t, true)
  const handlers = {} as { request: RequestHandler }
  const sess = {
    setPermissionRequestHandler: (h: RequestHandler) => void (handlers.request = h),
    setPermissionCheckHandler: () => {},
    setDevicePermissionHandler: () => {},
    extensions: { getExtension: () => null },
  }
  const questions: { wc: WebContents; q: Record<string, unknown> }[] = []
  let reply: Record<string, boolean> = { allow: true, remember: true }
  const inTab = { id: 1, session: sess } as unknown as WebContents
  const outside = { id: 2, session: sess } as unknown as WebContents
  const perms = new SitePermissions(
    () => null,
    (wc, q) => {
      if (wc !== inTab) return undefined
      questions.push({ wc, q: q as unknown as Record<string, unknown> })
      return Promise.resolve(reply as { allow: boolean; remember: boolean; dismissed?: boolean })
    },
  )
  perms.attach(sess as unknown as Session, { id: 'p', name: 'Work', color: '#000' })
  const request = (wc: WebContents, permission: string, details: Record<string, unknown>) =>
    new Promise<boolean>((resolve) => handlers.request(wc, permission, resolve, details))

  reply = { allow: false, remember: true, dismissed: true }
  assert.equal(await request(inTab, 'media', { requestingUrl: 'https://meet.example/', mediaTypes: ['video'] }), false)
  assert.deepEqual(questions[0].q, { who: 'meet.example', what: 'use your camera', permissions: ['camera'], profile: 'Work', remembers: true })
  assert.throws(() => saved())
  // Dismissed, so it asks again; a page without an origin isn't blocked for its lifetime either.
  reply = { allow: true, remember: true }
  assert.equal(await request(inTab, 'media', { requestingUrl: 'https://meet.example/', mediaTypes: ['video'] }), true)
  assert.deepEqual(saved(), { p: { 'https://meet.example': { camera: true } } })
  reply = { allow: false, remember: false, dismissed: true }
  await request(inTab, 'geolocation', { requestingUrl: 'file:///x.html' })
  assert.equal(perms.undecided(inTab, 'file:///x.html', 'geolocation'), true)
  assert.equal(questions.at(-1)!.q.remembers, false)
  assert.equal(dialogs.length, 0)
  // A page outside tabs gets the dialog.
  assert.equal(await request(outside, 'geolocation', { requestingUrl: 'https://maps.example/' }), true)
  assert.equal(dialogs.length, 1)
})
