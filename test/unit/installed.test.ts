import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { Session } from 'electron'
import { trackInstalls } from '../../src/main/installed'

const ID = 'nngceckbapebfimnlniiiahkandclblb'
const OTHER = 'aeblfdkhhhdcdjpifhhbdiojplfjncoa'

/** A profile session with extensions and service workers to start. */
function profile(storage: string | null = mkdtempSync(path.join(tmpdir(), 'jbrow-profile-'))) {
  const extensions = new Map<string, { id: string; version: string }>()
  const serviceWorkers = new EventEmitter() as EventEmitter & { getWorkerFromVersionID: (id: number) => unknown }
  const workers = new Map<number, { scope: string; ipc: EventEmitter }>()
  serviceWorkers.getWorkerFromVersionID = (id) => workers.get(id)
  const sess = {
    getStoragePath: () => storage,
    extensions: { getExtension: (id: string) => extensions.get(id) },
    serviceWorkers,
  }
  let nextVersion = 1
  /** Starts a worker with that scope and asks, as the preload does. */
  const ask = (scope: string, versionId = nextVersion++) => {
    let worker = workers.get(versionId)
    if (!worker) workers.set(versionId, (worker = { scope, ipc: new EventEmitter() }))
    serviceWorkers.emit('running-status-changed', { versionId, runningStatus: 'starting' })
    const event: { returnValue?: unknown } = {}
    worker.ipc.emit('jbrow-installed', event)
    return event
  }
  return { sess: sess as unknown as Session, storage, extensions, ask, file: storage && path.join(storage, 'jbrow-extension-versions.json') }
}

test('a new extension with empty storage is installed', () => {
  const p = profile()
  trackInstalls(p.sess)
  p.extensions.set(ID, { id: ID, version: '2025.1.0' })
  assert.deepEqual(p.ask(`chrome-extension://${ID}/`).returnValue, { reason: 'install' })
  assert.deepEqual(JSON.parse(readFileSync(p.file!, 'utf8')), { [ID]: '2025.1.0' })
})

test('the same version again gets no event, a new version gets update', () => {
  const p = profile()
  trackInstalls(p.sess)
  p.extensions.set(ID, { id: ID, version: '1.0' })
  p.ask(`chrome-extension://${ID}/`)
  assert.equal(p.ask(`chrome-extension://${ID}/`).returnValue, null)
  p.extensions.set(ID, { id: ID, version: '1.1' })
  assert.deepEqual(p.ask(`chrome-extension://${ID}/`).returnValue, { reason: 'update', previousVersion: '1.0' })
})

test('an extension already in use before jbrow kept track is not new', () => {
  const p = profile()
  mkdirSync(path.join(p.storage!, 'Local Extension Settings', ID), { recursive: true })
  trackInstalls(p.sess)
  p.extensions.set(ID, { id: ID, version: '1.0' })
  assert.equal(p.ask(`chrome-extension://${ID}/`).returnValue, null)
  // But it's remembered, so its next version is an update.
  p.extensions.set(ID, { id: ID, version: '1.1' })
  assert.deepEqual(p.ask(`chrome-extension://${ID}/`).returnValue, { reason: 'update', previousVersion: '1.0' })
})

test('versions seen are read back at launch', () => {
  const p = profile()
  writeFileSync(p.file!, JSON.stringify({ [ID]: '1.0' }))
  trackInstalls(p.sess)
  p.extensions.set(ID, { id: ID, version: '1.0' })
  p.extensions.set(OTHER, { id: OTHER, version: '3' })
  assert.equal(p.ask(`chrome-extension://${ID}/`).returnValue, null)
  assert.deepEqual(p.ask(`chrome-extension://${OTHER}/`).returnValue, { reason: 'install' })
  assert.deepEqual(JSON.parse(readFileSync(p.file!, 'utf8')), { [ID]: '1.0', [OTHER]: '3' })
})

test('a corrupt versions file starts over', () => {
  const p = profile()
  writeFileSync(p.file!, '{oops')
  trackInstalls(p.sess)
  p.extensions.set(ID, { id: ID, version: '1.0' })
  assert.deepEqual(p.ask(`chrome-extension://${ID}/`).returnValue, { reason: 'install' })
})

test('websites’ workers and unknown extensions get an answer of null', () => {
  const p = profile()
  trackInstalls(p.sess)
  for (const scope of ['https://example.com/', `chrome-extension://${ID}/`, 'chrome-extension://not-an-id/', '']) {
    assert.equal(p.ask(scope).returnValue, null, scope)
  }
})

test('a worker that restarts is listened to once', () => {
  const p = profile()
  trackInstalls(p.sess)
  p.extensions.set(ID, { id: ID, version: '1.0' })
  assert.deepEqual(p.ask(`chrome-extension://${ID}/`, 7).returnValue, { reason: 'install' })
  p.extensions.set(ID, { id: ID, version: '2.0' })
  // A second listener would answer first and leave the event looking like nothing changed.
  assert.deepEqual(p.ask(`chrome-extension://${ID}/`, 7).returnValue, { reason: 'update', previousVersion: '1.0' })
})

test('other running states and missing workers are ignored', () => {
  const p = profile()
  trackInstalls(p.sess)
  const sw = (p.sess as unknown as { serviceWorkers: EventEmitter }).serviceWorkers
  sw.emit('running-status-changed', { versionId: 99, runningStatus: 'starting' })
  sw.emit('running-status-changed', { versionId: 1, runningStatus: 'running' })
})

test('an in-memory session has nowhere to keep versions and is skipped', () => {
  const p = profile(null)
  trackInstalls(p.sess)
  const sw = (p.sess as unknown as { serviceWorkers: EventEmitter }).serviceWorkers
  assert.equal(sw.listenerCount('running-status-changed'), 0)
})

test('a versions file that can’t be written answers null instead of hanging the worker', () => {
  const p = profile(path.join(tmpdir(), 'jbrow-no-such-profile', String(process.pid), String(Math.random())))
  trackInstalls(p.sess)
  p.extensions.set(ID, { id: ID, version: '1.0' })
  const error = console.error
  console.error = () => {}
  try {
    assert.equal(p.ask(`chrome-extension://${ID}/`).returnValue, null)
  } finally {
    console.error = error
  }
})
