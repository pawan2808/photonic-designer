/**
 * preload.js — Secure Context Bridge
 * 
 * Exposes controlled APIs to the renderer process.
 * No direct Node.js access from the web page.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // License
  activateLicense: (key) => ipcRenderer.invoke('license:activate', key),
  licenseActivated: () => ipcRenderer.invoke('license:activated'),
  getFingerprint: () => ipcRenderer.invoke('license:fingerprint'),

  // Menu events (from native menu)
  onMenuNew: (cb) => ipcRenderer.on('menu:new', cb),
  onMenuSave: (cb) => ipcRenderer.on('menu:save', cb),
  onMenuSaveAs: (cb, filePath) => ipcRenderer.on('menu:save-as', (e, fp) => cb(fp)),
  onMenuOpenFile: (cb) => ipcRenderer.on('menu:open-file', (e, fp) => cb(fp)),
  onMenuExportGds: (cb) => ipcRenderer.on('menu:export-gds', cb),
  onMenuOpenKlayout: (cb) => ipcRenderer.on('menu:open-klayout', cb),
  onMenuUndo: (cb) => ipcRenderer.on('menu:undo', cb),
  onMenuRedo: (cb) => ipcRenderer.on('menu:redo', cb),

  // Platform info
  platform: process.platform,
  arch: process.arch,
  isElectron: true
});
