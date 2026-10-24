import { app } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

/**
 * jbrow's own extension, loaded into every profile. It holds the request rewrites jbrow itself
 * needs, as declarativeNetRequest rules.
 *
 * jbrow can't use session.webRequest for these: once a session has any webRequest listener,
 * Electron sends every request through its own proxy and Chromium's extension request handling
 * never sees it, so no extension's declarativeNetRequest rules apply (no blocking in uBlock Origin
 * Lite, no header rewriting in SideHN). As rules, jbrow's rewrites go through the same code as
 * every extension's.
 */
const ALL_TYPES = [
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object', 'xmlhttprequest',
  'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other',
]

/**
 * Writes the extension into userData and returns its folder. `electronUserAgent` is the session's
 * own user agent, before jbrow makes it look like Chrome.
 */
export function writeJbrowExtension(electronUserAgent: string): string {
  const dir = path.join(app.getPath('userData'), 'jbrow-extension')
  const rules = [
    // Google sign-in rejects a browser that claims to be Chrome but doesn't behave like it
    // ("This browser or app may not be secure"). Told the truth, it serves its lighter sign-in
    // flow, which works. Pages still see the Chrome user agent in navigator.userAgent.
    {
      id: 1,
      priority: 1,
      action: { type: 'modifyHeaders', requestHeaders: [{ header: 'User-Agent', operation: 'set', value: electronUserAgent }] },
      condition: { urlFilter: '|https://accounts.google.com/', resourceTypes: ALL_TYPES },
    },
  ]
  const files: Record<string, string> = {
    'manifest.json': JSON.stringify(
      {
        manifest_version: 3,
        name: 'jbrow',
        version: '1.0',
        description: "jbrow's own request rules.",
        background: { service_worker: 'worker.js' },
        permissions: ['declarativeNetRequest'],
        // Chromium only lets a rule change a request when the extension may access both the URL and
        // the page that sent it, so accounts.google.com alone would miss requests from other sites.
        host_permissions: ['<all_urls>'],
      },
      null,
      2,
    ),
    // Dynamic rules outlast a restart, so they hold even on a launch where the worker is slow to
    // start. It sets them again whenever it runs, which brings in a new user agent after updates.
    'worker.js': `// Written by jbrow on every launch.
const rules = ${JSON.stringify(rules)}
chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: rules.map((r) => r.id), addRules: rules })
`,
  }
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(dir, name)
    let current: string | undefined
    try {
      current = readFileSync(file, 'utf8')
    } catch {}
    if (current !== content) writeFileSync(file, content)
  }
  return dir
}
