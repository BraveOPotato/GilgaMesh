/**
 * plugin-ui.js — Renders the "Plugins" tab inside the settings modal.
 *
 * Exports:
 *   initPluginSettingsTab(pluginHost)  — call once after PluginHost.init()
 *   openPluginDetail(pluginId)         — open a specific plugin's detail view
 */

// ─── CSS (injected once) ──────────────────────────────────────────────────────
const CSS = `
/* ── Settings modal tabs ── */
.settings-tabs {
  display: flex;
  gap: 2px;
  border-bottom: 1px solid var(--border);
  margin: 0 -22px 18px;
  padding: 0 22px;
}
.settings-tab {
  background: none;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--text-secondary);
  cursor: pointer;
  font-family: var(--font);
  font-size: 13px;
  font-weight: 500;
  margin-bottom: -1px;
  padding: 9px 12px;
  transition: color .15s, border-color .15s;
}
.settings-tab:hover  { color: var(--text-primary); }
.settings-tab.active { color: var(--accent); border-bottom-color: var(--accent); }

/* ── Settings tab panels ── */
.settings-panel { display: none; }
.settings-panel.active { display: block; }

/* ── Plugin list ── */
.plugin-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 320px;
  overflow-y: auto;
  padding-right: 4px;
}
.plugin-list::-webkit-scrollbar { width: 4px; }
.plugin-list::-webkit-scrollbar-thumb { background: var(--scrollbar); border-radius: 2px; }

.plugin-card {
  align-items: center;
  background: var(--bg-raised);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  display: flex;
  gap: 11px;
  padding: 10px 12px;
  transition: border-color .15s, background .15s;
}
.plugin-card:hover { border-color: var(--border-accent); background: var(--bg-hover); }
.plugin-card.disabled { opacity: .5; }

.plugin-icon {
  align-items: center;
  background: var(--accent-glow);
  border: 1px solid var(--border-accent);
  border-radius: 8px;
  display: flex;
  flex-shrink: 0;
  font-size: 18px;
  height: 36px;
  justify-content: center;
  width: 36px;
}
.plugin-card.disabled .plugin-icon { filter: grayscale(1); }

.plugin-card-info { flex: 1; min-width: 0; }
.plugin-card-name {
  font-size: 13px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plugin-card-meta {
  color: var(--text-muted);
  font-size: 11px;
  margin-top: 1px;
}

.plugin-badges { display: flex; gap: 4px; align-items: center; flex-shrink: 0; }
.plugin-badge {
  border-radius: 4px;
  font-family: var(--mono);
  font-size: 9px;
  font-weight: 600;
  letter-spacing: .04em;
  padding: 2px 5px;
  text-transform: uppercase;
}
.badge-locked  { background: var(--red-dim);    color: var(--red);   border: 1px solid rgba(255,77,106,.25); }
.badge-enabled { background: rgba(61,220,132,.1); color: var(--green); border: 1px solid rgba(61,220,132,.25); }
.badge-disabled{ background: var(--bg-hover);    color: var(--text-muted); border: 1px solid var(--border); }

/* ── Plugin detail view ── */
.plugin-detail { display: none; flex-direction: column; gap: 14px; }
.plugin-detail.active { display: flex; }

.plugin-detail-header {
  align-items: center;
  display: flex;
  gap: 12px;
}
.plugin-detail-icon {
  align-items: center;
  background: var(--accent-glow);
  border: 1px solid var(--border-accent);
  border-radius: 12px;
  display: flex;
  flex-shrink: 0;
  font-size: 28px;
  height: 54px;
  justify-content: center;
  width: 54px;
}
.plugin-detail-title {
  font-size: 17px;
  font-weight: 700;
  letter-spacing: -.02em;
}
.plugin-detail-version {
  color: var(--text-muted);
  font-family: var(--mono);
  font-size: 11px;
  margin-top: 2px;
}
.plugin-detail-author {
  color: var(--text-secondary);
  font-size: 12px;
}

.plugin-detail-desc {
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.6;
}

.plugin-meta-grid {
  display: grid;
  gap: 8px 12px;
  grid-template-columns: 1fr 1fr;
}
.plugin-meta-item {}
.plugin-meta-label {
  color: var(--text-muted);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: .07em;
  text-transform: uppercase;
}
.plugin-meta-value {
  color: var(--text-primary);
  font-size: 12px;
  margin-top: 2px;
}

.plugin-perms-list {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: 4px;
}
.perm-chip {
  background: var(--bg-hover);
  border: 1px solid var(--border);
  border-radius: 5px;
  color: var(--text-secondary);
  font-family: var(--mono);
  font-size: 10px;
  padding: 2px 7px;
}

/* ── Manifest viewer ── */
.manifest-viewer {
  background: var(--bg-void);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--green);
  display: none;
  font-family: var(--mono);
  font-size: 11px;
  line-height: 1.6;
  max-height: 220px;
  overflow-y: auto;
  padding: 12px 14px;
  white-space: pre-wrap;
  word-break: break-all;
}
.manifest-viewer::-webkit-scrollbar { width: 3px; }
.manifest-viewer::-webkit-scrollbar-thumb { background: var(--scrollbar); }
.manifest-viewer.visible { display: block; }

.plugin-detail-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
`;

let _cssInjected = false;
let _host        = null;

function injectCSS() {
  if (_cssInjected) return;
  _cssInjected = true;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
export function initPluginSettingsTab(pluginHost) {
  _host = pluginHost;
  injectCSS();
  _patchSettingsModal();
}

// ─── PATCH EXISTING SETTINGS MODAL ───────────────────────────────────────────
function _patchSettingsModal() {
  // Idempotency guard — only patch once
  if (document.getElementById('settings-panel-plugins')) return;

  const modal = document.getElementById('settings-modal');
  if (!modal) { console.warn('[plugin-ui] #settings-modal not in DOM'); return; }

  const inner = modal.querySelector('.modal');
  if (!inner) { console.warn('[plugin-ui] .modal child not found'); return; }

  console.log('[plugin-ui] patching settings modal with Plugins tab');

  const h2 = inner.querySelector('h2');
  const p  = inner.querySelector('p');

  // ── Build tab bar ─────────────────────────────────────────────────────
  const tabBar = document.createElement('div');
  tabBar.className = 'settings-tabs';
  tabBar.innerHTML = `
    <button class="settings-tab active" data-tab="identity">Identity</button>
    <button class="settings-tab"        data-tab="plugins">Plugins</button>
  `;

  // ── Wrap existing content in identity panel ───────────────────────────
  const identityPanel = document.createElement('div');
  identityPanel.className = 'settings-panel active';
  identityPanel.id = 'settings-panel-identity';

  // Move everything after h2/p into identity panel
  const children = [...inner.children];
  // Keep h2 and p at top level (they become the modal title for all tabs)
  // Move form-groups and btn-row into the panel
  const toMove = children.filter(el =>
    el.classList.contains('form-group') || el.classList.contains('btn-row')
  );
  for (const el of toMove) identityPanel.appendChild(el);

  // ── Build plugins panel ───────────────────────────────────────────────
  const pluginsPanel = document.createElement('div');
  pluginsPanel.className = 'settings-panel';
  pluginsPanel.id = 'settings-panel-plugins';
  pluginsPanel.innerHTML = _buildPluginsPanelHTML();

  // ── Assemble ──────────────────────────────────────────────────────────
  // Insert tab bar after the <p> subtitle
  if (p) p.after(tabBar);
  else if (h2) h2.after(tabBar);
  else inner.prepend(tabBar);

  inner.appendChild(identityPanel);
  inner.appendChild(pluginsPanel);

  // ── Tab switching ─────────────────────────────────────────────────────
  tabBar.addEventListener('click', e => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    const tab = btn.dataset.tab;

    tabBar.querySelectorAll('.settings-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === tab));

    inner.querySelectorAll('.settings-panel').forEach(p =>
      p.classList.toggle('active', p.id === `settings-panel-${tab}`));

    if (tab === 'plugins') _renderPluginList();
  });
}

// ─── PLUGINS PANEL HTML SKELETON ─────────────────────────────────────────────
function _buildPluginsPanelHTML() {
  return `
  <!-- List view -->
  <div id="plugin-list-view">
    <div class="plugin-list" id="plugin-list-container"></div>
    <div style="margin-top:10px;display:flex;align-items:center;justify-content:space-between;gap:8px">
      <span style="font-size:11px;color:var(--text-muted)">Click a plugin to view details</span>
      <div style="display:flex;gap:8px;align-items:center">
        <button id="plugin-install-toggle" style="background:none;border:1px solid var(--border-accent);cursor:pointer;color:var(--accent);font-size:11px;font-family:var(--font);padding:3px 9px;border-radius:var(--radius-sm)">+ Install</button>
        <span id="dist-label" style="font-family:var(--mono);font-size:10px;color:var(--text-muted)"></span>
      </div>
    </div>
    <!-- Install from URL panel -->
    <div id="plugin-install-panel" style="display:none;margin-top:10px;border-top:1px solid var(--border);padding-top:10px">
      <div style="font-size:10px;font-weight:600;letter-spacing:.07em;text-transform:uppercase;color:var(--text-muted);margin-bottom:7px">Install Plugin from URL</div>
      <div style="display:flex;gap:7px">
        <input type="text" class="form-input" id="plugin-install-url" placeholder="https://example.com/my-plugin" style="flex:1;font-size:11px;font-family:var(--mono)">
        <button class="btn btn-primary" id="plugin-install-btn" style="font-size:12px;padding:6px 12px;white-space:nowrap;flex-shrink:0">Install</button>
      </div>
      <div style="font-size:11px;color:var(--text-muted);margin-top:5px">Directory must contain <code style="font-family:var(--mono)">manifest.json</code> + entry script.</div>
    </div>
  </div>

  <!-- Detail view -->
  <div class="plugin-detail" id="plugin-detail-view">
    <button id="plugin-back-btn" style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:13px;text-align:left;padding:0;display:flex;align-items:center;gap:5px;font-family:var(--font)">
      ← Back
    </button>

    <div class="plugin-detail-header">
      <div class="plugin-detail-icon" id="pd-icon"></div>
      <div>
        <div class="plugin-detail-title" id="pd-name"></div>
        <div class="plugin-detail-version" id="pd-version"></div>
        <div class="plugin-detail-author" id="pd-author"></div>
      </div>
    </div>

    <p class="plugin-detail-desc" id="pd-desc"></p>

    <div class="plugin-meta-grid">
      <div class="plugin-meta-item">
        <div class="plugin-meta-label">Scope</div>
        <div class="plugin-meta-value" id="pd-scope"></div>
      </div>
      <div class="plugin-meta-item">
        <div class="plugin-meta-label">Category</div>
        <div class="plugin-meta-value" id="pd-category"></div>
      </div>
      <div class="plugin-meta-item">
        <div class="plugin-meta-label">Visibility</div>
        <div class="plugin-meta-value" id="pd-visibility"></div>
      </div>
      <div class="plugin-meta-item">
        <div class="plugin-meta-label">Status</div>
        <div class="plugin-meta-value" id="pd-status"></div>
      </div>
    </div>

    <div>
      <div class="plugin-meta-label" style="margin-bottom:6px">Permissions</div>
      <div class="plugin-perms-list" id="pd-perms"></div>
    </div>

    <div class="plugin-detail-actions">
      <button id="pd-toggle-btn"   class="btn btn-secondary" style="font-size:12px;padding:7px 14px"></button>
      <button id="pd-remove-btn"   class="btn btn-secondary" style="font-size:12px;padding:7px 14px;color:var(--red);border-color:rgba(255,77,106,.3)"></button>
      <button id="pd-manifest-btn" class="btn btn-secondary" style="font-size:12px;padding:7px 14px">View Manifest</button>
    </div>

    <pre class="manifest-viewer" id="pd-manifest-viewer"></pre>
  </div>

  <!-- Install panel -->
  <div id="plugin-install-panel" style="margin-top:14px;border-top:1px solid var(--border);padding-top:14px;display:none">
    <div class="plugin-meta-label" style="margin-bottom:8px">Install Plugin from URL</div>
    <div style="display:flex;gap:8px">
      <input type="text" class="form-input" id="plugin-install-url" placeholder="https://example.com/my-plugin" style="flex:1;font-size:12px;font-family:var(--mono)">
      <button class="btn btn-primary" id="plugin-install-btn" style="font-size:12px;padding:7px 14px;white-space:nowrap">Install</button>
    </div>
    <div style="font-size:11px;color:var(--text-muted);margin-top:6px">
      The directory must contain a <code style="font-family:var(--mono)">manifest.json</code> and the entry script.
    </div>
  </div>
  `;
}

// ─── RENDER PLUGIN LIST ───────────────────────────────────────────────────────
function _renderPluginList() {
  if (!_host) return;

  const container = document.getElementById('plugin-list-container');
  const distLabel  = document.getElementById('dist-label');
  if (!container) return;

  const plugins = _host.getPluginList();

  if (distLabel) distLabel.textContent = _host.distConfig?.name || '';

  // Wire install panel toggle (idempotent)
  const installToggle = document.getElementById('plugin-install-toggle');
  const installPanel  = document.getElementById('plugin-install-panel');
  const installBtn    = document.getElementById('plugin-install-btn');
  if (installToggle && installPanel && !installToggle._wired) {
    installToggle._wired = true;
    installToggle.addEventListener('click', () => {
      const open = installPanel.style.display !== 'none';
      installPanel.style.display = open ? 'none' : 'block';
      installToggle.textContent  = open ? '+ Install' : '✕ Cancel';
    });
    installBtn.addEventListener('click', async () => {
      const url = document.getElementById('plugin-install-url')?.value.trim();
      if (!url) return;
      installBtn.textContent = 'Installing…';
      installBtn.disabled    = true;
      const ok = await window._gmInstallPlugin?.({ baseUrl: url });
      installBtn.textContent = 'Install';
      installBtn.disabled    = false;
      if (ok) {
        installPanel.style.display = 'none';
        installToggle.textContent  = '+ Install';
        document.getElementById('plugin-install-url').value = '';
        _renderPluginList();
      }
    });
  }

  if (plugins.length === 0) {
    container.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:12px 0">No plugins loaded.</div>';
    return;
  }

  container.innerHTML = plugins.map(p => {
    const m       = p.manifest;
    const enabled = p.enabled;
    const locked  = !p.removable;
    return `
    <div class="plugin-card ${enabled ? '' : 'disabled'}" data-plugin-id="${p.id}">
      <div class="plugin-icon">${m.icon || '🔌'}</div>
      <div class="plugin-card-info">
        <div class="plugin-card-name">${_esc(m.name || p.id)}</div>
        <div class="plugin-card-meta">${_esc(m.description || '')} &mdash; v${_esc(m.version || '?')}</div>
      </div>
      <div class="plugin-badges">
        ${locked  ? '<span class="plugin-badge badge-locked">🔒 core</span>' : ''}
        <span class="plugin-badge ${enabled ? 'badge-enabled' : 'badge-disabled'}">${enabled ? 'on' : 'off'}</span>
      </div>
    </div>`;
  }).join('');

  container.querySelectorAll('.plugin-card').forEach(card => {
    card.addEventListener('click', () => openPluginDetail(card.dataset.pluginId));
  });
}

// ─── OPEN PLUGIN DETAIL ───────────────────────────────────────────────────────
export function openPluginDetail(pluginId) {
  if (!_host) return;

  const info = _host.getPlugin(pluginId);
  if (!info) return;

  const m = info.manifest;

  // Ensure plugins tab is selected
  const tabBar = document.querySelector('.settings-tabs');
  if (tabBar) {
    tabBar.querySelectorAll('.settings-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === 'plugins'));
  }
  document.querySelectorAll('.settings-panel').forEach(p =>
    p.classList.toggle('active', p.id === 'settings-panel-plugins'));

  // Switch to detail view
  document.getElementById('plugin-list-view').style.display  = 'none';
  const detail = document.getElementById('plugin-detail-view');
  detail.classList.add('active');

  // Populate
  _set('pd-icon',       m.icon || '🔌');
  _set('pd-name',       m.name || pluginId);
  _set('pd-version',    `v${m.version || '?'}`);
  _set('pd-author',     m.author ? `by ${m.author}` : '');
  _set('pd-desc',       m.description || 'No description provided.');
  _set('pd-scope',      m.scope      || '—');
  _set('pd-category',   m.category   || '—');
  _set('pd-visibility', m.visibility || '—');
  _set('pd-status',     info.enabled
    ? '<span style="color:var(--green)">● Enabled</span>'
    : '<span style="color:var(--text-muted)">○ Disabled</span>');

  // Permissions
  const permsEl = document.getElementById('pd-perms');
  if (permsEl) {
    const perms = m.permissions || [];
    permsEl.innerHTML = perms.length
      ? perms.map(p => `<span class="perm-chip">${_esc(p)}</span>`).join('')
      : '<span style="color:var(--text-muted);font-size:12px">None</span>';
  }

  // Toggle button
  const toggleBtn = document.getElementById('pd-toggle-btn');
  if (toggleBtn) {
    if (!info.removable) {
      toggleBtn.textContent = '🔒 Core Plugin';
      toggleBtn.disabled    = true;
      toggleBtn.style.opacity = '.5';
    } else {
      toggleBtn.textContent = info.enabled ? 'Disable Plugin' : 'Enable Plugin';
      toggleBtn.disabled    = false;
      toggleBtn.style.opacity = '';
      toggleBtn.onclick = () => {
        if (info.enabled) _host.disablePlugin(pluginId);
        else              _host.enablePlugin(pluginId);
        // Re-open to refresh state
        openPluginDetail(pluginId);
      };
    }
  }

  // Remove button
  const removeBtn = document.getElementById('pd-remove-btn');
  if (removeBtn) {
    if (!info.removable) {
      removeBtn.style.display = 'none';
    } else {
      removeBtn.style.display = '';
      removeBtn.textContent   = 'Uninstall';
      removeBtn.onclick = async () => {
        if (!confirm(`Uninstall "${m.name || pluginId}"? This cannot be undone until you reinstall it.`)) return;
        const ok = await window._gmRemovePlugin?.(pluginId);
        if (ok) {
          // Return to list view
          document.getElementById('plugin-list-view').style.display = '';
          detail.classList.remove('active');
          _renderPluginList();
        }
      };
    }
  }

  // Manifest viewer toggle
  const manifestBtn    = document.getElementById('pd-manifest-btn');
  const manifestViewer = document.getElementById('pd-manifest-viewer');
  if (manifestBtn && manifestViewer) {
    manifestViewer.classList.remove('visible');
    manifestViewer.textContent = '';
    manifestBtn.textContent    = 'View Manifest';

    manifestBtn.onclick = () => {
      const visible = manifestViewer.classList.toggle('visible');
      manifestBtn.textContent = visible ? 'Hide Manifest' : 'View Manifest';
      if (visible && !manifestViewer.textContent) {
        // Pretty-print the manifest (strip any sensitive fields)
        const display = { ...m };
        delete display._internal;
        manifestViewer.textContent = JSON.stringify(display, null, 2);
      }
    };
  }

  // Back button
  const backBtn = document.getElementById('plugin-back-btn');
  if (backBtn) {
    backBtn.onclick = () => {
      document.getElementById('plugin-list-view').style.display = '';
      detail.classList.remove('active');
      _renderPluginList();
    };
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function _set(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function _esc(s) {
  return String(s || '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
