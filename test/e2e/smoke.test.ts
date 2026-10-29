import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { html, launch, serve, type Jbrow, type TestServer } from './harness'

let jb: Jbrow
let web: TestServer

before(async () => {
  web = await serve({ '/': html('Hello jbrow', '<h1>hi</h1>') })
  jb = await launch()
})
after(async () => {
  await jb?.close()
  await web?.close()
})

test('starts with a state for the UI', async () => {
  const s = await jb.state()
  assert.ok(s.profiles.length >= 1)
  assert.ok(Array.isArray(s.tabs))
})

test('opens a page and picks up its title', async () => {
  await jb.navigate(web.url + '/', { newTab: true })
  const s = await jb.waitForState((s) => s.tabs.some((t) => t.title === 'Hello jbrow'), 'the title')
  assert.equal(s.tabs.find((t) => t.id === s.activeId)?.title, 'Hello jbrow')
  const page = await jb.page(web.url)
  assert.equal(await page.eval('document.querySelector("h1").textContent'), 'hi')
})
