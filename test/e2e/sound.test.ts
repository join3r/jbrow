// Tabs playing sound: the sidebar and the toolbar say which, and a click mutes one or goes there.
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { html, launch, serve, waitFor, type Jbrow, type TestServer } from './harness'
import { activate, offline, openTab, tabById } from './tab-helpers'

let jb: Jbrow
let web: TestServer

before(async () => {
  web = await serve({
    // A tone too quiet to hear, but loud enough for Chromium to count the page as audible.
    '/tone': html(
      'Tone',
      `<script>
        const ctx = new AudioContext()
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        gain.gain.value = 0.002
        osc.connect(gain).connect(ctx.destination)
        osc.start()
      </script>`,
    ),
    '/quiet': html('Quiet'),
  })
  jb = await launch({ settings: offline(web) })
})
after(async () => {
  await jb?.close()
  await web?.close()
})

test('a tab playing sound shows a speaker, in its row and the toolbar, that mutes it or goes to it', async () => {
  const tone = await openTab(jb, `${web.url}/tone`)
  await jb.waitForState((s) => tabById(s, tone.id)?.audible, 'the tab to be audible')
  const quiet = await openTab(jb, `${web.url}/quiet`)
  await activate(jb, quiet.id)

  const ui = await jb.ui()
  await waitFor(() => ui.eval<boolean>(`!document.getElementById('sound').hidden`), 'the toolbar speaker')
  assert.equal(await ui.eval(`document.querySelectorAll('#threads .row .snd').length`), 1)
  assert.equal(await ui.eval(`document.querySelector('#threads .row .snd').dataset.mute`), tone.id)

  // The toolbar lists it, and takes you there.
  await ui.clickOn('#soundButton')
  await waitFor(() => ui.eval<boolean>(`!document.getElementById('soundPop').hidden`), 'the sound list')
  assert.equal(await ui.eval(`document.querySelector('#soundList [data-go]').dataset.go`), tone.id)
  await ui.clickOn('#soundList [data-go]')
  await jb.waitForState((s) => s.activeId === tone.id, 'the playing tab to be active')
  assert.equal(await ui.eval(`document.getElementById('soundPop').hidden`), true)

  // Its row's speaker mutes it; muted, nothing is heard, so the toolbar's speaker goes.
  await ui.clickOn('#threads .row .snd')
  await jb.waitForState((s) => tabById(s, tone.id)?.muted, 'the tab to be muted')
  await waitFor(() => ui.eval<boolean>(`document.getElementById('sound').hidden`), 'the toolbar speaker to go')
  assert.equal(await ui.eval(`document.querySelector('#threads .row .snd').classList.contains('muted')`), true)

  // And again unmutes it.
  await ui.clickOn('#threads .row .snd')
  await jb.waitForState((s) => !tabById(s, tone.id)?.muted, 'the tab to be unmuted')
  await waitFor(() => ui.eval<boolean>(`!document.getElementById('sound').hidden`), 'the toolbar speaker back')
  await jb.send('mute', { id: tone.id, muted: true })
})

test('the toolbar speaker stays a while after the sound stops, to go to what played', async () => {
  // Another tone than the first test's, which plays on muted.
  const tone = await openTab(jb, `${web.url}/tone?again`)
  await jb.waitForState((s) => tabById(s, tone.id)?.audible, 'the tab to be audible')
  const quiet = await openTab(jb, `${web.url}/quiet`)
  await activate(jb, quiet.id)
  const ui = await jb.ui()
  await waitFor(() => ui.eval<boolean>(`!document.getElementById('sound').hidden`), 'the toolbar speaker')

  const page = await jb.page(`${web.url}/tone?again`)
  await page.eval('osc.stop()')
  page.close()
  await jb.waitForState((s) => !tabById(s, tone.id)?.audible, 'the tab to go quiet')
  // Still there, saying what played, and its list still takes you there.
  assert.equal(await ui.eval(`document.getElementById('sound').hidden`), false)
  assert.equal(await ui.eval(`document.getElementById('soundButton').title`), 'Played sound: Tone')
  await ui.clickOn('#soundButton')
  await waitFor(() => ui.eval<boolean>(`!document.getElementById('soundPop').hidden`), 'the sound list')
  assert.equal(await ui.eval(`document.querySelector('#soundList .sound-item.quiet [data-go]')?.dataset.go`), tone.id)
  await ui.clickOn('#soundList .quiet [data-go]')
  await jb.waitForState((s) => s.activeId === tone.id, 'the tab that played to be active')
  // And goes a little later.
  await waitFor(() => ui.eval<boolean>(`document.getElementById('sound').hidden`), 'the toolbar speaker to go')
})
