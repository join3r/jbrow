import { execFile } from 'node:child_process'

export interface FrontApp {
  name: string
  bundleId: string
  pid: number
}

function run(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/lsappinfo', args, { timeout: 500 }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
  })
}

/**
 * The app macOS considers frontmost, via the lsappinfo tool that ships with macOS.
 * Takes about 10 ms and needs no permissions. Call it before showing the panel.
 */
export async function frontmostApp(): Promise<FrontApp | null> {
  try {
    const asn = (await run(['front'])).trim()
    if (!asn) return null
    const out = await run(['info', '-only', 'name', '-only', 'bundleID', '-only', 'pid', asn])
    const name = /^"([^"]*)"/m.exec(out)?.[1] ?? ''
    const bundleId = /bundleID="([^"]*)"/.exec(out)?.[1] ?? ''
    const pid = Number(/pid = (\d+)/.exec(out)?.[1] ?? 0)
    return bundleId ? { name, bundleId, pid } : null
  } catch (error) {
    console.error('[frontmost] lsappinfo failed:', error)
    return null
  }
}
