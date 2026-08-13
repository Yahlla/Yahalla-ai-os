// Exposes only a minimal, explicit bridge to the renderer -- the runtime's
// local base URL and auth token, plus two one-way status event streams
// (runtime process lifecycle, first-run model setup progress) -- never the
// full Node/Electron API surface (contextIsolation stays on,
// nodeIntegration stays off).
const { contextBridge, ipcRenderer } = require('electron')

function subscribe(channel, callback) {
  const listener = (_event, payload) => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('yahallaDesktop', {
  getRuntimeInfo: () => ipcRenderer.invoke('yahalla:get-runtime-info'),
  onRuntimeStatus: (callback) => subscribe('yahalla:runtime-status', callback),
  onModelStatus: (callback) => subscribe('yahalla:model-status', callback),
})
