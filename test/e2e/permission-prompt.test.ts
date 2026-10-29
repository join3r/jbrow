import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { html, launch, serve, sleep, waitFor, type Cdp, type Jbrow, type TestServer } from './harness'

let jb: Jbrow
let web: TestServer

before(async () => {
  web = await serve({ '/': html('Asks', '<button id="b" onclick="window.clicked = (window.clicked || 0) + 1">b</button>'), '/next': html('Next') })
  jb = await launch()
})
after(async () => {
  await jb?.close()
  await web?.close()
})

const isPrompt = (url: string) => /\/dist\/ui\/permission-prompt\.html/.test(url.replace(/\\/g, '/'))

/** The prompt's page, once it shows a question. */
async function prompt(): Promise<Cdp> {
  const target = await waitFor(async () => (await jb.targets()).find((t) => t.type === 'page' && isPrompt(t.url)), 'the permission prompt')
  const cdp = await jb.page((t) => t.id === target.id)
  await waitFor(() => cdp.eval('!document.getElementById("card").hidden && document.visibilityState === "visible" && innerHeight < 200'), 'the question')
  return cdp
}

/** Every prompt is closed. */
const gone = () => waitFor(async () => !(await jb.targets()).some((t) => isPrompt(t.url)), 'the prompt to close')

test('asks under the address bar, leaves the page usable, and remembers Allow', async () => {
  await jb.navigate(web.url + '/', { newTab: true })
  const page = await jb.page(web.url)
  void page.eval('Notification.requestPermission().then((r) => (window.answer = r))')
  const p = await prompt()
  const host = new URL(web.url).host
  assert.equal(await p.eval('document.getElementById("text").textContent'), `${host} wants to show notifications`)
  // A card, not a sheet over the whole page.
  const [w, h] = await p.eval<[number, number]>('[innerWidth, innerHeight]')
  const [pw, ph] = await page.eval<[number, number]>('[innerWidth, innerHeight]')
  assert.ok(w <= 340 && w < pw, `prompt is ${w} wide in a ${pw} page`)
  assert.ok(h < 200 && h < ph, `prompt is ${h} tall in a ${ph} page`)
  // The page keeps working while it waits.
  await page.clickOn('#b')
  assert.equal(await page.eval('window.clicked'), 1)
  assert.equal(await page.eval('window.answer'), undefined)
  // A click the moment it shows doesn't count; it has to have been on screen a little while.
  await sleep(700)
  await p.clickOn('#allow')
  assert.equal(await waitFor(() => page.eval('window.answer'), 'the answer'), 'granted')
  await gone()
  // Remembered: no second question.
  assert.equal(await page.eval('Notification.requestPermission()'), 'granted')
})

test('closing it refuses once, and the site can ask again', async () => {
  await jb.navigate(web.url + '/', { newTab: true })
  const page = await jb.page(web.url)
  void page.eval('navigator.geolocation.getCurrentPosition(() => (window.geo = "ok"), (e) => (window.geo = e.code))')
  let p = await prompt()
  await sleep(700)
  await p.clickOn('#dismiss')
  assert.equal(await waitFor(() => page.eval('window.geo'), 'the refusal'), 1)
  await gone()
  void page.eval('navigator.geolocation.getCurrentPosition(() => (window.geo2 = "ok"), (e) => (window.geo2 = e.code))')
  p = await prompt()
  // Leaving the page takes the question with it.
  await page.eval(`location.href = ${JSON.stringify(web.url + '/next')}`)
  await gone()
})
