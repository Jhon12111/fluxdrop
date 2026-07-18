'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('flux', {
  getState: () => ipcRenderer.invoke('get-state'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  chooseDownloadDir: () => ipcRenderer.invoke('choose-download-dir'),
  openDownloads: () => ipcRenderer.invoke('open-downloads'),
  pickAndSend: (deviceId, mode) => ipcRenderer.invoke('pick-and-send', { deviceId, mode }),
  sendPaths: (deviceId, paths) => ipcRenderer.invoke('send-paths', { deviceId, paths }),
  cancelTransfer: (id) => ipcRenderer.invoke('cancel-transfer', id),
  clearHistory: () => ipcRenderer.invoke('clear-history'),
  sendToIp: (ip, mode) => ipcRenderer.invoke('send-to-ip', { ip, mode }),
  respondRequest: (id, accept, trust) => ipcRenderer.invoke('respond-request', { id, accept, trust }),
  forgetTrusted: () => ipcRenderer.invoke('forget-trusted'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  contactDeveloper: () => ipcRenderer.invoke('contact-developer'),
  onDevices: (fn) => ipcRenderer.on('devices', (e, devices) => fn(devices)),
  onTransfer: (fn) => ipcRenderer.on('transfer', (e, record) => fn(record)),
  onRequest: (fn) => ipcRenderer.on('request', (e, info) => fn(info)),
  onRequestResolved: (fn) => ipcRenderer.on('request-resolved', (e, id) => fn(id)),
});
