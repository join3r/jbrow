import { SEARCH_ENGINES } from '../shared/engines'
import { shortcutFromKey, type ActionId } from '../shared/shortcuts'
import { THEMES, type AppEntry, type Prefs, type Profile, type UiState } from '../shared/types'

/**
 * The welcome: a tour of jbrow that sets its main settings on the way. It shows over the whole
 * window at first launch (until it's been through or skipped, `welcomed` in settings.json), and
 * again from Help → Welcome to jbrow, the menu bar item or General in settings. Every choice applies
 * right away through the same messages settings uses, except pinning, which waits for the end so
 * the window doesn't start hiding on click-away halfway through.
 */

type Send = (channel: string, data?: unknown) => void
type StepId = 'hello' | 'mode' | 'keys' | 'look' | 'profiles' | 'tabs' | 'privacy' | 'ready'

const STEPS: { id: StepId; label: string }[] = [
  { id: 'hello', label: 'Hello' },
  { id: 'mode', label: 'Pinned or ethereal' },
  { id: 'keys', label: 'Keys and motion' },
  { id: 'look', label: 'Look' },
  { id: 'profiles', label: 'Profiles' },
  { id: 'tabs', label: 'Tabs and links' },
  { id: 'privacy', label: 'Search and privacy' },
  { id: 'ready', label: 'Ready' },
]

const EASES = {
  spring: 'cubic-bezier(0.34, 1.45, 0.64, 1)',
  snappy: 'cubic-bezier(0.2, 0.9, 0.3, 1)',
  smooth: 'cubic-bezier(0.4, 0, 0.2, 1)',
}
const FRAMES: Record<string, Keyframe[]> = {
  materialize: [{ opacity: 0, transform: 'scale(0.965)', filter: 'blur(10px)' }, { opacity: 1, transform: 'scale(1)', filter: 'blur(0)' }],
  slide: [{ opacity: 0, transform: 'translateY(-28px)' }, { opacity: 1, transform: 'translateY(0)' }],
  scale: [{ opacity: 0, transform: 'scale(0.86)' }, { opacity: 1, transform: 'scale(1)' }],
  fade: [{ opacity: 0 }, { opacity: 1 }],
}
const ENGINE_COLORS: Record<string, string> = { google: '#4285f4', duckduckgo: '#de5833', bing: '#0f7b6c', brave: '#fb542b', kagi: '#f5a623', ecosia: '#2d9b4c' }
const GLYPHS: Record<string, string> = { Command: '⌘', Control: '⌃', Alt: '⌥', Shift: '⇧', Up: '↑', Down: '↓', Left: '←', Right: '→' }
const MAC_ORDER = ['Control', 'Alt', 'Shift', 'Command']

const esc = (v: unknown) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** A shortcut as key caps, ⌥ then Space. */
function caps(shortcut: string) {
  if (!shortcut) return '<span class="wl-none">none</span>'
  const parts = shortcut.split('+')
  const key = parts.pop()!
  const keys = [...MAC_ORDER.filter((m) => parts.includes(m)), key]
  return `<span class="wl-keys">${keys.map((k) => `<kbd>${esc(GLYPHS[k] ?? k)}</kbd>`).join('')}</span>`
}
const days = (n: number) => (n === 1 ? '1 day' : `${n} days`)

export interface Welcome {
  open(first: boolean): void
  readonly isOpen: boolean
}

export function initWelcome(el: HTMLElement, send: Send, changed: () => void): Welcome {
  let S: UiState | null = null
  let apps: AppEntry[] = []
  let defaultBrowser: 'yes' | 'no' | 'dev' | null = null
  let isOpen = false
  let first = false
  let step = 0
  let seen = 0
  let pinned = true
  let recording: ActionId | null = null
  let message = ''
  let lastKey = ''
  let focusNewProfile = 0
  // The little Mac on the first three steps.
  let shown = false
  let sceneMode: 'pinned' | 'ethereal' = 'ethereal'

  const q = <T extends HTMLElement>(sel: string) => el.querySelector<T>(sel)
  const stateKey = (s: UiState) => JSON.stringify([s.prefs, s.profiles, s.keys.show, s.keys.showApp, s.thirdPartyCookiesBlocked])

  function open(isFirst: boolean) {
    first = isFirst
    step = 0
    seen = isFirst ? 0 : STEPS.length - 1
    pinned = S?.pinned ?? true
    message = ''
    isOpen = true
    el.hidden = false
    send('focus-ui')
    send('apps')
    send('default-browser')
    render()
    el.focus()
    changed()
  }

  function close() {
    stopRecording()
    isOpen = false
    el.hidden = true
    el.innerHTML = ''
    send('welcome-done', { pinned })
    changed()
    send('focus-page')
  }

  function go(i: number) {
    if (i < 0 || i >= STEPS.length) return
    step = i
    seen = Math.max(seen, i)
    message = ''
    render()
    q('.wl-pane')?.scrollTo({ top: 0 })
  }

  // ---------- changing settings ----------

  function prefs(patch: Partial<Prefs>) {
    if (!S) return
    S = { ...S, prefs: { ...S.prefs, ...patch } }
    lastKey = stateKey(S)
    if (patch.theme) document.documentElement.dataset.theme = patch.theme
    send('prefs', patch)
    render()
  }

  function updateProfile(id: string, change: Partial<Profile>) {
    if (!S) return
    S = { ...S, profiles: S.profiles.map((p) => (p.id === id ? { ...p, ...change } : p)) }
    lastKey = stateKey(S)
    send('profile', { id, ...change })
  }

  function stopRecording() {
    if (!recording) return
    recording = null
    send('recording-shortcut', { on: false })
    if (isOpen) render()
  }

  // ---------- rendering ----------

  function render() {
    if (!isOpen || !S) return
    const focused = (document.activeElement as HTMLElement | null)?.id
    const id = STEPS[step].id
    const last = step === STEPS.length - 1
    el.innerHTML = `
      <div class="wl-drag"></div>
      <aside class="wl-rail">
        <div class="wl-brand"><span class="wl-mark">jb</span><b>Welcome</b></div>
        <ol class="wl-steps">${STEPS.map(
          (s, i) => `<li><button id="wl-go-${i}" data-act="go" data-v="${i}" class="${i !== step && i <= seen ? 'done' : ''}" ${i === step ? 'aria-current="step"' : ''} ${i > seen ? 'disabled' : ''}>
            <span class="n">${i + 1}</span><span>${s.label}</span></button></li>`,
        ).join('')}</ol>
        ${last ? '' : `<button id="wl-skip" class="wl-skip" data-act="skip">${first ? 'Skip and keep the defaults' : 'Close'}</button>`}
      </aside>
      <div class="wl-pane">
        <section class="wl-step wl-step-${id}">${VIEWS[id]()}</section>
        <footer class="wl-foot">
          <span class="wl-msg" aria-live="polite">${esc(message)}</span>
          ${step ? '<button id="wl-back" class="wl-btn" data-act="back">Back</button>' : ''}
          <button id="wl-next" class="wl-btn primary${step === 0 || last ? ' big' : ''}" data-act="next">${step === 0 ? 'Set up jbrow' : last ? 'Start browsing' : 'Continue'}</button>
        </footer>
      </div>`
    if (id === 'hello' || id === 'mode' || id === 'keys') initScene(id === 'hello' ? 'ethereal' : pinned ? 'pinned' : 'ethereal')
    const again = focused && document.getElementById(focused)
    if (again && el.contains(again)) again.focus()
    else if (!el.contains(document.activeElement)) el.focus()
    if (focusNewProfile && S.profiles.length > focusNewProfile) {
      focusNewProfile = 0
      const names = el.querySelectorAll<HTMLInputElement>('.wl-prof input.name')
      names[names.length - 1]?.select()
    }
  }

  const seg = (act: string, options: [string, string][], value: string) =>
    `<div class="wl-seg" role="group">${options.map(([v, l]) => `<button id="wl-${act}-${v}" data-act="${act}" data-v="${v}" aria-pressed="${v === value}">${l}</button>`).join('')}</div>`
  const toggle = (pref: string, on: boolean, title: string, sub: string) => `
    <label class="wl-row"><span class="txt"><span class="label">${title}</span><span class="sub">${sub}</span></span>
      <span class="wl-switch"><input type="checkbox" id="wl-pref-${pref}" data-pref="${pref}" ${on ? 'checked' : ''}><span></span></span></label>`
  const profileColor = (i: number) => S!.profiles[i % S!.profiles.length].color

  function sceneHtml() {
    const p = S!.profiles.find((x) => x.id === S!.prefs.defaultProfile) ?? S!.profiles[0]
    const tab = (name: string, i: number, on = false) => `<div class="tab${on ? ' on' : ''}" style="--c:${esc(profileColor(i))}">${esc(name)}</div>`
    return `
      <div class="wl-scene" id="wl-scene" role="button" tabindex="0" aria-label="Show or hide jbrow">
        <div class="menubar"><span></span><span>File</span><span>Edit</span><span>View</span><span class="jb">jb</span></div>
        <div class="app"><i style="width:40%"></i><i class="c" style="width:62%"></i><i style="width:78%"></i><i style="width:52%"></i><i class="c" style="width:34%"></i><i style="width:70%"></i><i style="width:46%"></i></div>
        <div class="mini" hidden style="--pc:${esc(p.color)}">
          <div class="side">
            <div class="lights"></div>
            <div class="pins"><b></b><b></b><b></b></div>
            <div class="sec">Kept</div>${tab('Linear · Sprint', 0)}${tab('Calendar', 1)}
            <div class="sec">Today</div>${tab('MDN · Popover API', 0, true)}${tab('Hacker News', 1)}${tab('Pull request #482', 0)}
          </div>
          <div class="main"><div class="addr">developer.mozilla.org</div><div class="page"><i class="h"></i><i></i><i style="width:85%"></i><i style="width:70%"></i><i></i><i style="width:60%"></i></div></div>
        </div>
        <div class="sdock"><b></b><b></b><b></b><b class="me">jb</b></div>
        <div class="press"></div>
      </div>`
  }

  const VIEWS: Record<StepId, () => string> = {
    hello: () => `
      <div class="wl-hello">
        <div class="wl-head">
          <span class="wl-eyebrow">Welcome to jbrow</span>
          <h1>A browser that can be there <em>only when you call it.</em></h1>
          <p class="wl-lede">jbrow starts as a regular window, like any browser. Unpin it and it has no window at all: a key brings it up over whatever you're doing, and clicking back into your work sends it away. You choose which in the next step.</p>
          <ul class="wl-facts">
            <li><b>Chrome extensions</b> from the Chrome Web Store, Bitwarden and uBlock included.</li>
            <li><b>Profiles side by side</b>: Work and Personal tabs in one list, each signed in separately.</li>
            <li><b>Tabs that tidy themselves</b>: unused ones fall asleep, then archive.</li>
          </ul>
        </div>
        ${sceneHtml()}
      </div>`,

    mode: () => `
      <div class="wl-head">
        <span class="wl-eyebrow">Pinned or ethereal</span>
        <h2>Keep it pinned, or let it disappear?</h2>
        <p class="wl-lede">Try each one on the little Mac: click the other app and see what jbrow does. Switch any time with the pin in the toolbar or ${caps(S!.keys.pin)}.</p>
      </div>
      <div class="wl-grid2">
        <button id="wl-mode-pinned" class="wl-choice" data-act="mode" data-v="pinned" aria-pressed="${pinned}">
          <span class="art"><span class="w"></span><span class="dock"><b></b><b></b><b class="me"></b><b></b></span></span>
          <span class="t">Pinned ${first ? '<span class="wl-tag">How jbrow starts</span>' : ''}</span>
          <span class="d">A regular window with a Dock icon, in ⌘Tab like any app. It stays where it is when you click elsewhere. Your key still shows and hides it.</span>
        </button>
        <button id="wl-mode-ethereal" class="wl-choice" data-act="mode" data-v="ethereal" aria-pressed="${!pinned}">
          <span class="art"><span class="ghost"></span><span class="k">${caps(S!.keys.show)}</span></span>
          <span class="t">Ethereal</span>
          <span class="d">No window and no Dock icon, only <b>jb</b> in the menu bar. ${caps(S!.keys.show)} brings jbrow up over whatever you're doing; click back into your work and it's gone.</span>
        </button>
      </div>
      ${sceneHtml()}`,

    keys: () => {
      const a = S!.prefs.animation
      return `
      <div class="wl-head">
        <span class="wl-eyebrow">Keys and motion</span>
        <h2>Pick your key and how jbrow arrives</h2>
      </div>
      <div class="wl-recorder">
        <span class="txt"><span class="label">Show jbrow</span><span class="sub">Brings it up with every tab, from any app.</span></span>
        <button id="wl-rec-show" class="wl-rec${recording === 'show' ? ' listening' : ''}" data-act="rec" data-v="show">${recording === 'show' ? 'Press keys…' : caps(S!.keys.show)}</button>
      </div>
      <div class="wl-recorder">
        <span class="txt"><span class="label">Show the tabs of the app you're in</span><span class="sub">Each app gets its own tabs. Links from Slack land under Slack.</span></span>
        <button id="wl-rec-showApp" class="wl-rec${recording === 'showApp' ? ' listening' : ''}" data-act="rec" data-v="showApp">${recording === 'showApp' ? 'Press keys…' : caps(S!.keys.showApp)}</button>
      </div>
      ${S!.keys.show === 'Alt+Space' ? '<p class="wl-note">Raycast and Alfred also use ⌥Space by default. If yours does, click the key above and press another.</p>' : ''}
      <div class="wl-grid2 top">
        <div class="wl-group">
          <span class="label">Animation</span>
          ${seg('anim-style', [['materialize', 'Materialize'], ['slide', 'Slide'], ['scale', 'Scale'], ['fade', 'Fade'], ['off', 'Off']], a.style)}
          <span class="label">Feel</span>
          ${seg('anim-ease', [['spring', 'Spring'], ['snappy', 'Snappy'], ['smooth', 'Smooth']], a.ease)}
          <span class="label">Speed <span class="sub" id="wl-dur-out">${a.durationMs} ms</span></span>
          <input type="range" id="wl-dur" min="100" max="400" step="10" value="${a.durationMs}" aria-label="Animation duration">
          <button id="wl-anim-play" class="wl-btn" data-act="anim-play" ${a.style === 'off' ? 'disabled' : ''}>Play it on this window</button>
        </div>
        ${sceneHtml()}
      </div>`
    },

    look: () => {
      const p = S!.prefs
      return `
      <div class="wl-head">
        <span class="wl-eyebrow">Look</span>
        <h2>Make it yours</h2>
        <p class="wl-lede">Websites get your light or dark choice too, so sites with a dark mode follow along.</p>
      </div>
      <div class="wl-group">
        <span class="label">Appearance</span>
        ${seg('appearance', [['system', 'Match macOS'], ['light', 'Light'], ['dark', 'Dark']], p.appearance)}
      </div>
      <div class="wl-group">
        <span class="label">Color</span>
        <div class="wl-swatches">${THEMES.map(
          (t) => `<button id="wl-theme-${t.id}" class="wl-swatch" data-act="theme" data-v="${t.id}" aria-pressed="${t.id === p.theme}"><i data-theme="${t.id}"></i>${t.name}</button>`,
        ).join('')}</div>
      </div>
      <div class="wl-group">
        <span class="label">Profile in the address bar</span>
        ${seg('profile-style', [['tint', 'Tint'], ['edge', 'Tint and edge'], ['solid', 'Solid']], p.profileStyle)}
        <span class="sub">How strongly the address bar shows which profile the tab is in.</span>
      </div>`
    },

    profiles: () => {
      const def = S!.prefs.defaultProfile
      const options: { id: string; name: string; color: string }[] = [{ id: '', name: 'Auto', color: '' }, ...S!.profiles]
      return `
      <div class="wl-head">
        <span class="wl-eyebrow">Profiles</span>
        <h2>Work and life, one sidebar</h2>
        <p class="wl-lede">Each profile has its own logins, cookies and extensions. Their tabs mix in one list, marked by color. In the address bar, Tab switches which profile a page opens in.</p>
      </div>
      <div class="wl-grid2 top">
        <div class="wl-group">
          <span class="label">Your profiles</span>
          ${S!.profiles
            .map(
              (p) => `
            <div class="wl-prof" style="--c:${esc(p.color)}">
              <span class="color"><input type="color" id="wl-color-${esc(p.id)}" data-profile="${esc(p.id)}" value="${esc(p.color)}" aria-label="Color of ${esc(p.name)}"></span>
              <input class="name" id="wl-name-${esc(p.id)}" data-profile="${esc(p.id)}" value="${esc(p.name)}" aria-label="Name of ${esc(p.name)}" maxlength="24" spellcheck="false">
              <button id="wl-def-${esc(p.id)}" class="def" data-act="default" data-v="${esc(p.id)}" aria-pressed="${p.id === def}" title="Links from other apps and new tabs open here when nothing else decides">${p.id === def ? 'Default' : 'Make default'}</button>
              ${S!.profiles.length > 1 ? `<button id="wl-rm-${esc(p.id)}" class="rm" data-act="delete-profile" data-v="${esc(p.id)}" title="Delete ${esc(p.name)}" aria-label="Delete ${esc(p.name)}">×</button>` : ''}
            </div>`,
            )
            .join('')}
          <button id="wl-add-profile" class="wl-add" data-act="add-profile">Add a profile</button>
        </div>
        <div class="wl-group">
          <span class="label">New tabs from these apps open in</span>
          ${
            apps.length
              ? apps
                  .map((e) => {
                    const icon = e.apps[0]?.icon ? `<img src="${esc(e.apps[0].icon)}" alt="">` : `<span class="no-icon">${esc(e.apps[0]?.name.slice(0, 1) ?? '?')}</span>`
                    const name = e.apps.map((a) => a.name).join(' + ')
                    return `<div class="wl-app">${icon}<span class="nm">${esc(name)}</span>
                      <div class="wl-seg small" role="group" aria-label="Profile for ${esc(name)}">${options
                        .map(
                          (p) =>
                            `<button id="wl-app-${esc(e.key)}-${esc(p.id)}" data-act="app-profile" data-app="${esc(e.key)}" data-v="${esc(p.id)}" aria-pressed="${e.profile === p.id}" title="${esc(p.id ? `New tabs open in ${p.name}` : 'New tabs open in the profile of the tab you were on')}">${p.color ? `<span class="dot" style="background:${esc(p.color)}"></span>` : ''}${esc(p.name)}</button>`,
                        )
                        .join('')}</div></div>`
                  })
                  .join('')
              : '<p class="sub">No apps yet.</p>'
          }
          <span class="sub">Add more apps, or link apps like VS Code and Terminal to share tabs, under Apps in settings.</span>
        </div>
      </div>`
    },

    tabs: () => {
      const p = S!.prefs
      const stepper = (k: 'summarizeAfterDays' | 'archiveAfterDays', title: string, sub: string) => `
        <div class="wl-row"><span class="txt"><span class="label">${title}</span><span class="sub">${sub}</span></span>
          <span class="wl-stepper"><button id="wl-${k}-less" data-act="days" data-k="${k}" data-v="-1" aria-label="Fewer days">−</button><output>${p[k] ? days(p[k]) : 'Never'}</output><button id="wl-${k}-more" data-act="days" data-k="${k}" data-v="1" aria-label="More days">+</button></span></div>`
      return `
      <div class="wl-head">
        <span class="wl-eyebrow">Tabs and links</span>
        <h2>A sidebar that keeps itself tidy</h2>
        <p class="wl-lede">Pin the sites you live in, keep the ones you'll come back to, and let the rest fade away on their own. Archived tabs are one search away for 90 days.</p>
      </div>
      <div class="wl-tabs">
        <div class="wl-sidebar" aria-hidden="true">
          <div class="pins"><b>M</b><b>C</b><b>L</b><b>G</b></div>
          <div class="sec">Kept</div>
          <div class="t" style="--c:${esc(profileColor(0))}"><span>Sprint board</span></div>
          <div class="t" style="--c:${esc(profileColor(1))}"><span>Flat in Lisbon</span></div>
          <div class="sec">Today</div>
          <div class="t on" style="--c:${esc(profileColor(0))}"><span>MDN · Popover API</span></div>
          <div class="t" style="--c:${esc(profileColor(1))}"><span>Hacker News</span></div>
          <div class="t sleep" style="--c:${esc(profileColor(0))}"><span>RFC 9110 <small>· ${p.summarizeAfterDays ? `${days(p.summarizeAfterDays)} ago` : 'open'}</small></span></div>
          ${p.archiveAfterDays ? '<div class="arch"><span>Archived 3 tabs</span><b>Undo</b></div>' : ''}
        </div>
        <div class="wl-group flush">
          ${stepper('summarizeAfterDays', 'Sleep after', 'The page unloads and the row says which site it was. Kept tabs never sleep.')}
          ${stepper('archiveAfterDays', 'Archive after', 'The tab leaves the sidebar. Undo puts it back where it was.')}
          ${toggle('quietLinks', p.quietLinks, 'Quiet links', 'Links an app opens on its own, without your click, wait in the background with a dot. The menu bar counts them: jb •2.')}
          ${toggle('miniOnHide', p.miniPlayer.onHide, 'Keep videos playing', 'A playing video moves to a picture-in-picture window when jbrow hides.')}
        </div>
      </div>`
    },

    privacy: () => {
      const p = S!.prefs
      const cookiesLater = p.blockThirdPartyCookies !== S!.thirdPartyCookiesBlocked ? ' Takes effect when jbrow restarts.' : ''
      return `
      <div class="wl-head">
        <span class="wl-eyebrow">Search and privacy</span>
        <h2>Where you search, and what stays yours</h2>
      </div>
      <div class="wl-group">
        <span class="label">Search with</span>
        <div class="wl-engines">${SEARCH_ENGINES.map(
          (e) => `<button id="wl-engine-${e.id}" class="wl-engine" data-act="engine" data-v="${esc(e.url)}" aria-pressed="${e.url === p.searchUrl}"><i style="--c:${ENGINE_COLORS[e.id] ?? 'var(--accent)'}">${esc(e.name[0])}</i>${esc(e.name)}</button>`,
        ).join('')}</div>
      </div>
      <div class="wl-group flush">
        ${toggle('searchSuggestions', p.searchSuggestions, 'Search suggestions', 'Ask the search engine as you type. Never for addresses or private ones.')}
        ${toggle('blockThirdPartyCookies', p.blockThirdPartyCookies, 'Block third-party cookies', `Sites can't follow you around through embedded trackers.${cookiesLater}`)}
        ${toggle('dangerousSites', p.dangerousSites, 'Warn about dangerous sites', 'Checked against phishing and malware lists on your Mac. Addresses you visit never leave it.')}
        ${toggle('hideFromScreenCapture', p.hideFromScreenCapture, 'Hide jbrow from screen sharing', 'Nobody on a call sees jbrow, even when you share your whole screen.')}
      </div>`
    },

    ready: () => {
      const p = S!.prefs
      const theme = THEMES.find((t) => t.id === p.theme)?.name ?? p.theme
      const engine = SEARCH_ENGINES.find((e) => e.url === p.searchUrl)?.name ?? 'Custom'
      const def = (S!.profiles.find((x) => x.id === p.defaultProfile) ?? S!.profiles[0]).name
      const look = { system: 'matching macOS', light: 'light', dark: 'dark' }[p.appearance]
      const browser =
        defaultBrowser === 'no'
          ? '<button id="wl-make-default" class="wl-btn" data-act="make-default">Make jbrow the default browser</button>'
          : defaultBrowser === 'yes'
            ? '<p class="sub">jbrow is your default browser. Links from other apps open here.</p>'
            : defaultBrowser === 'dev'
              ? '<p class="sub">Only the installed app can be the default browser, not jbrow running from source.</p>'
              : ''
      return `
      <div class="wl-head">
        <span class="wl-eyebrow">Ready</span>
        <h2>You're set. Press ${caps(S!.keys.show)} whenever you need it.</h2>
        <p class="wl-lede">Everything here can be changed later in settings (${caps(S!.keys.settings)}), and Help → Welcome to jbrow brings this back.</p>
      </div>
      <div class="wl-grid2 top">
        <div class="wl-group">
          <div class="wl-summary">
            <div><span>Show jbrow</span>${caps(S!.keys.show)}</div>
            <div><span>This app's tabs</span>${caps(S!.keys.showApp)}</div>
            <div><span>Window</span><b>${pinned ? 'Pinned' : 'Ethereal'}</b></div>
            <div><span>Look</span><b>${esc(theme)}, ${look}</b></div>
            <div><span>Profiles</span><b>${S!.profiles.map((x) => esc(x.name)).join(', ')} · default ${esc(def)}</b></div>
            <div><span>Search</span><b>${esc(engine)}</b></div>
            <div><span>Tabs</span><b>sleep ${p.summarizeAfterDays ? `after ${days(p.summarizeAfterDays)}` : 'never'}, archive ${p.archiveAfterDays ? `after ${days(p.archiveAfterDays)}` : 'never'}</b></div>
          </div>
          ${browser}
        </div>
        <div class="wl-group">
          <span class="label">Also in jbrow</span>
          <div class="wl-features">
            <div><span class="t">Split view ${caps(S!.keys.splitView)}</span><span class="d">Up to four tabs side by side.</span></div>
            <div><span class="t">Restyle a site</span><span class="d">Tell Claude how a site should look with the wand in the toolbar. It writes the stylesheet.</span></div>
            <div><span class="t">Extensions</span><span class="d">Install from the Chrome Web Store, per profile.</span></div>
            <div><span class="t">Reopen tab ${caps(S!.keys.reopenTab)}</span><span class="d">The last 25, in their old place, history included.</span></div>
            <div><span class="t">Swipe back</span><span class="d">Two fingers on the trackpad, as in Chrome.</span></div>
            <div><span class="t">Copy link ${caps(S!.keys.copyUrl)}</span><span class="d">The page's address, ready to paste.</span></div>
          </div>
        </div>
      </div>`
    },
  }

  // ---------- the little Mac ----------

  function initScene(mode: 'pinned' | 'ethereal') {
    const scene = q('#wl-scene')
    if (!scene) return
    sceneMode = mode
    scene.classList.add(mode)
    shown = mode === 'pinned'
    q('.wl-scene .mini')!.hidden = !shown
    setPress()
  }

  function setPress() {
    const press = q('.wl-scene .press')
    const scene = q('#wl-scene')
    if (!press || !scene) return
    press.textContent =
      sceneMode === 'ethereal'
        ? shown
          ? 'Click the other app to send it away'
          : 'Click to call jbrow'
        : !shown
          ? 'Click to bring jbrow back'
          : scene.classList.contains('appFront')
            ? 'jbrow stays put behind your app. Click it to come back'
            : 'Click the other app'
  }

  function toggleMini(want = !shown) {
    const mini = q('.wl-scene .mini')
    if (!mini || want === shown || !S) return
    shown = want
    q('#wl-scene')!.classList.remove('appFront')
    setPress()
    const { style, durationMs, ease } = S.prefs.animation
    const frames = FRAMES[style]
    mini.getAnimations().forEach((a) => a.cancel())
    if (!frames || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      mini.hidden = !want
      return
    }
    mini.hidden = false
    const anim = mini.animate(want ? frames : [...frames].reverse(), {
      duration: want ? durationMs : Math.round(durationMs * 0.75),
      easing: want ? EASES[ease] : 'cubic-bezier(0.4, 0, 1, 1)',
    })
    if (!want) anim.onfinish = () => (mini.hidden = true)
  }

  /** Pinned: clicking the other app puts it in front and jbrow stays where it is. Ethereal: clicking away hides jbrow. */
  function sceneClick(onMini: boolean) {
    if (!shown) return toggleMini(true)
    if (sceneMode === 'pinned') q('#wl-scene')!.classList.toggle('appFront', !onMini)
    else if (!onMini) toggleMini(false)
    setPress()
  }

  function replay() {
    if (!S) return
    if (!shown) return toggleMini(true)
    toggleMini(false)
    setTimeout(() => toggleMini(true), S.prefs.animation.durationMs + 120)
  }

  // ---------- events ----------

  el.addEventListener('click', (e) => {
    const target = e.target as HTMLElement
    const scene = target.closest('#wl-scene')
    if (scene) return sceneClick(!!target.closest('.mini'))
    const b = target.closest<HTMLElement>('[data-act]')
    if (!b || !S) return
    const v = b.dataset.v ?? ''
    switch (b.dataset.act) {
      case 'go':
        return go(Number(v))
      case 'back':
        return go(step - 1)
      case 'next':
        return step === STEPS.length - 1 ? close() : go(step + 1)
      case 'skip':
        return close()
      case 'mode':
        pinned = v === 'pinned'
        return render()
      case 'rec':
        if (recording === v) return stopRecording()
        if (!recording) send('recording-shortcut', { on: true })
        recording = v as ActionId
        return render()
      case 'anim-style':
        prefs({ animation: { ...S.prefs.animation, style: v as Prefs['animation']['style'] } })
        return replay()
      case 'anim-ease':
        prefs({ animation: { ...S.prefs.animation, ease: v as Prefs['animation']['ease'] } })
        return replay()
      case 'anim-play':
        return send('anim-preview')
      case 'appearance':
        return prefs({ appearance: v as Prefs['appearance'] })
      case 'theme':
        return prefs({ theme: v as Prefs['theme'] })
      case 'profile-style':
        return prefs({ profileStyle: v as Prefs['profileStyle'] })
      case 'default':
        S = { ...S, prefs: { ...S.prefs, defaultProfile: v } }
        lastKey = stateKey(S)
        send('default-profile', { id: v })
        return render()
      case 'delete-profile':
        // Main asks first, and the list follows the state it sends.
        return send('delete-profile', { id: v })
      case 'add-profile':
        focusNewProfile = S.profiles.length
        return send('add-profile', { rename: false })
      case 'app-profile':
        return send('app-profile', { key: b.dataset.app, profile: v })
      case 'days': {
        const k = b.dataset.k as 'summarizeAfterDays' | 'archiveAfterDays'
        return prefs({ [k]: Math.max(0, Math.min(90, S.prefs[k] + Number(v))) })
      }
      case 'engine':
        return prefs({ searchUrl: v })
      case 'make-default':
        return send('make-default-browser')
    }
  })

  el.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement
    if (!S) return
    if (input.dataset.pref) {
      const pref = input.dataset.pref
      if (pref === 'miniOnHide') return prefs({ miniPlayer: { ...S.prefs.miniPlayer, onHide: input.checked } })
      return prefs({ [pref]: input.checked })
    }
    if (input.id === 'wl-dur') {
      prefs({ animation: { ...S.prefs.animation, durationMs: Number(input.value) } })
      return replay()
    }
    const profile = input.dataset.profile
    if (!profile) return
    if (input.type === 'color') updateProfile(profile, { color: input.value })
    else if (input.value.trim()) updateProfile(profile, { name: input.value.trim() })
    render()
  })

  el.addEventListener('input', (e) => {
    const input = e.target as HTMLInputElement
    if (input.id === 'wl-dur') q('#wl-dur-out')!.textContent = `${input.value} ms`
    if (input.type === 'color') (input.closest('.wl-prof') as HTMLElement | null)?.style.setProperty('--c', input.value)
  })

  el.addEventListener('keydown', (e) => {
    const target = e.target as HTMLElement
    if (e.key === 'Escape' && !first) {
      e.stopPropagation()
      return close()
    }
    if (target.id === 'wl-scene' && (e.key === ' ' || e.key === 'Enter')) {
      e.preventDefault()
      return toggleMini()
    }
    if (e.key === 'Enter' && target.matches('input.name')) return target.blur()
    if (e.key === 'Enter' && !target.matches('input, button, select, textarea')) {
      e.preventDefault()
      q<HTMLButtonElement>('#wl-next')?.click()
    }
  })

  // Capture phase and first in line, so the keys you're choosing don't also do what they usually do.
  document.addEventListener(
    'keydown',
    (e) => {
      if (!recording) return
      e.preventDefault()
      e.stopImmediatePropagation()
      const plain = !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey
      if (e.key === 'Escape' && plain) return stopRecording()
      const shortcut = shortcutFromKey({ key: e.key, code: e.code, command: e.metaKey, control: e.ctrlKey, alt: e.altKey, shift: e.shiftKey })
      if (!shortcut) return
      send('set-action-key', { id: recording, shortcut })
      stopRecording()
    },
    true,
  )
  window.addEventListener('blur', stopRecording)

  window.jbrow.on('state', (state: UiState) => {
    S = state
    if (!isOpen) return
    const key = stateKey(state)
    if (key === lastKey) return
    lastKey = key
    render()
  })
  window.jbrow.on('apps', (data: { entries: AppEntry[] }) => {
    apps = data.entries
    if (isOpen && STEPS[step].id === 'profiles') render()
  })
  window.jbrow.on('default-browser', (status: 'yes' | 'no' | 'dev') => {
    defaultBrowser = status
    if (isOpen && STEPS[step].id === 'ready') render()
  })
  // Settings shows these at the foot of the sidebar, which the welcome covers.
  window.jbrow.on('toast', (text: string) => {
    if (!isOpen) return
    message = text
    const msg = q('.wl-msg')
    if (msg) msg.textContent = text
  })
  window.jbrow.on('welcome', ({ first: isFirst }: { first: boolean }) => open(isFirst))

  return {
    open,
    get isOpen() {
      return isOpen
    },
  }
}
