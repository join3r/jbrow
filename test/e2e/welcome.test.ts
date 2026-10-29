// The welcome at first launch (welcomed: false): it shows over the window, its choices apply
// right away, and once done or skipped ('welcome-done') it doesn't come back.
import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { launch, removeDir, tempDir, waitFor, type Cdp, type Jbrow } from './harness'
import { isShown, offline, settle } from './ui-helpers'

const running: Jbrow[] = []
const dirs: string[] = []
after(async () => {
  for (const jb of running) await jb.close()
  for (const dir of dirs) await removeDir(dir)
})

async function firstLaunch(userData?: string) {
  const jb = await launch({ userData, settings: { ...offline(), welcomed: false } })
  running.push(jb)
  // The harness tells main the UI is ready once more, and main answers with the welcome again,
  // which starts it over: let that happen before clicking through it.
  await settle(jb)
  return jb
}

const welcomeShown = (ui: Cdp) => isShown(ui, 'welcome')
/** Clicks a button of the welcome by id, once it's there. */
async function click(ui: Cdp, id: string) {
  await waitFor(() => ui.call((id) => !!document.getElementById(id) && !(document.getElementById(id) as HTMLButtonElement).disabled, id), `#${id}`)
  await ui.call((id) => document.getElementById(id)!.click(), id)
}
const stepLabel = (ui: Cdp) => ui.eval<string>('document.querySelector(".wl-steps [aria-current=step]")?.textContent?.trim() ?? ""')

test('the welcome shows at first launch; skipping it keeps the defaults and it stays away', async () => {
  const userData = tempDir()
  dirs.push(userData)
  let jb = await firstLaunch(userData)
  const ui = await jb.ui()
  await waitFor(() => welcomeShown(ui), 'the welcome')
  assert.match(await stepLabel(ui), /Hello/)
  assert.match(await ui.eval('document.getElementById("wl-skip").textContent'), /Skip/)
  const before = (await jb.state()).prefs

  await click(ui, 'wl-skip')
  await waitFor(async () => !(await welcomeShown(ui)), 'the welcome to close')
  await waitFor(() => jb.readJson('settings.json').welcomed === true, 'welcomed in settings.json')
  const s = await jb.state()
  assert.deepEqual(s.prefs, before)
  assert.equal(s.pinned, true)

  await jb.quit()
  jb = await launch({ userData })
  running.push(jb)
  const again = await jb.ui()
  // The UI has had any welcome main was going to send.
  await settle(jb)
  assert.equal(await welcomeShown(again), false)
})

test('going through the welcome applies its choices, and ethereal unpins the window', async () => {
  const jb = await firstLaunch()
  const ui = await jb.ui()
  await waitFor(() => welcomeShown(ui), 'the welcome')
  const toastsBefore = (await jb.toasts()).length

  await click(ui, 'wl-next')
  await waitFor(async () => /Pinned or ethereal/.test(await stepLabel(ui)), 'the mode step')
  await click(ui, 'wl-mode-ethereal')
  await waitFor(() => ui.eval('document.getElementById("wl-mode-ethereal").getAttribute("aria-pressed") === "true"'), 'ethereal picked')
  // Pinning waits for the end.
  assert.equal((await jb.state()).pinned, true)

  for (let guard = 0; !/Look/.test(await stepLabel(ui)) && guard < 5; guard++) await click(ui, 'wl-next')
  assert.match(await stepLabel(ui), /Look/)
  await click(ui, 'wl-theme-rose')
  await jb.waitForState((s) => s.prefs.theme === 'rose', 'the rose theme')
  assert.equal(await ui.eval('document.documentElement.dataset.theme'), 'rose')
  await waitFor(() => jb.readJson('settings.json').theme === 'rose', 'settings.json to have the theme')

  for (let guard = 0; !/Tabs and links/.test(await stepLabel(ui)) && guard < 5; guard++) await click(ui, 'wl-next')
  assert.match(await stepLabel(ui), /Tabs and links/)
  await click(ui, 'wl-new-tabs-at-bottom')
  await jb.waitForState((s) => s.prefs.newTabsAt === 'bottom', 'new tabs at the bottom')
  await waitFor(() => jb.readJson('settings.json').newTabsAt === 'bottom', 'settings.json to have newTabsAt')

  await click(ui, 'wl-next')
  await waitFor(async () => /Address bar/.test(await stepLabel(ui)), 'the address bar step')
  assert.equal(await ui.eval('document.getElementById("wl-urlbar-columns").getAttribute("aria-pressed")'), 'true')
  await click(ui, 'wl-urlbar-preview')
  await jb.waitForState((s) => s.prefs.urlBarStyle === 'preview', 'the preview layout')
  await waitFor(() => jb.readJson('settings.json').urlBarStyle === 'preview', 'settings.json to have urlBarStyle')

  for (let guard = 0; !/Ready/.test(await stepLabel(ui)) && guard < 8; guard++) await click(ui, 'wl-next')
  assert.match(await stepLabel(ui), /Ready/)
  assert.match(await ui.eval('document.getElementById("wl-next").textContent'), /Start browsing/)
  await click(ui, 'wl-next')

  await waitFor(async () => !(await welcomeShown(ui)), 'the welcome to close')
  await jb.waitForState((s) => s.pinned === false, 'the window unpinned')
  await waitFor(() => {
    const file = jb.readJson('settings.json')
    return file.welcomed === true && file.pinned === false
  }, 'settings.json to have welcomed and pinned')
  const toast = await waitFor(async () => (await jb.toasts()).slice(toastsBefore).find((t) => /hides when you click another app/.test(String(t))), 'the toast')
  assert.match(String(toast), /brings it back/)
})

test("'welcome-done' from a second welcome leaves welcomed alone and can pin again", async () => {
  const jb = await launch({ settings: { ...offline(), pinned: false } })
  running.push(jb)
  assert.equal((await jb.state()).pinned, false)
  await jb.send('welcome-done', { pinned: true })
  await jb.waitForState((s) => s.pinned, 'pinned again')
  await waitFor(() => jb.readJson('settings.json').pinned === true, 'settings.json to have it')
  assert.equal(jb.readJson('settings.json').welcomed, true)
})
