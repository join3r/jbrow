import { nativeImage } from 'electron'
import { execFile } from 'node:child_process'
import path from 'node:path'

export interface AppInfo {
  name: string
  icon?: string
}

function run(file: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 2000 }, (error, stdout) => (error ? reject(error) : resolve(stdout)))
  })
}

/** Bundle IDs are letters, digits, dots and hyphens; anything else stays out of the Spotlight query. */
const validBundleId = (id: string) => /^[\w.-]+$/.test(id)

/** The bundle ID of an app bundle, from its Info.plist. */
export async function bundleIdOf(appPath: string): Promise<string | null> {
  try {
    const id = (await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', '-o', '-', path.join(appPath, 'Contents', 'Info.plist')])).trim()
    return validBundleId(id) ? id : null
  } catch {
    return null
  }
}

/**
 * Names and icons of apps by bundle ID, found with Spotlight and cached. Lookups run in the
 * background; `onUpdate` fires when one finishes, so callers show the fallback name meanwhile.
 */
export class AppDirectory {
  private known = new Map<string, AppInfo>()
  private pending = new Set<string>()
  /** Names the app hotkey saw, which are what the app calls itself. */
  private seen = new Map<string, string>()

  constructor(private onUpdate: () => void) {}

  /** Remembers the name of an app seen in front. */
  note(bundleId: string, name: string, appPath?: string) {
    if (name && this.seen.get(bundleId) !== name) {
      this.seen.set(bundleId, name)
      const info = this.known.get(bundleId)
      if (info) info.name = name
    }
    this.lookup(bundleId, appPath)
  }

  name(bundleId: string): string {
    return this.seen.get(bundleId) ?? this.known.get(bundleId)?.name ?? bundleId.split('.').pop() ?? bundleId
  }

  icon(bundleId: string): string | undefined {
    this.lookup(bundleId)
    return this.known.get(bundleId)?.icon
  }

  private lookup(bundleId: string, appPath?: string) {
    if (this.known.has(bundleId) || this.pending.has(bundleId) || !validBundleId(bundleId)) return
    this.pending.add(bundleId)
    void this.find(bundleId, appPath).then((info) => {
      this.pending.delete(bundleId)
      this.known.set(bundleId, info)
      this.onUpdate()
    })
  }

  private async find(bundleId: string, appPath?: string): Promise<AppInfo> {
    const fallback = this.name(bundleId)
    try {
      const where = appPath ?? (await run('/usr/bin/mdfind', [`kMDItemCFBundleIdentifier == "${bundleId}"`])).split('\n').find((l) => l.endsWith('.app'))
      if (!where) return { name: fallback }
      const name = this.seen.get(bundleId) ?? path.basename(where, '.app')
      // app.getFileIcon gives a generic icon for an app bundle; Quick Look's thumbnail is the real one.
      const image = await nativeImage.createThumbnailFromPath(where, { width: 64, height: 64 })
      return { name, icon: image.isEmpty() ? undefined : image.toDataURL() }
    } catch (error) {
      console.error(`[apps] could not look up ${bundleId}:`, error)
      return { name: fallback }
    }
  }
}
