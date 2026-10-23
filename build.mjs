import { build } from 'esbuild'
import { cp, mkdir } from 'node:fs/promises'

const common = { bundle: true, sourcemap: true, logLevel: 'info', target: 'es2023' }

await mkdir('dist/ui', { recursive: true })

await Promise.all([
  // Main process. Electron and the extension libraries stay external so their
  // own preload scripts resolve from node_modules.
  build({
    ...common,
    entryPoints: ['src/main/index.ts'],
    outfile: 'dist/main.js',
    platform: 'node',
    format: 'cjs',
    external: ['electron', 'electron-chrome-extensions', 'electron-chrome-web-store'],
  }),
  // Preload for jbrow's own UI. Sandboxed preloads can't require npm modules,
  // so everything (including the browser-action element) is bundled in.
  build({
    ...common,
    entryPoints: ['src/preload/ui.ts'],
    outfile: 'dist/preload-ui.js',
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  }),
  // Runs in extension service workers and pages to patch missing Chrome APIs.
  build({
    ...common,
    entryPoints: ['src/preload/extension-shims.ts'],
    outfile: 'dist/preload-extension-shims.js',
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  }),
  // Two-finger swipe back and forward, in every tab page's isolated preload world.
  build({
    ...common,
    entryPoints: ['src/preload/swipe.ts'],
    outfile: 'dist/preload-swipe.js',
    platform: 'node',
    format: 'cjs',
    external: ['electron'],
  }),
  build({
    ...common,
    entryPoints: ['src/ui/ui.ts'],
    outfile: 'dist/ui/ui.js',
    platform: 'browser',
    format: 'iife',
  }),
])

await cp('src/ui/index.html', 'dist/ui/index.html')
await cp('src/ui/ui.css', 'dist/ui/ui.css')

