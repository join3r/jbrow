import { app, nativeImage, type Session } from 'electron'
import { readdirSync, readFileSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import path from 'node:path'

/**
 * What jbrow reads straight from an extension's folder: its name in your language, its icon, the
 * newest installed version. Works for an extension that's turned off too, which Electron doesn't
 * know about, so it takes a folder and a manifest instead of an Electron.Extension.
 */
export interface ExtensionFolder {
  path: string
  manifest: Record<string, unknown>
}

export function readFolder(dir: string): ExtensionFolder | null {
  try {
    return { path: dir, manifest: JSON.parse(readFileSync(path.join(dir, 'manifest.json'), 'utf8')) }
  } catch {
    return null
  }
}

/** The extension's messages.json for your language, falling back to its default language. */
export function messages(ext: ExtensionFolder): Record<string, { message: string }> {
  const fallback = ext.manifest.default_locale as string | undefined
  const locale = app.getLocale().replace('-', '_')
  for (const lang of [locale, locale.split('_')[0], fallback]) {
    if (!lang) continue
    try {
      const raw = JSON.parse(readFileSync(path.join(ext.path, '_locales', lang, 'messages.json'), 'utf8'))
      return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v as { message: string }]))
    } catch {}
  }
  return {}
}

export const localize = (text: string, msgs: Record<string, { message: string }>) =>
  text.replace(/__MSG_(\w+)__/g, (m, key: string) => msgs[key.toLowerCase()]?.message ?? m)

/** "Bitwarden" rather than "__MSG_extName__". */
export function localizedName(ext: ExtensionFolder): string {
  const name = String(ext.manifest.name ?? '')
  return name.includes('__MSG_') ? localize(name, messages(ext)) : name
}

const icons = new Map<string, string | undefined>()
/** The extension's icon as a 32px data URL. */
export function iconOf(ext: ExtensionFolder): string | undefined {
  if (icons.has(ext.path)) return icons.get(ext.path)
  const list = (ext.manifest.icons as Record<string, string> | undefined) ?? {}
  const size = Object.keys(list).map(Number).sort((a, b) => Math.abs(a - 32) - Math.abs(b - 32))[0]
  let url: string | undefined
  if (size) {
    const img = nativeImage.createFromPath(path.join(ext.path, list[size]))
    if (!img.isEmpty()) url = img.resize({ width: 32, height: 32 }).toDataURL()
  }
  icons.set(ext.path, url)
  return url
}

const newer = (a: string, b: string) => {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0)
  return false
}

/**
 * Web Store extensions in a profile's folder, each as its newest version, by ID. They sit at
 * `<id>/<version>_0`; an update leaves the old version next to the new one until it's cleaned up.
 */
export function installedFolders(extensionsPath: string): Map<string, ExtensionFolder> {
  const found = new Map<string, ExtensionFolder>()
  let ids: string[] = []
  try {
    ids = readdirSync(extensionsPath)
  } catch {}
  for (const id of ids) {
    if (!/^[a-p]{32}$/.test(id)) continue
    let versions: string[] = []
    try {
      versions = readdirSync(path.join(extensionsPath, id))
    } catch {}
    for (const v of versions) {
      const ext = readFolder(path.join(extensionsPath, id, v))
      const best = found.get(id)
      if (ext && (!best || newer(String(ext.manifest.version), String(best.manifest.version)))) found.set(id, ext)
    }
  }
  return found
}

/**
 * Erases what an extension stored, as Chrome does when you remove one: chrome.storage and the
 * IndexedDB, local storage and cookies of its chrome-extension:// origin.
 */
export async function eraseExtensionData(sess: Session, id: string) {
  await sess.clearData({ origins: [`chrome-extension://${id}`] }).catch((error) => console.error(`[extensions] could not clear ${id}'s data:`, error))
  const dir = sess.getStoragePath()
  if (!dir) return
  for (const store of ['Local Extension Settings', 'Sync Extension Settings', 'Managed Extension Settings']) {
    await rm(path.join(dir, store, id), { recursive: true, force: true }).catch(() => {})
  }
}
