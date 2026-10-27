const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('swiftpdf', {
  openDialog: () => ipcRenderer.invoke('open-dialog'),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath),
  saveFile: (filePath, data) => ipcRenderer.invoke('save-file', filePath, data),
  saveDialog: (defaultName, data) => ipcRenderer.invoke('save-dialog', defaultName, data),
  getPendingFile: () => ipcRenderer.invoke('get-pending-file'),
  onOpenFile: (cb) => ipcRenderer.on('open-file', (_e, file) => cb(file)),
  setDirty: (value) => ipcRenderer.send('set-dirty', value),
  setTitle: (title) => ipcRenderer.send('set-title', title),
  pathForFile: (file) => {
    try { return webUtils.getPathForFile(file) || null; } catch { return null; }
  },
});
