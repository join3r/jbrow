import { contextBridge, ipcRenderer } from 'electron'

/**
 * Electron's permission check can only say granted or denied, so a site that hasn't been asked yet
 * reads "denied" from navigator.permissions.query() and Notification.permission. Sites that look
 * first then never ask: Google Meet shows "Meet is blocked from using your microphone and camera"
 * and jbrow's prompt never comes up. This tells the page "prompt" (Notification's "default") while
 * you haven't allowed or blocked the permission, as Chrome does. The main process decides that
 * (SitePermissions.undecided), so a page can't talk its way into anything: asking still goes
 * through jbrow's prompt. Only top frames, which jbrow asks for by their own origin.
 */
function start() {
  if (!/^https?:$/.test(location.protocol) || window !== window.top) return
  contextBridge.executeInMainWorld({
    func: (undecided: (name: string) => Promise<boolean>, undecidedNow: (name: string) => boolean) => {
      // The names permissions.query() takes, for what jbrow asks about.
      const NAMES = new Set(['camera', 'microphone', 'geolocation', 'notifications', 'clipboard-read', 'midi', 'idle-detection', 'window-management'])
      const state = Object.getOwnPropertyDescriptor(PermissionStatus.prototype, 'state')!.get!
      const query = Object.getOwnPropertyDescriptor(Permissions.prototype, 'query')!
      const original = query.value as Permissions['query']
      const patched = {
        query(this: Permissions, descriptor: PermissionDescriptor & { sysex?: boolean }) {
          return original.call(this, descriptor).then(async (status) => {
            const name = descriptor?.name === 'midi' && descriptor.sysex ? 'midiSysex' : descriptor?.name
            if (state.call(status) === 'denied' && NAMES.has(descriptor?.name) && (await undecided(name))) {
              Object.defineProperty(status, 'state', {
                configurable: true,
                get() {
                  const real = state.call(this) as PermissionState
                  return real === 'denied' ? 'prompt' : real
                },
              })
            }
            return status
          })
        },
      }.query
      Object.defineProperty(Permissions.prototype, 'query', { ...query, value: patched })

      const permission = Object.getOwnPropertyDescriptor(Notification, 'permission')
      if (!permission?.get) return
      const real = permission.get
      const patchedPermission = Object.getOwnPropertyDescriptor(
        {
          get permission() {
            const value = real.call(Notification) as NotificationPermission
            return value === 'denied' && undecidedNow('notifications') ? 'default' : value
          },
        },
        'permission',
      )!.get
      Object.defineProperty(Notification, 'permission', { ...permission, get: patchedPermission })
    },
    args: [
      (name: string) => ipcRenderer.invoke('jbrow:permission-undecided', name),
      (name: string) => ipcRenderer.sendSync('jbrow:permission-undecided', name) as boolean,
    ],
  })
}

try {
  start()
} catch (error) {
  console.error('[jbrow] permission states:', error)
}
