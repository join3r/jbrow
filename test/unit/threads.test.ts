import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  awayFromHome,
  besideClosed,
  byOrder,
  childrenOf,
  displayName,
  EARLIER_AFTER_MS,
  flatFolders,
  flatten,
  folderThreads,
  isAsleep,
  isFolder,
  isInFolder,
  isPinned,
  isRoot,
  keptThreads,
  numberedThreads,
  parentFolder,
  samePage,
  sections,
  subtree,
  threadsOf,
  type Sections,
} from '../../src/shared/threads'
import type { Folder, TabRecord } from '../../src/shared/types'

const HOUR = 60 * 60 * 1000
const NOW = 1_000_000_000_000

const tab = (id: string, over: Partial<TabRecord> = {}): TabRecord => ({
  id,
  profile: 'default',
  url: `https://${id}.example/`,
  title: id,
  createdAt: 0,
  lastSeen: NOW,
  ...over,
})

const folder = (id: string, over: Partial<Folder> = {}): Folder => ({ id, name: id, rules: [], createdAt: 0, ...over })

const ids = (list: { id: string }[]) => list.map((t) => t.id)
const roots = (list: { root: TabRecord }[]) => list.map((v) => v.root.id)

const baseOpts = { filter: 'all', scope: null, activeId: null, now: NOW, folders: [] as Folder[] }

describe('childrenOf / subtree / isRoot', () => {
  const tabs = [
    tab('r', { createdAt: 1 }),
    tab('c2', { parent: 'r', createdAt: 5 }),
    tab('c1', { parent: 'r', createdAt: 3 }),
    tab('g1', { parent: 'c1', createdAt: 9 }),
    tab('other', { createdAt: 2 }),
  ]

  test('childrenOf lists direct children by creation time', () => {
    assert.deepEqual(ids(childrenOf(tabs, 'r')), ['c1', 'c2'])
    assert.deepEqual(ids(childrenOf(tabs, 'c1')), ['g1'])
    assert.deepEqual(childrenOf(tabs, 'other'), [])
    assert.deepEqual(childrenOf([], 'r'), [])
  })

  test('subtree is root first, depth-first', () => {
    assert.deepEqual(ids(subtree(tabs, tabs[0])), ['r', 'c1', 'g1', 'c2'])
    assert.deepEqual(ids(subtree(tabs, tabs[4])), ['other'])
  })

  test('a tab is a root without a parent or when its parent is gone', () => {
    assert.equal(isRoot(tabs, tabs[0]), true)
    assert.equal(isRoot(tabs, tabs[1]), false)
    assert.equal(isRoot(tabs, tab('orphan', { parent: 'missing' })), true)
    assert.equal(isRoot(tabs, tab('emptyParent', { parent: '' })), true)
  })
})

describe('threadsOf', () => {
  test('empty input gives no threads', () => {
    assert.deepEqual(threadsOf([]), [])
  })

  test('agrees with subtree for every root, roots in list order', () => {
    const tabs = [
      tab('b', { createdAt: 10 }),
      tab('a', { createdAt: 1 }),
      tab('a2', { parent: 'a', createdAt: 8 }),
      tab('a1', { parent: 'a', createdAt: 4 }),
      tab('a1x', { parent: 'a1', createdAt: 6 }),
      tab('orphan', { parent: 'gone', createdAt: 0 }),
    ]
    const threads = threadsOf(tabs)
    assert.deepEqual(roots(threads), ['b', 'a', 'orphan'])
    for (const { root, all } of threads) assert.deepEqual(ids(all), ids(subtree(tabs, root)))
    assert.deepEqual(ids(threads[1].all), ['a', 'a1', 'a1x', 'a2'])
  })

  test('handles thousands of tabs', () => {
    const tabs = Array.from({ length: 5000 }, (_, i) => tab(`t${i}`, { createdAt: i, parent: i % 2 ? `t${i - 1}` : undefined }))
    const threads = threadsOf(tabs)
    assert.equal(threads.length, 2500)
    assert.equal(threads.reduce((n, t) => n + t.all.length, 0), 5000)
  })
})

describe('flatten', () => {
  test('a flat list is left alone', () => {
    const tabs = [tab('a'), tab('b', { kept: true, order: 1 })]
    const before = structuredClone(tabs)
    assert.equal(flatten(tabs), false)
    assert.deepEqual(tabs, before)
    assert.equal(flatten([]), false)
  })

  test('nested tabs take their root thread’s app, keep state and folder, placed right after it', () => {
    const tabs = [
      tab('r', { kept: true, folder: 'f', order: 2, scope: 'com.app', scopeName: 'App', app: 'com.app', createdAt: 1 }),
      tab('c1', { parent: 'r', createdAt: 2 }),
      tab('g', { parent: 'c1', createdAt: 3 }),
      tab('next', { kept: true, folder: 'f', order: 3, createdAt: 4 }),
    ]
    assert.equal(flatten(tabs), true)
    const [r, c1, g, next] = tabs
    for (const t of [c1, g]) {
      assert.equal(t.parent, undefined)
      assert.equal(t.kept, true)
      assert.equal(t.folder, 'f')
      assert.equal(t.scope, 'com.app')
      assert.equal(t.scopeName, 'App')
      assert.equal(t.app, 'com.app')
      assert.equal(t.pinned, undefined)
    }
    assert.ok(r.order! < c1.order! && c1.order! < g.order! && g.order! < next.order!)
    assert.equal(c1.order, 2 + 1 / 3)
    assert.equal(g.order, 2 + 2 / 3)
    assert.equal(r.parent, undefined)
    // Kept: the threads still sort the same way.
    assert.deepEqual(ids([...tabs].sort(byOrder)), ['r', 'c1', 'g', 'next'])
  })

  test('a pinned thread’s other tabs go to the bottom of Kept, outside folders', () => {
    const tabs = [tab('p', { kept: true, pinned: true, folder: 'f', order: 0 }), tab('c', { parent: 'p', pinned: true, createdAt: 1 })]
    assert.equal(flatten(tabs), true)
    const c = tabs[1]
    assert.equal(c.kept, true)
    assert.equal(c.pinned, undefined)
    assert.equal(c.folder, undefined)
    assert.equal(c.order, undefined)
    assert.equal(c.parent, undefined)
    assert.equal(isPinned(tabs[0]), true)
  })

  test('children of a loose thread aren’t kept and have no place', () => {
    const tabs = [tab('r'), tab('c', { parent: 'r', kept: true, order: 4, folder: 'x' })]
    flatten(tabs)
    assert.equal(tabs[1].kept, undefined)
    assert.equal(tabs[1].order, undefined)
    assert.equal(tabs[1].folder, undefined)
  })

  test('a kept root without a place leaves its children without one', () => {
    const tabs = [tab('r', { kept: true }), tab('c', { parent: 'r' })]
    flatten(tabs)
    assert.equal(tabs[1].kept, true)
    assert.equal(tabs[1].order, undefined)
  })

  test('a root whose parent is gone loses the dangling parent', () => {
    const tabs = [tab('r', { parent: 'gone' })]
    assert.equal(flatten(tabs), true)
    assert.equal(tabs[0].parent, undefined)
    assert.equal(flatten(tabs), false)
  })
})

describe('byOrder / isFolder', () => {
  test('items without a place go last, in the order they came', () => {
    const items = [{ id: 'a' }, { id: 'b', order: 2 }, { id: 'c' }, { id: 'd', order: -1 }, { id: 'e', order: 0 }]
    assert.deepEqual(ids([...items].sort(byOrder)), ['d', 'e', 'b', 'a', 'c'])
  })

  test('isFolder tells folders from threads', () => {
    const t = tab('t')
    assert.equal(isFolder({ root: t, all: [t], last: t, lastSeen: 0 }), false)
    assert.equal(isFolder({ folder: folder('f'), threads: [], folders: [], items: [] }), true)
  })
})

describe('folders', () => {
  const folders = [folder('a'), folder('b', { parent: 'a' }), folder('c', { parent: 'b' }), folder('x', { parent: 'missing' })]

  test('isInFolder: itself and anything nested', () => {
    assert.equal(isInFolder(folders, 'a', 'a'), true)
    assert.equal(isInFolder(folders, 'c', 'a'), true)
    assert.equal(isInFolder(folders, 'c', 'b'), true)
    assert.equal(isInFolder(folders, 'a', 'c'), false)
    assert.equal(isInFolder(folders, 'x', 'a'), false)
    assert.equal(isInFolder(folders, 'nope', 'a'), false)
    assert.equal(isInFolder([], 'a', 'a'), false)
  })

  test('isInFolder stops on a cycle', () => {
    const loop = [folder('p', { parent: 'q' }), folder('q', { parent: 'p' })]
    assert.equal(isInFolder(loop, 'p', 'q'), true)
    assert.equal(isInFolder(loop, 'p', 'z'), false)
    assert.equal(isInFolder([folder('s', { parent: 's' })], 's', 'z'), false)
  })

  test('parentFolder: the parent, or the top when it is gone or would be a cycle', () => {
    assert.equal(parentFolder(folders, folders[0]), undefined)
    assert.equal(parentFolder(folders, folders[1]), 'a')
    assert.equal(parentFolder(folders, folders[2]), 'b')
    assert.equal(parentFolder(folders, folders[3]), undefined)
    const loop = [folder('p', { parent: 'q' }), folder('q', { parent: 'p' })]
    assert.equal(parentFolder(loop, loop[0]), undefined)
    assert.equal(parentFolder(loop, loop[1]), undefined)
    const self = folder('s', { parent: 's' })
    assert.equal(parentFolder([self], self), undefined)
  })

  test('cyclic folders still show up in sections, at the top', () => {
    const loop = [folder('p', { parent: 'q' }), folder('q', { parent: 'p', createdAt: 1 })]
    const s = sections([tab('t', { kept: true, folder: 'q' })], { ...baseOpts, folders: loop })
    assert.deepEqual(
      s.folders.map((f) => f.folder.id),
      ['p', 'q'],
    )
    assert.deepEqual(roots(keptThreads(s)), ['t'])
  })

  test('flatFolders and folderThreads walk nested folders, parents first', () => {
    const tabs = [tab('ta', { kept: true, folder: 'a' }), tab('tb', { kept: true, folder: 'b' }), tab('tc', { kept: true, folder: 'c' })]
    const s = sections(tabs, { ...baseOpts, folders })
    assert.deepEqual(
      flatFolders(s.folders).map((f) => f.folder.id),
      ['a', 'b', 'c', 'x'],
    )
    const a = s.folders.find((f) => f.folder.id === 'a')!
    assert.deepEqual(roots(folderThreads(a)), ['ta', 'tb', 'tc'])
    assert.deepEqual(flatFolders([]), [])
  })
})

describe('sections', () => {
  test('empty input', () => {
    const s = sections([], baseOpts)
    assert.deepEqual(s, { pinned: [], folders: [], kept: [], top: [], today: [], apps: [], earlier: [] })
  })

  test('Today lists the newest thread first by creation time, not by last seen', () => {
    const tabs = [tab('old', { createdAt: 1, lastSeen: NOW }), tab('new', { createdAt: 3, lastSeen: NOW - 1000 }), tab('mid', { createdAt: 2 })]
    const s = sections(tabs, baseOpts)
    assert.deepEqual(roots(s.today), ['new', 'mid', 'old'])
    assert.deepEqual(s.earlier, [])
  })

  test('newTabsAt bottom lists Today and app sections oldest first', () => {
    const tabs = [tab('b', { createdAt: 2 }), tab('a', { createdAt: 1 }), tab('c', { createdAt: 3 }), tab('x', { createdAt: 4, scope: 'com.x' }), tab('y', { createdAt: 5, scope: 'com.x' })]
    const s = sections(tabs, { ...baseOpts, newTabsAt: 'bottom' })
    assert.deepEqual(roots(s.today), ['a', 'b', 'c'])
    assert.deepEqual(roots(s.apps[0].threads), ['x', 'y'])
  })

  test('threads unseen past the threshold move to Earlier, the active one never does', () => {
    const tabs = [
      tab('fresh', { createdAt: 1, lastSeen: NOW - EARLIER_AFTER_MS }),
      tab('stale', { createdAt: 2, lastSeen: NOW - EARLIER_AFTER_MS - 1 }),
      tab('activeStale', { createdAt: 3, lastSeen: 0 }),
    ]
    const s = sections(tabs, { ...baseOpts, activeId: 'activeStale' })
    assert.deepEqual(roots(s.today), ['activeStale', 'fresh'])
    assert.deepEqual(roots(s.earlier), ['stale'])
  })

  test('earlierAfterMs overrides the default threshold', () => {
    const tabs = [tab('a', { lastSeen: NOW - 2 * HOUR })]
    assert.deepEqual(roots(sections(tabs, { ...baseOpts, earlierAfterMs: HOUR }).earlier), ['a'])
    assert.deepEqual(roots(sections(tabs, { ...baseOpts, earlierAfterMs: 3 * HOUR }).today), ['a'])
  })

  test('a thread’s lastSeen and last come from its most recently seen tab', () => {
    const tabs = [tab('r', { lastSeen: 0, createdAt: 0 }), tab('c', { parent: 'r', lastSeen: NOW, createdAt: 1 })]
    const s = sections(tabs, baseOpts)
    assert.equal(s.today.length, 1)
    assert.equal(s.today[0].last.id, 'c')
    assert.equal(s.today[0].lastSeen, NOW)
    assert.deepEqual(ids(s.today[0].all), ['r', 'c'])
  })

  test('the profile filter narrows the list, pinned included', () => {
    const tabs = [tab('w', { profile: 'work' }), tab('p', { profile: 'personal' }), tab('pin', { profile: 'personal', kept: true, pinned: true })]
    const s = sections(tabs, { ...baseOpts, filter: 'work' })
    assert.deepEqual(roots(s.today), ['w'])
    assert.deepEqual(s.pinned, [])
    assert.equal(sections(tabs, baseOpts).today.length, 2)
  })

  test('kept threads sort by their place, pinned ones are icons not rows', () => {
    const tabs = [
      tab('k2', { kept: true, order: 2, createdAt: 1 }),
      tab('k1', { kept: true, order: 1, createdAt: 2 }),
      tab('kNone', { kept: true, createdAt: 0 }),
      tab('p2', { kept: true, pinned: true, order: 5 }),
      tab('p1', { kept: true, pinned: true, order: 3 }),
      tab('loose'),
    ]
    const s = sections(tabs, baseOpts)
    assert.deepEqual(roots(s.kept), ['k1', 'k2', 'kNone'])
    assert.deepEqual(roots(s.pinned), ['p1', 'p2'])
    assert.deepEqual(roots(s.today), ['loose'])
    assert.deepEqual(roots(s.top as never), ['k1', 'k2', 'kNone'])
  })

  test('pinned without kept is not pinned, and shows as a loose thread', () => {
    const t = tab('odd', { pinned: true })
    assert.equal(isPinned(t), false)
    const s = sections([t], baseOpts)
    assert.deepEqual(s.pinned, [])
    assert.deepEqual(roots(s.today), ['odd'])
  })

  test('kept and pinned threads never go to Earlier', () => {
    const tabs = [tab('k', { kept: true, lastSeen: 0 }), tab('p', { kept: true, pinned: true, lastSeen: 0 })]
    const s = sections(tabs, baseOpts)
    assert.deepEqual(s.earlier, [])
    assert.deepEqual(roots(s.kept), ['k'])
    assert.deepEqual(roots(s.pinned), ['p'])
  })

  test('each app gets its own section, sorted by name; names from appNames, then scopeName, then the key', () => {
    const tabs = [
      tab('z1', { scope: 'com.zeta', scopeName: 'Zeta', createdAt: 1 }),
      tab('z2', { scope: 'com.zeta', scopeName: 'Zeta', createdAt: 2 }),
      tab('a1', { scope: 'com.alpha', scopeName: 'Ignored', createdAt: 3 }),
      tab('k1', { scope: 'com.key', createdAt: 4 }),
      tab('zOld', { scope: 'com.zeta', createdAt: 0, lastSeen: 0 }),
      tab('loose', { createdAt: 5 }),
      tab('keptInApp', { scope: 'com.zeta', kept: true }),
    ]
    const s = sections(tabs, { ...baseOpts, appNames: { 'com.alpha': 'Alpha' } })
    assert.deepEqual(
      s.apps.map((a) => [a.scope, a.name]),
      [
        ['com.alpha', 'Alpha'],
        ['com.key', 'com.key'],
        ['com.zeta', 'Zeta'],
      ],
    )
    const zeta = s.apps[2]
    assert.deepEqual(roots(zeta.threads), ['z2', 'z1'])
    assert.deepEqual(roots(zeta.earlier), ['zOld'])
    assert.deepEqual(roots(s.today), ['loose'])
    assert.deepEqual(roots(s.kept), ['keptInApp'])
  })

  test('app sections with the same name are told apart by scope', () => {
    const tabs = [tab('b', { scope: 'b.app', scopeName: 'Same' }), tab('a', { scope: 'a.app', scopeName: 'Same' })]
    assert.deepEqual(
      sections(tabs, baseOpts).apps.map((a) => a.scope),
      ['a.app', 'b.app'],
    )
  })

  test('app names sort with unicode', () => {
    const tabs = [tab('z', { scope: 'z', scopeName: 'Zoom' }), tab('e', { scope: 'e', scopeName: 'Éclair' }), tab('a', { scope: 'a', scopeName: 'Arc' })]
    assert.deepEqual(
      sections(tabs, baseOpts).apps.map((a) => a.name),
      ['Arc', 'Éclair', 'Zoom'],
    )
  })

  test('showing one app, its threads are the whole list and pinned ones stay', () => {
    const tabs = [
      tab('mine', { scope: 'com.me', createdAt: 1 }),
      tab('mineOld', { scope: 'com.me', createdAt: 0, lastSeen: 0 }),
      tab('theirs', { scope: 'com.other' }),
      tab('loose'),
      tab('pinOther', { scope: 'com.other', kept: true, pinned: true }),
      tab('keptOther', { scope: 'com.other', kept: true }),
      tab('keptMine', { scope: 'com.me', kept: true }),
    ]
    const s = sections(tabs, { ...baseOpts, scope: 'com.me' })
    assert.deepEqual(s.apps, [])
    assert.deepEqual(roots(s.today), ['mine'])
    assert.deepEqual(roots(s.earlier), ['mineOld'])
    assert.deepEqual(roots(s.pinned), ['pinOther'])
    assert.deepEqual(roots(s.kept), ['keptMine'])
  })

  test('kept threads in a missing folder sit at the top of Kept', () => {
    const s = sections([tab('k', { kept: true, folder: 'deleted' })], baseOpts)
    assert.deepEqual(roots(s.kept), ['k'])
    assert.deepEqual(s.folders, [])
  })

  test('folders and kept threads interleave by place; folders first where neither has one', () => {
    const folders = [folder('fNone', { createdAt: 5 }), folder('f1', { order: 1, createdAt: 9 }), folder('fOld', { createdAt: 1 })]
    const tabs = [tab('t0', { kept: true, order: 0 }), tab('t2', { kept: true, order: 2 }), tab('tNone', { kept: true }), tab('in', { kept: true, folder: 'f1' })]
    const s = sections(tabs, { ...baseOpts, folders })
    const label = (i: Sections<TabRecord>['top'][number]) => (isFolder(i) ? i.folder.id : i.root.id)
    assert.deepEqual(s.top.map(label), ['t0', 'f1', 't2', 'fOld', 'fNone', 'tNone'])
    assert.deepEqual(
      s.folders.map((f) => f.folder.id),
      ['f1', 'fOld', 'fNone'],
    )
    assert.deepEqual(roots(s.kept), ['t0', 't2', 'tNone'])
    assert.deepEqual(roots(s.folders[0].threads), ['in'])
  })

  test('nested folders list their subfolders and threads in arranged order', () => {
    const folders = [folder('top'), folder('sub', { parent: 'top', order: 1 })]
    const tabs = [tab('a', { kept: true, folder: 'top', order: 2 }), tab('b', { kept: true, folder: 'top', order: 0 }), tab('c', { kept: true, folder: 'sub' })]
    const s = sections(tabs, { ...baseOpts, folders })
    assert.equal(s.folders.length, 1)
    const top = s.folders[0]
    assert.deepEqual(roots(top.threads), ['b', 'a'])
    assert.deepEqual(
      top.folders.map((f) => f.folder.id),
      ['sub'],
    )
    assert.deepEqual(
      top.items.map((i) => (isFolder(i) ? i.folder.id : i.root.id)),
      ['b', 'sub', 'a'],
    )
    assert.deepEqual(roots(keptThreads(s)), ['b', 'c', 'a'])
  })
})

describe('keptThreads', () => {
  const folders = [folder('open', { order: 0 }), folder('shut', { collapsed: true, order: 1 }), folder('inShut', { parent: 'shut' })]
  const tabs = [
    tab('top', { kept: true, order: 10 }),
    tab('o', { kept: true, folder: 'open' }),
    tab('s', { kept: true, folder: 'shut' }),
    tab('deep', { kept: true, folder: 'inShut' }),
  ]
  const s = sections(tabs, { ...baseOpts, folders })

  test('lists every kept thread in sidebar order, subfolders before unplaced threads', () => {
    assert.deepEqual(roots(keptThreads(s)), ['o', 'deep', 's', 'top'])
  })

  test('skipCollapsed leaves out threads in collapsed folders and their subfolders', () => {
    assert.deepEqual(roots(keptThreads(s, { skipCollapsed: true })), ['o', 'top'])
  })
})

describe('numberedThreads', () => {
  const tabs = [
    tab('p1', { kept: true, pinned: true, order: 0 }),
    tab('k1', { kept: true, order: 0 }),
    tab('hidden', { kept: true, folder: 'shut' }),
    tab('t1', { createdAt: 2 }),
    tab('t2', { createdAt: 1 }),
    tab('app1', { scope: 'com.app' }),
    tab('old', { lastSeen: 0 }),
  ]
  const s = sections(tabs, { ...baseOpts, folders: [folder('shut', { collapsed: true, order: 5 })] })

  test('from pinned by default: pinned, Kept, Today; apps start collapsed; Earlier never counts', () => {
    assert.deepEqual(roots(numberedThreads(s)), ['p1', 'k1', 't1', 't2'])
  })

  test('open apps count after Today', () => {
    assert.deepEqual(roots(numberedThreads(s, { openApps: ['com.app'] })), ['p1', 'k1', 't1', 't2', 'app1'])
    assert.deepEqual(roots(numberedThreads(s, { openApps: ['com.other'] })), ['p1', 'k1', 't1', 't2'])
  })

  test('from kept or today skips the sections above', () => {
    assert.deepEqual(roots(numberedThreads(s, { from: 'kept' })), ['k1', 't1', 't2'])
    assert.deepEqual(roots(numberedThreads(s, { from: 'today' })), ['t1', 't2'])
  })

  test('at most nine', () => {
    const many = Array.from({ length: 15 }, (_, i) => tab(`t${i}`, { createdAt: i }))
    const n = numberedThreads(sections(many, baseOpts))
    assert.equal(n.length, 9)
    assert.equal(n[0].root.id, 't14')
  })

  test('empty sections give none', () => {
    assert.deepEqual(numberedThreads(sections([], baseOpts)), [])
  })
})

describe('isAsleep', () => {
  const opts = { now: NOW, afterMs: HOUR, activeId: null }

  test('asleep once unseen for afterMs or longer', () => {
    assert.equal(isAsleep([tab('a', { lastSeen: NOW - HOUR })], opts), true)
    assert.equal(isAsleep([tab('a', { lastSeen: NOW - HOUR + 1 })], opts), false)
  })

  test('the most recently seen tab of the thread counts', () => {
    assert.equal(isAsleep([tab('r', { lastSeen: 0 }), tab('c', { lastSeen: NOW })], opts), false)
  })

  test('kept and active threads never sleep; 0 or less turns it off; empty is awake', () => {
    assert.equal(isAsleep([tab('k', { kept: true, lastSeen: 0 })], opts), false)
    assert.equal(isAsleep([tab('r', { lastSeen: 0 }), tab('c', { lastSeen: 0 })], { ...opts, activeId: 'c' }), false)
    assert.equal(isAsleep([tab('r', { lastSeen: 0 })], { ...opts, afterMs: 0 }), false)
    assert.equal(isAsleep([tab('r', { lastSeen: 0 })], { ...opts, afterMs: -5 }), false)
    assert.equal(isAsleep([], opts), false)
  })
})

describe('displayName', () => {
  test('name, then title, then URL, then New tab', () => {
    assert.equal(displayName(tab('a', { name: 'Mine', title: 'T', url: 'https://u/' })), 'Mine')
    assert.equal(displayName(tab('a', { title: 'T', url: 'https://u/' })), 'T')
    assert.equal(displayName(tab('a', { name: '', title: '', url: 'https://u/' })), 'https://u/')
    assert.equal(displayName(tab('a', { title: '', url: '' })), 'New tab')
    assert.equal(displayName(tab('a', { title: '日本語 🎉' })), '日本語 🎉')
  })
})

describe('samePage', () => {
  test('ignores the fragment and one trailing slash', () => {
    assert.equal(samePage('https://a.example/'), 'https://a.example')
    assert.equal(samePage('https://a.example/page#section'), 'https://a.example/page')
    assert.equal(samePage('https://a.example/dir/#top'), 'https://a.example/dir')
    assert.equal(samePage('https://a.example/#'), 'https://a.example')
    assert.equal(samePage('https://a.example/p?q=1#x'), 'https://a.example/p?q=1')
    assert.equal(samePage('https://a.example/a#b#c'), 'https://a.example/a')
  })

  test('the same page compares equal, different pages don’t', () => {
    assert.equal(samePage('https://a.example/x/'), samePage('https://a.example/x#y'))
    assert.notEqual(samePage('https://a.example/x'), samePage('https://a.example/y'))
    assert.notEqual(samePage('https://a.example/?q=1'), samePage('https://a.example/?q=2'))
  })

  test('odd addresses', () => {
    assert.equal(samePage(''), '')
    assert.equal(samePage('about:blank'), 'about:blank')
    assert.equal(samePage('file:///tmp/a.html#x'), 'file:///tmp/a.html')
    assert.equal(samePage('http://localhost:3000/'), 'http://localhost:3000')
    assert.equal(samePage('http://[::1]:8080/'), 'http://[::1]:8080')
  })
})

describe('awayFromHome', () => {
  const home = { url: 'https://a.example/start', title: 'Start' }

  test('a kept tab on another page than its home', () => {
    assert.equal(awayFromHome(tab('t', { kept: true, home, url: 'https://a.example/other' })), true)
  })

  test('the same page, give or take a fragment or trailing slash, is home', () => {
    assert.equal(awayFromHome(tab('t', { kept: true, home, url: 'https://a.example/start' })), false)
    assert.equal(awayFromHome(tab('t', { kept: true, home, url: 'https://a.example/start/' })), false)
    assert.equal(awayFromHome(tab('t', { kept: true, home, url: 'https://a.example/start#x' })), false)
  })

  test('not kept, no home, or no URL yet is never away', () => {
    assert.equal(awayFromHome(tab('t', { home, url: 'https://a.example/other' })), false)
    assert.equal(awayFromHome(tab('t', { kept: true, url: 'https://a.example/other' })), false)
    assert.equal(awayFromHome(tab('t', { kept: true, home, url: '' })), false)
  })
})

describe('besideClosed', () => {
  const tabs = [tab('a', { createdAt: 1 }), tab('b', { createdAt: 2 }), tab('c', { createdAt: 3 }), tab('k', { kept: true })]

  test('at top, the tab above takes over, or the one below for the top tab', () => {
    const s = sections(tabs, baseOpts)
    assert.deepEqual(roots(s.today), ['c', 'b', 'a'])
    assert.equal(besideClosed(s, 'b', 'top'), 'c')
    assert.equal(besideClosed(s, 'c', 'top'), 'b')
  })

  test('at bottom, the tab below takes over, or the one above for the bottom tab', () => {
    const s = sections(tabs, { ...baseOpts, newTabsAt: 'bottom' })
    assert.deepEqual(roots(s.today), ['a', 'b', 'c'])
    assert.equal(besideClosed(s, 'b', 'bottom'), 'c')
    assert.equal(besideClosed(s, 'c', 'bottom'), 'b')
  })

  test('nothing for a kept tab or one alone in its section', () => {
    assert.equal(besideClosed(sections(tabs, baseOpts), 'k'), undefined)
    assert.equal(besideClosed(sections([tab('solo')], baseOpts), 'solo'), undefined)
  })
})
