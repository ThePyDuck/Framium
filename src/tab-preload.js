'use strict';

const { contextBridge, ipcRenderer } = require('electron');

if (location.protocol === 'framium:' && location.hostname === 'home') {
  contextBridge.exposeInMainWorld('framiumHome', {
    getData: () => ipcRenderer.invoke('framium:home-data'),
    updateHome: (patch) => ipcRenderer.send('framium:home-update', patch),
    chooseBackgroundImage: () => ipcRenderer.invoke('framium:home-choose-background'),
    removeBackgroundImage: () => ipcRenderer.invoke('framium:home-remove-background'),
    open: (url, newTab = false) => ipcRenderer.send('framium:home-open', { url, newTab }),
    customizeBrowser: () => ipcRenderer.send('framium:show-settings')
  });
}

if (location.protocol === 'framium:' && location.hostname === 'downloads') {
  const listeners = new Set();
  ipcRenderer.on('framium:downloads-updated', (_event, downloads) => {
    for (const listener of listeners) listener(downloads);
  });

  contextBridge.exposeInMainWorld('framiumDownloads', {
    getData: () => ipcRenderer.invoke('framium:downloads-data'),
    action: (action, id = null) => ipcRenderer.invoke('framium:download-action', { action, id }),
    startDrag: (id) => ipcRenderer.send('framium:start-download-drag', id),
    onUpdated: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    }
  });
}
