import { contextBridge, ipcRenderer } from 'electron'

// Only jbrow's permission prompt (src/ui/permission-prompt.html) gets this preload, but check anyway.
if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('permissionPrompt', {
    on(listener: (view: unknown) => void) {
      ipcRenderer.on('prompt:view', (_event, view) => listener(view))
    },
    onShown(listener: () => void) {
      ipcRenderer.on('prompt:shown', () => listener())
    },
    size(height: number) {
      ipcRenderer.send('prompt:size', height)
    },
    answer(data: { id: number; allow?: boolean; remember?: boolean; dismissed?: boolean }) {
      ipcRenderer.send('prompt:answer', data)
    },
  })
}
