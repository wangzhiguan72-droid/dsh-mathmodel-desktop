'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('updateSettings', {
  get: () => ipcRenderer.invoke('desktop:update-settings-get'),
  save: value => ipcRenderer.invoke('desktop:update-settings-save', value),
});
