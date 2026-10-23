import { app } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Profile } from '../shared/types'

export type AnimationStyle = 'materialize' | 'slide' | 'scale' | 'fade' | 'off'
export type AnimationEase = 'spring' | 'snappy' | 'smooth'

export interface Settings {
  hotkeys: { all: string; app: string }
  profiles: Profile[]
  /** Profile used when nothing else decides. */
  defaultProfile: string
  /** Default profile per app, keyed by bundle ID. Used for links from and new tabs in that app's view. */
  appProfiles: Record<string, string>
  /** Groups of bundle IDs that share one set of tabs for the app hotkey. An app belongs to at most one group. */
  linkedApps: string[][]
  animation: { style: AnimationStyle; durationMs: number; ease: AnimationEase }
  /** %s is replaced by the encoded query. */
  searchUrl: string
  /** Unpacked extension folders to load, per profile ID. */
  unpackedExtensions: Record<string, string[]>
  /** Panel size as a fraction of the display's work area. */
  panel: { widthFraction: number; heightFraction: number }
  /** Keep jbrow out of screen shares and screenshots. */
  hideFromScreenCapture: boolean
  /** Addresses matching these show as "Private" in the address bar until clicked. `*` matches anything. */
  privateUrls: string[]
  /** Threads unseen this many days unload their pages and show as a one-line summary, unless kept. 0 never does. */
  summarizeAfterDays: number
  /** Threads unseen this many days are archived, unless kept or caught by a folder's rules. 0 never archives. */
  archiveAfterDays: number
  /** Extension IDs shown as buttons in the toolbar, in this order, whenever the current profile has them. */
  pinnedExtensions: string[]
  /** Your extension shortcuts, per profile, extension ID and command: Electron accelerators, '' for none. Unlisted commands use the extension's suggestion. */
  extensionShortcuts: Record<string, Record<string, Record<string, string>>>
}

const DEFAULTS: Settings = {
  hotkeys: { all: 'Alt+Space', app: 'Alt+Shift+Space' },
  profiles: [
    { id: 'work', name: 'Work', color: '#2f9aab' },
    { id: 'personal', name: 'Personal', color: '#d0679a' },
  ],
  defaultProfile: 'personal',
  appProfiles: {
    'com.tinyspeck.slackmacgap': 'work',
    'com.microsoft.teams2': 'work',
  },
  linkedApps: [['com.microsoft.VSCode', 'com.apple.Terminal']],
  animation: { style: 'materialize', durationMs: 180, ease: 'spring' },
  searchUrl: 'https://www.google.com/search?q=%s',
  unpackedExtensions: {},
  panel: { widthFraction: 0.72, heightFraction: 0.78 },
  hideFromScreenCapture: true,
  privateUrls: [],
  summarizeAfterDays: 3,
  archiveAfterDays: 7,
  pinnedExtensions: [],
  extensionShortcuts: {},
}

export const settingsPath = () => path.join(app.getPath('userData'), 'settings.json')

/** Reads settings.json, writing the defaults on first run. Missing keys fall back to defaults. */
export function loadSettings(): Settings {
  const file = settingsPath()
  if (!existsSync(file)) {
    writeFileSync(file, JSON.stringify(DEFAULTS, null, 2))
    return structuredClone(DEFAULTS)
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Settings>
    return { ...structuredClone(DEFAULTS), ...parsed }
  } catch (error) {
    console.error(`[settings] ${file} is not valid JSON, using defaults:`, error)
    return structuredClone(DEFAULTS)
  }
}

/** Writes settings back to settings.json, for changes made in the settings screen. */
export function saveSettings(settings: Settings) {
  writeFileSync(settingsPath(), JSON.stringify(settings, null, 2))
}

/** The scope key for an app: its linked group if it has one, otherwise its own bundle ID. */
export function scopeForApp(settings: Settings, bundleId: string): string {
  const group = settings.linkedApps.find((g) => g.includes(bundleId))
  return group ? group.slice().sort().join('+') : bundleId
}
