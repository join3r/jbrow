/**
 * Whimsical touches, off unless turned on under Animation in settings: tabs pop in and vanish in a
 * puff, rows glide to their new places, the tab you switch to hops, finished downloads throw
 * confetti. All of it is Web Animations on elements the render already made, so nothing replays
 * when the sidebar redraws, and macOS's Reduce motion turns it all off.
 */

const reduced = matchMedia('(prefers-reduced-motion: reduce)')
let on = false
const live = () => on && !reduced.matches

/** Particles go here, over everything, so they can fly out of the sidebar's clipping. */
const layer = document.createElement('div')
layer.className = 'whimsy-layer'
layer.setAttribute('aria-hidden', 'true')
document.body.append(layer)

export function setWhimsy(enabled: boolean) {
  on = enabled
  document.documentElement.classList.toggle('whimsy', enabled)
}

const accent = () => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#1a7f8e'
const CONFETTI = ['#f6c344', '#ef6f6c', '#5bc0eb', '#9bc53d', '#c879ff']
const rand = (min: number, max: number) => min + Math.random() * (max - min)

/** `n` bits flung out from the middle of `rect`, falling a little as they fade. */
function burst(rect: DOMRect, colors: string[], n: number, reach: number, confetti = false) {
  const x = rect.left + rect.width / 2
  const y = rect.top + rect.height / 2
  for (let i = 0; i < n; i++) {
    const bit = document.createElement('span')
    bit.className = confetti ? 'whimsy-bit confetti' : 'whimsy-bit'
    bit.style.background = colors[i % colors.length]
    bit.style.left = `${x}px`
    bit.style.top = `${y}px`
    layer.append(bit)
    const angle = (i / n) * Math.PI * 2 + rand(-0.3, 0.3)
    const dist = reach * rand(0.6, 1.1)
    const dx = Math.cos(angle) * dist
    const dy = Math.sin(angle) * dist
    const spin = confetti ? rand(-540, 540) : 0
    const fall = confetti ? reach * 0.8 : reach * 0.15
    bit
      .animate(
        [
          { transform: 'translate(-50%, -50%) scale(0.4) rotate(0deg)', opacity: 1 },
          { transform: `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px)) scale(1) rotate(${spin / 2}deg)`, opacity: 1, offset: 0.45 },
          { transform: `translate(calc(-50% + ${dx * 1.15}px), calc(-50% + ${dy * 1.15 + fall}px)) scale(0.6) rotate(${spin}deg)`, opacity: 0 },
        ],
        { duration: confetti ? rand(700, 1000) : rand(420, 560), easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)', fill: 'forwards' },
      )
      .finished.finally(() => bit.remove())
  }
}

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
  burst(rect, [color, accent()], 9, Math.min(46, Math.max(22, rect.width * 0.25)))
}

/** Confetti from an element, for things worth a small celebration. */
export function celebrate(el: Element | null) {
  if (!live() || !el) return
  burst(el.getBoundingClientRect(), [accent(), ...CONFETTI], 18, 56, true)
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

/** Confetti for each download that just finished. */
const dlStates = new Map<string, string>()
export function downloadsChanged(list: { id: string; state: string }[], buttonFor: (id: string) => Element | null) {
  for (const d of list) {
    const prev = dlStates.get(d.id)
    if (prev && prev !== 'completed' && d.state === 'completed') {
      const b = buttonFor(d.id)
      celebrate(b)
      flourish(b, 'wiggle')
    }
    dlStates.set(d.id, d.state)
  }
  const ids = new Set(list.map((d) => d.id))
  for (const id of dlStates.keys()) if (!ids.has(id)) dlStates.delete(id)
}
