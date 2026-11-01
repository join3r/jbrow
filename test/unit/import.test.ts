import assert from 'node:assert/strict'
import { createCipheriv, createHash, pbkdf2Sync } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { after, test } from 'node:test'
import {
  arcProfile,
  chromiumBookmarks,
  chromiumCookies,
  chromiumHistory,
  firefoxBookmarks,
  firefoxHistory,
  parseArcSidebar,
  parsePlist,
  safariHistory,
  safariTree,
} from '../../src/main/import'
import { BrowsingHistory } from '../../src/main/visits'

const DAY = 24 * 60 * 60 * 1000
const FROM_1601_MS = 11644473600000
const dir = mkdtempSync(path.join(os.tmpdir(), 'jbrow-import-test-'))
after(() => rmSync(dir, { recursive: true, force: true }))

function db(name: string, sql: string): { file: string; db: DatabaseSync } {
  const file = path.join(dir, name)
  const d = new DatabaseSync(file)
  d.exec(sql)
  return { file, db: d }
}

/** Chromium's time: µs since 1601, as a BigInt since it doesn't fit a number. */
const chromeTime = (ms: number) => BigInt(ms + FROM_1601_MS) * 1000n

test('Chromium history: the last 90 days, with times since 1970', () => {
  const { file, db: d } = db('History', 'CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, typed_count INTEGER, last_visit_time INTEGER, hidden INTEGER)')
  const now = Date.now()
  const add = d.prepare('INSERT INTO urls (url, title, visit_count, typed_count, last_visit_time, hidden) VALUES (?, ?, ?, 0, ?, ?)')
  add.run('https://a.com/', 'A', 7, chromeTime(now - DAY), 0)
  add.run('https://old.com/', 'Old', 3, chromeTime(now - 120 * DAY), 0)
  add.run('https://hidden.com/', 'Hidden', 1, chromeTime(now - DAY), 1)
  d.close()
  const pages = chromiumHistory(file)
  assert.deepEqual(pages.map((p) => [p.url, p.title, p.visits]), [['https://a.com/', 'A', 7]])
  assert.ok(Math.abs(pages[0].last - (now - DAY)) < 2)
})

test('Chromium cookies: decrypted with the Keychain password, the domain hash dropped, expired ones left out', () => {
  const { file, db: d } = db(
    'Cookies',
    `CREATE TABLE meta (key TEXT, value TEXT); INSERT INTO meta VALUES ('version', '24');
     CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, expires_utc INTEGER,
       is_secure INTEGER, is_httponly INTEGER, samesite INTEGER, is_persistent INTEGER)`,
  )
  const key = pbkdf2Sync('secret', 'saltysalt', 1003, 16, 'sha1')
  const encrypt = (host: string, value: string) => {
    const c = createCipheriv('aes-128-cbc', key, Buffer.alloc(16, ' '))
    const plain = Buffer.concat([createHash('sha256').update(host).digest(), Buffer.from(value)])
    return Buffer.concat([Buffer.from('v10'), c.update(plain), c.final()])
  }
  // On a whole second, as expiry times come out in seconds.
  const now = Math.floor(Date.now() / 1000) * 1000
  const add = d.prepare('INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
  add.run('.github.com', 'sid', '', encrypt('.github.com', 'abc123'), '/', chromeTime(now + 30 * DAY), 1, 1, 1, 1)
  add.run('app.example.com', '__Host-x', '', encrypt('app.example.com', 'v'), '/', 0n, 1, 0, 2, 0)
  add.run('.gone.com', 'old', '', encrypt('.gone.com', 'x'), '/', chromeTime(now - DAY), 0, 0, -1, 1)
  add.run('plain.com', 'p', 'visible', Buffer.alloc(0), '/a', chromeTime(now + DAY), 0, 0, 0, 1)
  d.close()
  const cookies = chromiumCookies(file, 'secret')
  assert.deepEqual(
    cookies.map((c) => (c.expirationDate ? { ...c, expirationDate: Math.round(c.expirationDate) } : c)),
    [
      { url: 'https://github.com/', name: 'sid', value: 'abc123', domain: '.github.com', path: '/', secure: true, httpOnly: true, expirationDate: Math.round((now + 30 * DAY) / 1000), sameSite: 'lax' },
      { url: 'https://app.example.com/', name: '__Host-x', value: 'v', path: '/', secure: true, httpOnly: false, sameSite: 'strict' },
      { url: 'http://plain.com/a', name: 'p', value: 'visible', path: '/a', secure: false, httpOnly: false, expirationDate: Math.round((now + DAY) / 1000), sameSite: 'no_restriction' },
    ],
  )
})

test('Chromium bookmarks: the bar at the top of one folder, other and mobile bookmarks in their own', () => {
  const file = path.join(dir, 'Bookmarks')
  writeFileSync(
    file,
    JSON.stringify({
      roots: {
        bookmark_bar: { type: 'folder', children: [{ type: 'url', name: 'A', url: 'https://a.com/' }, { type: 'folder', name: 'Dev', children: [{ type: 'url', name: 'GH', url: 'https://github.com/' }] }] },
        other: { type: 'folder', children: [{ type: 'url', name: 'O', url: 'https://o.com/' }] },
        synced: { type: 'folder', children: [] },
      },
    }),
  )
  assert.deepEqual(chromiumBookmarks(file, 'Chrome'), [
    {
      title: 'Chrome bookmarks',
      children: [
        { url: 'https://a.com/', title: 'A' },
        { title: 'Dev', children: [{ url: 'https://github.com/', title: 'GH' }] },
        { title: 'Other bookmarks', children: [{ url: 'https://o.com/', title: 'O' }] },
        { title: 'Mobile bookmarks', children: [] },
      ],
    },
  ])
})

test("Arc: a profile's Favorites and each space's pinned tabs, with folders kept and split views flattened", () => {
  const tab = (id: string, url: string, title: string | null = null, saved = 'Saved') => ({ id, title, childrenIds: [], data: { tab: { savedURL: url, savedTitle: saved } } })
  const work = { custom: { _0: { directoryBasename: 'Profile 1', machineID: 'm' } } }
  const sidebar = parseArcSidebar({
    sidebar: {
      containers: [
        { global: {} },
        {
          topAppsContainerIDs: [{ default: true }, 'favP', work, 'favW'],
          spaces: [
            'sp1',
            { id: 'sp1', title: 'Work', profile: work, containerIDs: ['pinned', 'pinW', 'unpinned', 'todayW'] },
            'sp2',
            { id: 'sp2', title: 'Personal', profile: { default: true }, containerIDs: ['pinned', 'pinP', 'unpinned', 'todayP'] },
          ],
          items: [
            'favW', { id: 'favW', childrenIds: ['f1'], data: { itemContainer: {} } },
            'f1', tab('f1', 'https://mail.example/', 'Mail'),
            'pinW', { id: 'pinW', childrenIds: ['l1', 't3'], data: { itemContainer: {} } },
            'l1', { id: 'l1', title: 'Docs', childrenIds: ['split'], data: { list: {} } },
            'split', { id: 'split', childrenIds: ['t1', 't2'], data: { splitView: {} } },
            't1', tab('t1', 'https://a.example/'),
            't2', tab('t2', 'https://b.example/', 'Renamed'),
            't3', tab('t3', 'https://c.example/'),
            'todayW', { id: 'todayW', childrenIds: ['t4'], data: { itemContainer: {} } },
            't4', tab('t4', 'https://today.example/'),
            'favP', { id: 'favP', childrenIds: [], data: { itemContainer: {} } },
            'pinP', { id: 'pinP', childrenIds: [], data: { itemContainer: {} } },
          ],
        },
      ],
    },
  })!
  assert.deepEqual(arcProfile(sidebar, 'Profile 1'), {
    name: 'Work',
    favorites: [{ url: 'https://mail.example/', title: 'Mail' }],
    spaces: [
      {
        title: 'Work',
        children: [
          { title: 'Docs', children: [{ url: 'https://a.example/', title: 'Saved' }, { url: 'https://b.example/', title: 'Renamed' }] },
          { url: 'https://c.example/', title: 'Saved' },
        ],
      },
    ],
  })
  assert.equal(arcProfile(sidebar, 'Default')?.name, 'Personal')
  assert.equal(arcProfile(sidebar, 'Profile 9'), null)
})

test('Safari: history with times since 2001, bookmarks from the XML property list', () => {
  const { file, db: d } = db(
    'History.db',
    `CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT, visit_count INTEGER);
     CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER, visit_time REAL, title TEXT)`,
  )
  const now = Date.now()
  const at = (ms: number) => ms / 1000 - 978307200
  d.exec(`INSERT INTO history_items VALUES (1, 'https://apple.com/', 4), (2, 'https://old.com/', 1)`)
  d.prepare('INSERT INTO history_visits (history_item, visit_time, title) VALUES (?, ?, ?)').run(1, at(now - 2 * DAY), 'Apple old')
  d.prepare('INSERT INTO history_visits (history_item, visit_time, title) VALUES (?, ?, ?)').run(1, at(now - DAY), 'Apple')
  d.prepare('INSERT INTO history_visits (history_item, visit_time, title) VALUES (?, ?, ?)').run(2, at(now - 100 * DAY), 'Old')
  d.close()
  const pages = safariHistory(file)
  assert.deepEqual(pages.map((p) => [p.url, p.title, p.visits]), [['https://apple.com/', 'Apple', 4]])
  assert.ok(Math.abs(pages[0].last - (now - DAY)) < 2)

  const plist = parsePlist(`<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>Children</key>
	<array>
		<dict>
			<key>Title</key><string>BookmarksBar</string>
			<key>WebBookmarkType</key><string>WebBookmarkTypeList</string>
			<key>Children</key>
			<array>
				<dict>
					<key>URIDictionary</key><dict><key>title</key><string>Tom &amp; Jerry</string></dict>
					<key>URLString</key><string>https://tj.example/?a=1&amp;b=2</string>
					<key>WebBookmarkType</key><string>WebBookmarkTypeLeaf</string>
					<key>Sync</key><dict><key>Data</key><data>
					AAEC
					</data></dict>
				</dict>
			</array>
		</dict>
		<dict>
			<key>Title</key><string>com.apple.ReadingList</string>
			<key>WebBookmarkType</key><string>WebBookmarkTypeList</string>
			<key>Children</key><array/>
		</dict>
	</array>
	<key>WebBookmarkFileVersion</key><integer>1</integer>
	<key>Empty</key><true/>
</dict>
</plist>`)
  assert.equal(plist.WebBookmarkFileVersion, 1)
  assert.equal(plist.Empty, true)
  assert.deepEqual(safariTree(plist), [
    {
      title: 'Safari bookmarks',
      children: [
        { url: 'https://tj.example/?a=1&b=2', title: 'Tom & Jerry' },
        { title: 'Bookmarks menu', children: [] },
        { title: 'Reading list', children: [] },
      ],
    },
  ])
})

test('Firefox: history and bookmarks from places.sqlite', () => {
  const { file, db: d } = db(
    'places.sqlite',
    `CREATE TABLE moz_places (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_date INTEGER, hidden INTEGER DEFAULT 0);
     CREATE TABLE moz_bookmarks (id INTEGER PRIMARY KEY, type INTEGER, fk INTEGER, parent INTEGER, position INTEGER, title TEXT, guid TEXT)`,
  )
  const now = Date.now()
  d.prepare('INSERT INTO moz_places (id, url, title, visit_count, last_visit_date) VALUES (?, ?, ?, ?, ?)').run(1, 'https://mozilla.org/', 'Mozilla', 2, (now - DAY) * 1000)
  d.prepare('INSERT INTO moz_places (id, url, title, visit_count, last_visit_date) VALUES (?, ?, ?, ?, ?)').run(2, 'place:sort=8', 'Recent', 0, null)
  d.exec(`INSERT INTO moz_bookmarks VALUES
    (1, 2, NULL, 0, 0, '', 'root________'),
    (2, 2, NULL, 1, 0, 'menu', 'menu________'),
    (3, 2, NULL, 1, 1, 'toolbar', 'toolbar_____'),
    (4, 1, 1, 3, 0, 'MDN', 'aaaaaaaaaaaa'),
    (5, 1, 2, 3, 1, 'Recent', 'bbbbbbbbbbbb'),
    (6, 2, NULL, 2, 0, 'Reading', 'cccccccccccc')`)
  d.close()
  assert.deepEqual(firefoxHistory(file).map((p) => [p.url, p.visits]), [['https://mozilla.org/', 2]])
  assert.deepEqual(firefoxBookmarks(file), [
    {
      title: 'Firefox bookmarks',
      children: [
        { url: 'https://mozilla.org/', title: 'MDN' },
        { title: 'Bookmarks menu', children: [{ title: 'Reading', children: [] }] },
        { title: 'Other bookmarks', children: [] },
        { title: 'Mobile bookmarks', children: [] },
      ],
    },
  ])
})

test('importing history twice changes nothing; a page already there keeps the higher count and later visit', () => {
  const h = new BrowsingHistory()
  const now = Date.now()
  h.record('p', 'https://a.com/', 'A')
  const pages = [
    { url: 'https://a.com/', title: 'Other', visits: 9, last: now - DAY },
    { url: 'https://b.com/', title: 'B', visits: 2, last: now - DAY },
    { url: 'ftp://c.com/', title: 'C', visits: 1, last: now },
  ]
  assert.equal(h.import('p', pages), 1)
  assert.equal(h.import('p', pages), 0)
  assert.deepEqual(h.search('p', 'a.com', 5), [{ url: 'https://a.com/', title: 'A' }])
  assert.deepEqual(h.search('p', 'b.com', 5), [{ url: 'https://b.com/', title: 'B' }])
})
