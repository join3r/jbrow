import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import type { Session } from 'electron'
import { addContentShim, shimContentScripts } from '../../src/main/content-shim'

const SHIM = 'jbrow-content-shim.js'

function extension(manifest: unknown) {
  const dir = mkdtempSync(path.join(tmpdir(), 'jbrow-ext-'))
  writeFileSync(path.join(dir, 'manifest.json'), typeof manifest === 'string' ? manifest : JSON.stringify(manifest))
  return dir
}
const manifestOf = (dir: string) => JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8'))

test('the shim goes first in each isolated-world content script', () => {
  const dir = extension({
    name: 'Video Speed Controller',
    content_scripts: [
      { matches: ['<all_urls>'], js: ['inject.js', 'ui.js'] },
      { matches: ['<all_urls>'], js: ['page.js'], world: 'MAIN' },
      { matches: ['<all_urls>'], css: ['style.css'] },
      { matches: ['<all_urls>'], js: [] },
      { matches: ['<all_urls>'], js: ['iso.js'], world: 'ISOLATED' },
    ],
  })
  assert.equal(addContentShim(dir), true)
  const scripts = manifestOf(dir).content_scripts
  assert.deepEqual(scripts.map((c: { js?: string[] }) => c.js), [[SHIM, 'inject.js', 'ui.js'], ['page.js'], undefined, [], [SHIM, 'iso.js']])
  assert.equal(manifestOf(dir).name, 'Video Speed Controller')
  const shim = readFileSync(path.join(dir, SHIM), 'utf8')
  assert.match(shim, /define\('sync', storage\.local\)/)
})

test('running it again changes nothing', () => {
  const dir = extension({ content_scripts: [{ js: ['a.js'] }] })
  assert.equal(addContentShim(dir), true)
  const manifest = readFileSync(path.join(dir, 'manifest.json'), 'utf8')
  assert.equal(addContentShim(dir), false)
  assert.equal(readFileSync(path.join(dir, 'manifest.json'), 'utf8'), manifest)
})

test('a shim listed elsewhere moves to the front', () => {
  const dir = extension({ content_scripts: [{ js: ['a.js', SHIM, 'b.js'] }] })
  assert.equal(addContentShim(dir), true)
  assert.deepEqual(manifestOf(dir).content_scripts[0].js, [SHIM, 'a.js', 'b.js'])
})

test('an outdated shim file is rewritten even when the manifest is current', () => {
  const dir = extension({ content_scripts: [{ js: [SHIM, 'a.js'] }] })
  writeFileSync(path.join(dir, SHIM), '// old')
  assert.equal(addContentShim(dir), false)
  assert.notEqual(readFileSync(path.join(dir, SHIM), 'utf8'), '// old')
})

test('extensions without isolated-world content scripts are left alone', () => {
  for (const manifest of [{}, { content_scripts: [] }, { content_scripts: [{ js: ['p.js'], world: 'MAIN' }] }]) {
    const dir = extension(manifest)
    assert.equal(addContentShim(dir), false)
    assert.equal(existsSync(path.join(dir, SHIM)), false)
    assert.deepEqual(manifestOf(dir), manifest)
  }
})

test('a missing or broken manifest is no error', () => {
  const empty = mkdtempSync(path.join(tmpdir(), 'jbrow-ext-'))
  assert.equal(addContentShim(empty), false)
  assert.equal(addContentShim(path.join(empty, 'does-not-exist')), false)
  const broken = extension('{ "content_scripts": [')
  const error = console.error
  console.error = () => {}
  try {
    assert.equal(addContentShim(broken), false)
  } finally {
    console.error = error
  }
})

test('shimContentScripts shims only extensions inside the extensions folder', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'jbrow-exts-'))
  const extensionsPath = path.join(root, 'Extensions')
  const inside = path.join(extensionsPath, 'abcdefghijklmnopabcdefghijklmnop', '1.0.0_0')
  const sibling = path.join(root, 'Extensions-unpacked', 'mine')
  const elsewhere = mkdtempSync(path.join(tmpdir(), 'jbrow-unpacked-'))
  for (const dir of [inside, sibling, elsewhere]) {
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ content_scripts: [{ js: ['a.js'] }] }))
  }
  const loaded: unknown[][] = []
  const sess = {
    extensions: {
      loadExtension(this: unknown, dir: string, options?: unknown) {
        loaded.push([this, dir, options])
        return Promise.resolve({ id: 'x' })
      },
    },
  }
  shimContentScripts(sess as unknown as Session, extensionsPath)
  for (const dir of [inside, sibling, elsewhere, extensionsPath]) await sess.extensions.loadExtension(dir, { allowFileAccess: true })
  assert.deepEqual(
    loaded.map(([self, dir, options]) => [self === sess.extensions, dir, options]),
    [inside, sibling, elsewhere, extensionsPath].map((dir) => [true, dir, { allowFileAccess: true }]),
  )
  assert.deepEqual(manifestOf(inside).content_scripts[0].js, [SHIM, 'a.js'])
  assert.deepEqual(manifestOf(sibling).content_scripts[0].js, ['a.js'])
  assert.deepEqual(manifestOf(elsewhere).content_scripts[0].js, ['a.js'])
})

test('a manifest starting with a byte order mark is shimmed, as Chrome reads it', () => {
  const dir = extension('﻿' + JSON.stringify({ content_scripts: [{ js: ['a.js'] }] }))
  assert.equal(addContentShim(dir), true)
  assert.deepEqual(manifestOf(dir).content_scripts[0].js, [SHIM, 'a.js'])
})
