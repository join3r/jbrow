// Clicking into a pane of a split with a real mouse, which only X11 lets a test do (xdotool):
// CDP's clicks don't move keyboard focus between pages. jbrow runs with a window here (not in
// the background), on the virtual display the Linux tests use.
import { execFileSync } from 'node:child_process'
import { after, before, test } from 'node:test'
import { CMD, html, launch, serve, waitFor, type Jbrow, type TestServer } from './harness'
import { offline, openTab, shownPage } from './tab-helpers'

const hasXdotool = (() => {
  if (process.platform !== 'linux') return false
  try {
    execFileSync('xdotool', ['version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
})()

let jb: Jbrow
let web: TestServer

before(async () => {
  if (!hasXdotool) return
  web = await serve({ '/left': html('Left', '<p style="height:300px">left</p>'), '/right': html('Right', '<p style="height:300px">right</p>') })
  jb = await launch({ settings: offline(web), env: { JBROW_BACKGROUND: '' } })
})
after(async () => {
  await jb?.close()
  await web?.close()
})

test('a click into the other pane makes it the active tab, and ⌘D keeps the new pane active', { skip: !hasXdotool && 'needs Linux and xdotool' }, async () => {
  const left = await openTab(jb, `${web.url}/left`)
  await (await jb.ui()).press('d', { modifiers: CMD })
  // Focusing the UI for the new pane's address bar passes focus through the left page on Linux;
  // that mustn't take the new pane away.
  const split = await jb.waitForState((s) => s.splits.length === 1 && s.activeId !== left.id, 'a split with a new pane')
  const right = split.activeId!
  await jb.send('navigate', { input: `${web.url}/right` })
  await jb.waitForState((s) => s.tabs.some((t) => t.id === right && t.url.endsWith('/right') && !t.loading), 'the right page')
  await shownPage(jb, `${web.url}/left`)
  const ui = await jb.ui()
  // The UI lays out a placeholder where each pane's page sits.
  const at = await waitFor(
    () =>
      ui.call((id) => {
        const r = document.querySelector(`.pane[data-pane="${id}"]`)?.getBoundingClientRect()
        return r?.width ? { x: Math.round(window.screenX + r.x + r.width / 2), y: Math.round(window.screenY + r.y + r.height / 2) } : null
      }, left.id),
    'the left pane on screen',
  )
  await jb.waitForState((s) => s.activeId === right, 'the right pane still active')
  execFileSync('xdotool', ['mousemove', String(at.x), String(at.y), 'click', '1'], { env: { ...process.env, DISPLAY: jb.display } })
  await jb.waitForState((s) => s.activeId === left.id, 'the clicked pane to be active')
})
