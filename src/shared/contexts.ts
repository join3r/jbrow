/**
 * What you were working on in another app, read from its focused window: a Slack conversation, a
 * mail thread, an editor's project. Tabs opened there remember it, so ⌥⇧Space can put them first
 * when you come back to the same one.
 */
export interface WindowContext {
  /** Stable across visits: the same conversation gives the same key. Starts with the app's bundle ID. */
  key: string
  /** How the sidebar names it. */
  name: string
}

/** What the Accessibility API said about the app's focused window. */
export interface WindowInfo {
  title: string
  /** The window's document as a URL (file://…), for apps that work on files. Empty otherwise. */
  document?: string
}

/** Turns an app's window into the parts of a context, the last of them its name. Null: nothing to group by. */
type Rule = (w: WindowInfo) => string[] | null

/** Unread counts and marks apps put in front of their titles: "(3) ", "* ", "! ", "• ". */
const unread = (s: string) => s.replace(/^(\(\d+\+?\)|[*!•●])\s+/, '')

/** Reply and forward prefixes, in the languages jbrow's users write mail in. Any number of them. */
const replies = (s: string) => s.replace(/^((re|fw|fwd|aw|wg|odp|sv|vs|tr|r|i)(\[\d+\])?:\s*)+/i, '')

const trimEnd = (s: string, suffix: RegExp) => s.replace(suffix, '').trim()

/** Slack's own views, which aren't a conversation. */
const SLACK_VIEWS = new Set(['activity', 'later', 'home', 'dms', 'direct messages', 'threads', 'search', 'files', 'canvases', 'lists', 'huddles', 'saved items', 'mentions & reactions', 'all unreads', 'more', 'tools'])

/**
 * Slack: "Jane Doe (DM) - Acme - Slack", "general (Channel) - Acme - Slack", or the older
 * "Slack | general | Acme". The conversation and its workspace, as a channel in one workspace
 * isn't the one of the same name in another.
 */
const slack: Rule = ({ title }) => {
  let t = unread(title.trim())
  let parts: string[]
  if (/^Slack \| /.test(t)) parts = t.split(' | ').slice(1)
  else parts = trimEnd(t, /\s+-\s+Slack$/).split(' - ')
  if (parts.length < 2) return null
  const workspace = parts.pop()!.trim()
  t = parts.join(' - ').trim()
  const channel = / \(Channel\)$/.test(t)
  t = trimEnd(t, /\s+\((DM|Channel|Group DM|Private channel)\)$/)
  if (!t || SLACK_VIEWS.has(t.toLowerCase())) return null
  if (channel && !t.startsWith('#')) t = `#${t}`
  return [workspace, t]
}

/** Discord: "#general | Server - Discord", "@jane - Discord", or with "Discord | " in front. */
const discord: Rule = ({ title }) => {
  const t = trimEnd(unread(title.trim()).replace(/^Discord \| /, ''), /\s+-\s+Discord$/)
  if (!t || t === 'Discord' || /^(Friends|Nitro|Shop|Discover|Message Requests)$/.test(t)) return null
  const at = t.lastIndexOf(' | ')
  return at < 0 ? [t] : [t.slice(at + 3), t.slice(0, at)]
}

/** Microsoft Teams: "Chat | Jane Doe | Microsoft Teams", "General | Team | Microsoft Teams". */
const teams: Rule = ({ title }) => {
  const parts = trimEnd(unread(title.trim()), /\s*\|\s*Microsoft Teams$/).split(' | ').filter((p) => !/^(Chat|Activity|Calendar|Teams)$/.test(p))
  return parts.length ? parts.reverse() : null
}

/**
 * Mail: the viewer's title is "Mailbox – Subject" (or the mailbox alone), a message's own window
 * just its subject. The thread is the subject without Re: and Fwd:.
 */
const mail: Rule = ({ title }) => {
  const parts = title.split(' – ')
  if (parts.length < 2) return null
  const subject = replies(parts.slice(1).join(' – ').trim())
  return subject ? [subject] : null
}

/** VS Code and its forks: "● file.ts — project", "file.ts — project (Workspace)", "project". The project. */
const vscode: Rule = ({ title }) => {
  const parts = unread(title.trim()).split(' — ')
  let project = parts[parts.length - 1]
  project = trimEnd(project, /\s+—?\s*(Visual Studio Code|Cursor|Windsurf|VSCodium)$/)
  project = trimEnd(project, /\s+\(Workspace\)$/)
  if (!project || parts.length < 2 || /^(Welcome|Get Started|Settings|Extensions?:.*)$/.test(project)) return null
  return [project]
}

/** Xcode and JetBrains IDEs: "project — file" (Xcode) or "project – file" (JetBrains). The project. */
const projectFirst: Rule = ({ title }) => {
  const project = title.split(/ [—–] /)[0].trim()
  return project && project !== title.trim() ? [project] : null
}

/** Obsidian: "Note - Vault - Obsidian v1.8.10". The vault and the note. */
const obsidian: Rule = ({ title }) => {
  const parts = trimEnd(title.trim(), /\s+-\s+Obsidian( v[\d.]+)?$/).split(' - ')
  return parts.length >= 2 ? [parts.pop()!, parts.join(' - ')] : null
}

/** Apps that work on files with no rule of their own: the document's file name. */
const fromDocument = (document?: string): string[] | null => {
  if (!document?.startsWith('file://')) return null
  const name = decodeURIComponent(document.replace(/\/$/, '').split('/').pop() ?? '')
  return name ? [name] : null
}

const RULES: Record<string, Rule> = {
  'com.tinyspeck.slackmacgap': slack,
  'com.hnc.Discord': discord,
  'com.hnc.Discord.Canary': discord,
  'com.microsoft.teams2': teams,
  'com.microsoft.teams': teams,
  'com.apple.mail': mail,
  'com.microsoft.VSCode': vscode,
  'com.microsoft.VSCodeInsiders': vscode,
  'com.todesktop.230313mzl4w4u92': vscode,
  'com.exafunction.windsurf': vscode,
  'com.vscodium': vscode,
  'com.apple.dt.Xcode': projectFirst,
  'md.obsidian': obsidian,
}

/**
 * Apps whose titles change with what's running or loaded (terminals, other browsers), so tabs
 * opened from them would scatter, and chat apps that don't say who you're talking to.
 */
const NO_CONTEXT = new Set([
  'com.apple.Terminal',
  'com.googlecode.iterm2',
  'com.mitchellh.ghostty',
  'dev.warp.Warp-Stable',
  'net.kovidgoyal.kitty',
  'com.github.wez.wezterm',
  'io.alacritty',
  'com.apple.Safari',
  'com.google.Chrome',
  'org.mozilla.firefox',
  'company.thebrowser.Browser',
  'com.brave.Browser',
  'com.microsoft.edgemac',
  'com.apple.finder',
  'ru.keepcoder.Telegram',
  'net.whatsapp.WhatsApp',
  'org.whispersystems.signal-desktop',
])

/** The context of an app's window, or null when there's nothing in it to group tabs by. */
export function windowContext(bundleId: string, appName: string, w: WindowInfo): WindowContext | null {
  if (NO_CONTEXT.has(bundleId)) return null
  const title = w.title.trim()
  let rule = RULES[bundleId]
  if (!rule && bundleId.startsWith('com.jetbrains.')) rule = projectFirst
  // Without a rule: the document if the window has one, else the title without the app's name.
  const parts = rule
    ? rule(w)
    : (fromDocument(w.document) ?? (title && title !== appName ? [trimEnd(unread(title), new RegExp(`\\s+[-—–|]\\s+${escape(appName)}$`))] : null))
  const clean = parts?.map((p) => p.trim()).filter(Boolean)
  if (!clean?.length) return null
  return { key: [bundleId, ...clean].join('\u001f'), name: clean[clean.length - 1] }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
