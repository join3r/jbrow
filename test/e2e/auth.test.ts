// HTTP basic auth (state.login, answered with 'login') and the warning for plain http from
// another machine (state.insecure).
import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { html, launch, serve, waitFor, type Jbrow, type TestServer } from './harness'
import { activeTab, isShown, offline, openTab } from './ui-helpers'

let jb: Jbrow
let web: TestServer

const GOOD = `Basic ${Buffer.from('ada:lovelace').toString('base64')}`

before(async () => {
  web = await serve({
    '/secret': (req, res) => {
      if (req.headers.authorization === GOOD) {
        res.writeHead(200, { 'content-type': 'text/html' }).end(html('Secret page', '<p>in</p>'))
      } else {
        res.writeHead(401, { 'content-type': 'text/html', 'www-authenticate': 'Basic realm="Test realm"' }).end(html('Denied'))
      }
    },
    '/plain': html('Plain'),
  })
  // Made-up hosts for the test server: one that counts as another machine, one under .localhost.
  jb = await launch({ settings: offline(web), args: ['--host-resolver-rules=MAP far.test 127.0.0.1, MAP app.localhost 127.0.0.1'] })
})
after(async () => {
  await jb?.close()
  await web?.close()
})

const host = () => new URL(web.url).host

/** Opens /secret on a new tab and waits for the question. */
async function ask(path = '/secret') {
  await jb.send('new')
  await jb.waitForState((s) => !!activeTab(s) && !activeTab(s)!.url, 'an empty tab')
  await jb.send('navigate', { input: `${web.url}${path}` })
  return jb.waitForState((s) => !!s.login, 'the sign-in question')
}

test('a 401 with WWW-Authenticate asks for a username and password', async () => {
  const s = await ask()
  assert.deepEqual({ ...s.login, id: 0 }, { id: 0, host: host(), realm: 'Test realm', proxy: false, retry: false })
  // jbrow's own form covers the page.
  const ui = await jb.ui()
  await waitFor(() => isShown(ui, 'loginWarn'), 'the sign-in form')
  assert.match(await ui.eval('document.getElementById("loginText").textContent'), /Test realm/)

  // A wrong password asks again, saying so.
  await jb.send('login', { id: s.login!.id, username: 'ada', password: 'wrong' })
  const again = await jb.waitForState((x) => !!x.login && x.login.id !== s.login!.id, 'the question again')
  assert.equal(again.login!.retry, true)
  await waitFor(async () => !(await ui.eval('document.getElementById("loginError").hidden')), 'the error line')

  await jb.send('login', { id: again.login!.id, username: 'ada', password: 'lovelace' })
  const done = await jb.waitForState((x) => !x.login && activeTab(x)?.title === 'Secret page', 'the secret page')
  assert.equal(activeTab(done)!.url, `${web.url}/secret`)
  await waitFor(async () => !(await isShown(ui, 'loginWarn')), 'the form to go')
})

test('an answer to an older question is ignored', async () => {
  // Signed in above; Chromium remembers that until jbrow quits, so use another realm's page.
  web.route('/secret2', (req, res) => {
    res.writeHead(401, { 'content-type': 'text/html', 'www-authenticate': 'Basic realm="Other realm"' }).end(html('Denied 2'))
  })
  const s = await ask('/secret2')
  await jb.send('login', { id: s.login!.id + 1000, username: 'x', password: 'y' })
  // Then cancel it. Had the stale answer gone through, the server would have asked again with a
  // new question, which this cancel (for the old one) wouldn't answer.
  await jb.send('login', { id: s.login!.id })
  const after = await jb.waitForState((x) => !x.login && activeTab(x)?.title === 'Denied 2', 'the page the server sent with its 401')
  assert.equal(after.login, null)
})

test('the form in the UI signs in', async () => {
  web.route('/secret3', (req, res) => {
    if (req.headers.authorization === `Basic ${Buffer.from('grace:hopper').toString('base64')}`) {
      res.writeHead(200, { 'content-type': 'text/html' }).end(html('Third secret'))
    } else res.writeHead(401, { 'www-authenticate': 'Basic realm="Third realm"' }).end()
  })
  await ask('/secret3')
  const ui = await jb.ui()
  await waitFor(() => isShown(ui, 'loginWarn'), 'the sign-in form')
  await ui.eval(`(() => {
    document.getElementById('loginUser').value = 'grace'
    document.getElementById('loginPass').value = 'hopper'
    document.getElementById('loginForm').requestSubmit()
  })()`)
  await jb.waitForState((s) => !s.login && activeTab(s)?.title === 'Third secret', 'the third secret page')
})

test('Cancel in the UI cancels the sign-in', async () => {
  web.route('/secret4', (_req, res) => {
    res.writeHead(401, { 'content-type': 'text/html', 'www-authenticate': 'Basic realm="Fourth realm"' }).end(html('Denied 4'))
  })
  await ask('/secret4')
  const ui = await jb.ui()
  await waitFor(() => isShown(ui, 'loginWarn'), 'the sign-in form')
  await ui.eval('document.getElementById("loginCancel").click()')
  await jb.waitForState((s) => !s.login && activeTab(s)?.title === 'Denied 4', 'the 401 page')
})

test('plain http is insecure only from another machine', async () => {
  const port = new URL(web.url).port
  let t = await openTab(jb, `${web.url}/plain`)
  assert.equal((await jb.state()).insecure, false, '127.0.0.1 is this machine')
  t = await openTab(jb, `http://app.localhost:${port}/plain`)
  assert.equal(t.title, 'Plain')
  assert.equal((await jb.state()).insecure, false, '*.localhost is this machine')
  await openTab(jb, `http://far.test:${port}/plain`)
  const s = await jb.waitForState((s) => activeTab(s)?.title === 'Plain' && s.insecure, 'far.test to be insecure')
  assert.equal(s.insecure, true)
  // Going back to a tab on this machine clears it.
  await jb.send('activate', { id: t.id })
  await jb.waitForState((s) => s.activeId === t.id && !s.insecure, 'insecure to clear')
})
