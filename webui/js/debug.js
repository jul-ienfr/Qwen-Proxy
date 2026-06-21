/**
 * QwenProxy Dashboard - Debug Mode Tab
 */

// ─── State ───────────────────────────────────────────────────────────────────

const debugState = {
  enabled: false,
  page: 1,
  perPage: 100,
  total: 0,
  maxSize: 5000,
  refreshInterval: null,
};

// ─── API Helper ──────────────────────────────────────────────────────────────

async function debugApi(path, options = {}) {
  try {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`Debug API Error (${path}):`, err);
    return null;
  }
}

// ─── Status ──────────────────────────────────────────────────────────────────

async function refreshDebugStatus() {
  const data = await debugApi('/api/debug/status');
  if (!data) return;

  debugState.enabled = data.enabled;
  debugState.maxSize = data.stats.maxSize;

  const toggle = document.getElementById('debug-toggle');
  const text = document.getElementById('debug-status-text');
  const badge = document.getElementById('debugBadge');

  if (toggle) toggle.checked = data.enabled;
  if (text) text.textContent = data.enabled ? 'ON' : 'OFF';
  if (badge) badge.style.display = data.enabled ? 'inline' : 'none';

  updateDebugCounter(data.stats.total, data.stats.maxSize);
}

function updateDebugCounter(total, maxSize) {
  const counter = document.getElementById('debug-counter');
  if (counter) {
    counter.textContent = `${total} / ${maxSize}`;
  }
}

// ─── Toggle ──────────────────────────────────────────────────────────────────

async function toggleDebugMode() {
  const data = await debugApi('/api/debug/toggle', { method: 'POST' });
  if (!data) return;

  debugState.enabled = data.enabled;
  debugState.page = 1;

  const text = document.getElementById('debug-status-text');
  const badge = document.getElementById('debugBadge');

  if (text) text.textContent = data.enabled ? 'ON' : 'OFF';
  if (badge) badge.style.display = data.enabled ? 'inline' : 'none';

  if (data.enabled) {
    refreshDebugLogs();
  } else {
    renderDebugLogs({ entries: [], total: 0, hasMore: false, stats: { enabled: false, bufferUsed: 0, maxSize: debugState.maxSize } });
  }
}

// ─── Logs ────────────────────────────────────────────────────────────────────

async function refreshDebugLogs() {
  const category = document.getElementById('debug-filter-category')?.value || '';
  const search = document.getElementById('debug-filter-search')?.value || '';

  const params = new URLSearchParams({
    page: debugState.page,
    perPage: debugState.perPage,
  });
  if (category) params.set('category', category);
  if (search) params.set('search', search);

  const data = await debugApi(`/api/debug/logs?${params}`);
  if (!data) return;

  debugState.total = data.total;
  updateDebugCounter(data.stats.bufferUsed, data.stats.maxSize);
  renderDebugLogs(data);
}

function renderDebugLogs(data) {
  const viewer = document.getElementById('debug-log-viewer');
  if (!viewer) return;

  if (data.entries.length === 0) {
    viewer.innerHTML = `<div class="empty">${debugState.enabled ? 'Aucun log — faites une requête pour voir les données' : 'Activez le mode debug pour voir les logs'}</div>`;
    renderDebugPagination();
    return;
  }

  viewer.innerHTML = data.entries.map(entry => renderDebugLogEntry(entry)).join('');
  renderDebugPagination();
}

function renderDebugLogEntry(entry) {
  const time = new Date(entry.timestamp).toLocaleTimeString('fr-FR');
  const catClass = `debug-category-${entry.category.toLowerCase()}`;
  const metadataHtml = entry.metadata
    ? `<div class="debug-metadata">${escapeHtml(JSON.stringify(entry.metadata, null, 2))}</div>`
    : '';

  return `
    <div class="debug-log-entry" onclick="this.classList.toggle('expanded')">
      <div class="debug-log-main">
        <span class="debug-category-badge ${catClass}">${entry.category}</span>
        <span class="debug-log-time">${time}</span>
        <span class="debug-log-component">${escapeHtml(entry.component)}</span>
        <span class="debug-log-message">${escapeHtml(entry.message)}</span>
        ${entry.metadata ? '<span class="debug-log-expand">▼</span>' : ''}
      </div>
      ${metadataHtml}
    </div>
  `;
}

function renderDebugPagination() {
  const container = document.getElementById('debug-pagination');
  if (!container) return;

  const totalPages = Math.ceil(debugState.total / debugState.perPage);

  if (totalPages <= 1) {
    container.innerHTML = '';
    return;
  }

  let html = '';
  for (let i = 1; i <= totalPages; i++) {
    html += `<button class="${i === debugState.page ? 'active' : ''}" data-page="${i}">${i}</button>`;
  }
  container.innerHTML = html;

  container.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      debugState.page = parseInt(btn.dataset.page);
      refreshDebugLogs();
    });
  });
}

// ─── Clear Logs ──────────────────────────────────────────────────────────────

async function clearDebugLogs() {
  const data = await debugApi('/api/debug/logs', { method: 'DELETE' });
  if (!data) return;

  debugState.total = 0;
  renderDebugLogs({ entries: [], total: 0, hasMore: false, stats: { enabled: debugState.enabled, bufferUsed: 0, maxSize: debugState.maxSize } });
}

// ─── Export Logs ──────────────────────────────────────────────────────────────

async function exportDebugLogs() {
  const allEntries = [];
  let offset = 0;
  const limit = 500;

  while (true) {
    const params = new URLSearchParams({ limit, offset });
    const data = await debugApi(`/api/debug/logs?${params}`);
    if (!data || data.entries.length === 0) break;

    allEntries.push(...data.entries);
    if (!data.hasMore) break;
    offset += limit;
  }

  if (allEntries.length === 0) {
    alert('Aucun log à exporter');
    return;
  }

  const blob = new Blob([JSON.stringify(allEntries, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `qwenproxy-debug-${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Event Listeners ─────────────────────────────────────────────────────────

document.getElementById('debug-toggle')?.addEventListener('change', toggleDebugMode);
document.getElementById('btn-clear-logs')?.addEventListener('click', clearDebugLogs);
document.getElementById('btn-export-logs')?.addEventListener('click', exportDebugLogs);
document.getElementById('debug-filter-category')?.addEventListener('change', () => { debugState.page = 1; refreshDebugLogs(); });
document.getElementById('debug-filter-search')?.addEventListener('keyup', (e) => {
  if (e.key === 'Enter') { debugState.page = 1; refreshDebugLogs(); }
});

// ─── Expose for refreshCurrentTab ────────────────────────────────────────────

window.refreshDebugTab = function() {
  refreshDebugStatus();
  refreshDebugLogs();
};
