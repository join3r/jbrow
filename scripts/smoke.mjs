// Starts a packaged jbrow and waits for its UI to load, so a release build that can't even open
// never gets uploaded: `node scripts/smoke.mjs <path to the jbrow executable>`. Used by
// .github/workflows/release.yml on the build it's about to publish. Packaged builds refuse a
// debugging port, so this goes by jbrow's log. Errors logged on the way are shown, as warnings on
// GitHub, but only a jbrow that exits or never loads its UI fails.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const exe = process.argv[2]
const userData = mkdtempSync(path.join(tmpdir(), 'jbrow-smoke-'))
const log = path.join(userData, 'logs', 'main.log')
// CI runners can't give the packaged app's sandbox what it needs; the e2e tests do the same.
const args = ['--show', ...(process.platform === 'linux' ? ['--no-sandbox'] : [])]
const app = spawn(exe, args, { env: { ...process.env, JBROW_USER_DATA: userData, JBROW_BACKGROUND: '1' }, stdio: 'ignore' })
let exited = null
app.on('exit', (code, signal) => (exited = signal ?? code))

const lines = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n') : [])
let failure = 'jbrow’s UI didn’t load within a minute'
for (const deadline = Date.now() + 60_000; Date.now() < deadline; ) {
  await new Promise((r) => setTimeout(r, 1000))
  if (lines().some((line) => line.includes('[jbrow] UI loaded'))) {
    failure = null
    break
  }
  if (exited !== null) {
    failure = `jbrow exited (${exited}) before its UI loaded`
    break
  }
}
app.kill()
await new Promise((r) => setTimeout(r, 2000))

// Lines are "<time> <level> <message>".
for (const line of lines().filter((line) => line.split(' ')[1] === 'error')) {
  console.log(process.env.GITHUB_ACTIONS ? `::warning title=jbrow logged an error::${line}` : `smoke: logged ${line}`)
}
if (failure) console.log(lines().join('\n'))
console.log(failure ? `smoke: ${failure}` : 'smoke: jbrow started and its UI loaded')
rmSync(userData, { recursive: true, force: true, maxRetries: 5 })
process.exit(failure ? 1 : 0)
