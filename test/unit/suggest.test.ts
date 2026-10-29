import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import type { Profile, TabRecord } from '../../src/shared/types'
import { columnsLayout } from '../../src/ui/suggest/columns'
import type { KeyInput } from '../../src/ui/suggest/layout'
import { suggestModel, type ModelInput } from '../../src/ui/suggest/model'
import { certLine, groups, listItems, previewLayout, shortAgo, toolFits } from '../../src/ui/suggest/preview'

const profiles: Profile[] = [
  { id: 'personal', name: 'Personal', color: '#d0679a' },
  { id: 'work', name: 'Work', color: '#2f9aab' },
] as Profile[]
const tab = (id: string, url: string, title: string, extra: Partial<TabRecord> = {}) =>
  ({ id, url, title, profile: 'personal', lastSeen: Date.now(), ...extra }) as TabRecord

function input(over: Partial<ModelInput> = {}): ModelInput {
  return {
    typed: '',
    untouched: false,
    completion: null,
    tabs: [],
    archived: [],
    profiles,
    opensIn: 'personal',
    visits: [],
    searchReply: null,
    searchSuggestions: true,
    searchUrl: 'https://www.google.com/search?q=%s',
    isPrivate: () => false,
    ...over,
  }
}

describe('suggestModel', () => {
  test('a completion is the goal, and the typed text is the first search', () => {
    const m = suggestModel(input({ typed: 'you', completion: { text: 'youtube.com', url: 'https://youtube.com/' } }))
    assert.equal(m.goal?.kind, 'site')
    assert.equal(m.goal?.title, 'youtube.com')
    assert.deepEqual(
      m.searches.map((s) => s.query),
      ['you'],
    )
    assert.equal(m.engine, 'Google')
  })

  test('a typed address goes there; a ? searches; a word goes to a tab it matches, or searches', () => {
    assert.equal(suggestModel(input({ typed: 'localhost:3000' })).goal?.kind, 'address')
    const q = suggestModel(input({ typed: '?node.js' })).goal
    assert.equal(q?.kind === 'search' && q.query, 'node.js')
    const tabs = [tab('a', 'https://notes.example/', 'Zebra notes')]
    const m = suggestModel(input({ typed: 'zebra', tabs }))
    assert.equal(m.goal?.kind, 'tab')
    // The tab in the card isn't repeated in Your tabs.
    assert.equal(m.tabs.length, 0)
    assert.equal(suggestModel(input({ typed: 'hello world', tabs })).goal?.kind, 'search')
  })

  test('nothing typed: no goal or searches, the recent tabs', () => {
    const tabs = [tab('a', 'https://a.example/', 'A'), tab('b', 'https://b.example/', 'B')]
    const m = suggestModel(input({ typed: 'https://a.example/', untouched: true, tabs }))
    assert.equal(m.goal, null)
    assert.equal(m.searches.length, 0)
    assert.equal(m.tabs.length, 2)
  })

  test('history leaves out open pages and masks private ones', () => {
    const m = suggestModel(
      input({
        typed: 'zeb',
        tabs: [tab('a', 'https://open.example/zebra', 'Zebra open')],
        visits: [
          { url: 'https://open.example/zebra', title: 'Zebra open' },
          { url: 'https://secret.example/zebra', title: '' },
        ],
        isPrivate: (u) => u.includes('secret'),
      }),
    )
    assert.deepEqual(
      m.visits.map((v) => [v.title, v.sub]),
      [['Private', 'Private']],
    )
  })
})

describe('the columns layout keys', () => {
  const press = (key: string, shiftKey = false): KeyInput => ({ key, shiftKey, metaKey: false, ctrlKey: false, altKey: false })
  // A completed site, three searches, two history pages and two tabs.
  const model = suggestModel(
    input({
      typed: 'zeb',
      completion: { text: 'zebra.example', url: 'https://zebra.example/' },
      tabs: [tab('t1', 'https://x.example/zeb1', 'Zeb one'), tab('t2', 'https://x.example/zeb2', 'Zeb two', { lastSeen: 1 })],
      visits: [
        { url: 'https://h.example/zeb1', title: 'History one' },
        { url: 'https://h.example/zeb2', title: 'History two' },
      ],
      searchReply: { seq: 1, input: 'zeb', searches: ['zebra', 'zebra crossing'] },
    }),
  )

  test('↓ walks card, searches, History; ← → move between searches and across the columns', () => {
    const l = columnsLayout()
    const key = (k: string, shift = false) => l.key(press(k, shift), model)
    assert.equal(key('ArrowLeft').do, 'none')
    key('ArrowDown')
    assert.deepEqual(l.selection(), { zone: 'card', at: 0 })
    assert.equal(key('ArrowRight').do, 'none')
    key('ArrowDown')
    assert.deepEqual(l.selection(), { zone: 'search', at: 0 })
    key('ArrowRight')
    key('ArrowRight')
    key('ArrowRight')
    assert.deepEqual(l.selection(), { zone: 'search', at: 2 })
    key('ArrowLeft')
    assert.deepEqual(l.selection(), { zone: 'search', at: 1 })
    key('ArrowDown')
    assert.deepEqual(l.selection(), { zone: 'history', at: 0 })
    key('ArrowDown')
    key('ArrowDown')
    assert.deepEqual(l.selection(), { zone: 'history', at: 1 })
    key('ArrowRight')
    assert.deepEqual(l.selection(), { zone: 'tabs', at: 1 })
    key('ArrowLeft')
    key('ArrowUp')
    key('ArrowUp')
    // Back up to the search last used, then the card, then the text.
    assert.deepEqual(l.selection(), { zone: 'search', at: 1 })
    key('ArrowUp')
    key('ArrowUp')
    assert.deepEqual(l.selection(), { zone: 'none', at: 0 })
  })

  test('Tab is the address bar’s in the text, and moves between sections in the menu', () => {
    const l = columnsLayout()
    const key = (k: string, shift = false) => l.key(press(k, shift), model)
    assert.equal(key('Tab').do, 'none')
    key('ArrowDown')
    const zones = [1, 2, 3, 4].map(() => (key('Tab'), l.selection().zone))
    assert.deepEqual(zones, ['search', 'history', 'tabs', 'card'])
    key('Tab', true)
    assert.equal(l.selection().zone, 'tabs')
  })

  test('Return picks the selection, or the goal from the text; ⇧Delete forgets a history page', () => {
    const l = columnsLayout()
    const key = (k: string, shift = false) => l.key(press(k, shift), model)
    assert.deepEqual(key('Enter'), { do: 'pick', item: model.goal })
    key('ArrowDown')
    key('ArrowDown')
    const chip = key('Enter')
    assert.equal(chip.do === 'pick' && chip.item?.kind === 'search' && chip.item.query, 'zeb')
    key('ArrowDown')
    assert.equal(key('Delete', true).do, 'forget')
    key('Tab')
    const t = key('Enter')
    assert.equal(t.do === 'pick' && t.item?.kind, 'tab')
  })
})

describe('the preview layout keys', () => {
  const press = (key: string, shiftKey = false): KeyInput => ({ key, shiftKey, metaKey: false, ctrlKey: false, altKey: false })
  // A completed site, two tabs, two history pages, an archived tab and the searches.
  const model = suggestModel(
    input({
      typed: 'zeb',
      completion: { text: 'zebra.example', url: 'https://zebra.example/' },
      tabs: [tab('t1', 'https://x.example/zeb1', 'Zeb one'), tab('t2', 'https://x.example/zeb2', 'Zeb two', { lastSeen: 1 })],
      archived: [tab('a1', 'https://old.example/zeb', 'Zeb old', { archivedAt: 5 })],
      visits: [
        { url: 'https://h.example/zeb1', title: 'History one' },
        { url: 'https://h.example/zeb2', title: 'History two' },
      ],
      searchReply: { seq: 1, input: 'zeb', searches: ['zebra'] },
    }),
  )

  test('one list: the goal, then Open tabs, History, Archived and the searches', () => {
    assert.deepEqual(
      groups(model).map((g) => g.head),
      ['', 'Open tabs', 'History', 'Archived', 'Search Google'],
    )
    assert.deepEqual(
      listItems(model).map((i) => i.kind),
      ['site', 'tab', 'tab', 'visit', 'visit', 'archived', 'search', 'search'],
    )
    // A typed search on top isn't repeated under Search.
    const searchGoal = suggestModel(input({ typed: 'hello world' }))
    assert.deepEqual(
      listItems(searchGoal).map((i) => i.kind),
      ['search'],
    )
  })

  test('↓ and ↑ walk the whole list across its groups, and ↑ off the top is back in the text', () => {
    const l = previewLayout()
    const key = (k: string) => l.key(press(k), model)
    assert.equal(key('ArrowUp').do, 'none')
    key('ArrowDown')
    assert.deepEqual(l.selection(), { zone: 'list', at: 0, tool: 'search' })
    for (let i = 0; i < 10; i++) key('ArrowDown')
    assert.equal(l.selection().at, listItems(model).length - 1)
    for (let i = 0; i < 7; i++) key('ArrowUp')
    assert.equal(l.selection().at, 0)
    key('ArrowUp')
    assert.equal(l.selection().zone, 'none')
  })

  test('→ goes into the tools, across the buttons that fit, and ← back to the same row', () => {
    const l = previewLayout()
    const key = (k: string) => l.key(press(k), model)
    // In the text → is the caret's.
    assert.equal(key('ArrowRight').do, 'none')
    key('ArrowDown')
    key('ArrowDown')
    key('ArrowRight')
    assert.deepEqual(l.selection(), { zone: 'tools', at: 1, tool: 'search' })
    const tools = [1, 2, 3, 4, 5].map(() => (key('ArrowRight'), l.selection().tool))
    assert.deepEqual(tools, ['tab', 'profile', 'copy', 'split', 'split'])
    key('ArrowLeft')
    key('ArrowLeft')
    key('ArrowLeft')
    key('ArrowLeft')
    assert.equal(l.selection().tool, 'search')
    key('ArrowLeft')
    assert.deepEqual(l.selection(), { zone: 'list', at: 1, tool: 'search' })
  })

  test('an archived tab skips split view; one profile has no profile tool', () => {
    const l = previewLayout()
    const key = (k: string) => l.key(press(k), model)
    for (let i = 0; i < 6; i++) key('ArrowDown')
    assert.equal(listItems(model)[l.selection().at].kind, 'archived')
    key('ArrowRight')
    const tools = [1, 2, 3, 4].map(() => (key('ArrowRight'), l.selection().tool))
    assert.deepEqual(tools, ['tab', 'profile', 'copy', 'copy'])

    const single = suggestModel(input({ typed: 'zeb', profiles: [profiles[0]], tabs: [tab('t1', 'https://x.example/zeb1', 'Zeb one')] }))
    assert.equal(toolFits('profile', single.goal, single), false)
  })

  test('Tab does nothing in the list or the tools, and is the text’s in the text', () => {
    const l = previewLayout()
    const key = (k: string) => l.key(press(k), model)
    assert.equal(key('Tab').do, 'none')
    key('ArrowDown')
    key('ArrowDown')
    const before = l.selection()
    assert.equal(key('Tab').do, 'moved')
    assert.deepEqual(l.selection(), before)
    key('ArrowRight')
    key('ArrowRight')
    assert.equal(key('Tab').do, 'moved')
    assert.equal(l.selection().tool, 'tab')
  })

  test('Return picks the row, or does the tool; ⇧Delete forgets a history page only in the list', () => {
    const l = previewLayout()
    const key = (k: string, shift = false) => l.key(press(k, shift), model)
    assert.deepEqual(key('Enter'), { do: 'pick', item: model.goal })
    key('ArrowDown')
    key('ArrowDown')
    const t = key('Enter')
    assert.equal(t.do === 'pick' && t.item?.kind, 'tab')
    key('ArrowDown')
    key('ArrowDown')
    assert.equal(key('Delete', true).do, 'forget')
    key('ArrowRight')
    // The search field, empty: searches for what's typed.
    const s = key('Enter')
    assert.equal(s.do === 'pick' && s.item?.kind === 'search' && s.item.query, 'zeb')
    assert.equal(key('Backspace', true).do, 'none')
    key('ArrowRight')
    const n = key('Enter')
    assert.ok(n.do === 'pick' && n.open === 'tab' && n.item?.kind === 'visit')
    key('ArrowRight')
    key('ArrowRight')
    const c = key('Enter')
    assert.ok(c.do === 'copy' && c.item.url === 'https://h.example/zeb1')
  })
})

describe('the preview panel', () => {
  test('the certificate in one line', () => {
    assert.deepEqual(certLine({ state: 'none' }), ['Plain http, no certificate', 'warn'])
    assert.deepEqual(certLine(undefined), ['Not checked yet', ''])
    assert.deepEqual(certLine({ state: 'valid', daysLeft: 52 }), ['Valid · 52 days left', 'ok'])
    assert.deepEqual(certLine({ state: 'error', error: 'CERT_DATE_INVALID', trusted: true }), ['CERT_DATE_INVALID · you chose to trust it', 'bad'])
  })
  test('how long ago, short', () => {
    const now = Date.UTC(2026, 0, 10)
    assert.equal(shortAgo(now - 5 * 60_000, now), '5 min')
    assert.equal(shortAgo(now - 30 * 3_600_000, now), 'Yesterday')
    assert.equal(shortAgo(now - 3 * 86_400_000, now), '3 d')
    assert.equal(shortAgo(now - 21 * 86_400_000, now), '3 w')
  })
})
