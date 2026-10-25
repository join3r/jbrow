// Runs jbrow's tests. Each test file is bundled with esbuild (the sources use extensionless
// imports Node can't resolve on its own) and handed to Node's own test runner.
//
//   node test/run.mjs                 unit and end-to-end tests
//   node test/run.mjs unit            unit tests only (no Electron needed)
//   node test/run.mjs e2e             end-to-end tests: launches the built app (npm run build first)
//   node test/run.mjs unit zoom       only files whose name contains "zoom"
//   node test/run.mjs --repeat 5      everything five times, to catch flaky tests
//
// Unit tests get test/mocks/electron.ts in place of Electron. End-to-end tests drive the real
// app over the Chrome DevTools Protocol (test/e2e/harness.ts).
import { build } from 'esbuild'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const out = path.join(root, '.test-build')

const args = process.argv.slice(2)
let repeat = 1
const words = []
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--repeat') repeat = Number(args[++i])
  else words.push(args[i])
}
const kinds = words.filter((w) => w === 'unit' || w === 'e2e')
const filters = words.filter((w) => w !== 'unit' && w !== 'e2e')
const selected = kinds.length ? kinds : ['unit', 'e2e']

const testsIn = (kind) =>
  readdirSync(path.join(root, 'test', kind))
    .filter((f) => f.endsWith('.test.ts') && (!filters.length || filters.some((w) => f.includes(w))))
    .map((f) => path.join(root, 'test', kind, f))

rmSync(out, { recursive: true, force: true })

const suites = []
for (const kind of selected) {
  const entryPoints = testsIn(kind)
  if (!entryPoints.length) continue
  if (kind === 'e2e' && !existsSync(path.join(root, 'dist', 'main.js'))) {
    console.error('test: dist/main.js is missing, run `npm run build` first')
    process.exit(1)
  }
  await build({
    entryPoints,
    outdir: path.join(out, kind),
    outExtension: { '.js': '.mjs' },
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    sourcemap: 'inline',
    logLevel: 'warning',
    // Bundled CommonJS dependencies may call require() for Node built-ins.
    banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
    alias: kind === 'unit' ? { electron: path.join(root, 'test', 'mocks', 'electron.ts') } : {},
    external: kind === 'e2e' ? ['electron'] : [],
  })
  const files = readdirSync(path.join(out, kind)).filter((f) => f.endsWith('.mjs')).map((f) => path.join(out, kind, f))
  suites.push({ kind, files })
}

if (!suites.length) {
  console.error('test: no test files matched')
  process.exit(1)
}

let failed = false
for (let run = 1; run <= repeat; run++) {
  for (const { kind, files } of suites) {
    if (repeat > 1) console.log(`\n=== ${kind}, run ${run} of ${repeat} ===`)
    const result = spawnSync(
      process.execPath,
      [
        '--enable-source-maps',
        '--test',
        // Each end-to-end file launches its own jbrow; a few at a time keeps a CI runner responsive.
        `--test-concurrency=${kind === 'e2e' ? (process.env.CI ? 2 : 3) : 8}`,
        `--test-timeout=${kind === 'e2e' ? 180_000 : 30_000}`,
        ...(process.env.CI ? ['--test-reporter=spec'] : []),
        ...files,
      ],
      { stdio: 'inherit', cwd: root, env: { ...process.env, JBROW_TEST_ROOT: root } },
    )
    if (result.status !== 0) failed = true
  }
}
process.exit(failed ? 1 : 0)
