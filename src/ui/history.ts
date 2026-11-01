import type { HistoryQuery, HistoryReply, HistorySearch, HistorySite, HistoryTrail, HistoryVisit, HistoryView, HistoryWhen, Profile, VisitHow } from '../shared/types'
import { esc, icon } from './markup'

type Send = (channel: string, data?: unknown) => void

export interface HistoryPage {
  /** Shows it, searching for `text` if given. */
  show(text?: string): void
  hide(): void
  readonly shown: boolean
  focusSearch(): void
  /** The profiles changed. */
  setProfiles(profiles: Profile[]): void
  reply(r: HistoryReply): void
}

const PAGE = 200
const VIEWS: [HistoryView, string][] = [['trails', 'Trails'], ['pages', 'Pages'], ['sites', 'Sites'], ['searches', 'Searches']]
const WHENS: [HistoryWhen, string][] = [['today', 'Today'], ['yesterday', 'Since yesterday'], ['week', 'Last 7 days'], ['month', 'Last 30 days'], ['all', 'Last year']]
const HOWS: [VisitHow, string][] = [['typed', 'Typed'], ['search', 'Searched'], ['link', 'Followed a link'], ['app', 'From another app'], ['imported', 'Imported']]
const EXAMPLES = ['site:github.com', 'in:work', 'from:slack']

const pad = (n: number) => String(n).padStart(2, '0')
const clock = (at: number) => {
  const d = new Date(at)
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`
}
const dayKey = (at: number) => new Date(at).toDateString()
function dayLabel(at: number): string {
  const d = new Date(at)
  const today = new Date()
  const start = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const days = Math.round((start(today) - start(d)) / 86400000)
  if (days === 0) return 'Today'
  if (days === 1) return 'Yesterday'
  return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', ...(d.getFullYear() !== today.getFullYear() && { year: 'numeric' }) })
}
const shortDay = (at: number) => {
  const l = dayLabel(at)
  return l.includes(',') ? l.split(',')[0] : l
}
function duration(s: number): string {
  if (s < 60) return `${Math.round(s)}s`
  if (s < 3600) return `${Math.round(s / 60)}m`
  const h = Math.floor(s / 3600)
  const m = Math.round((s % 3600) / 60)
  return m ? `${h}h ${m}m` : `${h}h`
}
const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`
const snippetHtml = (s: string) => esc(s).replace(/\u0001/g, '<mark>').replace(/\u0002/g, '</mark>')

function startLabel(t: HistoryTrail, hostShown: (host: string) => string): string {
  const s = { ...t.start, host: hostShown(t.start.host) }
  if (s.how === 'search' && s.query) return `Searched “${s.query}”`
  if (s.how === 'app') return `From ${s.app ?? 'another app'}`
  if (s.how === 'typed') return `Typed ${s.host}`
  if (s.how === 'imported') return `Imported from ${s.app ?? 'another browser'}`
  return `Opened ${s.host}`
}
function howLabel(v: HistoryVisit): string {
  if (v.how === 'app') return `From ${v.app ?? 'another app'}`
  if (v.how === 'imported') return `From ${v.app ?? 'another browser'}`
  if (v.how === 'search') return 'Searched'
  if (v.how === 'typed') return 'Typed'
  if (v.how === 'link') return 'Link'
  return 'Opened'
}

export function initHistory(el: HTMLElement, send: Send, onShown: (shown: boolean) => void, isPrivate: (url: string) => boolean): HistoryPage {
  const fresh = (): Omit<HistoryQuery, 'seq'> => ({ text: '', view: 'trails', when: 'week', profile: 'all', how: [], sites: [], read: false, hideRedirects: true, state: 'any', limit: PAGE })
  let q = fresh()
  let seq = 0
  let last: HistoryReply | null = null
  let profiles: Profile[] = []
  let timer: ReturnType<typeof setTimeout> | null = null

  el.innerHTML = `
    <header class="hist-head">
      <h1>History</h1>
      <label class="hist-search">${icon('search')}<span class="vh">Search history</span>
        <input type="search" spellcheck="false" placeholder="Search titles, addresses and what pages said" data-hist-text />
      </label>
      <div class="seg hist-views" role="tablist" aria-label="View" data-hist-views></div>
      <button class="icon" data-hist-close title="Close" aria-label="Close history">${icon('close')}</button>
    </header>
    <div class="hist-sub"><span data-hist-summary></span><span class="hist-try">Try</span>${EXAMPLES.map((x) => `<button class="hist-ex" data-hist-example="${esc(x)}">${esc(x)}</button>`).join('')}</div>
    <div class="hist-body">
      <aside class="hist-facets" aria-label="Filters" data-hist-facets></aside>
      <div class="hist-results" data-hist-results aria-live="polite"></div>
    </div>
    <footer class="hist-foot">
      <span>Kept on this computer for a year. The text of private addresses, and of sites you leave out in settings, isn't kept. Click opens a page, ⌘-click opens it in the background.</span>
      <button class="link" data-hist-settings>History settings…</button>
    </footer>`
  const $ = <T extends HTMLElement>(sel: string) => el.querySelector<T>(sel)!
  const textEl = $<HTMLInputElement>('[data-hist-text]')
  const resultsEl = $('[data-hist-results]')

  /** Asks main for what the search and filters give. `soon` waits for typing to pause. */
  function ask(soon = false) {
    if (timer) clearTimeout(timer)
    const go = () => send('history-query', { ...q, seq: ++seq })
    if (soon) timer = setTimeout(go, 150)
    else go()
  }
  const change = (patch: Partial<typeof q>) => {
    q = { ...q, limit: PAGE, ...patch }
    renderControls()
    ask()
  }

  const profile = (id: string) => profiles.find((p) => p.id === id)
  // Private addresses show as Private here too, as in the address bar and the sidebar.
  const privateHost = (host: string) => isPrivate(`https://${host}/`) || isPrivate(`http://${host}/`)
  const hostShown = (host: string) => (privateHost(host) ? 'Private' : host)
  const dot = (id: string) => (profiles.length > 1 ? `<span class="dot" style="background:${esc(profile(id)?.color ?? '#888')}" title="${esc(profile(id)?.name ?? '')}"></span>` : '')
  const favicon = (v: { profile: string; url: string; host: string }) => {
    let origin = ''
    try {
      origin = new URL(v.url).origin
    } catch {}
    const src = origin ? `jbrow-icon://icon/?${new URLSearchParams({ p: v.profile, u: `${origin}/favicon.ico` })}` : ''
    return `<span class="hist-fav" aria-hidden="true"><span>${esc(v.host.charAt(0).toUpperCase())}</span>${src ? `<img src="${esc(src)}" alt="">` : ''}</span>`
  }
  // An icon that doesn't load leaves the letter under it.
  el.addEventListener('error', (e) => (e.target as HTMLElement).matches?.('.hist-fav img') && (e.target as HTMLElement).remove(), true)

  function renderControls() {
    $('[data-hist-views]').innerHTML = VIEWS.map(([id, name]) => `<button role="tab" data-hist-view="${id}" aria-selected="${q.view === id}" aria-pressed="${q.view === id}">${name}</button>`).join('')
    const f = last?.facets
    const box = (kind: 'radio' | 'check', on: boolean, attrs: string, label: string, count?: number, color = '') =>
      `<button class="hist-facet ${kind}" ${attrs} aria-pressed="${on}"><span class="box" aria-hidden="true"></span>${color ? `<span class="dot" style="background:${esc(color)}"></span>` : ''}<span class="name">${esc(label)}</span>${count === undefined ? '' : `<span class="n">${count.toLocaleString()}</span>`}</button>`
    const group = (title: string, body: string) => (body ? `<fieldset><legend>${title}</legend>${body}</fieldset>` : '')
    const profileTotal = f ? Object.values(f.profile).reduce((a, b) => a + b, 0) : undefined
    const sites = [...(f?.sites ?? [])]
    for (const h of q.sites) if (!sites.some((s) => s.host === h)) sites.push({ host: h, count: 0 })
    $('[data-hist-facets]').innerHTML = [
      group('When', WHENS.map(([id, name]) => box('radio', q.when === id, `data-hist-when="${id}"`, name, f?.when[id])).join('')),
      profiles.length > 1
        ? group('Profile', [box('radio', q.profile === 'all', 'data-hist-profile="all"', 'All', profileTotal), ...profiles.map((p) => box('radio', q.profile === p.id, `data-hist-profile="${esc(p.id)}"`, p.name, f?.profile[p.id] ?? 0, p.color))].join(''))
        : '',
      group('How you got there', HOWS.filter(([id]) => id !== 'imported' || (f?.how.imported ?? 0) > 0 || q.how.includes('imported')).map(([id, name]) => box('check', q.how.includes(id), `data-hist-how="${id}"`, name, f?.how[id] ?? 0)).join('')),
      group('Sites', sites.map((s) => box('check', q.sites.includes(s.host), `data-hist-site="${esc(s.host)}"`, hostShown(s.host), s.count)).join('')),
      group(
        'Show',
        [
          box('check', q.read, 'data-hist-toggle="read"', 'Stayed a minute or more'),
          box('check', q.hideRedirects, 'data-hist-toggle="hideRedirects"', 'Hide redirects'),
          box('check', q.state === 'open', 'data-hist-state="open"', 'Still open in a tab', f?.open),
          box('check', q.state === 'kept', 'data-hist-state="kept"', 'In Kept', f?.kept),
        ].join(''),
      ),
    ].join('')
    if (document.activeElement !== textEl) textEl.value = q.text
  }

  const visitRow = (v: HistoryVisit, cols: 'trail' | 'page') => {
    if (isPrivate(v.url)) v = { ...v, title: 'Private', host: 'Private', snippet: undefined }
    const badge = v.state === 'open' ? '<span class="hist-badge">Open</span>' : v.state === 'kept' ? '<span class="hist-badge">Kept</span>' : ''
    const bar = Math.min(100, Math.round((v.secs / 900) * 100))
    return `<div class="hist-row ${cols}" data-url="${esc(v.url)}" data-profile="${esc(v.profile)}">
      <span class="time">${clock(v.at)}</span>
      ${favicon(v)}
      <div class="main">
        <a href="${esc(v.url)}" class="title"${v.host === 'Private' ? '' : ` title="${esc(v.url)}"`}><span class="t">${esc(v.title || v.url)}</span><span class="host">${esc(v.host)}</span>${badge}</a>
        ${v.snippet ? `<div class="snip">${snippetHtml(v.snippet)}</div>` : ''}
      </div>
      ${cols === 'page' ? `<span class="how">${dot(v.profile)}${esc(howLabel(v))}</span>` : ''}
      <span class="spent" title="In front for ${duration(v.secs)}"><span class="track"><span style="width:${bar}%"></span></span><span class="d">${v.secs ? duration(v.secs) : '–'}</span></span>
      <button class="icon act" data-hist-forget title="Forget this page" aria-label="Forget this page">${icon('close')}</button>
    </div>`
  }

  function byDay<T>(items: T[], at: (x: T) => number): { label: string; items: T[] }[] {
    const days: { key: string; label: string; items: T[] }[] = []
    for (const x of items) {
      const k = dayKey(at(x))
      let d = days.find((y) => y.key === k)
      if (!d) days.push((d = { key: k, label: dayLabel(at(x)), items: [] }))
      d.items.push(x)
    }
    return days
  }

  const trailsHtml = (trails: HistoryTrail[]) =>
    byDay(trails, (t) => t.visits[t.visits.length - 1].at)
      .map(
        (d) => `<h2>${esc(d.label)}</h2>${d.items
          .map((t) => {
            const first = t.visits[0]
            const lastV = t.visits[t.visits.length - 1]
            const span = t.visits.length > 1 ? `${clock(first.at)}–${clock(lastV.at)}` : clock(first.at)
            const name = startLabel(t, hostShown)
            return `<article class="hist-trail" data-trail="${t.id}" data-name="${esc(name)}">
              <div class="hist-trail-head">${dot(t.profile)}<b>${esc(name)}</b><span class="meta">${span} · ${plural(t.visits.length, 'page', 'pages')}${t.secs ? ` · ${duration(t.secs)}` : ''}</span>
                <span class="grow"></span>
                <button class="chip" data-hist-trail="open">Reopen as tabs</button>
                <button class="chip" data-hist-trail="keep">Keep as folder</button>
              </div>
              ${t.visits.map((v) => visitRow(v, 'trail')).join('')}
            </article>`
          })
          .join('')}`,
      )
      .join('')

  const pagesHtml = (pages: HistoryVisit[]) => byDay(pages, (v) => v.at).map((d) => `<h2>${esc(d.label)}</h2>${d.items.map((v) => visitRow(v, 'page')).join('')}`).join('')

  const sitesHtml = (sites: HistorySite[]) => {
    const max = Math.max(1, ...sites.flatMap((s) => s.days))
    return `<div class="hist-site head"><span></span><span>Site</span><span>Visits</span><span>Time</span><span>Last visit</span><span>Last 7 days</span></div>
      ${sites
        .map(
          (s) => `<button class="hist-site" data-hist-site-open="${esc(s.host)}" title="Show its pages">
            ${favicon({ profile: q.profile === 'all' ? (profiles[0]?.id ?? '') : q.profile, url: `https://${s.host}/`, host: hostShown(s.host) })}
            <span class="host">${esc(hostShown(s.host))}</span><span>${s.visits.toLocaleString()}</span><span>${s.secs ? duration(s.secs) : '–'}</span><span class="muted">${esc(shortDay(s.last))}</span>
            <span class="spark" role="img" aria-label="${s.days.reduce((a, b) => a + b, 0)} visits in the last 7 days">${s.days.map((n) => `<span style="height:${n ? 4 + Math.round((n / max) * 18) : 2}px" class="${n ? 'on' : ''}"></span>`).join('')}</span>
          </button>`,
        )
        .join('')}`
  }

  const searchesHtml = (searches: HistorySearch[]) =>
    searches
      .map(
        (s) => `<div class="hist-search-row">
          <span class="time">${esc(shortDay(s.at))}<br>${clock(s.at)}</span>
          <div class="main">
            <div class="q">${icon('search')}<a href="#" data-hist-requery="${esc(s.query)}" title="Search history for this">${esc(s.query)}</a><span class="muted">${esc(s.engine)}</span>${dot(s.profile)}</div>
            <div class="led">${s.led.length ? `Led to ${s.led.map((p) => `<a href="${esc(p.url)}" data-hist-link data-profile="${esc(s.profile)}">${esc(isPrivate(p.url) ? 'Private' : p.title || p.url)}</a>`).join(', ')}${s.more ? ` and ${s.more} more` : ''}` : 'Opened nothing from it'}</div>
          </div>
        </div>`,
      )
      .join('')

  function renderResults() {
    const r = last
    if (!r) return
    $('[data-hist-summary]').textContent = r.total
      ? `${plural(r.total, 'visit', 'visits')} in ${plural(r.trailCount, 'trail', 'trails')}${r.secs ? ` · ${duration(r.secs)} in front` : ''}`
      : ''
    let html = ''
    if (q.view === 'trails' && r.trails) html = trailsHtml(r.trails)
    else if (q.view === 'pages' && r.pages) html = pagesHtml(r.pages)
    else if (q.view === 'sites' && r.sites) html = sitesHtml(r.sites)
    else if (q.view === 'searches' && r.searches) html = searchesHtml(r.searches)
    if (!html) {
      const filtered = q.text || q.how.length || q.sites.length || q.read || q.state !== 'any' || q.profile !== 'all' || q.when !== 'all'
      html = `<p class="hist-empty">${filtered ? 'Nothing matches. Loosen a filter, or pick a longer time on the left.' : 'Nothing here yet. Pages you visit show up here.'}</p>`
    }
    if (r.more) html += `<button class="chip hist-more" data-hist-more>Show more</button>`
    resultsEl.innerHTML = html
  }

  // ---------- events ----------

  textEl.addEventListener('input', () => {
    q = { ...q, text: textEl.value, limit: PAGE }
    ask(true)
  })
  textEl.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && textEl.value) {
      e.stopPropagation()
      change({ text: '' })
    }
  })

  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement
    const b = t.closest<HTMLElement>('button, a')
    if (!b) return
    const d = b.dataset
    if (d.histClose !== undefined) return void page.hide()
    if (d.histSettings !== undefined) return void send('history-settings')
    if (d.histView) return change({ view: d.histView as HistoryView })
    if (d.histWhen) return change({ when: d.histWhen as HistoryWhen })
    if (d.histProfile) return change({ profile: d.histProfile })
    if (d.histHow) {
      const how = d.histHow as VisitHow
      return change({ how: q.how.includes(how) ? q.how.filter((x) => x !== how) : [...q.how, how] })
    }
    if (d.histSite) return change({ sites: q.sites.includes(d.histSite) ? q.sites.filter((x) => x !== d.histSite) : [...q.sites, d.histSite] })
    if (d.histSiteOpen) return change({ sites: [d.histSiteOpen], view: 'pages' })
    if (d.histToggle === 'read') return change({ read: !q.read })
    if (d.histToggle === 'hideRedirects') return change({ hideRedirects: !q.hideRedirects })
    if (d.histState) return change({ state: q.state === d.histState ? 'any' : (d.histState as 'open' | 'kept') })
    if (d.histExample) {
      textEl.value = d.histExample
      change({ text: d.histExample })
      return textEl.focus()
    }
    if (d.histMore !== undefined) {
      q = { ...q, limit: q.limit + PAGE }
      return ask()
    }
    if (d.histRequery) {
      e.preventDefault()
      return change({ text: d.histRequery, view: 'pages' })
    }
    if (d.histTrail) {
      const card = b.closest<HTMLElement>('[data-trail]')!
      return send('history-trail', { trail: Number(card.dataset.trail), action: d.histTrail, name: card.dataset.name })
    }
    const row = b.closest<HTMLElement>('[data-url]')
    if (d.histForget !== undefined && row) {
      send('forget-visit', { profile: row.dataset.profile, url: row.dataset.url })
      return ask()
    }
    // A page: here in front, or with ⌘ in the background.
    if (b.tagName === 'A' && (row || d.histLink !== undefined)) {
      e.preventDefault()
      const url = row?.dataset.url ?? b.getAttribute('href')!
      send('history-open', { url, profile: row?.dataset.profile ?? b.dataset.profile, background: e.metaKey || e.ctrlKey })
    }
  })
  // A middle click opens a page in the background too.
  el.addEventListener('auxclick', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href]')
    const row = a?.closest<HTMLElement>('[data-url]')
    if (e.button !== 1 || !a || !(row || a.dataset.histLink !== undefined)) return
    e.preventDefault()
    send('history-open', { url: row?.dataset.url ?? a.getAttribute('href'), profile: row?.dataset.profile ?? a.dataset.profile, background: true })
  })

  const page: HistoryPage = {
    get shown() {
      return !el.hidden
    },
    show(text) {
      if (text !== undefined) q = { ...fresh(), text, view: 'pages', when: 'all' }
      const was = !el.hidden
      el.hidden = false
      renderControls()
      ask()
      if (!was) onShown(true)
      page.focusSearch()
    },
    hide() {
      if (el.hidden) return
      el.hidden = true
      onShown(false)
    },
    focusSearch() {
      textEl.focus()
      textEl.select()
    },
    setProfiles(list) {
      if (JSON.stringify(list) === JSON.stringify(profiles)) return
      profiles = list
      if (q.profile !== 'all' && !profile(q.profile)) q = { ...q, profile: 'all' }
      if (!el.hidden) renderControls()
    },
    reply(r) {
      if (r.seq !== seq) return
      last = r
      renderControls()
      renderResults()
    },
  }
  return page
}
