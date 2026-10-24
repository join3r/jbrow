import { contextBridge, ipcRenderer } from 'electron'

// Only jbrow's sign-in sheet (src/ui/signin.html) gets this preload, but check anyway.
if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('signin', {
    on(listener: (view: unknown) => void) {
      ipcRenderer.on('signin:view', (_event, view) => listener(view))
    },
    answer(data: { id: number; username?: string; password?: string }) {
      ipcRenderer.send('signin:answer', data)
    },
  })
}
