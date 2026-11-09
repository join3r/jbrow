// A page that fails to load shows what went wrong, not an empty white tab.
import assert from 'node:assert/strict'
import { createServer, type AddressInfo, type Server } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { after, before, test } from 'node:test'
import { html, launch, serve, waitFor, type Jbrow, type TestServer } from './harness'
import { activeTab, offline } from './tab-helpers'

let jb: Jbrow
let web: TestServer

before(async () => {
  web = await serve({})
  jb = await launch({ settings: offline(web) })
})
after(async () => {
  await jb?.close()
  await web?.close()
})

/** A port with nothing on it. */
async function freePort(): Promise<number> {
  const s: Server = createServer()
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r))
  const port = (s.address() as AddressInfo).port
  await new Promise<void>((r) => s.close(() => r()))
  return port
}

test('a refused connection shows an error page, and Try again loads the site once it answers', async () => {
  const port = await freePort()
  const address = `http://127.0.0.1:${port}/`
  await jb.send('new')
  await jb.waitForState((s) => activeTab(s) && !activeTab(s)!.url, 'an empty tab')
  await jb.send('navigate', { input: address })
  const page = await jb.page((t) => t.url === address)
  const heading = await waitFor(() => page.eval<string | null>('document.querySelector("[data-jbrow-error] h1")?.textContent ?? null'), 'the error page')
  assert.match(heading, /refused to connect/)
  assert.equal(await page.eval('document.querySelector("[data-act=settings]")'), null, 'no Local Network button for this computer')

  const site = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html('Back up'))
  })
  await new Promise<void>((r) => site.listen(port, '127.0.0.1', r))
  try {
    // Later, not in the eval: the click navigates, which would close the eval's page under it.
    await page.eval('setTimeout(() => document.querySelector("[data-act=reload]").click(), 10), 1')
    await jb.waitForState((s) => activeTab(s)?.title === 'Back up', 'the site after Try again')
  } finally {
    // An open keep-alive connection would keep close() waiting for ever.
    site.closeAllConnections()
    await new Promise<void>((r) => site.close(() => r()))
  }
})
