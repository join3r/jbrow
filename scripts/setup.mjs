// Gets a fresh checkout or worktree ready to run, then builds. Worktrees don't
// share node_modules with the main checkout, and npm skips packages' install
// scripts unless they're approved, so Electron's binary never downloads on its own.
// Installing is skipped when node_modules already matches package-lock.json.
import { execSync } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'

const run = (cmd) => execSync(cmd, { stdio: 'inherit' })
const installed = 'node_modules/.package-lock.json'

if (!existsSync(installed) || statSync('package-lock.json').mtimeMs > statSync(installed).mtimeMs) {
  console.log('setup: installing packages')
  run('npm ci')
}

if (!existsSync('node_modules/electron/path.txt')) {
  console.log('setup: downloading the Electron binary')
  run('node node_modules/electron/install.js')
}

run('npm run build')
