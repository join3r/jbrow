import { contextBridge, ipcRenderer } from 'electron'
import { injectBrowserAction } from 'electron-chrome-extensions/browser-action'

// Only jbrow's own UI page gets this preload, but check anyway.
if (location.protocol === 'file:') {
  // Defines <browser-action-list>, the row of extension buttons.
  injectBrowserAction()

  const inbound = new Set(['state', 'archived', 'anim', 'focus-omnibox', 'find', 'toast', 'url-copied', 'settings', 'rename-tab', 'folder-rules', 'shortcuts', 'extensions', 'apps', 'run-action', 'downloads', 'rename-profile', 'default-browser', 'updates', 'suggestions', 'search-suggestions', 'welcome'])
  contextBridge.exposeInMainWorld('jbrow', {
    on(channel: string, listener: (data: unknown) => void) {
      if (inbound.has(channel)) ipcRenderer.on(channel, (_event, data) => listener(data))
    },
    send(channel: string, data?: unknown) {
      ipcRenderer.send(`ui:${channel}`, data)
    },
  })
}
