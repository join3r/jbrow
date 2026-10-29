import { app, dialog, session, type BaseWindow, type Session, type WebContents } from 'electron'
import { ElectronChromeExtensions, type ChromeExtensionOptions } from 'electron-chrome-extensions'
import { installChromeWebStore, installExtension } from 'electron-chrome-web-store'
import path from 'node:path'
import type { Profile } from '../shared/types'
import { shimContentScripts } from './content-shim'
import { installedFolders } from './extension-files'
import { trackInstalls } from './installed'
import type { DeviceChooser } from './devices'
import { writeJbrowExtension } from './jbrow-extension'
import type { SitePermissions } from './permissions'
import type { Settings } from './settings'

export interface ProfileRuntime {
  profile: Profile
  partition: string
  session: Session
  extensions: ElectronChromeExtensions
  extensionsPath: string
}

/**
 * How the extension library reaches back into jbrow's tabs. Shared by every profile. Past the
 * library's own hooks are jbrow's, added by scripts/patch-deps.mjs: tabs without a page (asleep, or
 * not opened since launch) have no WebContents, so jbrow lists them and loads one when asked.
 */
export type TabHooks = (profileId: string) => Pick<ChromeExtensionOptions, 'selectTab' | 'removeTab' | 'createWindow' | 'removeWindow'> & {
  /** `extension` is the one that called chrome.tabs.create, if one did. */
  createTab: (details: chrome.tabs.CreateProperties, extension?: Electron.Extension) => Promise<[WebContents, BaseWindow]>
  /** jbrow's window, which holds every profile's tabs. */
  mainWindow: () => BaseWindow
  /** The profile's tabs without a page, as chrome.tabs.Tab. */
  pagelessTabs: () => chrome.tabs.Tab[]
  /** The tab without a page an extension knows by `id`, as chrome.tabs.Tab. */
  pagelessTab: (id: number) => chrome.tabs.Tab | undefined
  /** The page of the tab an extension knows by `id`; with `wake`, a tab without one gets it. */
  tabFor: (id: number, wake: boolean) => WebContents | undefined
  removePagelessTab: (id: number) => void
}

export const partitionFor = (profileId: string) => `persist:profile-${profileId}`

/** Electron's own user agent, read before jbrow replaces it. */
let electronUserAgent: string | undefined

/**
 * Chrome Web Store only offers "Add to Chrome" to user agents that look like Chrome.
 * Google sign-in is the exception: see setupProfiles.
 */
function chromeLikeUserAgent(ua: string): string {
  return ua.replace(/\sElectron\/\S+/, '').replace(new RegExp(`\\s${app.getName()}/\\S+`, 'i'), '')
}

export interface ProfileDeps {
  hooks: TabHooks
  pickShareSource: (callback: (streams: Electron.Streams | null) => void) => void
  permissions: SitePermissions
  devices: DeviceChooser
  /** Adds jbrow's own extension APIs (idle, sidePanel, userScripts) to a profile, before its extensions load and start. */
  attach: (rt: ProfileRuntime) => void
}

export async function setupProfiles(settings: Settings, deps: ProfileDeps): Promise<Map<string, ProfileRuntime>> {
  const runtimes = new Map<string, ProfileRuntime>()
  for (const profile of settings.profiles) runtimes.set(profile.id, await setupProfile(profile, settings, deps))
  return runtimes
}

/** Sets up one profile's session and extensions. Also used for a profile added in settings. */
export async function setupProfile(profile: Profile, settings: Settings, { hooks, pickShareSource, permissions, devices, attach }: ProfileDeps): Promise<ProfileRuntime> {
  const partition = partitionFor(profile.id)
  const sess = session.fromPartition(partition)
  // Google sign-in gets the real user agent from jbrow's own extension (see jbrow-extension.ts):
  // a session.webRequest listener here would switch off every extension's declarativeNetRequest.
  electronUserAgent ??= app.userAgentFallback
  const ownExtension = writeJbrowExtension(electronUserAgent)
  sess.setUserAgent(chromeLikeUserAgent(electronUserAgent))
  // A cross-site frame in its own process (Cloudflare's Turnstile on bistro.sk's login) reads
  // navigator.userAgent from the app's user agent, not the session's. Left as Electron's, it
  // disagrees with the Chrome one in the request headers, and Turnstile fails the check.
  app.userAgentFallback = chromeLikeUserAgent(electronUserAgent)

  // Without a handler Electron rejects getDisplayMedia, so Meet and friends can't share the
  // screen. The macOS system picker (useSystemPicker) closes and reopens on the first click,
  // so jbrow asks with its own menu instead.
  sess.setDisplayMediaRequestHandler((_request, callback) => pickShareSource(callback))
  // Electron grants every permission unless told otherwise.
  permissions.attach(sess, profile)
  devices.attach(sess, profile.id)

  // Must be registered before ElectronChromeExtensions, whose preload freezes `chrome`.
  // JBROW_NO_SHIMS=1 turns them off, to compare behavior while debugging.
  if (!process.env.JBROW_NO_SHIMS) {
    const shims = path.join(__dirname, 'preload-extension-shims.js')
    sess.registerPreloadScript({ id: 'jbrow-shims-sw', type: 'service-worker', filePath: shims })
    sess.registerPreloadScript({ id: 'jbrow-shims-frame', type: 'frame', filePath: shims })
    trackInstalls(sess)
  }

  // Two-finger swipe back and forward in tab pages; see src/preload/swipe.ts.
  sess.registerPreloadScript({ id: 'jbrow-swipe', type: 'frame', filePath: path.join(__dirname, 'preload-swipe.js') })
  // Tells pages they may still ask for what you haven't decided; see src/preload/permissions.ts.
  sess.registerPreloadScript({ id: 'jbrow-permissions', type: 'frame', filePath: path.join(__dirname, 'preload-permissions.js') })
  // Extensions' user scripts (chrome.userScripts) in tab pages; see src/preload/user-scripts.ts.
  sess.registerPreloadScript({ id: 'jbrow-user-scripts', type: 'frame', filePath: path.join(__dirname, 'preload-user-scripts.js') })

  const extensions = new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session: sess,
    ...hooks(profile.id),
  })

  const extensionsPath = path.join(app.getPath('userData'), 'Extensions', profile.id)
  const rt: ProfileRuntime = { profile, partition, session: sess, extensions, extensionsPath }
  attach(rt)
  if (!process.env.JBROW_NO_SHIMS) shimContentScripts(sess, extensionsPath)
  await installChromeWebStore({
    session: sess,
    extensionsPath,
    // jbrow loads them itself below, leaving out the ones you turned off.
    loadExtensions: false,
    async beforeInstall(details) {
      const permissions = [...(details.manifest.permissions ?? []), ...(details.manifest.host_permissions ?? [])]
      const options = {
        type: 'question' as const,
        title: `Add "${details.localizedName}" to ${profile.name}?`,
        message: `Add "${details.localizedName}" to ${profile.name}?`,
        detail: permissions.length ? `It can use: ${permissions.join(', ')}` : undefined,
        icon: details.icon,
        buttons: ['Cancel', 'Add extension'],
        defaultId: 1,
        cancelId: 0,
      }
      const win = details.browserWindow && !details.browserWindow.isDestroyed() ? details.browserWindow : null
      const { response } = win ? await dialog.showMessageBox(win, options) : await dialog.showMessageBox(options)
      return { action: response === 1 ? 'allow' : 'deny' }
    },
  })

  try {
    await sess.extensions.loadExtension(ownExtension)
  } catch (error) {
    console.error(`[profiles] ${profile.id}: could not load jbrow's own extension:`, error)
  }

  const disabled = settings.disabledExtensions[profile.id] ?? []
  for (const [id, ext] of installedFolders(extensionsPath)) {
    if (disabled.some((d) => d.id === id)) continue
    try {
      await sess.extensions.loadExtension(ext.path)
    } catch (error) {
      console.error(`[profiles] ${profile.id}: could not load ${ext.path}:`, error)
    }
  }

  for (const dir of settings.unpackedExtensions[profile.id] ?? []) {
    if (disabled.some((d) => d.path === dir)) continue
    try {
      const ext = await sess.extensions.loadExtension(dir, { allowFileAccess: true })
      console.log(`[profiles] ${profile.id}: loaded unpacked ${ext.name} from ${dir}`)
    } catch (error) {
      console.error(`[profiles] ${profile.id}: could not load unpacked extension at ${dir}:`, error)
    }
  }

  await Promise.all(sess.extensions.getAllExtensions().map((ext) => startWorker(sess, ext, profile.id)))

  console.log(`[profiles] ${profile.id}: ${sess.extensions.getAllExtensions().length} extension(s) loaded`)
  return rt
}

/** MV3 service workers don't start on their own until something wakes them. */
export async function startWorker(sess: Session, ext: Electron.Extension, profileId: string) {
  const manifest = ext.manifest as { manifest_version?: number; background?: { service_worker?: string } }
  if (manifest.manifest_version === 3 && manifest.background?.service_worker) {
    await sess.serviceWorkers.startWorkerForScope(ext.url).catch((error) => {
      console.error(`[profiles] ${profileId}: worker for ${ext.name} did not start:`, error)
    })
  }
}

/**
 * Loads an unpacked extension folder into a profile. Loading a folder that's already loaded
 * reloads it, which is what you want after editing your own extension.
 */
export async function loadUnpacked(rt: ProfileRuntime, dir: string): Promise<Electron.Extension> {
  const existing = rt.session.extensions.getAllExtensions().find((e) => e.path === dir)
  if (existing) rt.session.extensions.removeExtension(existing.id)
  const ext = await rt.session.extensions.loadExtension(dir, { allowFileAccess: true })
  console.log(`[profiles] ${rt.profile.id}: loaded unpacked ${ext.name} from ${dir}`)
  await startWorker(rt.session, ext, rt.profile.id)
  return ext
}

/** Your must-have extensions, installable in one go from the menu bar item. */
export const TEST_EXTENSIONS: { id: string; name: string }[] = [
  { id: 'nngceckbapebfimnlniiiahkandclblb', name: 'Bitwarden' },
  { id: 'ddkjiahejlhfcafbddmgiahcphecmpfh', name: 'uBlock Origin Lite' },
  { id: 'fngbdhimbgbonhlibfmiemipheabfdmj', name: 'D.Bridge 2' },
  { id: 'nomnklagbgmgghhjidfhnoelnjfndfpd', name: 'Canvas Blocker' },
  { id: 'mdjildafknihdffpkfmmpnpoiajfjnjd', name: 'Consent-O-Matic' },
  { id: 'ponfpcnoihfmfllpaingbgckeeldkhle', name: 'Enhancer for YouTube' },
  { id: 'mnjggcdmjocbbbhaepdhchncahnbgone', name: 'SponsorBlock' },
  { id: 'nffaoalbilbmmfgbnbgppjihopabppdk', name: 'Video Speed Controller' },
  { id: 'onhcdbnmlldkpneodnponijjndidkgph', name: 'SideHN' },
]

export async function installTestExtensions(rt: ProfileRuntime): Promise<string[]> {
  const results: string[] = []
  for (const { id, name } of TEST_EXTENSIONS) {
    if (rt.session.extensions.getExtension(id)) {
      results.push(`${name}: already installed`)
      continue
    }
    try {
      await installExtension(id, { session: rt.session, extensionsPath: rt.extensionsPath })
      results.push(`${name}: installed`)
    } catch (error) {
      const cause = error instanceof Error && error.cause instanceof Error ? `: ${error.cause.message}` : ''
      results.push(`${name}: failed (${error instanceof Error ? error.message : String(error)}${cause})`)
    }
  }
  return results
}
