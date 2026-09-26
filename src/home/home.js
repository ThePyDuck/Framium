'use strict';

const api = window.framiumHome;
let data = null;
let draggedWidget = null;
let noteTimer = null;
let glassTimer = null;

const $ = (selector) => document.querySelector(selector);
const labels = {
  clock: 'Clock',
  quickLinks: 'Quick links',
  notes: 'Scratchpad',
  recent: 'Recent pages',
  privacy: 'Privacy stats'
};

function hexToRgb(hex) {
  const match = String(hex).replace('#', '').match(/^([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i);
  return match ? `${parseInt(match[1], 16)}, ${parseInt(match[2], 16)}, ${parseInt(match[3], 16)}` : '139, 92, 246';
}

function greeting() {
  const hour = new Date().getHours();
  if (hour < 5) return 'A quiet night.';
  if (hour < 12) return 'Good morning.';
  if (hour < 18) return 'Good afternoon.';
  return 'Good evening.';
}

function updateClock() {
  const now = new Date();
  $('#clockTime').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('#clockSeconds').textContent = now.toLocaleTimeString([], { second: '2-digit' });
  $('#clockDate').textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  $('#dateLine').textContent = now.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
}

function render(payload) {
  data = payload;
  const home = data.settings.home || {};
  const accent = data.settings.accent || '#8b5cf6';
  const opacity = Math.min(96, Math.max(20, Number(home.glassOpacity ?? 62)));
  const blur = Math.min(48, Math.max(0, Number(home.glassBlur ?? 24)));
  document.documentElement.style.setProperty('--accent', accent);
  document.documentElement.style.setProperty('--glass-opacity', String(opacity / 100));
  document.documentElement.style.setProperty('--glass-blur', `${blur}px`);
  $('#opacityRange').value = opacity;
  $('#opacityValue').textContent = `${opacity}%`;
  $('#blurRange').value = blur;
  $('#blurValue').textContent = `${blur}px`;
  $('#removeBackgroundImage').classList.toggle('hidden', !home.backgroundImagePath);
  const logo = ['halo', 'portal', 'fold'].includes(data.settings.logo) ? data.settings.logo : 'halo';
  $('#homeLogo').src = `logo-${logo}.svg`;
  document.body.dataset.background = home.background || 'aurora';
  $('#greeting').textContent = data.mode === 'vanish' ? 'Here, then gone.' : data.amnesia ? 'Nothing follows you home.' : greeting();
  $('#heroSubtitle').textContent = data.mode === 'vanish'
    ? 'This tab is isolated and erases its local state when closed.'
    : data.amnesia ? 'This space forgets when the window closes.' : 'Your space. Your rhythm. Your web.';
  $('#modePill').classList.toggle('hidden', !data.amnesia);
  $('#modeLabel').textContent = data.mode === 'vanish' ? 'Vanish tab' : 'Amnesia session';
  $('#engineBadge').textContent = data.searchEngine;
  $('#searchInput').placeholder = `Search with ${data.searchEngine}`;
  $('#notesInput').value = home.notes || '';
  $('#privacyCount').textContent = data.blockedCount || 0;
  $('#greetingBlock').classList.toggle('hidden', home.greeting === false);
  renderQuickLinks();
  renderRecent();
  applyWidgetOrder();
  renderCustomizer();
  updateClock();
}

function renderQuickLinks() {
  const container = $('#quickLinks');
  container.replaceChildren();
  const defaults = [
    { title: 'Google', url: 'https://www.google.com' },
    { title: 'YouTube', url: 'https://www.youtube.com' },
    { title: 'GitHub', url: 'https://github.com' },
    { title: 'Wikipedia', url: 'https://wikipedia.org' },
    { title: 'Gmail', url: 'https://mail.google.com' },
    { title: 'Maps', url: 'https://maps.google.com' }
  ];
  const items = (data.bookmarks.length ? data.bookmarks : defaults).slice(0, 6);
  for (const item of items) {
    const button = document.createElement('button');
    button.className = 'quick-link';
    const icon = document.createElement('span');
    icon.className = 'link-icon';
    if (item.favicon) {
      const image = document.createElement('img');
      image.src = item.favicon;
      image.alt = '';
      image.addEventListener('error', () => {
        icon.replaceChildren((item.title || compactUrl(item.url)).charAt(0).toUpperCase());
      });
      icon.append(image);
    } else {
      icon.textContent = (item.title || compactUrl(item.url)).charAt(0).toUpperCase();
    }
    const title = document.createElement('span');
    title.className = 'link-title';
    title.textContent = item.title || compactUrl(item.url);
    button.append(icon, title);
    button.title = item.url;
    button.addEventListener('click', () => api.open(item.url, false));
    button.addEventListener('auxclick', (event) => {
      if (event.button === 1) api.open(item.url, true);
    });
    container.append(button);
  }
}

function renderRecent() {
  const container = $('#recentList');
  container.replaceChildren();
  if (data.amnesia || !data.recent.length) {
    const empty = document.createElement('p');
    empty.className = 'empty-copy';
    empty.textContent = data.amnesia ? 'Recent activity stays hidden in Amnesia Mode.' : 'Pages you visit will appear here.';
    container.append(empty);
    return;
  }
  for (const item of data.recent.slice(0, 4)) {
    const button = document.createElement('button');
    button.className = 'recent-item';
    const icon = document.createElement('span');
    icon.className = 'recent-favicon';
    icon.textContent = compactUrl(item.url).charAt(0).toUpperCase();
    const copy = document.createElement('span');
    copy.className = 'recent-copy';
    const title = document.createElement('span');
    title.className = 'recent-title';
    title.textContent = item.title || compactUrl(item.url);
    const host = document.createElement('span');
    host.className = 'recent-host';
    host.textContent = compactUrl(item.url);
    copy.append(title, host);
    button.append(icon, copy);
    button.addEventListener('click', () => api.open(item.url, false));
    container.append(button);
  }
}

function compactUrl(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

function applyWidgetOrder() {
  const grid = $('#widgetGrid');
  const order = data.settings.home.widgetOrder || ['clock', 'quickLinks', 'notes', 'recent', 'privacy'];
  const hidden = data.settings.home.hiddenWidgets || [];
  for (const id of order) {
    const widget = grid.querySelector(`[data-widget="${id}"]`);
    if (widget) grid.append(widget);
  }
  grid.querySelectorAll('[data-widget]').forEach((widget) => {
    widget.classList.toggle('hidden', hidden.includes(widget.dataset.widget));
  });
}

function renderCustomizer() {
  const home = data.settings.home;
  document.querySelectorAll('[data-background]').forEach((button) => button.classList.toggle('active', button.dataset.background === home.background));
  const holder = $('#widgetToggles');
  holder.replaceChildren();
  const hidden = home.hiddenWidgets || [];
  for (const [id, label] of Object.entries(labels)) {
    const row = document.createElement('label');
    row.className = 'widget-toggle';
    const text = document.createElement('span');
    text.textContent = label;
    const toggle = document.createElement('button');
    const visible = !hidden.includes(id);
    toggle.type = 'button';
    toggle.className = 'widget-switch';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-label', `${visible ? 'Disable' : 'Enable'} ${label}`);
    toggle.setAttribute('aria-checked', String(visible));
    toggle.addEventListener('click', () => {
      const currentlyVisible = toggle.getAttribute('aria-checked') === 'true';
      const next = new Set(data.settings.home.hiddenWidgets || []);
      if (currentlyVisible) next.add(id); else next.delete(id);
      data.settings.home.hiddenWidgets = [...next];
      toggle.setAttribute('aria-checked', String(!currentlyVisible));
      toggle.setAttribute('aria-label', `${currentlyVisible ? 'Enable' : 'Disable'} ${label}`);
      api.updateHome({ hiddenWidgets: [...next] });
      applyWidgetOrder();
    });
    row.append(text, toggle);
    holder.append(row);
  }
}

function saveOrder() {
  const order = [...document.querySelectorAll('#widgetGrid [data-widget]')].map((widget) => widget.dataset.widget);
  data.settings.home.widgetOrder = order;
  api.updateHome({ widgetOrder: order });
}

$('#searchForm').addEventListener('submit', (event) => {
  event.preventDefault();
  const value = $('#searchInput').value.trim();
  if (value) api.open(value, false);
});

$('#notesInput').addEventListener('input', (event) => {
  clearTimeout(noteTimer);
  $('#saveStatus').textContent = 'Saving…';
  noteTimer = setTimeout(() => {
    api.updateHome({ notes: event.target.value });
    $('#saveStatus').textContent = 'Saved locally';
  }, 350);
});

$('#customizeButton').addEventListener('click', () => $('#customizeDrawer').classList.remove('hidden'));
$('#closeCustomize').addEventListener('click', () => $('#customizeDrawer').classList.add('hidden'));
$('#openBrowserSettings').addEventListener('click', () => api.customizeBrowser());
document.querySelectorAll('[data-background]').forEach((button) => {
  button.addEventListener('click', () => {
    document.body.dataset.background = button.dataset.background;
    data.settings.home.background = button.dataset.background;
    api.updateHome({ background: button.dataset.background });
    renderCustomizer();
  });
});

$('#chooseBackgroundImage').addEventListener('click', () => api.chooseBackgroundImage());
$('#removeBackgroundImage').addEventListener('click', () => api.removeBackgroundImage());

function updateGlass(kind, value) {
  const numeric = Number(value);
  if (kind === 'opacity') {
    data.settings.home.glassOpacity = numeric;
    document.documentElement.style.setProperty('--glass-opacity', String(numeric / 100));
    $('#opacityValue').textContent = `${numeric}%`;
  } else {
    data.settings.home.glassBlur = numeric;
    document.documentElement.style.setProperty('--glass-blur', `${numeric}px`);
    $('#blurValue').textContent = `${numeric}px`;
  }
  clearTimeout(glassTimer);
  glassTimer = setTimeout(() => {
    api.updateHome(kind === 'opacity' ? { glassOpacity: numeric } : { glassBlur: numeric });
  }, 120);
}
$('#opacityRange').addEventListener('input', (event) => updateGlass('opacity', event.target.value));
$('#blurRange').addEventListener('input', (event) => updateGlass('blur', event.target.value));

document.querySelectorAll('[data-widget]').forEach((widget) => {
  widget.addEventListener('dragstart', (event) => {
    draggedWidget = widget;
    widget.classList.add('dragging');
    event.dataTransfer.effectAllowed = 'move';
  });
  widget.addEventListener('dragend', () => {
    widget.classList.remove('dragging');
    draggedWidget = null;
    saveOrder();
  });
  widget.addEventListener('dragover', (event) => {
    event.preventDefault();
    if (!draggedWidget || draggedWidget === widget) return;
    const rect = widget.getBoundingClientRect();
    const before = event.clientY < rect.top + rect.height / 2;
    $('#widgetGrid').insertBefore(draggedWidget, before ? widget : widget.nextSibling);
  });
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') $('#customizeDrawer').classList.add('hidden');
  if (event.key === '/' && document.activeElement?.tagName !== 'TEXTAREA') {
    event.preventDefault();
    $('#searchInput').focus();
  }
});

updateClock();
setInterval(updateClock, 1000);
api.getData().then(render);
