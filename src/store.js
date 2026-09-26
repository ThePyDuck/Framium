'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

class JsonStore {
  constructor(directory) {
    this.directory = directory;
    this.paths = {
      settings: path.join(directory, 'settings.json'),
      bookmarks: path.join(directory, 'bookmarks.json'),
      history: path.join(directory, 'history.json'),
      session: path.join(directory, 'session.json'),
      downloads: path.join(directory, 'downloads.json')
    };

    fs.mkdirSync(directory, { recursive: true });

    this.settings = this.read('settings', {
      searchEngine: 'google',
      blockTrackers: true,
      restoreSession: true,
      openLinksInNewTab: true,
      askDownloadLocation: false,
      compactSidebar: false,
      extensionPaths: [],
      theme: 'midnight',
      accent: '#8b5cf6',
      logo: 'halo',
      home: {
        background: 'aurora',
        backgroundImagePath: '',
        glassOpacity: 62,
        glassBlur: 24,
        greeting: true,
        clock: true,
        notes: '',
        widgetOrder: ['search', 'clock', 'quickLinks', 'notes', 'privacy']
      }
    });
    this.bookmarks = this.read('bookmarks', []);
    this.history = this.read('history', []);
    this.session = this.read('session', { tabs: ['framium://home'], activeIndex: 0 });
    this.downloads = this.read('downloads', []);
  }

  read(key, fallback) {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.paths[key], 'utf8'));
      return parsed ?? clone(fallback);
    } catch {
      return clone(fallback);
    }
  }

  write(key, value) {
    const target = this.paths[key];
    const temporary = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(temporary, target);
  }

  patchSettings(patch) {
    this.settings = {
      ...this.settings,
      ...patch,
      home: { ...this.settings.home, ...(patch.home || {}) }
    };
    this.write('settings', this.settings);
    return clone(this.settings);
  }

  addBookmark(input) {
    const existing = this.bookmarks.find((item) => item.url === input.url);
    if (existing) {
      if (input.favicon && existing.favicon !== input.favicon) {
        existing.favicon = input.favicon;
        this.write('bookmarks', this.bookmarks);
      }
      return existing;
    }
    const item = {
      id: crypto.randomUUID(),
      title: input.title || input.url,
      url: input.url,
      favicon: input.favicon || '',
      createdAt: Date.now()
    };
    this.bookmarks.unshift(item);
    this.write('bookmarks', this.bookmarks);
    return item;
  }

  updateBookmarkFavicon(url, favicon) {
    if (!url || !favicon) return;
    const bookmark = this.bookmarks.find((item) => item.url === url);
    if (!bookmark || bookmark.favicon === favicon) return;
    bookmark.favicon = favicon;
    this.write('bookmarks', this.bookmarks);
  }

  removeBookmarkByUrl(url) {
    const originalLength = this.bookmarks.length;
    this.bookmarks = this.bookmarks.filter((item) => item.url !== url);
    if (this.bookmarks.length !== originalLength) this.write('bookmarks', this.bookmarks);
  }

  removeBookmark(id) {
    this.bookmarks = this.bookmarks.filter((item) => item.id !== id);
    this.write('bookmarks', this.bookmarks);
  }

  addHistory(input) {
    if (!input.url || !/^https?:/i.test(input.url)) return;
    const newest = this.history[0];
    if (newest?.url === input.url && Date.now() - newest.visitedAt < 30000) {
      newest.title = input.title || newest.title;
      newest.visitedAt = Date.now();
    } else {
      this.history.unshift({
        id: crypto.randomUUID(),
        title: input.title || input.url,
        url: input.url,
        visitedAt: Date.now()
      });
    }
    this.history = this.history.slice(0, 2000);
    this.write('history', this.history);
  }

  clearHistory() {
    this.history = [];
    this.write('history', this.history);
  }

  setSession(session) {
    this.session = session;
    this.write('session', session);
  }

  addDownload(item) {
    const index = this.downloads.findIndex((entry) => entry.id === item.id);
    if (index >= 0) this.downloads[index] = { ...this.downloads[index], ...item };
    else this.downloads.unshift(item);
    this.downloads = this.downloads.slice(0, 200);
    this.write('downloads', this.downloads);
  }

  removeDownload(id) {
    this.downloads = this.downloads.filter((item) => item.id !== id);
    this.write('downloads', this.downloads);
  }

  clearDownloads(completedOnly = false) {
    this.downloads = completedOnly
      ? this.downloads.filter((item) => !['completed', 'cancelled', 'interrupted'].includes(item.state))
      : [];
    this.write('downloads', this.downloads);
  }

  publicData() {
    return {
      settings: clone(this.settings),
      bookmarks: clone(this.bookmarks),
      history: clone(this.history),
      downloads: clone(this.downloads)
    };
  }
}

module.exports = { JsonStore };
