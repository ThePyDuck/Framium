'use strict';

const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  session,
  dialog,
  shell,
  protocol,
  Menu,
  clipboard,
  nativeImage
} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { JsonStore } = require('./store');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'framium',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: false,
      stream: true
    }
  }
]);

app.setName('Framium');

const HOME_URL = 'framium://home/';
const DOWNLOADS_URL = 'framium://downloads/';
const TOP_INSET = 64;
const SEARCH_ENGINES = {
  google: { name: 'Google', keyword: 'g', url: 'https://www.google.com/search?q=%s' },
  duckduckgo: { name: 'DuckDuckGo', keyword: 'd', url: 'https://duckduckgo.com/?q=%s' },
  brave: { name: 'Brave Search', keyword: 'b', url: 'https://search.brave.com/search?q=%s' },
  bing: { name: 'Bing', keyword: 'bi', url: 'https://www.bing.com/search?q=%s' },
  startpage: { name: 'Startpage', keyword: 's', url: 'https://www.startpage.com/do/dsearch?query=%s' },
  wikipedia: { name: 'Wikipedia', keyword: 'w', url: 'https://en.wikipedia.org/wiki/Special:Search?search=%s' }
};

const TRACKER_HOSTS = [
  'doubleclick.net',
  'googlesyndication.com',
  'google-analytics.com',
  'googletagmanager.com',
  'facebook.net',
  'connect.facebook.net',
  'scorecardresearch.com',
  'hotjar.com',
  'segment.io',
  'segment.com',
  'mixpanel.com',
  'amplitude.com',
  'adnxs.com',
  'taboola.com',
  'outbrain.com'
];

let store;
let nextTabId = 1;
let restoredOnce = false;
const windows = new Map();
const tabByWebContents = new Map();
const configuredPartitions = new Set();
const activeDownloads = new Map();
let sessionSaveTimer = null;

function copy(value) {
  return JSON.parse(JSON.stringify(value));
}

function isTrackerHost(hostname) {
  const host = String(hostname || '').toLowerCase();
  return TRACKER_HOSTS.some((blocked) => host === blocked || host.endsWith(`.${blocked}`));
}

function safeHostname(value) {
  try {
    return new URL(value).hostname;
  } catch {
    return '';
  }
}

function uniqueDownloadPath(filename) {
  const directory = app.getPath('downloads');
  const parsed = path.parse(filename || 'download');
  let candidate = path.join(directory, filename || 'download');
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(directory, `${parsed.name} (${counter++})${parsed.ext}`);
  }
  return candidate;
}

function localResourceResponse(request) {
  const url = new URL(request.url);
  const key = `${url.hostname}${url.pathname}`;
  const fileMap = {
    'home/': path.join(__dirname, 'home', 'index.html'),
    'home/index.html': path.join(__dirname, 'home', 'index.html'),
    'home/home.css': path.join(__dirname, 'home', 'home.css'),
    'home/home.js': path.join(__dirname, 'home', 'home.js'),
    'home/logo-halo.svg': path.join(__dirname, '..', 'assets', 'logo-halo.svg'),
    'home/logo-portal.svg': path.join(__dirname, '..', 'assets', 'logo-portal.svg'),
    'home/logo-fold.svg': path.join(__dirname, '..', 'assets', 'logo-fold.svg'),
    'downloads/': path.join(__dirname, 'downloads', 'index.html'),
    'downloads/index.html': path.join(__dirname, 'downloads', 'index.html'),
    'downloads/downloads.css': path.join(__dirname, 'downloads', 'downloads.css'),
    'downloads/downloads.js': path.join(__dirname, 'downloads', 'downloads.js'),
    'downloads/logo-halo.svg': path.join(__dirname, '..', 'assets', 'logo-halo.svg')
  };

  const userBackground = key === 'home/user-background'
    ? store?.settings?.home?.backgroundImagePath
    : '';
  const file = userBackground || fileMap[key];
  if (!file || !fs.existsSync(file)) {
    return new Response('Not found', {
      status: 404,
      headers: { 'content-type': 'text/plain; charset=utf-8' }
    });
  }

  const extension = path.extname(file).toLowerCase();
  const mime = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.gif': 'image/gif'
  }[extension] || 'application/octet-stream';

  try {
    return new Response(fs.readFileSync(file), {
      status: 200,
      headers: {
        'content-type': mime,
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff'
      }
    });
  } catch {
    return new Response('Internal page unavailable', { status: 500 });
  }
}

function displayUrl(url) {
  if (url === HOME_URL || url.startsWith('framium://home')) return '';
  if (url.startsWith('framium://downloads')) return 'Framium Downloads';
  return url;
}

function searchOrUrl(rawValue) {
  const value = String(rawValue || '').trim();
  if (!value) return HOME_URL;
  if (/^framium:\/\/home\/?$/i.test(value)) return HOME_URL;

  try {
    const parsed = new URL(value);
    if (['http:', 'https:', 'framium:', 'view-source:'].includes(parsed.protocol)) return parsed.toString();
  } catch {
    // Fall through to hostname/search handling.
  }

  if (/^(localhost|\d{1,3}(\.\d{1,3}){3})(:\d+)?(\/.*)?$/i.test(value)) {
    return `http://${value}`;
  }

  if (/^[\w.-]+\.[a-z]{2,}(?::\d+)?(?:\/\S*)?$/i.test(value) && !value.includes(' ')) {
    return `https://${value}`;
  }

  const shortcut = value.match(/^([a-z]+)\s+(.+)$/i);
  let engine = SEARCH_ENGINES[store.settings.searchEngine] || SEARCH_ENGINES.google;
  let query = value;
  if (shortcut) {
    const match = Object.values(SEARCH_ENGINES).find((item) => item.keyword === shortcut[1].toLowerCase());
    if (match) {
      engine = match;
      query = shortcut[2];
    }
  }
  return engine.url.replace('%s', encodeURIComponent(query));
}

function ownerForWebContents(webContents) {
  return tabByWebContents.get(webContents.id)?.state || null;
}

function configureSession(ses, partition, amnesia) {
  if (configuredPartitions.has(partition)) return;
  configuredPartitions.add(partition);
  const permissionDecisions = new Map();

  ses.protocol.handle('framium', localResourceResponse);

  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, callback) => {
    if (!store.settings.blockTrackers || details.resourceType === 'mainFrame') {
      callback({ cancel: false });
      return;
    }

    const requestHost = safeHostname(details.url);
    const sourceHost = safeHostname(details.initiator || details.referrer || '');
    const thirdParty = !sourceHost || (requestHost !== sourceHost && !requestHost.endsWith(`.${sourceHost}`));
    if (thirdParty && isTrackerHost(requestHost)) {
      const state = ownerForWebContents({ id: details.webContentsId });
      if (state) {
        state.blockedCount += 1;
        state.sendStateSoon();
      }
      callback({ cancel: true });
      return;
    }
    callback({ cancel: false });
  });

  ses.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const quietPermissions = new Set([
      'fullscreen',
      'pointerLock',
      'clipboardSanitizedWrite',
      'clipboard-sanitized-write'
    ]);
    if (quietPermissions.has(permission)) {
      callback(true);
      return;
    }

    const requestingOrigin = (() => {
      try { return new URL(details.requestingUrl || webContents.getURL()).origin; } catch { return 'unknown'; }
    })();
    const decisionKey = `${requestingOrigin}|${permission}`;
    if (permissionDecisions.has(decisionKey)) {
      callback(permissionDecisions.get(decisionKey));
      return;
    }

    const state = ownerForWebContents(webContents);
    const parent = state?.win;
    const host = safeHostname(details.requestingUrl || webContents.getURL()) || 'This site';
    const friendly = {
      media: 'camera or microphone',
      geolocation: 'location',
      notifications: 'notifications',
      midi: 'MIDI devices',
      midiSysex: 'system-exclusive MIDI',
      clipboardRead: 'clipboard contents',
      openExternal: 'external applications',
      fullscreen: 'full screen'
    }[permission] || permission;

    if (!parent || parent.isDestroyed()) {
      callback(false);
      return;
    }

    dialog.showMessageBox(parent, {
      type: 'question',
      title: 'Site permission',
      message: `${host} wants to use ${friendly}.`,
      detail: amnesia ? 'This permission lasts only for this Amnesia session.' : 'Allow only if you trust this site.',
      buttons: ['Block', 'Allow'],
      defaultId: 0,
      cancelId: 0,
      noLink: true
    }).then(({ response }) => {
      const allowed = response === 1;
      permissionDecisions.set(decisionKey, allowed);
      callback(allowed);
    }).catch(() => callback(false));
  });

  ses.setPermissionCheckHandler((_webContents, permission, requestingOrigin) => {
    if (['fullscreen', 'pointerLock', 'clipboardSanitizedWrite', 'clipboard-sanitized-write'].includes(permission)) return true;
    return permissionDecisions.get(`${requestingOrigin}|${permission}`) === true;
  });

  ses.on('will-download', (_event, item, webContents) => {
    const state = ownerForWebContents(webContents);
    if (!state) return;

    const id = crypto.randomUUID();
    const record = {
      id,
      filename: item.getFilename(),
      url: item.getURL(),
      path: '',
      state: 'choosing',
      receivedBytes: 0,
      totalBytes: item.getTotalBytes(),
      startedAt: Date.now(),
      amnesia,
      partition
    };
    activeDownloads.set(id, { item, state, partition });

    const beginDownload = (filePath) => {
      item.setSavePath(filePath);
      record.path = filePath;
      record.state = 'progressing';
      state.updateDownload(record);
      if (item.isPaused() && item.canResume()) item.resume();
    };

    if (store.settings.askDownloadLocation) {
      state.updateDownload(record);
      if (item.canResume()) item.pause();
      dialog.showSaveDialog(state.win, {
        title: amnesia ? 'Save file from Amnesia Mode' : 'Save download',
        defaultPath: path.join(app.getPath('downloads'), item.getFilename()),
        buttonLabel: 'Save'
      }).then((result) => {
        if (result.canceled || !result.filePath) {
          item.cancel();
          activeDownloads.delete(id);
          state.updateDownload({ ...record, state: 'cancelled' });
          return;
        }
        beginDownload(result.filePath);
      }).catch(() => {
        item.cancel();
        activeDownloads.delete(id);
        state.updateDownload({ ...record, state: 'cancelled' });
      });
    } else {
      beginDownload(uniqueDownloadPath(item.getFilename()));
    }

    item.on('updated', (_event, downloadState) => {
      state.updateDownload({
        ...record,
        path: item.getSavePath(),
        state: downloadState,
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes()
      });
    });

    item.once('done', (_event, downloadState) => {
      activeDownloads.delete(id);
      state.updateDownload({
        ...record,
        path: item.getSavePath(),
        state: downloadState,
        receivedBytes: item.getReceivedBytes(),
        totalBytes: item.getTotalBytes(),
        finishedAt: Date.now()
      });
    });
  });
}

class BrowserState {
  constructor(win, amnesia) {
    this.win = win;
    this.amnesia = amnesia;
    this.partition = amnesia ? `framium-amnesia-${crypto.randomUUID()}` : 'persist:framium-default';
    this.session = session.fromPartition(this.partition, { cache: !amnesia });
    this.tabs = [];
    this.activeTabId = null;
    this.closedTabs = [];
    this.insets = {
      top: TOP_INSET,
      left: store.settings.compactSidebar ? 78 : 260,
      right: 12,
      bottom: 12
    };
    this.blockedCount = 0;
    this.ephemeralDownloads = [];
    this.dismissedPartitions = new Set();
    this.mediaFullscreen = false;
    this.mediaFullscreenTabId = null;
    this.restoreWindowFullscreen = false;
    this.sendTimer = null;
    this.closing = false;
    configureSession(this.session, this.partition, amnesia);
  }

  snapshot() {
    const active = this.activeTab();
    const shared = store.publicData();
    return {
      appName: 'Framium',
      version: app.getVersion(),
      amnesia: this.amnesia,
      blockedCount: this.blockedCount,
      activeTabId: this.activeTabId,
      activeUrl: active?.url || HOME_URL,
      activeDisplayUrl: displayUrl(active?.url || HOME_URL),
      activeVanish: Boolean(active?.burner),
      mediaFullscreen: this.mediaFullscreen,
      activeBookmarked: Boolean(active && !active.burner && store.bookmarks.some((item) => item.url === active.url)),
      tabs: this.tabs.map((tab) => ({
        id: tab.id,
        title: tab.title,
        url: tab.url,
        displayUrl: displayUrl(tab.url),
        favicon: tab.favicon,
        loading: tab.loading,
        canGoBack: tab.view.webContents.navigationHistory.canGoBack(),
        canGoForward: tab.view.webContents.navigationHistory.canGoForward(),
        audible: tab.audible,
        muted: tab.view.webContents.isAudioMuted(),
        crashed: tab.crashed,
        pinned: tab.pinned,
        burner: tab.burner
      })),
      settings: copy(shared.settings),
      bookmarks: this.amnesia ? [] : copy(shared.bookmarks),
      history: this.amnesia ? [] : copy(shared.history.slice(0, 250)),
      downloads: this.amnesia
        ? copy(this.ephemeralDownloads)
        : copy([...this.ephemeralDownloads, ...shared.downloads]),
      searchEngines: Object.entries(SEARCH_ENGINES).map(([id, value]) => ({ id, ...value })),
      extensions: this.amnesia ? [] : this.session.extensions.getAllExtensions().map((extension) => ({
        id: extension.id,
        name: extension.name,
        version: extension.version,
        path: extension.path
      })),
      maximized: this.win.isMaximized(),
      fullscreen: this.win.isFullScreen()
    };
  }

  sendState() {
    if (this.win.isDestroyed() || this.win.webContents.isDestroyed()) return;
    this.win.webContents.send('framium:state', this.snapshot());
  }

  sendStateSoon() {
    clearTimeout(this.sendTimer);
    this.sendTimer = setTimeout(() => this.sendState(), 24);
  }

  activeTab() {
    return this.tabs.find((tab) => tab.id === this.activeTabId) || null;
  }

  createTab(input = HOME_URL, activate = true, insertAfter = null, options = {}) {
    const burner = Boolean(options.burner && !this.amnesia);
    const tabPartition = burner
      ? (options.partition || `framium-vanish-${crypto.randomUUID()}`)
      : this.partition;
    const tabSession = burner
      ? (options.session || session.fromPartition(tabPartition, { cache: false }))
      : this.session;
    if (burner) configureSession(tabSession, tabPartition, true);

    const view = new WebContentsView({
      webPreferences: {
        session: tabSession,
        preload: path.join(__dirname, 'tab-preload.js'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        allowRunningInsecureContent: false,
        spellcheck: true
      }
    });
    view.setBackgroundColor('#0b1020');
    view.setBorderRadius(14);

    const tab = {
      id: nextTabId++,
      view,
      title: 'New Tab',
      url: HOME_URL,
      favicon: '',
      loading: false,
      audible: false,
      crashed: false,
      pinned: false,
      burner,
      session: tabSession,
      partition: tabPartition
    };

    const insertionIndex = insertAfter == null
      ? this.tabs.length
      : Math.min(this.tabs.length, Math.max(0, this.tabs.findIndex((item) => item.id === insertAfter) + 1));
    this.tabs.splice(insertionIndex, 0, tab);
    tabByWebContents.set(view.webContents.id, { state: this, tab });
    this.win.contentView.addChildView(view);
    view.setVisible(false);

    const wc = view.webContents;
    wc.setWindowOpenHandler(({ url }) => {
      let protocolName = '';
      try { protocolName = new URL(url).protocol; } catch { /* handled as a search below */ }
      if (['http:', 'https:', 'framium:', 'view-source:'].includes(protocolName)) {
        this.createTab(url, true, tab.id, burner ? { burner: true, session: tabSession, partition: tabPartition } : {});
      } else if (['mailto:', 'tel:'].includes(protocolName)) {
        shell.openExternal(url).catch(() => {});
      } else {
        this.createTab(url, true, tab.id, burner ? { burner: true, session: tabSession, partition: tabPartition } : {});
      }
      return { action: 'deny' };
    });

    wc.on('will-navigate', (event, url) => {
      let protocolName = '';
      try { protocolName = new URL(url).protocol; } catch { return; }
      if (!['http:', 'https:', 'framium:', 'view-source:'].includes(protocolName)) {
        event.preventDefault();
        if (['mailto:', 'tel:'].includes(protocolName)) shell.openExternal(url).catch(() => {});
      }
    });

    wc.on('did-start-loading', () => {
      tab.loading = true;
      tab.crashed = false;
      this.sendStateSoon();
    });

    wc.on('did-stop-loading', () => {
      tab.loading = false;
      tab.url = wc.getURL() || tab.url;
      tab.title = wc.getTitle() || tab.title;
      this.sendStateSoon();
      this.scheduleSessionSave();
    });

    wc.on('did-navigate', (_event, url) => {
      tab.url = url;
      tab.crashed = false;
      if (!this.amnesia && !tab.burner) store.addHistory({ url, title: tab.title });
      this.sendStateSoon();
      this.scheduleSessionSave();
    });

    wc.on('did-navigate-in-page', (_event, url) => {
      tab.url = url;
      if (!this.amnesia && !tab.burner) store.addHistory({ url, title: tab.title });
      this.sendStateSoon();
      this.scheduleSessionSave();
    });

    wc.on('page-title-updated', (event, title) => {
      event.preventDefault();
      tab.title = title || safeHostname(tab.url) || 'New Tab';
      this.sendStateSoon();
    });

    wc.on('page-favicon-updated', (_event, favicons) => {
      tab.favicon = favicons.find((item) => /^https?:|^data:/i.test(item)) || '';
      if (!this.amnesia && !tab.burner && tab.favicon) store.updateBookmarkFavicon(tab.url, tab.favicon);
      this.sendStateSoon();
    });

    wc.on('media-started-playing', () => {
      tab.audible = true;
      this.sendStateSoon();
    });

    wc.on('media-paused', () => {
      tab.audible = false;
      this.sendStateSoon();
    });

    wc.on('render-process-gone', () => {
      tab.crashed = true;
      tab.loading = false;
      this.sendStateSoon();
    });

    wc.on('enter-html-full-screen', () => this.enterMediaFullscreen(tab));
    wc.on('leave-html-full-screen', () => this.leaveMediaFullscreen(tab));

    wc.on('context-menu', (_event, params) => this.showContextMenu(tab, params));
    wc.on('before-input-event', (event, inputEvent) => this.handleShortcut(event, inputEvent));

    wc.loadURL(searchOrUrl(input)).catch(() => {});
    if (activate) this.activateTab(tab.id);
    else this.sendStateSoon();
    this.scheduleSessionSave();
    return tab;
  }

  enterMediaFullscreen(tab) {
    if (this.mediaFullscreen && this.mediaFullscreenTabId === tab.id) return;
    this.mediaFullscreen = true;
    this.mediaFullscreenTabId = tab.id;
    this.restoreWindowFullscreen = this.win.isFullScreen();
    if (this.activeTabId !== tab.id) this.activateTab(tab.id);
    if (!this.win.isFullScreen()) this.win.setFullScreen(true);
    this.layout();
    this.sendStateSoon();
  }

  leaveMediaFullscreen(tab) {
    if (!this.mediaFullscreen || this.mediaFullscreenTabId !== tab.id) return;
    this.mediaFullscreen = false;
    this.mediaFullscreenTabId = null;
    if (!this.restoreWindowFullscreen && this.win.isFullScreen()) this.win.setFullScreen(false);
    this.restoreWindowFullscreen = false;
    this.layout();
    this.sendStateSoon();
  }

  activateTab(id) {
    if (!this.tabs.some((tab) => tab.id === id)) return;
    this.activeTabId = id;
    for (const tab of this.tabs) tab.view.setVisible(tab.id === id);
    this.layout();
    const active = this.activeTab();
    if (active && !active.view.webContents.isDestroyed()) active.view.webContents.focus();
    this.sendStateSoon();
    this.scheduleSessionSave();
  }

  closeTab(id, remember = true) {
    const index = this.tabs.findIndex((tab) => tab.id === id);
    if (index < 0) return;
    const tabToClose = this.tabs[index];
    if (this.mediaFullscreenTabId === tabToClose.id) this.leaveMediaFullscreen(tabToClose);
    const [tab] = this.tabs.splice(index, 1);
    if (remember && !tab.burner && tab.url && !tab.url.startsWith('devtools:')) {
      this.closedTabs.unshift({ url: tab.url, title: tab.title });
      this.closedTabs = this.closedTabs.slice(0, 25);
    }
    tabByWebContents.delete(tab.view.webContents.id);
    this.win.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });

    if (tab.burner && !this.tabs.some((other) => other.burner && other.partition === tab.partition)) {
      this.dismissedPartitions.add(tab.partition);
      for (const [downloadId, active] of activeDownloads) {
        if (active.state === this && active.partition === tab.partition) {
          active.item.cancel();
          activeDownloads.delete(downloadId);
        }
      }
      tab.session.clearCache().catch(() => {});
      tab.session.clearStorageData().catch(() => {});
      configuredPartitions.delete(tab.partition);
      this.ephemeralDownloads = this.ephemeralDownloads.filter((item) => item.partition !== tab.partition);
      broadcastDownloadPages();
    }

    if (!this.tabs.length) {
      if (!this.amnesia) store.setSession({ tabs: [HOME_URL], activeIndex: 0 });
      if (!this.closing) this.win.close();
      return;
    }
    if (this.activeTabId === id) {
      const replacement = this.tabs[Math.min(index, this.tabs.length - 1)];
      this.activateTab(replacement.id);
    } else {
      this.sendStateSoon();
    }
    this.scheduleSessionSave();
  }

  reopenClosedTab() {
    const item = this.closedTabs.shift();
    if (item) this.createTab(item.url, true);
  }

  createVanishTab(url = null, insertAfter = this.activeTabId) {
    if (this.amnesia) {
      this.createTab(url || this.activeTab()?.url || HOME_URL, true, insertAfter);
      return;
    }
    this.createTab(url || this.activeTab()?.url || HOME_URL, true, insertAfter, { burner: true });
  }

  reorder(ids) {
    if (!Array.isArray(ids) || ids.length !== this.tabs.length) return;
    const byId = new Map(this.tabs.map((tab) => [tab.id, tab]));
    if (!ids.every((id) => byId.has(id))) return;
    this.tabs = ids.map((id) => byId.get(id));
    this.sendStateSoon();
    this.scheduleSessionSave();
  }

  navigate(value) {
    const tab = this.activeTab();
    if (!tab) return;
    tab.view.webContents.loadURL(searchOrUrl(value)).catch(() => {});
  }

  navigationAction(action) {
    const tab = this.activeTab();
    if (!tab) return;
    const wc = tab.view.webContents;
    if (action === 'back' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
    else if (action === 'forward' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
    else if (action === 'reload') wc.reload();
    else if (action === 'hard-reload') wc.reloadIgnoringCache();
    else if (action === 'stop') wc.stop();
    else if (action === 'home') wc.loadURL(HOME_URL).catch(() => {});
  }

  toggleBookmark() {
    if (this.amnesia) return;
    const tab = this.activeTab();
    if (!tab || tab.burner || !/^https?:/i.test(tab.url)) return;
    const existing = store.bookmarks.find((item) => item.url === tab.url);
    if (existing) store.removeBookmarkByUrl(tab.url);
    else store.addBookmark({ url: tab.url, title: tab.title, favicon: tab.favicon });
    broadcastStates();
  }

  updateDownload(record) {
    if (record.partition && this.dismissedPartitions.has(record.partition)) return;
    if (this.amnesia || record.amnesia) {
      const index = this.ephemeralDownloads.findIndex((entry) => entry.id === record.id);
      if (index >= 0) this.ephemeralDownloads[index] = record;
      else this.ephemeralDownloads.unshift(record);
    } else {
      store.addDownload(record);
    }
    broadcastStates();
    broadcastDownloadPages();
  }

  setInsets(insets) {
    this.insets = {
      top: Number.isFinite(insets?.top) ? Math.max(TOP_INSET, insets.top) : TOP_INSET,
      left: Number.isFinite(insets?.left) ? Math.max(0, insets.left) : 0,
      right: Number.isFinite(insets?.right) ? Math.max(0, insets.right) : 0,
      bottom: Number.isFinite(insets?.bottom) ? Math.max(0, insets.bottom) : 0
    };
    this.layout();
  }

  layout() {
    if (this.win.isDestroyed()) return;
    const [width, height] = this.win.getContentSize();
    const bounds = this.mediaFullscreen
      ? { x: 0, y: 0, width, height }
      : {
          x: this.insets.left,
          y: this.insets.top,
          width: Math.max(0, width - this.insets.left - this.insets.right),
          height: Math.max(0, height - this.insets.top - this.insets.bottom)
        };
    const active = this.activeTab();
    if (active) {
      active.view.setBorderRadius(this.mediaFullscreen ? 0 : 14);
      active.view.setBounds(bounds);
    }
  }

  scheduleSessionSave() {
    if (this.amnesia || this.closing) return;
    clearTimeout(sessionSaveTimer);
    sessionSaveTimer = setTimeout(() => this.saveSession(), 250);
  }

  saveSession() {
    if (this.amnesia || !this.tabs.length) return;
    const persistentTabs = this.tabs.filter((tab) => !tab.burner);
    if (!persistentTabs.length) {
      store.setSession({ tabs: [HOME_URL], activeIndex: 0 });
      return;
    }
    const activeId = this.activeTab()?.burner ? persistentTabs[0].id : this.activeTabId;
    const activeIndex = Math.max(0, persistentTabs.findIndex((tab) => tab.id === activeId));
    store.setSession({
      tabs: persistentTabs.map((tab) => tab.url || HOME_URL),
      activeIndex
    });
  }

  showContextMenu(tab, params) {
    const template = [];
    if (params.linkURL) {
      template.push(
        {
          label: tab.burner ? 'Open Link in Related Vanish Tab' : 'Open Link in New Tab',
          click: () => this.createTab(
            params.linkURL,
            false,
            tab.id,
            tab.burner ? { burner: true, session: tab.session, partition: tab.partition } : {}
          )
        },
        { label: 'Open Link in Vanish Tab', visible: !this.amnesia, click: () => this.createVanishTab(params.linkURL, tab.id) },
        { label: 'Open Link in Amnesia Window', click: () => createBrowserWindow({ amnesia: true, url: params.linkURL }) },
        { label: 'Copy Link Address', click: () => clipboard.writeText(params.linkURL) },
        { type: 'separator' }
      );
    }
    if (params.isEditable) {
      template.push(
        { role: 'undo' }, { role: 'redo' }, { type: 'separator' },
        { role: 'cut' }, { role: 'copy' }, { role: 'paste' },
        { type: 'separator' }
      );
    } else if (params.selectionText) {
      template.push({ role: 'copy' }, { type: 'separator' });
    }
    template.push(
      { label: 'Back', enabled: tab.view.webContents.navigationHistory.canGoBack(), click: () => tab.view.webContents.navigationHistory.goBack() },
      { label: 'Forward', enabled: tab.view.webContents.navigationHistory.canGoForward(), click: () => tab.view.webContents.navigationHistory.goForward() },
      { label: 'Reload', click: () => tab.view.webContents.reload() },
      { type: 'separator' },
      { label: 'Open This Page as a Vanish Tab', visible: !this.amnesia && !tab.burner, click: () => this.createVanishTab(tab.url, tab.id) },
      { label: 'Bookmark This Page', enabled: !this.amnesia && !tab.burner && /^https?:/i.test(tab.url), click: () => this.toggleBookmark() },
      {
        label: 'View Page Source',
        enabled: /^https?:/i.test(tab.url),
        click: () => this.createTab(
          `view-source:${tab.url}`,
          true,
          tab.id,
          tab.burner ? { burner: true, session: tab.session, partition: tab.partition } : {}
        )
      },
      { label: 'Inspect', click: () => tab.view.webContents.inspectElement(params.x, params.y) }
    );
    Menu.buildFromTemplate(template).popup({ window: this.win });
  }

  handleShortcut(event, input) {
    if (input.type !== 'keyDown') return;
    const control = input.control || input.meta;
    const shift = input.shift;
    const key = String(input.key || '').toLowerCase();
    let handled = true;

    if (control && key === 'l') this.command('focus-address');
    else if (control && key === 't') this.createTab(HOME_URL, true);
    else if (control && key === 'w') this.closeTab(this.activeTabId);
    else if (control && shift && key === 't') this.reopenClosedTab();
    else if (control && shift && key === 'n') createBrowserWindow({ amnesia: true });
    else if (control && key === 'r') this.navigationAction(shift ? 'hard-reload' : 'reload');
    else if (control && key === 'd') this.toggleBookmark();
    else if (control && key === 'k') this.command('command-palette');
    else if (control && key === 'f') this.command('find');
    else if (control && key === 'h') this.command('history');
    else if (control && key === 'b') this.command('bookmarks');
    else if (control && key === 'j') this.command('downloads');
    else if (control && key === 'p') this.activeTab()?.view.webContents.print();
    else if (control && ['+', '='].includes(key)) this.zoom('in');
    else if (control && key === '-') this.zoom('out');
    else if (control && key === '0') this.zoom('reset');
    else if (input.alt && key === 'l') this.command('spotlight');
    else if (input.alt && key === 'left') this.navigationAction('back');
    else if (input.alt && key === 'right') this.navigationAction('forward');
    else if (key === 'f11') this.win.setFullScreen(!this.win.isFullScreen());
    else if (key === 'f12') this.activeTab()?.view.webContents.toggleDevTools();
    else handled = false;

    if (handled) event.preventDefault();
  }

  command(name) {
    if (!this.win.isDestroyed()) this.win.webContents.send('framium:command', name);
  }

  zoom(action) {
    const wc = this.activeTab()?.view.webContents;
    if (!wc) return;
    const current = wc.getZoomFactor();
    if (action === 'in') wc.setZoomFactor(Math.min(3, current + 0.1));
    else if (action === 'out') wc.setZoomFactor(Math.max(0.25, current - 0.1));
    else wc.setZoomFactor(1);
  }

  dispose() {
    this.closing = true;
    clearTimeout(this.sendTimer);
    if (!this.amnesia) this.saveSession();
    const vanishSessions = new Map();
    for (const tab of this.tabs) {
      tabByWebContents.delete(tab.view.webContents.id);
      if (tab.burner) vanishSessions.set(tab.partition, tab.session);
    }
    for (const vanishSession of vanishSessions.values()) {
      vanishSession.clearCache().catch(() => {});
      vanishSession.clearStorageData().catch(() => {});
    }
    if (this.amnesia) {
      this.session.clearCache().catch(() => {});
      this.session.clearStorageData().catch(() => {});
    }
  }
}

function broadcastStates() {
  for (const state of windows.values()) state.sendStateSoon();
}

function reloadHomePages() {
  for (const state of windows.values()) {
    for (const tab of state.tabs) {
      if (tab.url.startsWith(HOME_URL) && !tab.view.webContents.isDestroyed()) tab.view.webContents.reload();
    }
  }
}

function broadcastDownloadPages() {
  for (const state of windows.values()) {
    const downloads = state.amnesia
      ? state.ephemeralDownloads
      : [...state.ephemeralDownloads, ...store.downloads];
    for (const tab of state.tabs) {
      if (tab.url.startsWith(DOWNLOADS_URL) && !tab.view.webContents.isDestroyed()) {
        tab.view.webContents.send('framium:downloads-updated', copy(downloads));
      }
    }
  }
}

function stateFromEvent(event) {
  const win = BrowserWindow.fromWebContents(event.sender);
  return win ? windows.get(win.id) : null;
}

function createBrowserWindow({ amnesia = false, url = null } = {}) {
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 820,
    minHeight: 560,
    frame: false,
    show: false,
    backgroundColor: '#080b14',
    icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    }
  });

  const state = new BrowserState(win, amnesia);
  windows.set(win.id, state);

  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => win.show());
  win.on('resize', () => state.layout());
  win.on('maximize', () => state.sendStateSoon());
  win.on('unmaximize', () => state.sendStateSoon());
  win.on('enter-full-screen', () => state.sendStateSoon());
  win.on('leave-full-screen', () => state.sendStateSoon());
  win.on('close', () => {
    state.closing = true;
    if (!amnesia) state.saveSession();
  });
  win.on('closed', () => {
    state.dispose();
    windows.delete(win.id);
  });

  win.webContents.on('did-finish-load', () => {
    const saved = store.session;
    if (url) {
      state.createTab(url, true);
    } else if (!amnesia && !restoredOnce && store.settings.restoreSession && Array.isArray(saved.tabs) && saved.tabs.length) {
      restoredOnce = true;
      const urls = saved.tabs.slice(0, 30);
      urls.forEach((tabUrl, index) => state.createTab(tabUrl, index === Math.min(saved.activeIndex || 0, urls.length - 1)));
      if (!state.activeTabId && state.tabs[0]) state.activateTab(state.tabs[0].id);
    } else {
      state.createTab(HOME_URL, true);
    }
    state.sendState();
  });

  win.webContents.on('before-input-event', (event, input) => state.handleShortcut(event, input));
  return win;
}

function installIpc() {
  ipcMain.handle('framium:get-state', (event) => stateFromEvent(event)?.snapshot() || null);

  ipcMain.on('framium:new-tab', (event, url) => stateFromEvent(event)?.createTab(url || HOME_URL, true));
  ipcMain.on('framium:close-tab', (event, id) => stateFromEvent(event)?.closeTab(id));
  ipcMain.on('framium:activate-tab', (event, id) => stateFromEvent(event)?.activateTab(id));
  ipcMain.on('framium:reorder-tabs', (event, ids) => stateFromEvent(event)?.reorder(ids));
  ipcMain.on('framium:duplicate-tab', (event, id) => {
    const state = stateFromEvent(event);
    const tab = state?.tabs.find((item) => item.id === id);
    if (tab) state.createTab(
      tab.url,
      true,
      id,
      tab.burner ? { burner: true, session: tab.session, partition: tab.partition } : {}
    );
  });
  ipcMain.on('framium:vanish-tab', (event, url) => {
    const state = stateFromEvent(event);
    state?.createVanishTab(url || state.activeTab()?.url || HOME_URL);
  });
  ipcMain.on('framium:tab-action', (event, payload) => {
    const state = stateFromEvent(event);
    if (!state || !payload) return;
    const index = state.tabs.findIndex((item) => item.id === payload.id);
    const tab = state.tabs[index];
    if (!tab) return;
    if (payload.action === 'close') state.closeTab(tab.id);
    else if (payload.action === 'vanish') state.createVanishTab(tab.url, tab.id);
    else if (payload.action === 'mute') {
      tab.view.webContents.setAudioMuted(!tab.view.webContents.isAudioMuted());
      state.sendStateSoon();
    } else if (payload.action === 'pin') {
      tab.pinned = !tab.pinned;
      state.tabs.splice(index, 1);
      if (tab.pinned) state.tabs.splice(state.tabs.filter((item) => item.pinned).length, 0, tab);
      else state.tabs.splice(state.tabs.filter((item) => item.pinned).length, 0, tab);
      state.sendStateSoon();
    } else if (payload.action === 'close-others') {
      for (const other of [...state.tabs]) if (other.id !== tab.id) state.closeTab(other.id);
    } else if (payload.action === 'close-right') {
      for (const other of state.tabs.slice(index + 1)) state.closeTab(other.id);
    }
  });
  ipcMain.on('framium:reopen-tab', (event) => stateFromEvent(event)?.reopenClosedTab());
  ipcMain.on('framium:navigate', (event, value) => stateFromEvent(event)?.navigate(value));
  ipcMain.on('framium:nav', (event, action) => stateFromEvent(event)?.navigationAction(action));
  ipcMain.on('framium:toggle-bookmark', (event) => stateFromEvent(event)?.toggleBookmark());
  ipcMain.on('framium:remove-bookmark', (_event, id) => {
    store.removeBookmark(id);
    broadcastStates();
  });
  ipcMain.on('framium:clear-history', () => {
    store.clearHistory();
    broadcastStates();
  });
  ipcMain.on('framium:clear-downloads', () => {
    store.clearDownloads();
    broadcastStates();
    broadcastDownloadPages();
  });
  ipcMain.on('framium:open-item', (event, payload) => {
    const state = stateFromEvent(event);
    if (!state) return;
    if (payload?.newTab) state.createTab(payload.url, true);
    else state.navigate(payload?.url);
  });
  ipcMain.on('framium:update-settings', (_event, patch) => {
    store.patchSettings(patch || {});
    reloadHomePages();
    broadcastStates();
  });
  ipcMain.handle('framium:clear-browsing-data', async (event) => {
    const state = stateFromEvent(event);
    if (!state || state.amnesia) return false;
    await state.session.clearCache();
    await state.session.clearStorageData({
      storages: ['cookies', 'filesystem', 'indexdb', 'localstorage', 'shadercache', 'websql', 'serviceworkers', 'cachestorage']
    });
    store.clearHistory();
    broadcastStates();
    return true;
  });
  ipcMain.on('framium:new-window', (_event, amnesia) => createBrowserWindow({ amnesia: Boolean(amnesia) }));
  ipcMain.on('framium:set-insets', (event, insets) => stateFromEvent(event)?.setInsets(insets));
  ipcMain.on('framium:window', (event, action) => {
    const state = stateFromEvent(event);
    if (!state) return;
    if (action === 'minimize') state.win.minimize();
    else if (action === 'maximize') state.win.isMaximized() ? state.win.unmaximize() : state.win.maximize();
    else if (action === 'close') state.win.close();
  });
  ipcMain.on('framium:find', (event, payload) => {
    const wc = stateFromEvent(event)?.activeTab()?.view.webContents;
    if (!wc || !payload?.text) return;
    wc.findInPage(payload.text, payload.options || {});
  });
  ipcMain.on('framium:stop-find', (event, action) => stateFromEvent(event)?.activeTab()?.view.webContents.stopFindInPage(action));
  ipcMain.on('framium:zoom', (event, action) => stateFromEvent(event)?.zoom(action));
  ipcMain.on('framium:page-action', async (event, action) => {
    const state = stateFromEvent(event);
    const wc = state?.activeTab()?.view.webContents;
    if (!state || !wc) return;
    if (action === 'devtools') wc.toggleDevTools();
    else if (action === 'print') wc.print();
    else if (action === 'downloads-folder') shell.openPath(app.getPath('downloads'));
    else if (action === 'save-pdf') {
      const result = await dialog.showSaveDialog(state.win, {
        title: 'Save page as PDF',
        defaultPath: path.join(app.getPath('documents'), 'page.pdf'),
        filters: [{ name: 'PDF', extensions: ['pdf'] }]
      });
      if (!result.canceled && result.filePath) {
        const data = await wc.printToPDF({ printBackground: true });
        fs.writeFileSync(result.filePath, data);
      }
    }
  });

  ipcMain.on('framium:start-download-drag', (event, id) => {
    const owner = tabByWebContents.get(event.sender.id);
    if (!owner || !event.sender.getURL().startsWith(DOWNLOADS_URL)) return;
    const record = [...owner.state.ephemeralDownloads, ...store.downloads].find((item) => item.id === id);
    if (!record?.path || !fs.existsSync(record.path)) return;
    event.sender.startDrag({
      file: record.path,
      icon: nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'icon.png')).resize({ width: 32, height: 32 })
    });
  });

  ipcMain.handle('framium:downloads-data', (event) => {
    const owner = tabByWebContents.get(event.sender.id);
    if (!owner || !event.sender.getURL().startsWith(DOWNLOADS_URL)) return null;
    const privateContext = owner.state.amnesia || owner.tab.burner;
    const downloads = owner.tab.burner
      ? owner.state.ephemeralDownloads.filter((item) => item.partition === owner.tab.partition)
      : owner.state.amnesia
        ? owner.state.ephemeralDownloads
        : [...owner.state.ephemeralDownloads, ...store.downloads];
    return {
      downloads: copy(downloads),
      amnesia: privateContext,
      downloadsPath: app.getPath('downloads')
    };
  });

  ipcMain.handle('framium:download-action', async (event, payload) => {
    const owner = tabByWebContents.get(event.sender.id);
    if (!owner || !event.sender.getURL().startsWith(DOWNLOADS_URL) || !payload?.action) return false;
    const privateContext = owner.state.amnesia || owner.tab.burner;
    const downloads = owner.tab.burner
      ? owner.state.ephemeralDownloads.filter((item) => item.partition === owner.tab.partition)
      : owner.state.amnesia
        ? owner.state.ephemeralDownloads
        : [...owner.state.ephemeralDownloads, ...store.downloads];
    const record = downloads.find((item) => item.id === payload.id);

    if (payload.action === 'open-folder') {
      await shell.openPath(app.getPath('downloads'));
      return true;
    }
    if (payload.action === 'clear-completed') {
      if (owner.tab.burner) {
        owner.state.ephemeralDownloads = owner.state.ephemeralDownloads.filter(
          (item) => item.partition !== owner.tab.partition || !['completed', 'cancelled', 'interrupted'].includes(item.state)
        );
      } else if (owner.state.amnesia) {
        owner.state.ephemeralDownloads = owner.state.ephemeralDownloads.filter(
          (item) => !['completed', 'cancelled', 'interrupted'].includes(item.state)
        );
      } else {
        owner.state.ephemeralDownloads = owner.state.ephemeralDownloads.filter(
          (item) => !['completed', 'cancelled', 'interrupted'].includes(item.state)
        );
        store.clearDownloads(true);
      }
      broadcastStates();
      broadcastDownloadPages();
      return true;
    }
    if (!record) return false;
    if (payload.action === 'open' && record.path && fs.existsSync(record.path)) {
      return (await shell.openPath(record.path)) === '';
    }
    if (payload.action === 'show' && record.path && fs.existsSync(record.path)) {
      shell.showItemInFolder(record.path);
      return true;
    }
    if (payload.action === 'cancel') {
      const active = activeDownloads.get(record.id);
      if (active) active.item.cancel();
      return Boolean(active);
    }
    if (payload.action === 'retry' && record.url) {
      owner.state.createTab(record.url, true, owner.tab.id);
      return true;
    }
    if (payload.action === 'remove') {
      if (privateContext || record.amnesia) {
        owner.state.ephemeralDownloads = owner.state.ephemeralDownloads.filter((item) => item.id !== record.id);
      } else {
        store.removeDownload(record.id);
      }
      broadcastStates();
      broadcastDownloadPages();
      return true;
    }
    return false;
  });

  ipcMain.handle('framium:home-choose-background', async (event) => {
    const owner = tabByWebContents.get(event.sender.id);
    if (!owner || !event.sender.getURL().startsWith(HOME_URL)) return { ok: false };
    const result = await dialog.showOpenDialog(owner.state.win, {
      title: 'Choose a Framium Home background',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, cancelled: true };
    const source = result.filePaths[0];
    const extension = path.extname(source).toLowerCase();
    if (!['.png', '.jpg', '.jpeg', '.webp', '.gif'].includes(extension)) return { ok: false, error: 'Unsupported image format.' };
    const destination = path.join(app.getPath('userData'), `home-background${extension}`);
    const previous = store.settings.home.backgroundImagePath;
    try {
      if (path.resolve(source) !== path.resolve(destination)) fs.copyFileSync(source, destination);
      if (previous && previous !== destination && path.dirname(previous) === app.getPath('userData') && fs.existsSync(previous)) fs.unlinkSync(previous);
      store.patchSettings({ home: { background: 'image', backgroundImagePath: destination } });
      reloadHomePages();
      broadcastStates();
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error.message };
    }
  });

  ipcMain.handle('framium:home-remove-background', (event) => {
    const owner = tabByWebContents.get(event.sender.id);
    if (!owner || !event.sender.getURL().startsWith(HOME_URL)) return false;
    const previous = store.settings.home.backgroundImagePath;
    if (previous && path.dirname(previous) === app.getPath('userData') && fs.existsSync(previous)) {
      try { fs.unlinkSync(previous); } catch { /* File may be in use; settings are still reset. */ }
    }
    store.patchSettings({ home: { background: 'aurora', backgroundImagePath: '' } });
    reloadHomePages();
    broadcastStates();
    return true;
  });

  ipcMain.handle('framium:home-data', (event) => {
    const owner = tabByWebContents.get(event.sender.id);
    if (!owner) return null;
    const privateContext = owner.state.amnesia || owner.tab.burner;
    return {
      settings: copy(store.settings),
      bookmarks: privateContext ? [] : copy(store.bookmarks.slice(0, 12)),
      recent: privateContext ? [] : copy(store.history.slice(0, 8)),
      blockedCount: owner.state.blockedCount,
      amnesia: privateContext,
      mode: owner.tab.burner ? 'vanish' : owner.state.amnesia ? 'amnesia' : 'normal',
      searchEngine: SEARCH_ENGINES[store.settings.searchEngine]?.name || 'Google'
    };
  });
  ipcMain.on('framium:home-update', (_event, patch) => {
    store.patchSettings({ home: patch || {} });
    broadcastStates();
  });
  ipcMain.on('framium:home-open', (event, payload) => {
    const owner = tabByWebContents.get(event.sender.id);
    if (!owner || !payload?.url) return;
    if (payload.newTab) owner.state.createTab(payload.url, true, owner.tab.id);
    else owner.tab.view.webContents.loadURL(searchOrUrl(payload.url)).catch(() => {});
  });
  ipcMain.on('framium:show-settings', (event) => {
    const owner = tabByWebContents.get(event.sender.id);
    owner?.state.command('settings');
  });
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    const existing = [...windows.values()][0];
    if (existing) {
      if (existing.win.isMinimized()) existing.win.restore();
      existing.win.focus();
      const candidate = argv.find((arg) => /^https?:\/\//i.test(arg));
      if (candidate) existing.createTab(candidate, true);
    } else {
      createBrowserWindow();
    }
  });

  app.whenReady().then(() => {
    store = new JsonStore(app.getPath('userData'));
    installIpc();
    createBrowserWindow();
  });

  app.on('window-all-closed', () => app.quit());
}
