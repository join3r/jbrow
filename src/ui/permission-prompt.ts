// The permission prompt under a tab's address bar (src/main/permission-prompt.ts).
import type { PromptView } from '../shared/types'
import { esc, icon } from './markup'

declare global {
  interface Window {
    permissionPrompt: {
      on(listener: (view: PromptView) => void): void
      onShown(listener: () => void): void
      size(height: number): void
      answer(data: { id: number; allow?: boolean; remember?: boolean; dismissed?: boolean }): void
    }
  }
}

/** How long after it shows before a click counts, as for the device chooser in ui.ts. */
const ARM_MS = 600

const ICON: Record<string, string> = {
  camera: 'camera',
  microphone: 'mic',
  geolocation: 'mapPin',
  notifications: 'bell',
  'clipboard-read': 'clipboard',
  midi: 'music',
  midiSysex: 'music',
  'idle-detection': 'clock',
  'window-management': 'monitor',
  openExternal: 'open',
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

const params = new URLSearchParams(location.search)
const theme = params.get('theme')
if (theme) document.documentElement.dataset.theme = theme
const pad = JSON.parse(params.get('pad') ?? '{}') as { top?: number; side?: number; bottom?: number }
for (const [k, v] of Object.entries(pad)) document.body.style.setProperty(`--pad-${k}`, `${v}px`)

const card = $('card')
const remember = $<HTMLInputElement>('remember')
$('dismiss').innerHTML = icon('close')
let shown: PromptView | null = null
let armedAt = Infinity

window.permissionPrompt.on((v) => {
  shown = v
  // Both camera and microphone show the camera: it's the one people look for.
  const first = v.permissions.includes('camera') ? 'camera' : v.permissions[0]!.split(':')[0]!
  $('icon').innerHTML = icon(ICON[first] ?? 'shield')
  $('text').innerHTML = `<b>${esc(v.who)}</b> wants to ${esc(v.what)}`
  const profile = $('profile')
  profile.hidden = !v.profile
  profile.textContent = v.profile ? `In the ${v.profile} profile` : ''
  $('rememberRow').hidden = !v.remembers
  $('spacer').hidden = v.remembers
  remember.checked = true
  card.hidden = false
  window.permissionPrompt.size(card.offsetHeight)
})
window.permissionPrompt.onShown(() => (armedAt = Date.now() + ARM_MS))

const answer = (data: { allow?: boolean; dismissed?: boolean }) => {
  if (!shown || Date.now() < armedAt) return
  window.permissionPrompt.answer({ id: shown.id, remember: remember.checked, ...data })
}
$('allow').addEventListener('click', () => answer({ allow: true }))
$('block').addEventListener('click', () => answer({ allow: false }))
$('dismiss').addEventListener('click', () => answer({ dismissed: true }))
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') answer({ dismissed: true })
})
// The text wraps differently as the view's width changes with a narrower pane.
new ResizeObserver(() => !card.hidden && window.permissionPrompt.size(card.offsetHeight)).observe(card)
