import type { AuthInfo } from 'electron'
import type { LoginView } from '../shared/types'

type Answer = (username?: string, password?: string) => void

interface Asking {
  id: number
  key: string
  host: string
  realm: string
  proxy: boolean
  /** The last username and password for this site were wrong. */
  retry: boolean
  /** Every request waiting on the same site and realm gets the one answer. */
  callbacks: Answer[]
}

/**
 * HTTP basic and digest auth. Chromium asks for a username and password through a page's
 * 'login' event; jbrow asks and answers. Questions are kept per tab id, and per `wc:<id>` for
 * pages outside tabs (popup windows, extension pages), which signin.ts asks in a sheet of their
 * own. Nothing is stored: Chromium remembers what worked until jbrow quits, and a password
 * manager can fill the tab's form.
 */
export class Logins {
  private asking = new Map<string, Asking[]>()
  /** Tab and site last answered with a username, so asking again means it was wrong. */
  private answered = new Map<string, string>()
  private nextId = 1

  constructor(private onChange: (tabId: string) => void) {}

  ask(tabId: string, info: AuthInfo, callback: Answer) {
    const host = info.port && ![80, 443].includes(info.port) ? `${info.host}:${info.port}` : info.host
    const key = `${info.isProxy ? 'proxy' : 'site'}\n${host}\n${info.realm}`
    const list = this.asking.get(tabId) ?? []
    const same = list.find((a) => a.key === key)
    if (same) return void same.callbacks.push(callback)
    const retry = this.answered.get(tabId) === key
    this.answered.delete(tabId)
    list.push({ id: this.nextId++, key, host, realm: info.realm, proxy: info.isProxy, retry, callbacks: [callback] })
    this.asking.set(tabId, list)
    this.onChange(tabId)
  }

  /** Signs in with the username and password, or cancels without them. */
  answer(tabId: string, username?: string, password?: string) {
    const list = this.asking.get(tabId)
    const first = list?.shift()
    if (!list || !first) return
    if (!list.length) this.asking.delete(tabId)
    if (username !== undefined) this.answered.set(tabId, first.key)
    for (const cb of first.callbacks) {
      try {
        if (username === undefined) cb()
        else cb(username, password ?? '')
      } catch {}
    }
    this.onChange(tabId)
  }

  /** The tab is going somewhere new, or its page is gone: whatever it was asked is cancelled. */
  clear(tabId: string) {
    this.answered.delete(tabId)
    const list = this.asking.get(tabId)
    if (!list) return
    this.asking.delete(tabId)
    for (const a of list) for (const cb of a.callbacks) {
      try {
        cb()
      } catch {}
    }
    this.onChange(tabId)
  }

  /** The tab's page loaded; the next time it's asked isn't about a wrong password. */
  loaded(tabId: string) {
    this.answered.delete(tabId)
  }

  isAsking(tabId: string) {
    return this.asking.has(tabId)
  }

  view(tabId: string): LoginView | null {
    const a = this.asking.get(tabId)?.[0]
    return a ? { id: a.id, host: a.host, realm: a.realm, proxy: a.proxy, retry: a.retry } : null
  }
}
