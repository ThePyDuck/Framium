'use strict';

const api = window.framium;
const $ = (selector) => document.querySelector(selector);
let state = null;
let libraryOpen = false;
let libraryMode = 'bookmarks';
let libraryQuery = '';
let settingsOpen = false;
let paletteOpen = false;
let findOpen = false;
let tabMenuOpen = false;
let contextTabId = null;
let dragTabId = null;
let paletteItems = [];
let paletteSelection = 0;

const elements = {
  tabStrip: $('#tabStrip'),
  addressInput: $('#addressInput'),
  addressForm: $('#addressForm'),
  siteIndicator: $('#siteIndicator'),
  addressMode: $('#addressMode'),
  back: $('#backButton'),
  forward: $('#forwardButton'),
  reload: $('#reloadButton'),
  bookmark: $('#bookmarkButton'),
  blocked: $('#blockedCount'),
  progress: $('#loadProgress'),
  libraryDrawer: $('#libraryDrawer'),
  libraryTitle: $('#libraryTitle'),
  librarySearch: $('#librarySearch'),
  libraryActions: $('#libraryActions'),
  libraryList: $('#libraryList'),
  settingsLayer: $('#settingsLayer'),
  paletteLayer: $('#paletteLayer'),
  paletteInput: $('#paletteInput'),
  paletteResults: $('#paletteResults'),
  findBar: $('#findBar'),
  findInput: $('#findInput'),
  tabMenu: $('#tabMenu')
};

function activeTab() {
  return state?.tabs.find((tab) => tab.id === state.activeTabId) || null;
}

function compactMode() {
  return Boolean(state?.settings.compactSidebar || window.innerWidth < 900);
}

function hexToRgb(hex) {
  const match = String(hex).replace('#', '').match(/^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  return match ? `${parseInt(match[1], 16)}, ${parseInt(match[2], 16)}, ${parseInt(match[3], 16)}` : '139, 92, 246';
}

function logoName() {
  return ['halo', 'portal', 'fold'].includes(state?.settings.logo) ? state.settings.logo : 'halo';
}

function applyAppearance() {
  document.body.dataset.theme = state.settings.theme || 'midnight';
  document.body.classList.toggle('sidebar-compact', compactMode());
  const accent = state.settings.accent || '#8b5cf6';
  document.documentElement.style.setProperty('--accent', accent);
  document.documentElement.style.setProperty('--accent-rgb', hexToRgb(accent));
  const logo = logoName();
  document.querySelectorAll('.dynamic-logo').forEach((image) => {
    image.src = `../../assets/logo-${logo}.svg`;
  });
}

function render(nextState) {
  if (!nextState) return;
  const previousActive = state?.activeTabId;
  state = nextState;
  applyAppearance();
  document.body.classList.toggle('media-fullscreen', Boolean(state.mediaFullscreen));
  renderTabs();
  renderToolbar(previousActive !== state.activeTabId);
  renderLibrary();
  syncSettings();
  renderDownloadBadge();
  if (paletteOpen) buildPalette(elements.paletteInput.value);
  $('#amnesiaPill').classList.toggle('hidden', !state.amnesia);
  $('#maximizeWindow').textContent = state.maximized ? '❐' : '□';
  document.title = `${activeTab()?.title || 'Framium'} — Framium${state.amnesia ? ' Amnesia' : ''}`;
  updateInsets();
}

function renderTabs() {
  elements.tabStrip.replaceChildren();
  $('#tabCount').textContent = state.tabs.length;
  for (const tab of state.tabs) {
    const button = document.createElement('div');
    button.className = `browser-tab${tab.id === state.activeTabId ? ' active' : ''}${tab.pinned ? ' pinned' : ''}${tab.burner ? ' burner' : ''}`;
    button.dataset.id = tab.id;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(tab.id === state.activeTabId));
    button.draggable = true;
    button.title = tab.title || tab.url;

    let favicon;
    if (tab.loading) {
      favicon = document.createElement('span');
      favicon.className = 'tab-spinner';
    } else if (tab.favicon) {
      favicon = document.createElement('img');
      favicon.className = 'tab-favicon';
      favicon.src = tab.favicon;
      favicon.alt = '';
      favicon.addEventListener('error', () => favicon.replaceWith(faviconFallback(tab)));
    } else {
      favicon = faviconFallback(tab);
    }

    const title = document.createElement('span');
    title.className = 'tab-title';
    title.textContent = tab.crashed ? 'Tab crashed' : (tab.title || 'New Tab');
    const audio = document.createElement('span');
    audio.className = 'tab-audio';
    audio.textContent = tab.muted ? '×' : tab.audible ? '♪' : '';
    const close = document.createElement('button');
    close.className = 'tab-close';
    close.textContent = '×';
    close.setAttribute('aria-label', `Close ${tab.title || 'tab'}`);
    close.addEventListener('click', (event) => {
      event.stopPropagation();
      api.closeTab(tab.id);
    });

    button.append(favicon, title, audio, close);
    button.addEventListener('click', () => api.activateTab(tab.id));
    button.addEventListener('auxclick', (event) => {
      if (event.button === 1) api.closeTab(tab.id);
    });
    button.addEventListener('contextmenu', (event) => showTabMenu(event, tab.id));
    button.addEventListener('dragstart', (event) => {
      dragTabId = tab.id;
      button.classList.add('dragging');
      event.dataTransfer.effectAllowed = 'move';
    });
    button.addEventListener('dragend', () => {
      dragTabId = null;
      button.classList.remove('dragging');
    });
    button.addEventListener('dragover', (event) => event.preventDefault());
    button.addEventListener('drop', (event) => {
      event.preventDefault();
      if (!dragTabId || dragTabId === tab.id) return;
      const ids = state.tabs.map((item) => item.id);
      const from = ids.indexOf(dragTabId);
      const to = ids.indexOf(tab.id);
      ids.splice(to, 0, ids.splice(from, 1)[0]);
      api.reorderTabs(ids);
    });
    elements.tabStrip.append(button);
  }
}

function faviconFallback(item) {
  const fallback = document.createElement('span');
  fallback.className = 'favicon-fallback';
  let letter = '•';
  try { letter = new URL(item.url).hostname.charAt(0).toUpperCase() || '•'; } catch { /* internal */ }
  fallback.textContent = letter;
  return fallback;
}

function renderToolbar(activeChanged) {
  const tab = activeTab();
  if (!tab) return;
  elements.back.disabled = !tab.canGoBack;
  elements.forward.disabled = !tab.canGoForward;
  elements.reload.classList.toggle('loading', tab.loading);
  elements.reload.title = tab.loading ? 'Stop loading' : 'Reload';
  elements.progress.classList.toggle('loading', tab.loading);
  elements.bookmark.classList.toggle('active', state.activeBookmarked);
  elements.bookmark.style.visibility = /^https?:/i.test(tab.url) && !state.amnesia && !tab.burner ? 'visible' : 'hidden';
  elements.blocked.textContent = state.blockedCount > 999 ? '999+' : state.blockedCount;
  elements.addressMode.textContent = tab.burner ? 'VANISH' : state.amnesia ? 'AMNESIA' : '';

  const internal = tab.url.startsWith('framium:');
  const secure = tab.url.startsWith('https:');
  elements.siteIndicator.classList.toggle('search', internal);
  elements.siteIndicator.style.color = secure ? '#34d399' : '';
  elements.siteIndicator.title = internal ? 'Framium internal page' : secure ? 'Secure connection' : 'Connection is not secure';
  if (document.activeElement !== elements.addressInput || activeChanged) elements.addressInput.value = tab.displayUrl || '';
  elements.addressInput.placeholder = `Search with ${engineName()} or enter an address`;
}

function engineName() {
  return state.searchEngines.find((engine) => engine.id === state.settings.searchEngine)?.name || 'Google';
}

function renderDownloadBadge() {
  const count = state.downloads.filter((item) => ['choosing', 'progressing'].includes(item.state)).length;
  const badge = $('#downloadBadge');
  badge.textContent = count;
  badge.classList.toggle('hidden', count === 0);
}

function openLibrary(mode) {
  if (state.amnesia) {
    toast('Bookmarks and history stay outside Amnesia Mode.');
    return;
  }
  libraryMode = mode;
  libraryQuery = '';
  elements.librarySearch.value = '';
  libraryOpen = true;
  elements.libraryDrawer.classList.remove('hidden');
  document.querySelectorAll('[data-library]').forEach((button) => button.classList.toggle('active', button.dataset.library === mode));
  renderLibrary();
  updateInsets();
  requestAnimationFrame(() => elements.librarySearch.focus());
}

function closeLibrary() {
  libraryOpen = false;
  elements.libraryDrawer.classList.add('hidden');
  document.querySelectorAll('[data-library]').forEach((button) => button.classList.remove('active'));
  updateInsets();
}

function renderLibrary() {
  if (!state || !libraryOpen) return;
  elements.libraryTitle.textContent = libraryMode === 'bookmarks' ? 'Bookmarks' : 'History';
  elements.libraryActions.replaceChildren();
  elements.libraryList.replaceChildren();
  let items = libraryMode === 'bookmarks' ? state.bookmarks : state.history;
  const needle = libraryQuery.toLowerCase();
  if (needle) items = items.filter((item) => `${item.title} ${item.url}`.toLowerCase().includes(needle));
  if (libraryMode === 'history' && state.history.length) elements.libraryActions.append(textAction('Clear history', () => api.clearHistory()));

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-panel';
    empty.textContent = needle ? 'Nothing matches your search.' : libraryMode === 'bookmarks' ? 'Bookmark a page and it will live here.' : 'No browsing history yet.';
    elements.libraryList.append(empty);
    return;
  }
  items.slice(0, 400).forEach((item) => elements.libraryList.append(libraryItem(item)));
}

function libraryItem(item) {
  const row = document.createElement('div');
  row.className = 'library-item';
  const open = document.createElement('div');
  open.className = 'item-open';
  const icon = document.createElement('span');
  icon.className = 'item-icon';
  if (item.favicon) {
    const image = document.createElement('img');
    image.src = item.favicon;
    image.alt = '';
    image.addEventListener('error', () => icon.replaceChildren(iconLetter(item)));
    icon.append(image);
  } else icon.textContent = iconLetter(item);
  const copy = document.createElement('div');
  copy.className = 'item-copy';
  const title = document.createElement('div');
  title.className = 'item-title';
  title.textContent = item.title || item.url;
  const url = document.createElement('div');
  url.className = 'item-url';
  url.textContent = libraryMode === 'history' ? `${formatDate(item.visitedAt)} · ${compactUrl(item.url)}` : compactUrl(item.url);
  copy.append(title, url);
  open.append(icon, copy);
  open.addEventListener('click', () => api.openItem(item.url, false));
  row.append(open);
  const remove = document.createElement('button');
  remove.className = 'item-delete';
  remove.textContent = '×';
  remove.title = 'Remove';
  if (libraryMode === 'bookmarks') remove.addEventListener('click', () => api.removeBookmark(item.id));
  else remove.style.visibility = 'hidden';
  row.append(remove);
  return row;
}

function iconLetter(item) {
  return (item.title || compactUrl(item.url) || '•').charAt(0).toUpperCase();
}

function compactUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url || ''; }
}
function formatDate(timestamp) {
  return timestamp ? new Intl.DateTimeFormat(undefined, { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' }).format(timestamp) : '';
}
function textAction(label, handler) {
  const button = document.createElement('button');
  button.className = 'text-action';
  button.textContent = label;
  button.addEventListener('click', handler);
  return button;
}

function updateInsets() {
  if (!state) return;
  const overlay = settingsOpen || paletteOpen;
  const baseLeft = compactMode() ? 78 : 260;
  const left = overlay ? 0 : libraryOpen ? baseLeft + 366 : tabMenuOpen && compactMode() ? 240 : baseLeft;
  const top = overlay ? window.innerHeight : 64;
  const right = overlay ? 0 : findOpen ? 370 : 12;
  api.setInsets({ top, left, right, bottom: overlay ? 0 : 12 });
}

function showSettings() {
  settingsOpen = true;
  closeLibrary();
  closeTabMenu();
  elements.settingsLayer.classList.remove('hidden');
  syncSettings();
  updateInsets();
}
function closeSettings() {
  settingsOpen = false;
  elements.settingsLayer.classList.add('hidden');
  updateInsets();
}

function syncSettings() {
  if (!state) return;
  const search = $('#searchEngineSelect');
  if (!search.options.length) {
    state.searchEngines.forEach((engine) => {
      const option = document.createElement('option');
      option.value = engine.id;
      option.textContent = `${engine.name} · ${engine.keyword} query`;
      search.append(option);
    });
  }
  search.value = state.settings.searchEngine;
  $('#themeSelect').value = state.settings.theme || 'midnight';
  $('#logoSelect').value = logoName();
  $('#accentInput').value = state.settings.accent || '#8b5cf6';
  $('#trackerToggle').checked = Boolean(state.settings.blockTrackers);
  $('#restoreToggle').checked = Boolean(state.settings.restoreSession);
  $('#compactToggle').checked = Boolean(state.settings.compactSidebar);
  $('#askDownloadToggle').checked = Boolean(state.settings.askDownloadLocation);
  $('#versionText').textContent = state.version;

  const list = $('#extensionList');
  list.replaceChildren();
  if (!state.extensions.length) {
    const empty = document.createElement('p');
    empty.textContent = 'No unpacked extensions loaded.';
    list.append(empty);
  } else {
    state.extensions.forEach((extension) => {
      const row = document.createElement('div');
      row.className = 'extension-entry';
      const icon = document.createElement('span'); icon.textContent = 'E';
      const copy = document.createElement('div');
      const name = document.createElement('b'); name.textContent = extension.name;
      const version = document.createElement('small'); version.textContent = `Version ${extension.version}`;
      copy.append(name, version);
      const remove = document.createElement('button'); remove.textContent = 'Remove';
      remove.addEventListener('click', () => api.removeExtension(extension.id));
      row.append(icon, copy, remove); list.append(row);
    });
  }
}

function showPalette() {
  paletteOpen = true;
  paletteSelection = 0;
  closeLibrary();
  closeTabMenu();
  elements.paletteLayer.classList.remove('hidden');
  elements.paletteInput.value = '';
  buildPalette('');
  updateInsets();
  requestAnimationFrame(() => elements.paletteInput.focus());
}
function closePalette() {
  paletteOpen = false;
  elements.paletteLayer.classList.add('hidden');
  updateInsets();
}
function buildPalette(query) {
  if (!state) return;
  const commands = [
    { symbol:'+', title:'New tab', subtitle:'Open Framium Home', run:() => api.newTab() },
    { symbol:'◌', title:'New Amnesia window', subtitle:'Temporary isolated browsing', run:() => api.newWindow(true) },
    { symbol:'↓', title:'Open Downloads', subtitle:'Manage files and active transfers', run:() => api.navigate('framium://downloads/') },
    { symbol:'◇', title:'Vanish this tab', subtitle:'Clone into isolated memory and erase it on close', run:() => api.vanishTab(activeTab()?.url) },
    { symbol:'↶', title:'Reopen closed tab', subtitle:'Restore the most recently closed tab', run:() => api.reopenClosedTab() },
    { symbol:'★', title:'Bookmark this page', subtitle:'Add or remove the active page', run:() => api.toggleBookmark() },
    { symbol:'⚙', title:'Open Settings', subtitle:'Privacy, search, and appearance', run:showSettings },
    { symbol:'↗', title:'Developer tools', subtitle:'Inspect the active page', run:() => api.pageAction('devtools') }
  ];
  const tabs = state.tabs.map((tab) => ({ symbol:'T', title:tab.title, subtitle:tab.url, run:() => api.activateTab(tab.id) }));
  const bookmarks = state.bookmarks.map((item) => ({ symbol:'★', title:item.title, subtitle:item.url, run:() => api.openItem(item.url, false) }));
  const history = state.history.slice(0, 80).map((item) => ({ symbol:'↺', title:item.title, subtitle:item.url, run:() => api.openItem(item.url, false) }));
  const rawQuery = query.trim();
  const needle = rawQuery.toLowerCase();
  paletteItems = [...commands, ...tabs, ...bookmarks, ...history]
    .filter((item) => !needle || `${item.title} ${item.subtitle}`.toLowerCase().includes(needle))
    .slice(0, rawQuery ? 15 : 16);
  if (rawQuery) {
    paletteItems.unshift({ symbol:'→', title:`Search the web for “${rawQuery}”`, subtitle:`Use ${engineName()}`, run:() => api.navigate(rawQuery) });
  }
  paletteSelection = Math.min(paletteSelection, Math.max(0, paletteItems.length - 1));
  elements.paletteResults.replaceChildren();
  paletteItems.forEach((item, index) => {
    const button = document.createElement('button');
    button.className = `palette-item${index === paletteSelection ? ' selected' : ''}`;
    const symbol = document.createElement('span'); symbol.className = 'palette-symbol'; symbol.textContent = item.symbol;
    const copy = document.createElement('span'); copy.className = 'palette-copy';
    const title = document.createElement('b'); title.textContent = item.title;
    const subtitle = document.createElement('small'); subtitle.textContent = item.subtitle;
    copy.append(title, subtitle); button.append(symbol, copy);
    button.addEventListener('click', () => runPaletteItem(index));
    elements.paletteResults.append(button);
  });
}
function runPaletteItem(index) {
  const item = paletteItems[index];
  if (!item) return;
  closePalette();
  item.run();
}

function openFind() {
  findOpen = true;
  elements.findBar.classList.remove('hidden');
  updateInsets();
  requestAnimationFrame(() => elements.findInput.focus());
}
function closeFind() {
  findOpen = false;
  elements.findBar.classList.add('hidden');
  api.stopFind('clearSelection');
  updateInsets();
}
function showTabMenu(event, id) {
  event.preventDefault();
  contextTabId = id;
  tabMenuOpen = true;
  elements.tabMenu.style.top = `${Math.min(event.clientY, window.innerHeight - 245)}px`;
  elements.tabMenu.classList.remove('hidden');
  updateInsets();
}
function closeTabMenu() {
  if (!tabMenuOpen) return;
  tabMenuOpen = false;
  elements.tabMenu.classList.add('hidden');
  updateInsets();
}
function toast(message) {
  const node = document.createElement('div');
  node.className = 'toast'; node.textContent = message;
  $('#toastRegion').append(node);
  setTimeout(() => node.remove(), 3000);
}
async function clearBrowsingData() {
  if (state.amnesia) return toast('Amnesia data disappears when this window closes.');
  if (!confirm('Clear normal history, cookies, cache, and site storage? Bookmarks and passwords remain.')) return;
  await api.clearBrowsingData();
  toast('Browsing data cleared.');
}

function handleCommand(command) {
  if (command === 'focus-address') { elements.addressInput.focus(); elements.addressInput.select(); }
  else if (command === 'command-palette' || command === 'spotlight') showPalette();
  else if (command === 'settings') showSettings();
  else if (command === 'find') openFind();
  else if (command === 'bookmarks') openLibrary('bookmarks');
  else if (command === 'history') openLibrary('history');
  else if (command === 'downloads') api.navigate('framium://downloads/');
}

// Core controls
$('#newTab').addEventListener('click', () => api.newTab());
$('#newAmnesia').addEventListener('click', () => api.newWindow(true));
$('#settingsButton').addEventListener('click', showSettings);
$('#downloadsButton').addEventListener('click', () => api.navigate('framium://downloads/'));
$('#vanishTab').addEventListener('click', () => {
  if (state.amnesia) return toast('This entire window is already temporary.');
  api.vanishTab(activeTab()?.url);
  toast('Opened an isolated Vanish tab. Close it to erase its local state.');
});
$('#collapseSidebar').addEventListener('click', () => api.updateSettings({ compactSidebar: !state.settings.compactSidebar }));
$('#minimizeWindow').addEventListener('click', () => api.windowAction('minimize'));
$('#maximizeWindow').addEventListener('click', () => api.windowAction('maximize'));
$('#closeWindow').addEventListener('click', () => api.windowAction('close'));
document.querySelectorAll('[data-nav]').forEach((button) => button.addEventListener('click', () => {
  if (button.dataset.nav === 'reload' && activeTab()?.loading) api.nav('stop'); else api.nav(button.dataset.nav);
}));
elements.addressForm.addEventListener('submit', (event) => { event.preventDefault(); api.navigate(elements.addressInput.value); elements.addressInput.blur(); });
elements.addressInput.addEventListener('focus', () => elements.addressInput.select());
elements.bookmark.addEventListener('click', () => api.toggleBookmark());
$('#privacyButton').addEventListener('click', () => toast(`${state.blockedCount} tracking request${state.blockedCount === 1 ? '' : 's'} blocked in this window.`));
document.querySelectorAll('[data-library]').forEach((button) => button.addEventListener('click', () => libraryOpen && libraryMode === button.dataset.library ? closeLibrary() : openLibrary(button.dataset.library)));
$('#closeLibrary').addEventListener('click', closeLibrary);
elements.librarySearch.addEventListener('input', (event) => { libraryQuery = event.target.value; renderLibrary(); });

// Settings
$('#closeSettings').addEventListener('click', closeSettings);
$('#searchEngineSelect').addEventListener('change', (event) => api.updateSettings({ searchEngine:event.target.value }));
$('#themeSelect').addEventListener('change', (event) => api.updateSettings({ theme:event.target.value }));
$('#logoSelect').addEventListener('change', (event) => api.updateSettings({ logo:event.target.value }));
$('#accentInput').addEventListener('change', (event) => api.updateSettings({ accent:event.target.value }));
$('#trackerToggle').addEventListener('change', (event) => api.updateSettings({ blockTrackers:event.target.checked }));
$('#restoreToggle').addEventListener('change', (event) => api.updateSettings({ restoreSession:event.target.checked }));
$('#compactToggle').addEventListener('change', (event) => api.updateSettings({ compactSidebar:event.target.checked }));
$('#askDownloadToggle').addEventListener('change', (event) => api.updateSettings({ askDownloadLocation:event.target.checked }));
$('#openDownloadsFromSettings').addEventListener('click', () => {
  closeSettings();
  api.navigate('framium://downloads/');
});
$('#clearData').addEventListener('click', clearBrowsingData);
$('#openAmnesiaFromSettings').addEventListener('click', () => api.newWindow(true));
$('#loadExtension').addEventListener('click', async () => {
  if (state.amnesia) return toast('Extensions are disabled in Amnesia Mode.');
  const result = await api.loadExtension();
  if (result?.ok) toast(`${result.name} loaded.`); else if (!result?.cancelled) toast(result?.error || 'Extension could not be loaded.');
});

// Find and command palette
elements.findInput.addEventListener('input', () => api.find(elements.findInput.value, { forward:true, findNext:false }));
elements.findInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') api.find(elements.findInput.value, { forward:!event.shiftKey, findNext:true });
  if (event.key === 'Escape') closeFind();
});
$('#findNext').addEventListener('click', () => api.find(elements.findInput.value, { forward:true, findNext:true }));
$('#findPrevious').addEventListener('click', () => api.find(elements.findInput.value, { forward:false, findNext:true }));
$('#closeFind').addEventListener('click', closeFind);
elements.paletteInput.addEventListener('input', () => { paletteSelection = 0; buildPalette(elements.paletteInput.value); });
elements.paletteInput.addEventListener('keydown', (event) => {
  if (event.key === 'ArrowDown') { event.preventDefault(); paletteSelection = Math.min(paletteItems.length - 1, paletteSelection + 1); buildPalette(elements.paletteInput.value); }
  else if (event.key === 'ArrowUp') { event.preventDefault(); paletteSelection = Math.max(0, paletteSelection - 1); buildPalette(elements.paletteInput.value); }
  else if (event.key === 'Enter') { event.preventDefault(); runPaletteItem(paletteSelection); }
  else if (event.key === 'Escape') closePalette();
});

// Tab menu
 elements.tabMenu.addEventListener('click', (event) => {
  const action = event.target.closest('[data-tab-action]')?.dataset.tabAction;
  if (!action || contextTabId == null) return;
  if (action === 'duplicate') api.duplicateTab(contextTabId); else api.tabAction(contextTabId, action);
  closeTabMenu();
});
document.addEventListener('pointerdown', (event) => {
  if (!event.target.closest('#tabMenu')) closeTabMenu();
});

document.addEventListener('keydown', (event) => {
  const control = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();
  if (event.key === 'Escape') {
    if (paletteOpen) closePalette(); else if (settingsOpen) closeSettings(); else if (tabMenuOpen) closeTabMenu(); else if (findOpen) closeFind(); else if (libraryOpen) closeLibrary();
    return;
  }
  if (event.altKey && key === 'l') { event.preventDefault(); showPalette(); }
  else if (control && key === 'l') { event.preventDefault(); elements.addressInput.focus(); elements.addressInput.select(); }
  else if (control && key === 'k') { event.preventDefault(); showPalette(); }
  else if (control && key === 't') { event.preventDefault(); api.newTab(); }
  else if (control && key === 'w' && document.activeElement !== elements.addressInput) { event.preventDefault(); api.closeTab(state.activeTabId); }
  else if (control && key === 'f') { event.preventDefault(); openFind(); }
});
window.addEventListener('resize', updateInsets);
api.onState(render);
api.onCommand(handleCommand);
api.getState().then(render);
