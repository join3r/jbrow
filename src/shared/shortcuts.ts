/**
 * Keyboard shortcuts as Electron accelerators in one canonical order, e.g. `Command+Shift+L`, so
 * a shortcut recorded in the UI compares equal to one matched in the main process.
 */

const MEDIA_KEYS = new Set(['MediaNextTrack', 'MediaPreviousTrack', 'MediaPlayPause', 'MediaStop'])

/** KeyboardEvent.code values for keys that aren't letters or digits. */
const CODE_KEYS: Record<string, string> = {
  Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\',
  Backquote: '`', Minus: '-', Equal: '=', Space: 'Space', Tab: 'Tab', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', Delete: 'Delete',
  MediaTrackNext: 'MediaNextTrack', MediaTrackPrevious: 'MediaPreviousTrack', MediaPlayPause: 'MediaPlayPause', MediaStop: 'MediaStop',
}

/** Punctuation an accelerator can name, taken from the typed key when it is one. */
const PUNCTUATION = new Set([...",./;'[]\\`-="])

export interface Mods {
  command?: boolean
  control?: boolean
  alt?: boolean
  shift?: boolean
}

export function canonical(mods: Mods, key: string): string {
  return [mods.command && 'Command', mods.control && 'Control', mods.alt && 'Alt', mods.shift && 'Shift', key].filter(Boolean).join('+')
}

/**
 * The shortcut a key press makes, or null if it can't be one: it needs ⌘, ⌃ or ⌥, as in Chrome,
 * unless it's a media key. Letters come from the typed key where it's a plain letter, so they
 * follow your layout (Z on a Slovak keyboard is Z); with Option held the Mac types a symbol
 * instead, so the key's position decides. Punctuation works the same way: ⌘[ where the layout has
 * a [ key, else the key in its place on a US keyboard.
 */
export function shortcutFromKey(e: { key: string; code: string } & Mods): string | null {
  let key: string | undefined
  if (/^[a-z]$/i.test(e.key)) key = e.key.toUpperCase()
  else if (PUNCTUATION.has(e.key)) key = e.key
  else if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3)
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5)
  else key = CODE_KEYS[e.code]
  if (!key) return null
  if (!MEDIA_KEYS.has(key) && !e.command && !e.control && !e.alt) return null
  return canonical(e, key)
}

const GLYPHS: Record<string, string> = {
  Command: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧', Up: '↑', Down: '↓', Left: '←', Right: '→',
  PageUp: '⇞', PageDown: '⇟', Home: '↖', End: '↘', Delete: '⌦',
  MediaNextTrack: '⏭', MediaPreviousTrack: '⏮', MediaPlayPause: '⏯', MediaStop: '⏹',
}
const MAC_ORDER = ['Control', 'Alt', 'Shift', 'Command']

/** How a Mac menu writes the shortcut, e.g. ⇧⌘L. */
export function shortcutLabel(shortcut: string): string {
  const parts = shortcut.split('+')
  const key = parts.pop()!
  const mods = MAC_ORDER.filter((m) => parts.includes(m))
  return [...mods, key].map((p) => GLYPHS[p] ?? p).join('')
}

/** jbrow's own commands whose keys you can change in settings. Global ones work while jbrow is hidden. */
export const ACTIONS = [
  { id: 'show', label: 'Show jbrow', key: 'Alt+Space', global: true },
  { id: 'showApp', label: "Show the tabs of the app you're in", key: 'Alt+Shift+Space', global: true },
  { id: 'newTab', label: 'New tab', key: 'Command+T' },
  { id: 'newTabNextProfile', label: 'New tab in the next profile', key: 'Command+Shift+N' },
  { id: 'closeTab', label: 'Close tab', key: 'Command+W' },
  { id: 'reopenTab', label: 'Reopen closed tab', key: 'Command+Shift+T' },
  { id: 'previousTab', label: 'Previous tab', key: 'Control+Tab' },
  { id: 'splitView', label: 'Split view', key: 'Command+D' },
  { id: 'paneLeft', label: 'Focus the pane on the left', key: 'Command+Control+Left' },
  { id: 'paneRight', label: 'Focus the pane on the right', key: 'Command+Control+Right' },
  { id: 'address', label: 'Address bar', key: 'Command+L' },
  { id: 'copyUrl', label: "Copy the page's URL", key: 'Command+Shift+C' },
  { id: 'find', label: 'Find in page', key: 'Command+F' },
  { id: 'reload', label: 'Reload', key: 'Command+R' },
  { id: 'hardReload', label: 'Reload without the cache', key: 'Command+Shift+R' },
  { id: 'print', label: 'Print the page', key: 'Command+P' },
  { id: 'back', label: 'Back', key: 'Command+[' },
  { id: 'forward', label: 'Forward', key: 'Command+]' },
  { id: 'pin', label: 'Pin the window', key: 'Command+Shift+P' },
  { id: 'settings', label: 'Settings', key: 'Command+,' },
  { id: 'devTools', label: "Developer tools for the page", key: 'Command+Alt+I' },
] as const

export type ActionId = (typeof ACTIONS)[number]['id']

export const isGlobal = (id: ActionId) => ACTIONS.some((a) => a.id === id && 'global' in a)

/** Each command's key: yours where you set one ('' for none), else the default. */
export function actionKeys(overrides: Partial<Record<ActionId, string>>): Record<ActionId, string> {
  return Object.fromEntries(ACTIONS.map((a) => [a.id, overrides[a.id] ?? a.key])) as Record<ActionId, string>
}

/** Keys that can't change: ⌘1–9, zoom, and the edit and app menus' key equivalents. Nothing else can take them. */
export const FIXED = new Set([
  ...'ACVXZQH'.split('').map((k) => `Command+${k}`),
  ...'123456789'.split('').map((k) => `Command+${k}`),
  'Command+Shift+Z', 'Command+=', 'Command+-', 'Command+0', 'Command+Shift+=',
])
