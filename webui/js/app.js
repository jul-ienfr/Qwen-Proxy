/**
 * QwenProxy Dashboard - Main Application
 */

// ─── State ───────────────────────────────────────────────────────────────────

const state = {
  currentTab: 'dashboard',
  history: {
    data: [],
    total: 0,
    page: 1,
    perPage: 20,
  },
  models: [],
  mapping: {
    modelMappings: [],
    customRoutes: [],
    aliases: {},
  },
  charts: {},
  refreshInterval: null,
};

// ─── API Helpers ─────────────────────────────────────────────────────────────

async function api(path, options = {}) {
  try {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...options.headers },
      ...options,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    console.error(`API Error (${path}):`, err);
    return null;
  }
}

// ─── Tab Navigation ──────────────────────────────────────────────────────────

document.querySelectorAll('.nav-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));

    tab.classList.add('active');
    const tabName = tab.dataset.tab;
    document.getElementById(`tab-${tabName}`).classList.add('active');

    state.currentTab = tabName;
    refreshCurrentTab();
  });
});

// ─── Theme Toggle ────────────────────────────────────────────────────────────

const themeToggle = document.getElementById('themeToggle');
const savedTheme = localStorage.getItem('theme') || 'dark';
document.documentElement.dataset.theme = savedTheme;
themeToggle.textContent = savedTheme === 'dark' ? '☀️' : '🌙';

themeToggle.addEventListener('click', () => {
  const current = document.documentElement.dataset.theme;
  const next = current === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  localStorage.setItem('theme', next);
  themeToggle.textContent = next === 'dark' ? '☀️' : '🌙';
});

// ─── Dashboard ───────────────────────────────────────────────────────────────

async function refreshDashboard() {
  const stats = await api('/api/stats?period=today');
  if (!stats) return;

  // Update stat cards
  document.getElementById('stat-total').textContent = stats.total.toLocaleString();
  document.getElementById('stat-success').textContent = stats.success.toLocaleString();
  document.getElementById('stat-failed').textContent = stats.failed.toLocaleString();
  document.getElementById('stat-tokens').textContent = formatNumber(stats.tokens.total);
  document.getElementById('stat-duration').textContent = `${Math.round(stats.avgDurationMs)}ms`;
  document.getElementById('stat-cache').textContent = `${Math.round(stats.cacheHitRate * 100)}%`;

  // Update charts
  updateTokensChart(stats);
  updateModelsChart(stats);
  updateHourlyChart(stats);
}

function updateTokensChart(stats) {
  const ctx = document.getElementById('chart-tokens');
  if (state.charts.tokens) state.charts.tokens.destroy();

  state.charts.tokens = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: ['Input', 'Output', 'Cache'],
      datasets: [{
        data: [stats.tokens.input, stats.tokens.output, stats.tokens.cache],
        backgroundColor: ['#6c5ce7', '#00b894', '#74b9ff'],
        borderWidth: 0,
      }],
    },
    options: {
      responsive: true,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#8b8fa3' } },
      },
    },
  });
}

function updateModelsChart(stats) {
  const ctx = document.getElementById('chart-models');
  if (state.charts.models) state.charts.models.destroy();

  const models = Object.entries(stats.byModel);
  const colors = ['#6c5ce7', '#00b894', '#e17055', '#fdcb6e', '#74b9ff', '#a29bfe', '#55efc4'];

  state.charts.models = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: models.map(([name]) => name),
      datasets: [{
        label: 'Requêtes',
        data: models.map(([, m]) => m.count),
        backgroundColor: colors.slice(0, models.length),
        borderWidth: 0,
        borderRadius: 4,
      }],
    },
    options: {
      responsive: true,
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#8b8fa3' }, grid: { color: '#2a2d3e' } },
        y: { ticks: { color: '#8b8fa3' }, grid: { display: false } },
      },
    },
  });
}

function updateHourlyChart(stats) {
  const ctx = document.getElementById('chart-hourly');
  if (state.charts.hourly) state.charts.hourly.destroy();

  const hours = stats.byHour.reverse();

  state.charts.hourly = new Chart(ctx, {
    type: 'line',
    data: {
      labels: hours.map(h => `${h.hour}h`),
      datasets: [{
        label: 'Requêtes',
        data: hours.map(h => h.count),
        borderColor: '#6c5ce7',
        backgroundColor: 'rgba(108, 92, 231, 0.1)',
        fill: true,
        tension: 0.4,
      }],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#8b8fa3' }, grid: { color: '#2a2d3e' } },
        y: { ticks: { color: '#8b8fa3' }, grid: { color: '#2a2d3e' } },
      },
    },
  });
}

// ─── History ─────────────────────────────────────────────────────────────────

async function refreshHistory() {
  const status = document.getElementById('filter-status').value;
  const model = document.getElementById('filter-model').value;
  const protocol = document.getElementById('filter-protocol').value;
  const search = document.getElementById('filter-search').value;

  const params = new URLSearchParams({
    page: state.history.page,
    perPage: state.history.perPage,
  });
  if (status) params.set('status', status);
  if (model) params.set('model', model);
  if (protocol) params.set('protocol', protocol);
  if (search) params.set('search', search);

  const data = await api(`/api/history?${params}`);
  if (!data) return;

  state.history.data = data.data;
  state.history.total = data.total;

  renderHistoryTable();
  renderPagination();
}

function renderHistoryTable() {
  const tbody = document.getElementById('history-table-body');

  if (state.history.data.length === 0) {
    tbody.innerHTML = '<tr><td colspan="7" class="empty">Aucune requête trouvée</td></tr>';
    return;
  }

  tbody.innerHTML = state.history.data.map(req => `
    <tr data-id="${req.id}">
      <td>${new Date(req.timestamp).toLocaleString('fr-FR')}</td>
      <td>${escapeHtml(req.originalModel)}</td>
      <td>${escapeHtml(req.mappedModel)}</td>
      <td><span class="badge badge-info">${req.protocol}</span></td>
      <td>${formatNumber(req.totalTokens)}</td>
      <td>${req.durationMs}ms</td>
      <td><span class="badge ${req.success ? 'badge-success' : 'badge-error'}">${req.success ? '✓' : '✗'}</span></td>
    </tr>
  `).join('');

  // Click handler for detail modal
  tbody.querySelectorAll('tr[data-id]').forEach(row => {
    row.addEventListener('click', () => showRequestDetail(row.dataset.id));
  });
}

function renderPagination() {
  const container = document.getElementById('history-pagination');
  const totalPages = Math.ceil(state.history.total / state.history.perPage);

  if (totalPages <= 1) {
    container.innerHTML = '';
    return;
  }

  let html = '';
  for (let i = 1; i <= totalPages; i++) {
    html += `<button class="${i === state.history.page ? 'active' : ''}" data-page="${i}">${i}</button>`;
  }
  container.innerHTML = html;

  container.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      state.history.page = parseInt(btn.dataset.page);
      refreshHistory();
    });
  });
}

async function showRequestDetail(id) {
  const data = await api(`/api/history/${id}`);
  if (!data) return;

  const modal = document.getElementById('detail-modal');
  const body = document.getElementById('modal-body');

  body.innerHTML = `
    <div class="detail-grid">
      <div class="detail-item"><label>ID</label><span>${data.id}</span></div>
      <div class="detail-item"><label>Timestamp</label><span>${new Date(data.timestamp).toLocaleString('fr-FR')}</span></div>
      <div class="detail-item"><label>Modèle original</label><span>${escapeHtml(data.originalModel)}</span></div>
      <div class="detail-item"><label>Modèle mappé</label><span>${escapeHtml(data.mappedModel)}</span></div>
      <div class="detail-item"><label>Protocole</label><span>${data.protocol}</span></div>
      <div class="detail-item"><label>Endpoint</label><span>${data.endpoint || '-'}</span></div>
      <div class="detail-item"><label>Client IP</label><span>${data.clientIp || '-'}</span></div>
      <div class="detail-item"><label>User Agent</label><span style="font-size:0.75rem">${escapeHtml(data.userAgent || '-')}</span></div>
      <div class="detail-item"><label>Thinking</label><span>${data.thinking ? '✓' : '✗'}</span></div>
      <div class="detail-item"><label>Tools</label><span>${data.hasTools ? '✓' : '✗'}</span></div>
      <div class="detail-item"><label>Stream</label><span>${data.streamMode ? '✓' : '✗'}</span></div>
      <div class="detail-item"><label>Compte</label><span>${data.accountId || '-'}</span></div>
      <div class="detail-item"><label>Tokens input</label><span>${data.inputTokens}</span></div>
      <div class="detail-item"><label>Tokens output</label><span>${data.outputTokens}</span></div>
      <div class="detail-item"><label>Tokens cache</label><span>${data.cacheTokens}</span></div>
      <div class="detail-item"><label>Durée</label><span>${data.durationMs}ms</span></div>
      <div class="detail-item"><label>Statut</label><span>${data.success ? '✓ Succès' : '✗ Échec'}</span></div>
      <div class="detail-item"><label>Matched by</label><span>${data.matchedBy || '-'}</span></div>
      ${data.errorMessage ? `<div class="detail-item" style="grid-column: span 2"><label>Erreur</label><span style="color:var(--error)">${escapeHtml(data.errorMessage)}</span></div>` : ''}
    </div>
  `;

  modal.classList.add('active');
}

// ─── Mapping ─────────────────────────────────────────────────────────────────

async function refreshMapping() {
  const data = await api('/api/config/mapping');
  if (!data) return;

  state.mapping = data;
  renderMappings();
  renderRoutes();
  renderAliases();
}

function renderMappings() {
  const container = document.getElementById('mappings-list');
  container.innerHTML = state.mapping.modelMappings.map((m, i) => `
    <div class="mapping-item">
      <div>
        <span>${escapeHtml(m.source)}</span>
        <span class="mapping-arrow">→</span>
        <span>${escapeHtml(m.target)}</span>
      </div>
      <div class="mapping-actions">
        <button onclick="toggleMapping(${i})" title="${m.enabled ? 'Désactiver' : 'Activer'}">${m.enabled ? '🟢' : '🔴'}</button>
        <button onclick="removeMapping('${escapeHtml(m.source)}')" title="Supprimer">🗑️</button>
      </div>
    </div>
  `).join('') || '<div class="empty">Aucun mapping configuré</div>';
}

function renderRoutes() {
  const container = document.getElementById('routes-list');
  container.innerHTML = state.mapping.customRoutes.map(r => `
    <div class="mapping-item">
      <div>
        <span>${r.match.join(', ')}</span>
        <span class="mapping-arrow">→</span>
        <span>${escapeHtml(r.targetModel)}</span>
      </div>
      <div class="mapping-actions">
        <button onclick="toggleRoute('${r.id}')" title="${r.enabled ? 'Désactiver' : 'Activer'}">${r.enabled ? '🟢' : '🔴'}</button>
        <button onclick="removeRoute('${r.id}')" title="Supprimer">🗑️</button>
      </div>
    </div>
  `).join('') || '<div class="empty">Aucune route personnalisée</div>';
}

function renderAliases() {
  const container = document.getElementById('aliases-list');
  const entries = Object.entries(state.mapping.aliases);
  container.innerHTML = entries.map(([alias, target]) => `
    <div class="mapping-item">
      <div>
        <span>${escapeHtml(alias)}</span>
        <span class="mapping-arrow">→</span>
        <span>${escapeHtml(target)}</span>
      </div>
      <div class="mapping-actions">
        <button onclick="removeAlias('${escapeHtml(alias)}')" title="Supprimer">🗑️</button>
      </div>
    </div>
  `).join('') || '<div class="empty">Aucun alias configuré</div>';
}

// Mapping actions
window.toggleMapping = async (index) => {
  const m = state.mapping.modelMappings[index];
  m.enabled = !m.enabled;
  await api('/api/config/mapping', {
    method: 'PUT',
    body: JSON.stringify(state.mapping),
  });
  renderMappings();
};

window.removeMapping = async (source) => {
  if (!confirm(`Supprimer le mapping "${source}" ?`)) return;
  await api(`/api/config/mappings/${encodeURIComponent(source)}`, { method: 'DELETE' });
  refreshMapping();
};

window.toggleRoute = async (id) => {
  const route = state.mapping.customRoutes.find(r => r.id === id);
  if (!route) return;
  route.enabled = !route.enabled;
  await api(`/api/config/routes/${id}`, {
    method: 'PUT',
    body: JSON.stringify(route),
  });
  renderRoutes();
};

window.removeRoute = async (id) => {
  if (!confirm('Supprimer cette route ?')) return;
  await api(`/api/config/routes/${id}`, { method: 'DELETE' });
  refreshMapping();
};

window.removeAlias = async (alias) => {
  if (!confirm(`Supprimer l'alias "${alias}" ?`)) return;
  await api(`/api/config/aliases/${encodeURIComponent(alias)}`, { method: 'DELETE' });
  refreshMapping();
};

// ─── Mapping Modal ───────────────────────────────────────────────────────────

document.getElementById('btn-add-mapping').addEventListener('click', () => {
  document.getElementById('mapping-modal-title').textContent = 'Ajouter un mapping';
  document.getElementById('mapping-source').value = '';
  document.getElementById('mapping-target').value = '';
  document.getElementById('mapping-enabled').checked = true;
  document.getElementById('mapping-modal').classList.add('active');
});

document.getElementById('mapping-modal-close').addEventListener('click', () => {
  document.getElementById('mapping-modal').classList.remove('active');
});

document.getElementById('mapping-cancel').addEventListener('click', () => {
  document.getElementById('mapping-modal').classList.remove('active');
});

document.getElementById('mapping-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const source = document.getElementById('mapping-source').value.trim();
  const target = document.getElementById('mapping-target').value.trim();
  const enabled = document.getElementById('mapping-enabled').checked;

  if (!source || !target) return;

  await api('/api/config/mappings', {
    method: 'POST',
    body: JSON.stringify({ source, target, enabled }),
  });

  document.getElementById('mapping-modal').classList.remove('active');
  refreshMapping();
});

// ─── Models ──────────────────────────────────────────────────────────────────

async function refreshModels() {
  const data = await api('/v1/models');
  if (!data || !data.data) return;

  state.models = data.data;
  renderModels();
}

function renderModels() {
  const tbody = document.getElementById('models-table-body');
  const models = state.models.filter(m => !m.id.endsWith('-no-thinking'));

  tbody.innerHTML = models.map(m => `
    <tr>
      <td><code>${escapeHtml(m.id)}</code></td>
      <td>${escapeHtml(m.name || '-')}</td>
      <td>${m.context_window ? formatNumber(m.context_window) : '-'}</td>
      <td>${escapeHtml(m.owned_by || '-')}</td>
    </tr>
  `).join('') || '<tr><td colspan="4" class="empty">Aucun modèle disponible</td></tr>';
}

// ─── Settings ────────────────────────────────────────────────────────────────

const settingsState = {
  config: null,
  metadata: null,
  dirty: {}, // path -> newValue
};

const SETTINGS_SECTIONS = [
  { key: 'server', label: '🖥️ Serveur', readOnly: true },
  { key: 'timeouts', label: '⏱️ Timeouts' },
  { key: 'cache', label: '💾 Cache' },
  { key: 'browser', label: '🌐 Navigateur' },
  { key: 'qwen', label: '🤖 Qwen API' },
  { key: 'performance', label: '⚡ Performance' },
  { key: 'watchdog', label: '🐕 Watchdog' },
  { key: 'debug', label: '🐛 Debug' },
  { key: 'logging', label: '📋 Logging' },
  { key: 'general', label: '🔧 Général' },
];

const SETTINGS_FIELDS = {
  'server.port': { label: 'Port', type: 'number', readOnly: true, requiresRestart: true },
  'server.host': { label: 'Host', type: 'text', readOnly: true, requiresRestart: true },
  'timeouts.navigation': { label: 'Navigation (ms)', type: 'number' },
  'timeouts.page': { label: 'Page (ms)', type: 'number' },
  'timeouts.http': { label: 'HTTP (ms)', type: 'number' },
  'timeouts.headers': { label: 'Headers (ms)', type: 'number' },
  'timeouts.chat': { label: 'Chat (ms)', type: 'number' },
  'timeouts.streamIdle': { label: 'Stream Idle (ms)', type: 'number' },
  'cache.defaultTTL': { label: 'Default TTL (s)', type: 'number' },
  'cache.responseTTL': { label: 'Response TTL (s)', type: 'number' },
  'browser.headless': { label: 'Headless', type: 'toggle' },
  'browser.type': { label: 'Type', type: 'select', options: ['chromium', 'firefox', 'webkit', 'chrome', 'edge'] },
  'browser.userAgent': { label: 'User Agent', type: 'text' },
  'browser.userDataDir': { label: 'User Data Dir', type: 'text' },
  'browser.logConsole': { label: 'Log Console', type: 'toggle' },
  'qwen.baseUrl': { label: 'Base URL', type: 'text' },
  'qwen.httpEndpoint': { label: 'HTTP Endpoint', type: 'text' },
  'qwen.apiKey': { label: 'API Key', type: 'password' },
  'fastStreamProxy': { label: 'Fast Stream Proxy (zero-copy)', type: 'toggle' },
  'tlsPoolSize': { label: 'TLS Pool Size', type: 'number' },
  'useWsBridge': { label: 'WebSocket Bridge', type: 'toggle' },
  'watchdog.checkInterval': { label: 'Check Interval (ms)', type: 'number' },
  'watchdog.consecutiveFailuresThreshold': { label: 'Failure Threshold', type: 'number' },
  'watchdog.ram.warningThreshold': { label: 'RAM Warning (%)', type: 'number' },
  'watchdog.ram.criticalThreshold': { label: 'RAM Critical (%)', type: 'number' },
  'watchdog.streams.warningThreshold': { label: 'Streams Warning', type: 'number' },
  'watchdog.streams.criticalThreshold': { label: 'Streams Critical', type: 'number' },
  'debug.initialMode': { label: 'Mode Initial', type: 'toggle' },
  'debug.bufferSize': { label: 'Buffer Size', type: 'number' },
  'debug.persist': { label: 'Persist', type: 'toggle' },
  'logging.enabled': { label: 'Enabled', type: 'toggle' },
  'directFetch': { label: 'Direct Fetch (Node.js)', type: 'toggle' },
  'apiKey': { label: 'API Key', type: 'password' },
};

async function refreshSettings() {
  const data = await api('/api/config/server');
  if (!data) return;

  settingsState.config = data.config;
  settingsState.metadata = data.metadata;
  settingsState.dirty = {};

  renderSettingsForm();
  updateSaveButton();
}

function renderSettingsForm() {
  const container = document.getElementById('settings-form-container');
  if (!container) return;

  let html = '';

  for (const section of SETTINGS_SECTIONS) {
    const fields = Object.entries(SETTINGS_FIELDS)
      .filter(([path]) => path.startsWith(section.key + '.') || (section.key === 'general' && !path.includes('.')));

    if (fields.length === 0) continue;

    html += `<div class="setting-group">`;
    html += `<h3>${section.label}</h3>`;

    for (const [path, field] of fields) {
      const value = settingsState.config?.[path.split('.')[0]]?.[path.split('.').slice(1).join('.')]
        ?? settingsState.config?.[path];
      const meta = settingsState.metadata?.[path];
      const isDirty = path in settingsState.dirty;
      const requiresRestart = meta?.requiresRestart || field.requiresRestart;

      html += `<div class="setting-item ${isDirty ? 'dirty' : ''}">`;
      html += `<label>${field.label}</label>`;

      if (field.type === 'toggle') {
        html += `<label class="toggle-switch">`;
        html += `<input type="checkbox" data-path="${path}" ${value ? 'checked' : ''} onchange="onSettingChange('${path}', this.checked)">`;
        html += `<span class="toggle-slider"></span>`;
        html += `</label>`;
      } else if (field.type === 'select') {
        html += `<select data-path="${path}" onchange="onSettingChange('${path}', this.value)">`;
        for (const opt of field.options) {
          html += `<option value="${opt}" ${value === opt ? 'selected' : ''}>${opt}</option>`;
        }
        html += `</select>`;
      } else if (field.type === 'password') {
        html += `<div class="password-field">`;
        html += `<input type="password" data-path="${path}" value="${escapeHtml(value || '')}" onchange="onSettingChange('${path}', this.value)" onkeyup="onSettingChange('${path}', this.value)">`;
        html += `<button class="btn-icon" onclick="togglePasswordVisibility(this)" title="Afficher/Masquer">👁️</button>`;
        html += `</div>`;
      } else if (field.type === 'number') {
        html += `<input type="number" data-path="${path}" value="${value ?? ''}" onchange="onSettingChange('${path}', Number(this.value))" onkeyup="onSettingChange('${path}', Number(this.value))">`;
      } else {
        html += `<input type="text" data-path="${path}" value="${escapeHtml(value || '')}" onchange="onSettingChange('${path}', this.value)" onkeyup="onSettingChange('${path}', this.value)">`;
      }

      if (requiresRestart && !field.readOnly) {
        html += `<span class="requires-restart-badge">⚠️ Restart</span>`;
      }
      if (field.readOnly) {
        html += `<span class="readonly-badge">📖 Lecture seule</span>`;
      }
      if (isDirty) {
        html += `<span class="dirty-indicator"></span>`;
      }

      html += `</div>`;
    }

    html += `</div>`;
  }

  container.innerHTML = html || '<div class="empty">Aucun paramètre disponible</div>';
}

window.onSettingChange = function(path, value) {
  settingsState.dirty[path] = value;
  updateSaveButton();
  // Update visual state
  const input = document.querySelector(`[data-path="${path}"]`);
  if (input) {
    const item = input.closest('.setting-item');
    if (item) item.classList.add('dirty');
  }
};

function updateSaveButton() {
  const btn = document.getElementById('btn-save-settings');
  if (btn) {
    const count = Object.keys(settingsState.dirty).length;
    btn.disabled = count === 0;
    btn.textContent = count > 0 ? `💾 Sauvegarder (${count})` : '💾 Sauvegarder';
  }
}

window.togglePasswordVisibility = function(btn) {
  const input = btn.previousElementSibling;
  if (input) {
    input.type = input.type === 'password' ? 'text' : 'password';
  }
};

async function saveSettings() {
  const updates = Object.entries(settingsState.dirty).map(([path, value]) => ({ path, value }));

  if (updates.length === 0) return;

  const data = await api('/api/config/server/batch', {
    method: 'PUT',
    body: JSON.stringify({ updates }),
  });

  if (data && data.success) {
    settingsState.dirty = {};
    showToast('Paramètres sauvegardés', 'success');
    refreshSettings();
  } else {
    showToast(data?.error || 'Erreur de sauvegarde', 'error');
  }
}

async function resetAllSettings() {
  if (!confirm('Réinitialiser tous les paramètres aux valeurs par défaut ?')) return;

  const data = await api('/api/config/server/reset', {
    method: 'POST',
    body: JSON.stringify({}),
  });

  if (data && data.success) {
    settingsState.dirty = {};
    showToast('Paramètres réinitialisés', 'success');
    refreshSettings();
  } else {
    showToast(data?.error || 'Erreur de réinitialisation', 'error');
  }
}

function showToast(message, type = 'info') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.classList.add('show'), 10);
  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ─── Event Listeners ─────────────────────────────────────────────────────────

document.getElementById('btn-refresh-history').addEventListener('click', refreshHistory);
document.getElementById('btn-refresh-models').addEventListener('click', refreshModels);
document.getElementById('btn-save-settings')?.addEventListener('click', saveSettings);
document.getElementById('btn-reset-all')?.addEventListener('click', resetAllSettings);
document.getElementById('filter-status').addEventListener('change', refreshHistory);
document.getElementById('filter-model').addEventListener('change', refreshHistory);
document.getElementById('filter-protocol').addEventListener('change', refreshHistory);
document.getElementById('filter-search').addEventListener('keyup', (e) => {
  if (e.key === 'Enter') refreshHistory();
});

// Modal close
document.getElementById('modal-close').addEventListener('click', () => {
  document.getElementById('detail-modal').classList.remove('active');
});
document.getElementById('detail-modal').addEventListener('click', (e) => {
  if (e.target === e.currentTarget) e.currentTarget.classList.remove('active');
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function formatNumber(n) {
  if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
  if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
  return String(n);
}

function formatBytes(bytes) {
  if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(1) + ' GB';
  if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
  return (bytes / 1024).toFixed(1) + ' KB';
}

function formatDuration(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ─── Refresh Logic ───────────────────────────────────────────────────────────

function refreshCurrentTab() {
  switch (state.currentTab) {
    case 'dashboard': refreshDashboard(); break;
    case 'history': refreshHistory(); break;
    case 'mapping': refreshMapping(); break;
    case 'models': refreshModels(); break;
    case 'settings': refreshSettings(); break;
    case 'debug': if (window.refreshDebugTab) window.refreshDebugTab(); break;
    case 'performance': refreshPerformance(); break;
  }
}

// Auto-refresh every 30 seconds
state.refreshInterval = setInterval(refreshCurrentTab, 30000);

// ─── Init ────────────────────────────────────────────────────────────────────

refreshDashboard();
refreshSettings();

// ─── Performance Dashboard ───────────────────────────────────────────────────

async function refreshPerformance() {
  const data = await api('/v1/performance');
  if (!data) return;

  // Config panel
  const configEl = document.getElementById('perf-config');
  if (configEl) {
    configEl.innerHTML = `
      <div class="perf-row"><span>Fast Stream Proxy</span><span class="perf-badge ${data.config.fastStreamProxy ? 'on' : 'off'}">${data.config.fastStreamProxy ? '✅ ON' : '❌ OFF'}</span></div>
      <div class="perf-row"><span>Direct Fetch</span><span class="perf-badge ${data.config.directFetch ? 'on' : 'off'}">${data.config.directFetch ? '✅ ON' : '❌ OFF'}</span></div>
      <div class="perf-row"><span>WS Bridge</span><span class="perf-badge ${data.config.useWsBridge ? 'on' : 'off'}">${data.config.useWsBridge ? '✅ ON' : '❌ OFF'}</span></div>
      <div class="perf-row"><span>TLS Pool Size</span><span class="perf-value">${data.config.tlsPoolSize}</span></div>
    `;
  }

  // Path selection
  const pathEl = document.getElementById('perf-path');
  if (pathEl) {
    const pathColors = { direct: '#4ade80', browser: '#f59e0b', 'ws-bridge': '#3b82f6', 'h2-pool': '#8b5cf6' };
    const pathLabels = { direct: '🟢 Direct', browser: '🟡 Browser', 'ws-bridge': '🔵 WS Bridge', 'h2-pool': '🟣 H2 Pool' };
    pathEl.innerHTML = `
      <div class="perf-current-path">
        <span class="perf-big-label">${pathLabels[data.pathSelection] || data.pathSelection}</span>
        <span class="perf-sub">Auto-selected based on latency</span>
      </div>
    `;
  }

  // TLS Pool
  const tlsEl = document.getElementById('perf-tls');
  if (tlsEl) {
    const tls = data.tlsPool || {};
    tlsEl.innerHTML = `
      <div class="perf-row"><span>Active Sessions</span><span class="perf-value">${tls.alive || 0} / ${tls.total || 0}</span></div>
      <div class="perf-row"><span>Total Requests</span><span class="perf-value">${tls.totalRequests || 0}</span></div>
    `;
  }

  // WebSocket Bridge
  const wsEl = document.getElementById('perf-ws');
  if (wsEl) {
    const ws = data.wsBridge || {};
    wsEl.innerHTML = `
      <div class="perf-row"><span>Server Running</span><span class="perf-badge ${ws.serverRunning ? 'on' : 'off'}">${ws.serverRunning ? '✅' : '❌'}</span></div>
      <div class="perf-row"><span>Port</span><span class="perf-value">${ws.port || 'N/A'}</span></div>
      <div class="perf-row"><span>Active Connections</span><span class="perf-value">${ws.activeConnections || 0}</span></div>
    `;
  }

  // Signaling
  const sigEl = document.getElementById('perf-signaling');
  if (sigEl) {
    const sig = data.signaling || {};
    sigEl.innerHTML = `
      <div class="perf-row"><span>Connected Clients</span><span class="perf-value">${sig.connectedClients || 0}</span></div>
      <div class="perf-row"><span>Authenticated</span><span class="perf-value">${sig.authenticatedClients || 0}</span></div>
      <div class="perf-row"><span>Active Chats</span><span class="perf-value">${sig.activeChats || 0}</span></div>
    `;
  }

  // Path Stats
  const statsEl = document.getElementById('perf-stats');
  if (statsEl && data.pathStats) {
    let html = '<table class="perf-table"><thead><tr><th>Path</th><th>Avg Latency</th><th>Avg TTFB</th><th>Success Rate</th><th>Requests</th></tr></thead><tbody>';
    for (const [path, stats] of Object.entries(data.pathStats)) {
      if (stats.requestCount > 0) {
        const latencyColor = stats.avgLatency < 200 ? '#4ade80' : stats.avgLatency < 500 ? '#f59e0b' : '#ef4444';
        html += `<tr>
          <td><strong>${path}</strong></td>
          <td style="color:${latencyColor}">${stats.avgLatency}ms</td>
          <td>${stats.avgTTFB}ms</td>
          <td>${stats.successRate}%</td>
          <td>${stats.requestCount}</td>
        </tr>`;
      }
    }
    html += '</tbody></table>';
    if (Object.values(data.pathStats).every(s => s.requestCount === 0)) {
      html = '<div class="perf-empty">No request data yet. Make some requests to see stats.</div>';
    }
    statsEl.innerHTML = html;
  }
}

// Performance refresh button
document.getElementById('btn-refresh-perf')?.addEventListener('click', refreshPerformance);
document.getElementById('btn-run-bench')?.addEventListener('click', runBenchmark);

async function runBenchmark() {
  const btn = document.getElementById('btn-run-bench');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Running...'; }

  const results = [];
  const iterations = 5;

  for (let i = 0; i < iterations; i++) {
    const start = Date.now();
    try {
      await api('/v1/models');
      results.push({ latency: Date.now() - start, success: true });
    } catch {
      results.push({ latency: Date.now() - start, success: false });
    }
  }

  const avgLatency = results.reduce((s, r) => s + r.latency, 0) / results.length;
  const successRate = results.filter(r => r.success).length / iterations * 100;

  const statsEl = document.getElementById('perf-stats');
  if (statsEl) {
    const existing = statsEl.querySelector('.bench-result');
    if (existing) existing.remove();

    const div = document.createElement('div');
    div.className = 'bench-result';
    div.innerHTML = `
      <div class="perf-row"><span>Benchmark (${iterations} iterations)</span></div>
      <div class="perf-row"><span>Avg Latency</span><span class="perf-value">${Math.round(avgLatency)}ms</span></div>
      <div class="perf-row"><span>Success Rate</span><span class="perf-value">${successRate}%</span></div>
      <div class="perf-row"><span>Min/Max</span><span class="perf-value">${Math.min(...results.map(r => r.latency))}ms / ${Math.max(...results.map(r => r.latency))}ms</span></div>
    `;
    statsEl.appendChild(div);
  }

  if (btn) { btn.disabled = false; btn.textContent = '🚀 Lancer Benchmark'; }
  refreshPerformance();
}

// Performance CSS (injected)
const perfStyle = document.createElement('style');
perfStyle.textContent = `
  .perf-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; }
  .perf-card { background: var(--bg-secondary, #1a1a2e); border: 1px solid var(--border, #333); border-radius: 12px; padding: 20px; }
  .perf-card-wide { grid-column: 1 / -1; }
  .perf-card h3 { margin: 0 0 16px 0; font-size: 14px; opacity: 0.8; }
  .perf-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border, #333); }
  .perf-row:last-child { border-bottom: none; }
  .perf-value { font-weight: 600; font-family: monospace; }
  .perf-badge { padding: 2px 8px; border-radius: 6px; font-size: 12px; font-weight: 600; }
  .perf-badge.on { background: rgba(74, 222, 128, 0.15); color: #4ade80; }
  .perf-badge.off { background: rgba(239, 68, 68, 0.15); color: #ef4444; }
  .perf-current-path { text-align: center; padding: 12px; }
  .perf-big-label { font-size: 24px; font-weight: 700; display: block; }
  .perf-sub { font-size: 12px; opacity: 0.5; }
  .perf-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .perf-table th { text-align: left; padding: 8px; opacity: 0.6; font-weight: 500; }
  .perf-table td { padding: 8px; border-top: 1px solid var(--border, #333); }
  .perf-empty { text-align: center; padding: 20px; opacity: 0.5; }
  .perf-loading { text-align: center; padding: 20px; opacity: 0.5; }
  .perf-controls { display: flex; gap: 8px; }
`;
document.head.appendChild(perfStyle);
