import { globalShortcut, type WebContents } from 'electron'
import { ACTIONS, actionKeys, canonical, FIXED, shortcutFromKey } from '../shared/shortcuts'
import type { ExtensionShortcut } from '../shared/types'
import { BACKGROUND } from './background'
import { localize, messages } from './extension-files'
import { libraryOf } from './library'
import type { ProfileRuntime } from './profiles'
import type { Settings } from './settings'

/**
 * chrome.commands: extension keyboard shortcuts. electron-chrome-extensions reads a manifest's
 * commands but leaves every shortcut empty and never fires onCommand, so jbrow resolves the keys
 * (yours from settings, else the manifest's suggestion), matches them against key presses in the
 * panel and in jbrow's other windows (action popups, pop-outs), and dispatches the event itself.
 *
 * Shortcuts are canonical accelerators (see shared/shortcuts.ts), so they double as
 * globalShortcut accelerators for commands marked `global`.
 */

const GLOBAL_SUGGESTION = /^Command\+Shift\+[0-9]$/

const EXECUTE_ACTION = new Set(['_execute_action', '_execute_browser_action', '_execute_page_action'])

/** Chrome's key names that differ from Electron's. */
const CHROME_KEYS: Record<string, string> = { Comma: ',', Period: '.' }

interface ManifestCommand {
  description?: string
  suggested_key?: Record<string, string>
  global?: boolean
}

/** Chrome's suggested_key syntax, as on a Mac: Ctrl means Command there, MacCtrl means Control. */
function fromChrome(chromeKey: string): string | null {
  const parts = chromeKey.split('+').map((p) => p.trim())
  const key = parts.pop()
  if (!key) return null
  const mods = {
    command: parts.includes('Ctrl') || parts.includes('Command'),
    control: parts.includes('MacCtrl'),
    alt: parts.includes('Alt'),
    shift: parts.includes('Shift'),
  }
  return canonical(mods, CHROME_KEYS[key] ?? (key.length === 1 ? key.toUpperCase() : key))
}

export class ExtensionCommands {
  /** When an extension shortcut last ran, so the tab it switches to right after is your doing. */
  lastRunAt = 0

  constructor(
    private settings: () => Settings,
    private runtimes: () => Map<string, ProfileRuntime>,
    private hooks: {
      /** Settings changed: write them out. */
      save: () => void
      /** Open an extension's popup from its toolbar button. */
      openPopup: (profileId: string, extensionId: string) => void
      /** The tab a command acts on: the active one, if it's in that profile. */
      activeTab: (profileId: string) => WebContents | undefined
    },
  ) {}

  private cache = new Map<string, ExtensionShortcut[]>()
  private globals: string[] = []

  /** Keeps the shortcuts current as extensions come and go. Call once the profiles exist. */
  watch() {
    for (const rt of this.runtimes().values()) this.watchProfile(rt)
    this.registerGlobal()
  }

  /** Same, for a profile added while jbrow runs. */
  watchProfile(rt: ProfileRuntime) {
    const changed = () => {
      this.cache.clear()
      this.registerGlobal()
    }
    rt.session.extensions.on('extension-loaded', changed)
    rt.session.extensions.on('extension-unloaded', changed)
  }

  /** Every command of every extension in a profile, with the shortcut each one has now. */
  list(profileId: string): ExtensionShortcut[] {
    let list = this.cache.get(profileId)
    if (!list) {
      list = this.resolve(profileId)
      this.cache.set(profileId, list)
    }
    return list
  }

  private resolve(profileId: string): ExtensionShortcut[] {
    const rt = this.runtimes().get(profileId)
    if (!rt) return []
    const overrides = this.settings().extensionShortcuts[profileId] ?? {}
    const taken = new Set([...FIXED, ...Object.values(actionKeys(this.settings().shortcuts))])
    const list: ExtensionShortcut[] = []
    const exts = rt.session.extensions.getAllExtensions()
    // Your shortcuts claim their keys first; a suggestion only gets a key nobody holds yet.
    for (const ext of exts) for (const s of Object.values(overrides[ext.id] ?? {})) if (s) taken.add(s)
    for (const ext of exts) {
      const commands = (ext.manifest as { commands?: Record<string, ManifestCommand> }).commands
      if (!commands) continue
      const msgs = messages(ext)
      for (const [name, cmd] of Object.entries(commands)) {
        let shortcut = overrides[ext.id]?.[name]
        if (shortcut === undefined) {
          const suggested = cmd.suggested_key?.mac ?? cmd.suggested_key?.default
          const parsed = suggested ? fromChrome(suggested) : null
          // As in Chrome, an extension can only suggest ⇧⌘0–9 for a global command, so it can't
          // take a key from every other app without you choosing it.
          const allowed = parsed && (!cmd.global || GLOBAL_SUGGESTION.test(parsed))
          shortcut = allowed && !taken.has(parsed) ? parsed : ''
          if (shortcut) taken.add(shortcut)
        }
        list.push({
          profile: profileId,
          extensionId: ext.id,
          extensionName: localize(ext.name, msgs),
          name,
          description: cmd.description ? localize(cmd.description, msgs) : EXECUTE_ACTION.has(name) ? 'Open the extension' : name,
          shortcut,
          global: !!cmd.global,
        })
      }
    }
    return list
  }

  /**
   * Runs the command a key press in a profile stands for. True if there was one. It acts on `tab`,
   * or else on the active tab.
   */
  handleKey(profileId: string | undefined, input: Electron.Input, tab?: WebContents): boolean {
    if (!profileId || input.type !== 'keyDown') return false
    const shortcut = shortcutFromKey({ ...input, command: input.meta })
    if (!shortcut) return false
    const cmd = this.list(profileId).find((c) => c.shortcut === shortcut && !c.global)
    if (!cmd) return false
    this.run(cmd, tab)
    return true
  }

  run(cmd: ExtensionShortcut, tab = this.hooks.activeTab(cmd.profile)) {
    this.lastRunAt = Date.now()
    if (EXECUTE_ACTION.has(cmd.name)) return this.hooks.openPopup(cmd.profile, cmd.extensionId)
    const rt = this.runtimes().get(cmd.profile)
    if (!rt) return
    const ctx = libraryOf(rt)
    const details = tab && !tab.isDestroyed() ? ctx.store.tabDetailsCache.get(tab.id) : undefined
    console.log(`[commands] ${cmd.profile}: ${cmd.extensionName} → ${cmd.name}`)
    ctx.router.sendEvent(cmd.extensionId, 'commands.onCommand', cmd.name, details)
  }

  /**
   * Sets your shortcut for a command; '' removes it. Returns why it can't have that key, if it can't.
   */
  set(profileId: string, extensionId: string, name: string, shortcut: string): string | null {
    if (shortcut) {
      if (FIXED.has(shortcut)) return 'jbrow uses that shortcut itself.'
      const keys = actionKeys(this.settings().shortcuts)
      const own = ACTIONS.find((a) => keys[a.id] === shortcut)
      if (own) return `jbrow uses that shortcut for "${own.label}".`
      const holder = this.list(profileId).find((c) => c.shortcut === shortcut && !(c.extensionId === extensionId && c.name === name))
      if (holder) return `${holder.extensionName} already uses that shortcut for "${holder.description}".`
    }
    const all = this.settings().extensionShortcuts
    ;((all[profileId] ??= {})[extensionId] ??= {})[name] = shortcut
    this.cache.clear()
    this.hooks.save()
    this.registerGlobal()
    return null
  }

  /** Commands marked global work while jbrow is hidden, as in Chrome. */
  registerGlobal() {
    this.unregisterGlobal()
    if (BACKGROUND) return
    for (const profileId of this.runtimes().keys()) {
      for (const cmd of this.list(profileId)) {
        if (!cmd.global || !cmd.shortcut || this.globals.includes(cmd.shortcut)) continue
        if (globalShortcut.register(cmd.shortcut, () => this.run(cmd))) this.globals.push(cmd.shortcut)
        else console.error(`[commands] another app holds ${cmd.shortcut}, so ${cmd.extensionName}'s "${cmd.description}" won't work globally`)
      }
    }
  }

  unregisterGlobal() {
    for (const accel of this.globals) globalShortcut.unregister(accel)
    this.globals = []
  }

  /** The command that has a shortcut in any profile, if one does. */
  holder(shortcut: string): ExtensionShortcut | undefined {
    for (const profileId of this.runtimes().keys()) {
      const cmd = this.list(profileId).find((c) => c.shortcut === shortcut)
      if (cmd) return cmd
    }
  }

  /** jbrow's own keys changed, so suggestions they now take or free up resolve again. */
  refresh() {
    this.cache.clear()
  }
}
