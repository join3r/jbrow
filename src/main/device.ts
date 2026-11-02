import type { Rectangle, WebContents } from 'electron'
import type { DeviceMode } from '../shared/types'

/** The width a page sees in each view, in CSS pixels: an iPad Air and an iPhone 15 standing up. */
const WIDTHS: Record<Exclude<DeviceMode, 'desktop'>, number> = { tablet: 820, mobile: 393 }

/**
 * The user agent a page gets in a view: Chrome on Android, with "Mobile" for a phone, so sites that
 * pick their layout on the server send their tablet or phone pages too. Chrome's version stays.
 */
export function deviceUserAgent(mode: DeviceMode, desktop: string): string {
  if (mode === 'desktop') return desktop
  const chrome = /Chrome\/(\S+)/.exec(desktop)?.[1] ?? '130.0.0.0'
  const mobile = mode === 'mobile' ? ' Mobile' : ''
  return `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chrome}${mobile} Safari/537.36`
}

/**
 * Where a tablet or phone page goes in the area its tab has: a column the device's width in the
 * middle, as tall as the area. An area narrower than the device gets all of it.
 */
export function deviceBounds(mode: DeviceMode, area: Rectangle): Rectangle {
  if (mode === 'desktop') return area
  const width = Math.min(area.width, WIDTHS[mode])
  return { ...area, x: area.x + Math.round((area.width - width) / 2), width }
}

/**
 * Lays the page out as a tablet or phone would in a view `bounds` big (from deviceBounds): the
 * device's width, with mobile viewport rules, shrunk to fit a view narrower than the device.
 */
export function emulate(wc: WebContents, mode: DeviceMode, bounds: Rectangle) {
  if (wc.isDestroyed()) return
  if (mode === 'desktop') return wc.disableDeviceEmulation()
  const width = WIDTHS[mode]
  const scale = Math.min(1, bounds.width / width)
  const size = { width, height: Math.max(1, Math.round(bounds.height / scale)) }
  wc.enableDeviceEmulation({
    screenPosition: 'mobile',
    screenSize: size,
    viewPosition: { x: 0, y: 0 },
    viewSize: size,
    deviceScaleFactor: 0,
    scale,
  })
}
