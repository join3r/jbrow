// Context groups: an app's tabs by the conversation, thread or project they were opened in.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { html, launch, serve, waitFor, type Jbrow, type TestServer } from './harness'
import { offline, tabById, waitRows } from './tab-helpers'

const SLACK = 'com.tinyspeck.slackmacgap'
const JANE = `${SLACK}\u001fAcme\u001fJane Doe`
const DESIGN = `${SLACK}\u001fAcme\u001f#design`

let jb: Jbrow
let web: TestServer

before(async () => {
  web = await serve({ '/a': html('A'), '/b': html('B'), '/c': html('C'), '/d': html('D') })
  const now = Date.now()
  const tab = (id: string, context?: string, contextName?: string) => ({
    id,
    profile: 'personal',
    url: `${web.url}/${id}`,
    title: id.toUpperCase(),
    createdAt: now - 1000 * id.charCodeAt(0),
    lastSeen: now,
    scope: SLACK,
    scopeName: 'Slack',
    app: SLACK,
    context,
    contextName,
  })
  jb = await launch({
    settings: { ...offline(web), openApps: [SLACK], openContexts: [JANE, DESIGN] },
    tabs: { tabs: [tab('a', JANE, 'Jane Doe'), tab('b', DESIGN, '#design'), tab('c', DESIGN, '#design'), tab('d')], activeId: 'a', folders: [], splits: [], archived: [] },
  })
})
after(async () => {
  await jb?.close()
  await web?.close()
})

/** Drags tab `from`'s row onto `selector`, `at` of the way down it, and drops it there. Returns the mark it showed. */
async function drag(from: string, selector: string, at = 0.1) {
  const ui = await jb.ui()
  const box = (sel: string) =>
    ui.call((sel) => {
      const r = document.querySelector(sel)!.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y, h: r.height }
    }, sel)
  const a = await box(`#threads .row[data-id="${from}"]`)
  await ui.send('Input.setInterceptDrags', { enabled: true })
  const caught = new Promise<any>((resolve) => ui.on('Input.dragIntercepted', (p) => resolve(p.data)))
  await ui.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: a.x, y: a.y + a.h / 2, button: 'left', clickCount: 1 })
  await ui.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: a.x, y: a.y + a.h / 2 + 10, button: 'left', buttons: 1 })
  const data = await caught
  await waitFor(() => ui.eval('document.getElementById("threads").classList.contains("dragging")'), 'the drag to start')
  const b = await box(selector)
  const y = b.y + b.h * at
  await ui.send('Input.dispatchDragEvent', { type: 'dragEnter', x: b.x, y, data })
  await ui.send('Input.dispatchDragEvent', { type: 'dragOver', x: b.x, y, data })
  const mark = await ui.call((sel) => document.querySelector(sel)!.className, selector)
  await ui.send('Input.dispatchDragEvent', { type: 'drop', x: b.x, y, data })
  await ui.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y, button: 'left', clickCount: 1 })
  await ui.send('Input.setInterceptDrags', { enabled: false })
  return mark
}

test("an app's section shows a heading per group, the one last seen first, and a heading folds its group", async () => {
  await waitRows(jb, (rows) => ['a', 'b', 'c', 'd'].every((id) => rows.some((r) => r.id === id)), 'every row')
  const ui = await jb.ui()
  const heads = await ui.call(() => [...document.querySelectorAll<HTMLElement>('[data-ctx-head]')].map((h) => h.textContent!.trim().replace(/\s+/g, ' ')))
  assert.deepEqual(heads.map((h) => h.replace(/\d+$/, '').trim()), ['Jane Doe', '#design'])
  await ui.call((key) => document.querySelector<HTMLElement>(`[data-ctx-head="${CSS.escape(key)}"]`)!.click(), DESIGN)
  await waitFor(() => ui.eval(`!document.querySelector('#threads .row[data-id="b"]')`), 'the #design group to fold')
  await ui.call((key) => document.querySelector<HTMLElement>(`[data-ctx-head="${CSS.escape(key)}"]`)!.click(), DESIGN)
  await waitFor(() => ui.eval(`!!document.querySelector('#threads .row[data-id="b"]')`), 'the #design group to open')
})

test("dragging a tab onto a group's heading moves it into that group", async () => {
  assert.match(await drag('b', `[data-ctx-head="${JANE.replace(/\u001f/g, '\\1f ')}"]`, 0.5), /\bdz\b/)
  const s = await jb.waitForState((s) => tabById(s, 'b')?.context === JANE, 'b in Jane Doe')
  assert.equal(tabById(s, 'b')!.contextName, 'Jane Doe')
  assert.equal(tabById(s, 'b')!.scope, SLACK)
})

test("dragging a tab onto the edge of another tab's row moves it into that tab's group, or out of any", async () => {
  await drag('c', '#threads .row[data-id="a"]', 0.1)
  await jb.waitForState((s) => tabById(s, 'c')?.context === JANE, 'c in Jane Doe')
  await drag('c', '#threads .row[data-id="d"]', 0.1)
  const s = await jb.waitForState((s) => !tabById(s, 'c')?.context, 'c out of any group')
  assert.equal(tabById(s, 'c')!.scope, SLACK)
})
