// Exposes only a minimal, explicit bridge to the renderer -- the runtime's
// local base URL and auth token -- never the full Node/Electron API
// surface (contextIsolation stays on, nodeIntegration stays off).
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('yahallaDesktop', {
  getRuntimeInfo: () => ipcRenderer.invoke('yahalla:get-runtime-info'),
})
