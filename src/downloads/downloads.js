'use strict';

const api = window.framiumDownloads;
let downloads = [];
let filter = 'all';
let query = '';
const $ = (selector) => document.querySelector(selector);

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (!value) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

function formatDate(timestamp) {
  if (!timestamp) return '';
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(timestamp);
}

function extensionOf(filename) {
  const extension = String(filename || '').split('.').pop();
  return extension && extension.length <= 5 ? extension : 'file';
}

function visibleItems() {
  return downloads.filter((item) => {
    const matchesQuery = !query || `${item.filename} ${item.url}`.toLowerCase().includes(query);
    const matchesFilter = filter === 'all'
      || (filter === 'progressing' && ['choosing', 'progressing'].includes(item.state))
      || (filter === 'completed' && item.state === 'completed')
      || (filter === 'issues' && ['cancelled', 'interrupted'].includes(item.state));
    return matchesQuery && matchesFilter;
  });
}

function render() {
  $('#totalCount').textContent = downloads.length;
  $('#activeCount').textContent = downloads.filter((item) => ['choosing', 'progressing'].includes(item.state)).length;
  const list = $('#downloadList');
  list.replaceChildren();
  const items = visibleItems();

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    const symbol = document.createElement('div');
    symbol.className = 'empty-symbol';
    symbol.textContent = '↓';
    const heading = document.createElement('h2');
    heading.textContent = downloads.length ? 'Nothing matches' : 'No downloads yet';
    const copy = document.createElement('p');
    copy.textContent = downloads.length ? 'Try another search or filter.' : 'Files you download will appear here.';
    empty.append(symbol, heading, copy);
    list.append(empty);
    return;
  }

  for (const item of items) list.append(createItem(item));
}

function createItem(item) {
  const row = document.createElement('article');
  row.className = 'download-item';
  if (item.state === 'completed' && item.path) {
    row.draggable = true;
    row.title = 'Double-click to open · drag to move or attach';
    row.addEventListener('dblclick', (event) => {
      if (!event.target.closest('button')) api.action('open', item.id);
    });
    row.addEventListener('dragstart', (event) => {
      event.preventDefault();
      api.startDrag(item.id);
    });
  }
  const icon = document.createElement('div');
  icon.className = 'file-icon';
  icon.textContent = extensionOf(item.filename);

  const copy = document.createElement('div');
  copy.className = 'item-copy';
  const name = document.createElement('p');
  name.className = 'item-name';
  name.textContent = item.filename || 'Download';
  name.title = item.path || item.url || '';
  const meta = document.createElement('div');
  meta.className = 'item-meta';
  const dot = document.createElement('span');
  dot.className = `status-dot ${item.state || ''}`;
  const status = document.createElement('span');
  status.textContent = statusText(item);
  const date = document.createElement('span');
  date.textContent = formatDate(item.finishedAt || item.startedAt);
  meta.append(dot, status, date);
  copy.append(name, meta);

  if (['choosing', 'progressing'].includes(item.state)) {
    const track = document.createElement('div');
    track.className = 'progress-track';
    const bar = document.createElement('span');
    const percent = item.totalBytes ? Math.min(100, item.receivedBytes / item.totalBytes * 100) : 18;
    bar.style.width = `${percent}%`;
    track.append(bar);
    copy.append(track);
  }

  const actions = document.createElement('div');
  actions.className = 'item-actions';
  if (item.state === 'completed') {
    actions.append(actionButton('Open', 'open', item.id, true), actionButton('Show', 'show', item.id));
  } else if (['choosing', 'progressing'].includes(item.state)) {
    actions.append(actionButton('Cancel', 'cancel', item.id));
  } else {
    actions.append(actionButton('Retry', 'retry', item.id, true));
  }
  actions.append(actionButton('Remove', 'remove', item.id));
  row.append(icon, copy, actions);
  return row;
}

function statusText(item) {
  if (item.state === 'completed') return `${formatBytes(item.totalBytes || item.receivedBytes)} · Complete`;
  if (item.state === 'progressing') return `${formatBytes(item.receivedBytes)} of ${formatBytes(item.totalBytes)}`;
  if (item.state === 'choosing') return 'Choose where to save';
  if (item.state === 'cancelled') return 'Cancelled';
  if (item.state === 'interrupted') return 'Interrupted';
  return item.state || 'Unknown';
}

function actionButton(label, action, id, primary = false) {
  const button = document.createElement('button');
  button.textContent = label;
  if (primary) button.className = 'primary';
  button.addEventListener('click', async () => {
    await api.action(action, id);
    if (action === 'remove') {
      downloads = downloads.filter((item) => item.id !== id);
      render();
    }
  });
  return button;
}

document.querySelectorAll('[data-filter]').forEach((button) => {
  button.addEventListener('click', () => {
    filter = button.dataset.filter;
    document.querySelectorAll('[data-filter]').forEach((item) => item.classList.toggle('active', item === button));
    render();
  });
});

$('#downloadSearch').addEventListener('input', (event) => {
  query = event.target.value.trim().toLowerCase();
  render();
});
$('#openFolder').addEventListener('click', () => api.action('open-folder'));
$('#clearCompleted').addEventListener('click', () => api.action('clear-completed'));

api.onUpdated((next) => {
  downloads = next;
  render();
});
api.getData().then((data) => {
  if (!data) return;
  downloads = data.downloads;
  $('#downloadLocation').textContent = data.amnesia ? 'Downloads remain on disk after Amnesia closes' : data.downloadsPath;
  render();
});
