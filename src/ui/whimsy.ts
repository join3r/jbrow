/**
 * Whimsical touches, off unless turned on under Animation in settings: tabs pop in and vanish in a
 * puff, rows glide to their new places, the tab you switch to hops, finished downloads wiggle.
 * All of it is Web Animations on elements the render already made, so nothing replays when the
 * sidebar redraws, and macOS's Reduce motion turns it all off. A loading tab's icon has a firefly
 * circling it in place of the plain pulse, a lantern glow drifts in its address bar and blooms away
 * once the page is in, and a page with nothing to show yet has two fireflies round its icon. The page sliding in as you switch
 * tabs is main's (Tabs.slideIn), since pages aren't part of this document.
 */

const reduced = matchMedia('(prefers-reduced-motion: reduce)')
let on = false
const live = () => on && !reduced.matches

/** Puffs go here, over everything, so they can spill out of the sidebar's clipping. */
const layer = document.createElement('div')
layer.className = 'whimsy-layer'
layer.setAttribute('aria-hidden', 'true')
document.body.append(layer)

export function setWhimsy(enabled: boolean) {
  on = enabled
  document.documentElement.classList.toggle('whimsy', enabled)
}

/** One loop of a loading tab's firefly, in ms; FIREFLY_MS in ui.css. */
const FIREFLY_MS = 1400

/**
 * The firefly for a loading row or pinned icon. ui.css only shows it with Whimsy on. Its loop
 * starts where the clock says, so a redraw (and a loading sidebar redraws often) carries it on
 * from where it was rather than throwing it back to the start.
 */
export const firefly = () =>
  `<span class="firefly" aria-hidden="true" style="--ff-at:-${Math.round(performance.now() % FIREFLY_MS)}ms"></span>`

/** Loops of the two fireflies round a page's icon while it opens; WAIT_MS in ui.css. */
const WAIT_MS = [1800, 2300]

/** The fireflies round the icon of a page that's opening, in step with the clock as above. */
export const waitFly = () =>
  `<span class="wait-fly" aria-hidden="true" style="${WAIT_MS.map((ms, i) => `--ff-at${i + 1}:-${Math.round(performance.now() % ms)}ms`).join(';')}"></span>`

/** The tab whose load each address bar's lantern is lit for. */
const lit = new WeakMap<HTMLElement, string>()

/**
 * A lantern glow drifts back and forth in an address bar while its tab loads. When that tab's
 * page is in, the glow blooms across the bar and fades as the firefly flies up out of it. A bar
 * that switches to another tab just goes dark: that tab didn't finish anything.
 */
export function lantern(bar: HTMLElement, tabId: string | null, loading: boolean) {
  if (loading && tabId && live()) {
    if (!bar.classList.contains('lantern-on')) {
      bar.classList.remove('lantern-end')
      bar.style.removeProperty('--lantern-x')
      bar.classList.add('lantern-on')
    }
    lit.set(bar, tabId)
    return
  }
  if (!bar.classList.contains('lantern-on')) return
  const finished = lit.get(bar) === tabId && live()
  // Where the glow had drifted to, so it blooms from there.
  const x = getComputedStyle(bar).getPropertyValue('--lantern-x')
  bar.classList.remove('lantern-on')
  lit.delete(bar)
  if (!finished) return
  bar.style.setProperty('--lantern-x', x)
  bar.classList.add('lantern-end')
  const done = (e: AnimationEvent) => {
    if (e.target !== bar || e.animationName !== 'lantern-bloom') return
    bar.removeEventListener('animationend', done)
    bar.classList.remove('lantern-end')
    bar.style.removeProperty('--lantern-x')
  }
  bar.addEventListener('animationend', done)
}

const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#1a7f8e'

/** A puff of smoke where something was. */
function poof(rect: DOMRect, color: string) {
  const cloud = document.createElement('span')
  cloud.className = 'whimsy-cloud'
  cloud.style.left = `${rect.left + rect.width / 2}px`
  cloud.style.top = `${rect.top + rect.height / 2}px`
  cloud.style.setProperty('--c', color)
  layer.append(cloud)
  cloud
    .animate(
      [
        { transform: 'translate(-50%, -50%) scale(0.3)', opacity: 0.9 },
        { transform: 'translate(-50%, -50%) scale(1.25)', opacity: 0 },
      ],
      { duration: 420, easing: 'cubic-bezier(0.2, 0.8, 0.3, 1)', fill: 'forwards' },
    )
    .finished.finally(() => cloud.remove())
}

/** A one-off flourish on an element that stays in the page (a toolbar button). */
export function flourish(el: Element | null, kind: 'spin' | 'twirl' | 'wiggle') {
  if (!live() || !el) return
  const frames: Record<typeof kind, Keyframe[]> = {
    spin: [{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }],
    twirl: [{ transform: 'rotate(0deg) scale(1)' }, { transform: 'rotate(100deg) scale(1.25)', offset: 0.5 }, { transform: 'rotate(180deg) scale(1)' }],
    wiggle: [
      { transform: 'rotate(0deg)' },
      { transform: 'rotate(-18deg) scale(1.15)', offset: 0.2 },
      { transform: 'rotate(14deg) scale(1.15)', offset: 0.45 },
      { transform: 'rotate(-8deg)', offset: 0.7 },
      { transform: 'rotate(0deg)' },
    ],
  }
  el.animate(frames[kind], { duration: kind === 'spin' ? 520 : 480, easing: 'cubic-bezier(0.34, 1.3, 0.64, 1)' })
}

// ---------- the sidebar ----------

const BIRTH: Keyframe[] = [
  { transform: 'scale(0.6) translateY(-6px)', opacity: 0 },
  { transform: 'scale(1.06)', opacity: 1, offset: 0.6 },
  { transform: 'scale(1)', opacity: 1 },
]
const HOP: Keyframe[] = [
  { transform: 'translateY(0) scale(1, 1)' },
  { transform: 'translateY(1px) scale(1.2, 0.8)', offset: 0.15 },
  { transform: 'translateY(-6px) scale(0.9, 1.15)', offset: 0.45 },
  { transform: 'translateY(0) scale(1.1, 0.9)', offset: 0.75 },
  { transform: 'translateY(0) scale(1, 1)' },
]

/**
 * Animations still running when the sidebar redraws (titles and loading states redraw it often).
 * Each is played again on the new element, from where it had got to.
 */
interface Running {
  container: HTMLElement
  selector: string
  frames: Keyframe[]
  options: KeyframeAnimationOptions & { duration: number }
  start: number
}
let running: Running[] = []

function play(container: HTMLElement, selector: string, frames: Keyframe[], options: Running['options']) {
  const el = container.querySelector(selector)
  if (!el) return
  el.animate(frames, options)
  running.push({ container, selector, frames, options, start: performance.now() })
}

/** Where each row and pinned icon was before a redraw, by `kind:id`, with its profile color. */
let before = new Map<string, { rect: DOMRect; color: string }>()
let knownTabs: Set<string> | null = null
let lastActive: string | null = null
let lastFilter = ''

const itemSelector = '.row[data-id], .pin-tile[data-id]'
const keyOf = (el: HTMLElement) => `${el.classList.contains('pin-tile') ? 'pin' : 'row'}:${el.dataset.id}`
const selectorFor = (key: string) => {
  const [kind, id] = key.split(/:(.*)/s)
  return `${kind === 'pin' ? '.pin-tile' : '.row'}[data-id="${CSS.escape(id)}"]`
}

/** Call just before the sidebar's rows and icons are redrawn. */
export function beforeRender(containers: HTMLElement[]) {
  before = new Map()
  if (!live()) return
  for (const c of containers)
    for (const el of c.querySelectorAll<HTMLElement>(itemSelector)) {
      const key = keyOf(el)
      if (!before.has(key)) before.set(key, { rect: el.getBoundingClientRect(), color: el.style.getPropertyValue('--pc') })
    }
}

/**
 * Call just after the redraw. Tabs that weren't there before pop in, tabs that are gone for good
 * puff away where they were, the rest glide from where they were, and a newly active tab hops.
 * A changed filter swaps the whole list, so that redraw only lets the active tab hop.
 */
export function afterRender(containers: HTMLElement[], state: { tabIds: string[]; activeId: string | null; filter: string; clip: DOMRect }) {
  const tabs = new Set(state.tabIds)
  const firstTime = knownTabs === null
  const prevTabs = knownTabs ?? tabs
  const prevActive = lastActive
  const swapped = state.filter !== lastFilter
  knownTabs = tabs
  lastActive = state.activeId
  lastFilter = state.filter
  const now = performance.now()
  running = running.filter((r) => now - r.start < r.options.duration)
  if (!live() || firstTime) return

  // Carry on with what was running.
  for (const r of running) {
    const el = r.container.querySelector(r.selector)
    if (el) el.animate(r.frames, r.options).currentTime = now - r.start
  }

  const after = new Set<string>()
  for (const c of containers)
    for (const el of c.querySelectorAll<HTMLElement>(itemSelector)) {
      const key = keyOf(el)
      if (after.has(key)) continue
      after.add(key)
      const id = el.dataset.id!
      const was = before.get(key)
      if (!prevTabs.has(id)) {
        play(c, selectorFor(key), BIRTH, { duration: 380, easing: 'cubic-bezier(0.34, 1.4, 0.64, 1)' })
      } else if (was && !swapped && was.rect.height) {
        const now = el.getBoundingClientRect()
        const dx = was.rect.left + was.rect.width / 2 - (now.left + now.width / 2)
        const dy = was.rect.top + was.rect.height / 2 - (now.top + now.height / 2)
        if (Math.abs(dx) > 1 || Math.abs(dy) > 1)
          el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], {
            duration: 340,
            easing: 'cubic-bezier(0.34, 1.25, 0.64, 1)',
            composite: 'add',
          })
      }
    }

  // Gone from the state, not just from view: closed or archived.
  const { clip } = state
  for (const [key, was] of before) {
    const id = key.split(/:(.*)/s)[1]
    if (tabs.has(id) || after.has(key)) continue
    const r = was.rect
    const cy = r.top + r.height / 2
    if (!r.height || cy < clip.top || cy > clip.bottom) continue
    poof(r, was.color || accent())
  }

  if (state.activeId && state.activeId !== prevActive && tabs.has(state.activeId) && prevTabs.has(state.activeId)) {
    const sel = `${selectorFor(`row:${state.activeId}`)} .fav, ${selectorFor(`pin:${state.activeId}`)} .fav`
    for (const c of containers) play(c, sel, HOP, { duration: 520, easing: 'ease-out' })
  }
}

/** A wiggle for each download that just finished. */
const dlStates = new Map<string, string>()
export function downloadsChanged(list: { id: string; state: string }[], buttonFor: (id: string) => Element | null) {
  for (const d of list) {
    const prev = dlStates.get(d.id)
    if (prev && prev !== 'completed' && d.state === 'completed') {
      flourish(buttonFor(d.id), 'wiggle')
    }
    dlStates.set(d.id, d.state)
  }
  const ids = new Set(list.map((d) => d.id))
  for (const id of dlStates.keys()) if (!ids.has(id)) dlStates.delete(id)
}
