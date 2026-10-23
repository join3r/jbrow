import { app, dialog, session, type Session } from 'electron'
import { ElectronChromeExtensions, type ChromeExtensionOptions } from 'electron-chrome-extensions'
import { installChromeWebStore, installExtension } from 'electron-chrome-web-store'
import path from 'node:path'
import type { Profile } from '../shared/types'
import { shimContentScripts } from './content-shim'
import type { SitePermissions } from './permissions'
import type { Settings } from './settings'

export interface ProfileRuntime {
  profile: Profile
  partition: string
  session: Session
  extensions: ElectronChromeExtensions
  extensionsPath: string
}

/** How the extension library reaches back into jbrow's tabs. Shared by every profile. */
export type TabHooks = (profileId: string) => Pick<
  ChromeExtensionOptions,
  'createTab' | 'selectTab' | 'removeTab' | 'createWindow' | 'removeWindow'
>

export const partitionFor = (profileId: string) => `persist:profile-${profileId}`

/**
 * Chrome Web Store only offers "Add to Chrome" to user agents that look like Chrome.
 * Google sign-in is the exception: see setupProfiles.
 */
function chromeLikeUserAgent(s: Session): string {
  return s
    .getUserAgent()
    .replace(/\sElectron\/\S+/, '')
    .replace(new RegExp(`\\s${app.getName()}/\\S+`, 'i'), '')
}

export interface ProfileDeps {
  hooks: TabHooks
  pickShareSource: (callback: (streams: Electron.Streams | null) => void) => void
  permissions: SitePermissions
}

export async function setupProfiles(settings: Settings, deps: ProfileDeps): Promise<Map<string, ProfileRuntime>> {
  const runtimes = new Map<string, ProfileRuntime>()
  for (const profile of settings.profiles) runtimes.set(profile.id, await setupProfile(profile, settings, deps))
  return runtimes
}

/** Sets up one profile's session and extensions. Also used for a profile added in settings. */
export async function setupProfile(profile: Profile, settings: Settings, { hooks, pickShareSource, permissions }: ProfileDeps): Promise<ProfileRuntime> {
  const partition = partitionFor(profile.id)
  const sess = session.fromPartition(partition)
  const electronUserAgent = sess.getUserAgent()
  sess.setUserAgent(chromeLikeUserAgent(sess))

  // Google sign-in rejects a browser that claims to be Chrome but doesn't behave like it
  // ("This browser or app may not be secure"). Told the truth, it serves its lighter sign-in
  // flow, which works.
  sess.webRequest.onBeforeSendHeaders({ urls: ['https://accounts.google.com/*'] }, (details, callback) => {
    details.requestHeaders['User-Agent'] = electronUserAgent
    callback({ requestHeaders: details.requestHeaders })
  })

  // Without a handler Electron rejects getDisplayMedia, so Meet and friends can't share the
  // screen. The macOS system picker (useSystemPicker) closes and reopens on the first click,
  // so jbrow asks with its own menu instead.
  sess.setDisplayMediaRequestHandler((_request, callback) => pickShareSource(callback))
  // Electron grants every permission unless told otherwise.
  permissions.attach(sess, profile)

  // Must be registered before ElectronChromeExtensions, whose preload freezes `chrome`.
  // JBROW_NO_SHIMS=1 turns them off, to compare behavior while debugging.
  if (!process.env.JBROW_NO_SHIMS) {
    const shims = path.join(__dirname, 'preload-extension-shims.js')
    sess.registerPreloadScript({ id: 'jbrow-shims-sw', type: 'service-worker', filePath: shims })
    sess.registerPreloadScript({ id: 'jbrow-shims-frame', type: 'frame', filePath: shims })
  }

  const extensions = new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session: sess,
    ...hooks(profile.id),
  })

  const extensionsPath = path.join(app.getPath('userData'), 'Extensions', profile.id)
  if (!process.env.JBROW_NO_SHIMS) shimContentScripts(sess, extensionsPath)
  await installChromeWebStore({
    session: sess,
    extensionsPath,
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

  for (const dir of settings.unpackedExtensions[profile.id] ?? []) {
    try {
      const ext = await sess.extensions.loadExtension(dir, { allowFileAccess: true })
      console.log(`[profiles] ${profile.id}: loaded unpacked ${ext.name} from ${dir}`)
    } catch (error) {
      console.error(`[profiles] ${profile.id}: could not load unpacked extension at ${dir}:`, error)
    }
  }

  await Promise.all(sess.extensions.getAllExtensions().map((ext) => startWorker(sess, ext, profile.id)))

  console.log(`[profiles] ${profile.id}: ${sess.extensions.getAllExtensions().length} extension(s) loaded`)
  return { profile, partition, session: sess, extensions, extensionsPath }
}

/** MV3 service workers don't start on their own until something wakes them. */
async function startWorker(sess: Session, ext: Electron.Extension, profileId: string) {
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
