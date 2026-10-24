// The sign-in sheet over a page outside tabs (src/main/signin.ts). Tabs use the form in ui.ts.
import type { LoginView } from '../shared/types'

declare global {
  interface Window {
    signin: {
      on(listener: (view: LoginView & { username?: string }) => void): void
      answer(data: { id: number; username?: string; password?: string }): void
    }
  }
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

const theme = new URLSearchParams(location.search).get('theme')
if (theme) document.documentElement.dataset.theme = theme

const user = $<HTMLInputElement>('loginUser')
const pass = $<HTMLInputElement>('loginPass')
let shown: LoginView | null = null

window.signin.on((l) => {
  const fresh = shown?.id !== l.id
  shown = l
  const realm = l.realm ? ` It says: “${esc(l.realm)}”` : ''
  $('loginText').innerHTML = `${l.proxy ? 'The proxy ' : ''}<b>${esc(l.host)}</b> wants a username and password.${realm}`
  $('loginError').hidden = !l.retry
  if (!fresh) return
  // After a wrong try, keep the username and retype the password. Each try takes the sheet
  // down, so main hands back the username that was wrong.
  user.value = l.retry ? (l.username ?? user.value) : ''
  pass.value = ''
  ;(l.retry && user.value ? pass : user).focus()
})

$('loginForm').addEventListener('submit', (e) => {
  e.preventDefault()
  if (shown) window.signin.answer({ id: shown.id, username: user.value, password: pass.value })
  pass.value = ''
})
const cancel = () => {
  if (shown) window.signin.answer({ id: shown.id })
  pass.value = ''
}
$('loginCancel').addEventListener('click', cancel)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') cancel()
})
