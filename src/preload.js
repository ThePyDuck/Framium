'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const stateListeners = new Set();
const commandListeners = new Set();

ipcRenderer.on('framium:state', (_event, state) => {
  for (const listener of stateListeners) listener(state);
});

ipcRenderer.on('framium:command', (_event, command) => {
  for (const listener of commandListeners) listener(command);
});

contextBridge.exposeInMainWorld('framium', {
  getState: () => ipcRenderer.invoke('framium:get-state'),
  onState: (listener) => {
    stateListeners.add(listener);
    return () => stateListeners.delete(listener);
  },
  onCommand: (listener) => {
    commandListeners.add(listener);
    return () => commandListeners.delete(listener);
  },
  newTab: (url) => ipcRenderer.send('framium:new-tab', url),
  closeTab: (id) => ipcRenderer.send('framium:close-tab', id),
  activateTab: (id) => ipcRenderer.send('framium:activate-tab', id),
  reorderTabs: (ids) => ipcRenderer.send('framium:reorder-tabs', ids),
  duplicateTab: (id) => ipcRenderer.send('framium:duplicate-tab', id),
  vanishTab: (url) => ipcRenderer.send('framium:vanish-tab', url),
  tabAction: (id, action) => ipcRenderer.send('framium:tab-action', { id, action }),
  reopenClosedTab: () => ipcRenderer.send('framium:reopen-tab'),
  navigate: (value) => ipcRenderer.send('framium:navigate', value),
  nav: (action) => ipcRenderer.send('framium:nav', action),
  toggleBookmark: () => ipcRenderer.send('framium:toggle-bookmark'),
  removeBookmark: (id) => ipcRenderer.send('framium:remove-bookmark', id),
  clearHistory: () => ipcRenderer.send('framium:clear-history'),
  clearDownloads: () => ipcRenderer.send('framium:clear-downloads'),
  openItem: (url, newTab = false) => ipcRenderer.send('framium:open-item', { url, newTab }),
  updateSettings: (patch) => ipcRenderer.send('framium:update-settings', patch),
  clearBrowsingData: () => ipcRenderer.invoke('framium:clear-browsing-data'),
  loadExtension: () => ipcRenderer.invoke('framium:load-extension'),
  removeExtension: (id) => ipcRenderer.invoke('framium:remove-extension', id),
  newWindow: (amnesia = false) => ipcRenderer.send('framium:new-window', amnesia),
  setInsets: (insets) => ipcRenderer.send('framium:set-insets', insets),
  windowAction: (action) => ipcRenderer.send('framium:window', action),
  find: (text, options) => ipcRenderer.send('framium:find', { text, options }),
  stopFind: (action = 'clearSelection') => ipcRenderer.send('framium:stop-find', action),
  zoom: (action) => ipcRenderer.send('framium:zoom', action),
  pageAction: (action) => ipcRenderer.send('framium:page-action', action)
});
