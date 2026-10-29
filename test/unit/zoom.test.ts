import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { WebContents } from 'electron'
import type { Settings } from '../../src/main/settings'
import { Zoom, ZOOM_STEPS, zoomSite } from '../../src/main/zoom'

/** A page with a URL and a zoom factor, recording what was set. */
function page(url: string, factor = 1) {
  const wc = {
    url,
    factor,
    destroyed: false,
    sets: [] as number[],
    getURL: () => wc.url,
    getZoomFactor: () => wc.factor,
    setZoomFactor(f: number) {
      wc.factor = f
      wc.sets.push(f)
    },
    isDestroyed: () => wc.destroyed,
  }
  return wc
}
const asWc = (p: ReturnType<typeof page>) => p as unknown as WebContents

function setup(zoom: Partial<Settings['zoom']> = {}) {
  const settings = { zoom: { defaultPercent: 100, remember: true, sites: {}, ...zoom } } as Settings
  let saves = 0
  const z = new Zoom(() => settings, () => void saves++)
  return { z, settings, saves: () => saves }
}

test('ZOOM_STEPS are Chrome’s, ascending and including 100', () => {
  assert.deepEqual(ZOOM_STEPS, [25, 33, 50, 67, 75, 80, 90, 100, 110, 125, 150, 175, 200, 250, 300, 400, 500])
  for (let i = 1; i < ZOOM_STEPS.length; i++) assert.ok(ZOOM_STEPS[i] > ZOOM_STEPS[i - 1])
})

test('zoomSite is the hostname without www for web pages only', () => {
  assert.equal(zoomSite('https://www.example.com/a?b#c'), 'example.com')
  assert.equal(zoomSite('http://example.com:8080/'), 'example.com')
  assert.equal(zoomSite('https://WWW.Example.COM/'), 'example.com')
  assert.equal(zoomSite('https://www2.example.com/'), 'www2.example.com')
  assert.equal(zoomSite('https://sub.www.example.com/'), 'sub.www.example.com')
  assert.equal(zoomSite('http://localhost:3000/'), 'localhost')
  assert.equal(zoomSite('http://[::1]:8080/'), '[::1]')
  assert.equal(zoomSite('http://192.168.1.1/'), '192.168.1.1')
  assert.equal(zoomSite('https://bücher.de/'), 'xn--bcher-kva.de')
  for (const url of ['file:///C:/Users/me/a.html', 'file:///tmp/a.html', 'about:blank', 'chrome-extension://abc/popup.html', 'data:text/html,hi', 'not a url', '']) {
    assert.equal(zoomSite(url), null, url)
  }
})

test('percentFor uses the site’s zoom, else the default', () => {
  const { z } = setup({ defaultPercent: 110, sites: { 'example.com': 150 } })
  assert.equal(z.percentFor('https://www.example.com/x'), 150)
  assert.equal(z.percentFor('https://other.com/'), 110)
  assert.equal(z.percentFor('file:///a.html'), 110)
})

test('step moves through the steps and remembers the site', () => {
  const { z, settings, saves } = setup()
  const wc = page('https://www.example.com/')
  assert.equal(z.step(asWc(wc), 1), 110)
  assert.equal(wc.factor, 1.1)
  assert.deepEqual(settings.zoom.sites, { 'example.com': 110 })
  assert.equal(z.step(asWc(wc), 1), 125)
  assert.equal(saves(), 2)
  assert.equal(z.step(asWc(wc), -1), 110)
  assert.equal(z.step(asWc(wc), -1), 100)
  // Back at the default, the site is forgotten.
  assert.deepEqual(settings.zoom.sites, {})
  assert.equal(z.step(asWc(wc), -1), 90)
  assert.equal(z.step(asWc(wc), 0), 100)
  assert.deepEqual(settings.zoom.sites, {})
})

test('step from a zoom between steps goes to the next one', () => {
  const { z } = setup()
  assert.equal(z.step(asWc(page('https://a.com/', 1.17)), 1), 125)
  assert.equal(z.step(asWc(page('https://a.com/', 1.17)), -1), 110)
  // 0.333… rounds to 33, which is a step itself.
  assert.equal(z.step(asWc(page('https://a.com/', 1 / 3)), 1), 50)
  assert.equal(z.step(asWc(page('https://a.com/', 1 / 3)), -1), 25)
})

test('step stops at the ends', () => {
  const { z } = setup()
  assert.equal(z.step(asWc(page('https://a.com/', 5)), 1), 500)
  assert.equal(z.step(asWc(page('https://a.com/', 0.25)), -1), 25)
  assert.equal(z.step(asWc(page('https://a.com/', 9)), 1), 500)
  assert.equal(z.step(asWc(page('https://a.com/', 0.1)), -1), 25)
})

test('⌘0 goes to the default percent, which may not be 100', () => {
  const { z, settings } = setup({ defaultPercent: 125 })
  const wc = page('https://a.com/', 2)
  settings.zoom.sites['a.com'] = 200
  assert.equal(z.step(asWc(wc), 0), 125)
  assert.equal(wc.factor, 1.25)
  assert.deepEqual(settings.zoom.sites, {})
})

test('pages without a site zoom but remember nothing', () => {
  const { z, settings, saves } = setup()
  const wc = page('file:///C:/Users/me/page.html')
  assert.equal(z.step(asWc(wc), 1), 110)
  assert.equal(wc.factor, 1.1)
  assert.deepEqual(settings.zoom.sites, {})
  assert.equal(saves(), 0)
})

test('without remember, zooms last for the session and nothing is saved', () => {
  const { z, settings, saves } = setup({ remember: false })
  const wc = page('https://a.com/')
  z.step(asWc(wc), 1)
  assert.deepEqual(settings.zoom.sites, {})
  assert.equal(saves(), 0)
  assert.equal(z.percentFor('https://a.com/'), 110)
  assert.deepEqual(z.list(), [{ site: 'a.com', percent: 110 }])
})

test('apply gives a page its site’s zoom only when it differs', () => {
  const { z } = setup({ sites: { 'a.com': 150 } })
  const wc = page('https://a.com/x')
  z.apply(asWc(wc))
  assert.deepEqual(wc.sets, [1.5])
  z.apply(asWc(wc))
  assert.deepEqual(wc.sets, [1.5])
  const other = page('https://b.com/', 1.5)
  z.apply(asWc(other))
  assert.deepEqual(other.sets, [1])
})

test('apply leaves destroyed pages and non-web pages alone', () => {
  const { z } = setup({ defaultPercent: 150 })
  const dead = page('https://a.com/')
  dead.destroyed = true
  z.apply(asWc(dead))
  const file = page('file:///tmp/a.html')
  z.apply(asWc(file))
  const blank = page('about:blank')
  z.apply(asWc(blank))
  assert.deepEqual([dead.sets, file.sets, blank.sets], [[], [], []])
})

test('setRemember on keeps what was zoomed since launch', () => {
  const { z, settings } = setup({ remember: false, sites: { 'old.com': 90 } })
  z.step(asWc(page('https://a.com/')), 1)
  z.setRemember(true)
  assert.equal(settings.zoom.remember, true)
  assert.deepEqual(settings.zoom.sites, { 'old.com': 90, 'a.com': 110 })
})

test('setRemember off moves remembered zooms into the session', () => {
  const { z, settings } = setup({ sites: { 'a.com': 150 } })
  z.setRemember(false)
  assert.equal(settings.zoom.remember, false)
  assert.deepEqual(settings.zoom.sites, {})
  assert.equal(z.percentFor('https://a.com/'), 150)
  // And back on, they're remembered again.
  z.setRemember(true)
  assert.deepEqual(settings.zoom.sites, { 'a.com': 150 })
})

test('setRemember to the current value changes nothing', () => {
  const { z, settings } = setup({ sites: { 'a.com': 150 } })
  z.setRemember(true)
  assert.deepEqual(settings.zoom.sites, { 'a.com': 150 })
})

test('list is sorted by site and forget removes one', () => {
  const { z, saves } = setup({ sites: { 'zeta.com': 90, 'alpha.com': 125, 'localhost': 200 } })
  assert.deepEqual(z.list().map((s) => s.site), ['alpha.com', 'localhost', 'zeta.com'])
  z.forget('alpha.com')
  assert.deepEqual(z.list(), [{ site: 'localhost', percent: 200 }, { site: 'zeta.com', percent: 90 }])
  assert.equal(saves(), 1)
  z.forget('never.com')
  assert.equal(z.list().length, 2)
})
