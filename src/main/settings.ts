import { app, type Rectangle } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { ActionId } from '../shared/shortcuts'
import { THEMES, type Appearance, type KeepLoaded, type MiniPlayerPrefs, type Profile, type ProfileStyle, type RestyleAgent, type ThemeId } from '../shared/types'

export type AnimationStyle = 'materialize' | 'slide' | 'scale' | 'fade' | 'off'
export type AnimationEase = 'spring' | 'snappy' | 'smooth'

export interface RestyleSettings {
  /** Which coding agent writes the stylesheets. */
  agent: RestyleAgent
  /** Claude model alias. */
  model: string
  /** Codex model; '' uses Codex's default. */
  codexModel: string
  /** The claude and codex commands; '' finds them. */
  claudePath: string
  codexPath: string
}

export interface Settings {
  /** Light, dark or following macOS. Websites get it as prefers-color-scheme too. */
  appearance: Appearance
  /** Color theme for jbrow's own screens. */
  theme: ThemeId
  /** How the address bar shows the tab's profile. */
  profileStyle: ProfileStyle
  /** Your keys for jbrow's own commands, as Electron accelerators, '' for none. Unlisted commands use their defaults (see ACTIONS). */
  shortcuts: Partial<Record<ActionId, string>>
  profiles: Profile[]
  /** Profile used when nothing else decides. */
  defaultProfile: string
  /** Default profile per app, keyed by bundle ID. Used for links from and new tabs in that app's view. */
  appProfiles: Record<string, string>
  /** Groups of bundle IDs that share one set of tabs for the app hotkey. An app belongs to at most one group. */
  linkedApps: string[][]
  animation: { style: AnimationStyle; durationMs: number; ease: AnimationEase }
  /** %s is replaced by the encoded query. Pick one under General in settings, or any address with %s. */
  searchUrl: string
  /** Ask the search engine for suggestions as you type in the address bar. Never for addresses or private ones. */
  searchSuggestions: boolean
  /** Unpacked extension folders to load, per profile ID. */
  unpackedExtensions: Record<string, string[]>
  /**
   * Where the window goes. Until you move or resize it, it's this fraction of the display's work
   * area. `displays`: where you left the unpinned panel on each display, by display ID, relative to
   * that display's work area. `pinned`: where you left the pinned window, in screen coordinates.
   */
  panel: { widthFraction: number; heightFraction: number; displays: Record<string, Rectangle>; pinned: Rectangle | null }
  /** Keep jbrow out of screen shares and screenshots. */
  hideFromScreenCapture: boolean
  /** Warn before opening sites on the phishing and malware lists (see dangerous.ts). */
  dangerousSites: boolean
  /** Block third-party cookies in every profile. Read at launch (see third-party-cookies.ts). */
  blockThirdPartyCookies: boolean
  /** A regular window with a Dock icon that stays when you click away, shown at launch. Off, jbrow only appears on its hotkey. */
  pinned: boolean
  /** Links from other apps with no click or key press just before open in the background, counted in the menu bar. */
  quietLinks: boolean
  /** Addresses matching these show as "Private" in the address bar until clicked. `*` matches anything. */
  privateUrls: string[]
  /** Threads unseen this many days unload their pages and show as a one-line summary. Kept ones unload without the summary, unless `keepLoaded` says not to. 0 never does. */
  summarizeAfterDays: number
  /** Threads unseen this many days are archived, unless kept or caught by a folder's rules. 0 never archives. */
  archiveAfterDays: number
  /** Kept and pinned threads whose pages never unload. Pinned ones load at launch, so they're ready when clicked. */
  keepLoaded: KeepLoaded
  /** Threads unseen this many hours leave the top of the sidebar for Earlier at the bottom. */
  earlierAfterHours: number
  /** Extension IDs shown as buttons in the toolbar, in this order, whenever the current profile has them. */
  pinnedExtensions: string[]
  /** Rows the pinned tabs' icons share at the top of the sidebar. */
  pinnedRows: number
  /** Your extension shortcuts, per profile, extension ID and command: Electron accelerators, '' for none. Unlisted commands use the extension's suggestion. */
  extensionShortcuts: Record<string, Record<string, Record<string, string>>>
  /** Restyling sites with Claude Code or Codex. */
  restyle: RestyleSettings
  /** When a playing video moves into the picture-in-picture window. */
  miniPlayer: MiniPlayerPrefs
  /** Page zoom: the default in percent, and whether each site's zoom is kept across restarts (`sites`, hostname without www → percent). */
  zoom: { defaultPercent: number; remember: boolean; sites: Record<string, number> }
  /** Width of the extension side panel (chrome.sidePanel), in pixels. Drag its edge to change it. */
  sidePanelWidth: number
  /** The welcome has been through or skipped. Until then it shows at launch. */
  welcomed: boolean
}

const DEFAULTS: Settings = {
  appearance: 'system',
  theme: 'teal',
  profileStyle: 'tint',
  shortcuts: {},
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
  searchSuggestions: true,
  unpackedExtensions: {},
  panel: { widthFraction: 0.72, heightFraction: 0.78, displays: {}, pinned: null },
  hideFromScreenCapture: true,
  dangerousSites: true,
  blockThirdPartyCookies: true,
  pinned: true,
  quietLinks: true,
  privateUrls: [],
  summarizeAfterDays: 3,
  archiveAfterDays: 7,
  keepLoaded: { kept: false, pinned: true },
  earlierAfterHours: 12,
  pinnedExtensions: [],
  pinnedRows: 1,
  extensionShortcuts: {},
  restyle: { agent: 'claude', model: 'sonnet', codexModel: '', claudePath: '', codexPath: '' },
  miniPlayer: { onHide: true, onTabSwitch: false, mutedToo: false, sites: 'all', onlySites: [], exceptSites: [] },
  zoom: { defaultPercent: 100, remember: true, sites: {} },
  sidePanelWidth: 360,
  welcomed: false,
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
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Settings> & { hotkeys?: { all?: string; app?: string } }
    // Older settings kept the two summon keys under "hotkeys".
    const { hotkeys, ...rest } = parsed
    const settings = { ...structuredClone(DEFAULTS), ...rest }
    // Settings from before the welcome belong to someone who already knows jbrow.
    if (typeof rest.welcomed !== 'boolean') settings.welcomed = true
    // Older settings have fewer restyle keys.
    settings.restyle = { ...DEFAULTS.restyle, ...rest.restyle }
    settings.miniPlayer = { ...DEFAULTS.miniPlayer, ...rest.miniPlayer }
    settings.zoom = { ...DEFAULTS.zoom, ...rest.zoom }
    settings.keepLoaded = { ...DEFAULTS.keepLoaded, ...rest.keepLoaded }
    // Older settings have only the fractions. A place that isn't a rectangle is dropped.
    const panel = { ...structuredClone(DEFAULTS.panel), ...rest.panel }
    const isRect = (r: unknown): r is Rectangle =>
      !!r && typeof r === 'object' && ['x', 'y', 'width', 'height'].every((k) => Number.isFinite((r as Record<string, unknown>)[k]))
    panel.displays = Object.fromEntries(Object.entries(panel.displays ?? {}).filter(([, r]) => isRect(r)))
    if (!isRect(panel.pinned)) panel.pinned = null
    settings.panel = panel
    if (!Number.isInteger(settings.pinnedRows) || settings.pinnedRows < 1) settings.pinnedRows = DEFAULTS.pinnedRows
    if (!Number.isFinite(settings.sidePanelWidth)) settings.sidePanelWidth = DEFAULTS.sidePanelWidth
    if (!['system', 'light', 'dark'].includes(settings.appearance)) settings.appearance = DEFAULTS.appearance
    if (!THEMES.some((t) => t.id === settings.theme)) settings.theme = DEFAULTS.theme
    if (!['tint', 'edge', 'solid'].includes(settings.profileStyle)) settings.profileStyle = DEFAULTS.profileStyle
    if (hotkeys?.all && settings.shortcuts.show === undefined) settings.shortcuts.show = hotkeys.all
    if (hotkeys?.app && settings.shortcuts.showApp === undefined) settings.shortcuts.showApp = hotkeys.app
    return settings
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
