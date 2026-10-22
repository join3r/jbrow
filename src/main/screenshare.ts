import { desktopCapturer, Menu, systemPreferences, type BrowserWindow, type DesktopCapturerSource, type MenuItemConstructorOptions } from 'electron'

/** Menu thumbnails, in points. */
const THUMB_HEIGHT = 36

const thumb = (source: DesktopCapturerSource) =>
  source.thumbnail.isEmpty() ? undefined : source.thumbnail.resize({ height: THUMB_HEIGHT, quality: 'good' })

/**
 * Asks what to share with a menu at the cursor: screens first, then windows. Closing the
 * menu without a choice cancels the share. Needs macOS Screen Recording permission; without
 * it macOS asks the first time, and the list holds only the screens until it's granted.
 */
export async function pickShareSource(win: BrowserWindow, callback: (streams: Electron.Streams | null) => void) {
  let sources: DesktopCapturerSource[]
  try {
    sources = await desktopCapturer.getSources({
      types: ['screen', 'window'],
      thumbnailSize: { width: Math.round(THUMB_HEIGHT * 3.2), height: THUMB_HEIGHT * 2 },
    })
  } catch (error) {
    console.error('[screenshare] could not list screens and windows:', error)
    return callback(null)
  }
  if (systemPreferences.getMediaAccessStatus('screen') !== 'granted') {
    console.warn('[screenshare] no Screen Recording permission; grant it in System Settings > Privacy & Security')
  }

  let answered = false
  const answer = (streams: Electron.Streams | null) => {
    if (answered) return
    answered = true
    callback(streams)
  }
  const item = (source: DesktopCapturerSource, label: string): MenuItemConstructorOptions => ({
    label,
    icon: thumb(source),
    click: () => answer({ video: source }),
  })

  const screens = sources.filter((s) => s.id.startsWith('screen:'))
  const windows = sources.filter((s) => s.id.startsWith('window:') && s.name)
  const template: MenuItemConstructorOptions[] = [
    { label: 'Share', enabled: false },
    ...screens.map((s, i) => item(s, screens.length > 1 ? s.name || `Screen ${i + 1}` : 'Entire screen')),
  ]
  if (windows.length) template.push({ type: 'separator' }, ...windows.map((s) => item(s, s.name)))

  if (win.isDestroyed()) return answer(null)
  // A menu item's click arrives after the menu reports closing, so wait a beat before cancelling.
  Menu.buildFromTemplate(template).popup({ window: win, callback: () => setTimeout(() => answer(null), 100) })
}
