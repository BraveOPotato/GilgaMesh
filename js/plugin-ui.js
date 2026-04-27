/**
 * plugin-ui.js — Plugins tab inside settings modal + Marketplace modal.
 *
 * Exports:
 *   initPluginSettingsTab(pluginHost)  — call once after PluginHost.init()
 *   openPluginDetail(pluginId)         — open installed plugin detail view
 *   openMarketplace()                  — open the marketplace modal directly
 */

// ─── MARKETPLACE CONFIG ───────────────────────────────────────────────────────
// Point this at your GitHub raw JSON URL.
// The file must be a JSON array matching the MarketplaceEntry schema.
// See: marketplace-index.json in this repo for the full schema.
const MARKETPLACE_INDEX_URL =
  'https://raw.githubusercontent.com/your-org/gilgamesh-plugins/main/marketplace-index.json';

// ─── HIGH-RISK PERMISSIONS ────────────────────────────────────────────────────
const DANGER_PERMS = new Set(['network', 'dm:write', 'room:write', 'ui:inject']);

// ─── STATE ───────────────────────────────────────────────────────────────────
let _cssInjected     = false;
let _host            = null;
let _mktCache        = null;   // cached marketplace entries array
let _mktCategory     = 'All';
let _mktQuery        = '';
let _mktDetailEntry  = null;   // currently open marketplace detail entry

// ─── CSS ──────────────────────────────────────────────────────────────────────
const CSS = `
.settings-tabs {
  display:flex; gap:2px;
  border-bottom:1px solid var(--border);
  margin:0 -22px 18px; padding:0 22px;
}
.settings-tab {
  background:none; border:none;
  border-bottom:2px solid transparent;
  color:var(--text-secondary);
  cursor:pointer; font-family:var(--font);
  font-size:13px; font-weight:500;
  margin-bottom:-1px; padding:9px 12px;
  transition:color .15s,border-color .15s;
}
.settings-tab:hover  { color:var(--text-primary); }
.settings-tab.active { color:var(--accent); border-bottom-color:var(--accent); }
.settings-panel        { display:none; }
.settings-panel.active { display:block; }

.plugin-list { display:flex; flex-direction:column; gap:6px; max-height:300px; overflow-y:auto; padding-right:4px; }
.plugin-list::-webkit-scrollbar       { width:4px; }
.plugin-list::-webkit-scrollbar-thumb { background:var(--scrollbar); border-radius:2px; }
.plugin-card {
  align-items:center; background:var(--bg-raised);
  border:1px solid var(--border); border-radius:var(--radius);
  cursor:pointer; display:flex; gap:11px; padding:10px 12px;
  transition:border-color .15s,background .15s;
}
.plugin-card:hover    { border-color:var(--border-accent); background:var(--bg-hover); }
.plugin-card.disabled { opacity:.5; }
.plugin-icon {
  align-items:center; background:var(--accent-glow);
  border:1px solid var(--border-accent); border-radius:8px;
  display:flex; flex-shrink:0; font-size:18px;
  height:36px; justify-content:center; width:36px;
}
.plugin-card.disabled .plugin-icon { filter:grayscale(1); }
.plugin-card-info   { flex:1; min-width:0; }
.plugin-card-name   { font-size:13px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.plugin-card-meta   { color:var(--text-muted); font-size:11px; margin-top:1px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.plugin-badges      { display:flex; gap:4px; align-items:center; flex-shrink:0; }
.plugin-badge       { border-radius:4px; font-family:var(--mono); font-size:9px; font-weight:600; letter-spacing:.04em; padding:2px 5px; text-transform:uppercase; }
.badge-locked       { background:var(--red-dim); color:var(--red); border:1px solid rgba(255,77,106,.25); }
.badge-enabled      { background:rgba(61,220,132,.1); color:var(--green); border:1px solid rgba(61,220,132,.25); }
.badge-disabled     { background:var(--bg-hover); color:var(--text-muted); border:1px solid var(--border); }

.plugin-detail        { display:none; flex-direction:column; gap:14px; }
.plugin-detail.active { display:flex; }
.plugin-detail-header { align-items:center; display:flex; gap:12px; }
.plugin-detail-icon   {
  align-items:center; background:var(--accent-glow);
  border:1px solid var(--border-accent); border-radius:12px;
  display:flex; flex-shrink:0; font-size:28px;
  height:54px; justify-content:center; width:54px;
}
.plugin-detail-title   { font-size:17px; font-weight:700; letter-spacing:-.02em; }
.plugin-detail-version { color:var(--text-muted); font-family:var(--mono); font-size:11px; margin-top:2px; }
.plugin-detail-author  { color:var(--text-secondary); font-size:12px; }
.plugin-detail-desc    { color:var(--text-secondary); font-size:13px; line-height:1.6; }
.plugin-meta-grid      { display:grid; gap:8px 12px; grid-template-columns:1fr 1fr; }
.plugin-meta-label     { color:var(--text-muted); font-size:10px; font-weight:600; letter-spacing:.07em; text-transform:uppercase; }
.plugin-meta-value     { color:var(--text-primary); font-size:12px; margin-top:2px; }
.plugin-perms-list     { display:flex; flex-wrap:wrap; gap:5px; margin-top:4px; }
.perm-chip             { background:var(--bg-hover); border:1px solid var(--border); border-radius:5px; color:var(--text-secondary); font-family:var(--mono); font-size:10px; padding:2px 7px; }
.manifest-viewer {
  background:var(--bg-void); border:1px solid var(--border); border-radius:var(--radius);
  color:var(--green); display:none; font-family:var(--mono); font-size:11px;
  line-height:1.6; max-height:200px; overflow-y:auto;
  padding:12px 14px; white-space:pre-wrap; word-break:break-all;
}
.manifest-viewer::-webkit-scrollbar       { width:3px; }
.manifest-viewer::-webkit-scrollbar-thumb { background:var(--scrollbar); }
.manifest-viewer.visible { display:block; }
.plugin-detail-actions { display:flex; gap:8px; flex-wrap:wrap; }

.plugin-panel-footer {
  align-items:center; border-top:1px solid var(--border);
  display:flex; justify-content:space-between;
  margin-top:12px; padding-top:10px;
}
.explore-btn {
  align-items:center; background:var(--accent); border:none;
  border-radius:7px; color:#fff; cursor:pointer;
  display:flex; font-family:var(--font); font-size:12px;
  font-weight:600; gap:5px; padding:7px 14px;
  transition:opacity .15s;
}
.explore-btn:hover { opacity:.88; }

/* ── Marketplace modal ── */
.mkt-overlay {
  align-items:center; background:rgba(0,0,0,.6);
  bottom:0; left:0; right:0; top:0;
  display:flex; justify-content:center;
  position:fixed; z-index:9999;
}
.mkt-overlay.hidden { display:none; }
.mkt-modal {
  background:var(--bg-primary);
  border:1px solid var(--border); border-radius:14px;
  display:flex; flex-direction:column;
  height:min(88vh,720px); max-width:900px;
  overflow:hidden; width:min(96vw,900px);
}
.mkt-header {
  align-items:center; border-bottom:1px solid var(--border);
  display:flex; gap:12px; padding:16px 20px 12px; flex-shrink:0;
}
.mkt-header-title { font-size:16px; font-weight:700; letter-spacing:-.02em; flex:1; }
.mkt-search-wrap {
  align-items:center; background:var(--bg-raised);
  border:1px solid var(--border); border-radius:8px;
  display:flex; gap:6px; padding:6px 10px; width:210px;
}
.mkt-search-wrap input {
  background:none; border:none; color:var(--text-primary);
  font-family:var(--font); font-size:13px; outline:none; width:100%;
}
.mkt-search-wrap input::placeholder { color:var(--text-muted); }
.mkt-close {
  background:none; border:none; border-radius:6px;
  color:var(--text-secondary); cursor:pointer;
  font-size:18px; height:30px; line-height:30px;
  text-align:center; width:30px;
}
.mkt-close:hover { background:var(--bg-hover); color:var(--text-primary); }
.mkt-body { display:flex; flex:1; min-height:0; }
.mkt-sidebar {
  border-right:1px solid var(--border);
  display:flex; flex-direction:column; flex-shrink:0;
  gap:2px; overflow-y:auto; padding:12px 8px; width:152px;
}
.mkt-cat-btn {
  background:none; border:none; border-radius:7px;
  color:var(--text-secondary); cursor:pointer;
  font-family:var(--font); font-size:13px;
  padding:7px 10px; text-align:left;
  transition:background .12s,color .12s;
}
.mkt-cat-btn:hover  { background:var(--bg-hover); color:var(--text-primary); }
.mkt-cat-btn.active { background:var(--accent-glow); color:var(--accent); font-weight:600; }
.mkt-grid-wrap { display:flex; flex:1; flex-direction:column; min-width:0; overflow:hidden; position:relative; }
.mkt-grid {
  display:grid; gap:12px;
  grid-template-columns:repeat(auto-fill,minmax(200px,1fr));
  overflow-y:auto; padding:16px; align-content:start; flex:1;
}
.mkt-grid::-webkit-scrollbar       { width:5px; }
.mkt-grid::-webkit-scrollbar-thumb { background:var(--scrollbar); border-radius:3px; }
.mkt-card {
  background:var(--bg-raised); border:1px solid var(--border);
  border-radius:10px; cursor:pointer;
  display:flex; flex-direction:column; overflow:hidden;
  transition:border-color .15s,transform .1s;
}
.mkt-card:hover    { border-color:var(--border-accent); transform:translateY(-1px); }
.mkt-card.installed { border-color:rgba(61,220,132,.4); }
.mkt-card-banner {
  background:var(--bg-hover); font-size:28px;
  height:68px; display:flex; align-items:center;
  justify-content:center; flex-shrink:0; position:relative; overflow:hidden;
}
.mkt-card-banner img {
  height:100%; object-fit:cover; position:absolute;
  width:100%; top:0; left:0;
}
.mkt-card-icon-over {
  position:relative; z-index:1; font-size:26px;
  background:var(--bg-primary); border:1px solid var(--border);
  border-radius:10px; width:46px; height:46px;
  display:flex; align-items:center; justify-content:center;
}
.mkt-card-body   { padding:10px 12px; flex:1; display:flex; flex-direction:column; gap:3px; }
.mkt-card-name   { font-size:13px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.mkt-card-author { color:var(--text-muted); font-size:11px; }
.mkt-card-desc   {
  color:var(--text-secondary); font-size:11px; line-height:1.45;
  margin-top:3px; flex:1;
  display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; overflow:hidden;
}
.mkt-card-footer { align-items:center; display:flex; justify-content:space-between; margin-top:6px; }
.mkt-stars       { color:#f5a623; font-size:11px; }
.mkt-installs    { color:var(--text-muted); font-size:10px; }
.mkt-installed-badge {
  background:rgba(61,220,132,.12); border-radius:4px;
  color:var(--green); font-size:9px; font-weight:600;
  letter-spacing:.04em; padding:2px 6px; text-transform:uppercase;
}
.mkt-empty {
  align-items:center; color:var(--text-muted);
  display:flex; flex-direction:column; font-size:13px;
  gap:8px; grid-column:1/-1; justify-content:center;
  padding:48px 24px; text-align:center;
}
.mkt-empty-icon { font-size:32px; opacity:.4; }
.mkt-loading {
  align-items:center; color:var(--text-muted);
  display:flex; font-size:13px; gap:10px;
  grid-column:1/-1; justify-content:center; padding:48px;
}

/* ── Marketplace slide-in detail ── */
.mkt-detail {
  background:var(--bg-primary);
  border-left:1px solid var(--border);
  bottom:0; display:flex; flex-direction:column;
  overflow:hidden; position:absolute; right:0; top:0;
  transform:translateX(100%);
  transition:transform .22s ease;
  width:min(420px,100%);
}
.mkt-detail.open { transform:translateX(0); }
.mkt-detail-scroll {
  flex:1; overflow-y:auto; padding:20px;
  display:flex; flex-direction:column; gap:16px;
}
.mkt-detail-scroll::-webkit-scrollbar       { width:4px; }
.mkt-detail-scroll::-webkit-scrollbar-thumb { background:var(--scrollbar); }
.mkt-detail-hero   { align-items:flex-start; display:flex; gap:14px; }
.mkt-detail-icon   {
  align-items:center; background:var(--accent-glow);
  border:1px solid var(--border-accent); border-radius:14px;
  display:flex; flex-shrink:0; font-size:30px;
  height:60px; justify-content:center; width:60px;
}
.mkt-detail-title  { font-size:18px; font-weight:700; letter-spacing:-.02em; line-height:1.2; }
.mkt-detail-author { color:var(--text-secondary); font-size:12px; margin-top:3px; }
.mkt-detail-ver    { color:var(--text-muted); font-family:var(--mono); font-size:11px; margin-top:2px; }
.mkt-rating-row    { align-items:center; display:flex; gap:8px; font-size:12px; color:var(--text-secondary); }
.mkt-rating-stars  { color:#f5a623; font-size:15px; }
.mkt-rating-count  { color:var(--text-muted); font-size:11px; }
.mkt-detail-desc   { color:var(--text-secondary); font-size:13px; line-height:1.65; }
.mkt-section-label { color:var(--text-muted); font-size:10px; font-weight:600; letter-spacing:.07em; margin-bottom:6px; text-transform:uppercase; }
.mkt-screenshots {
  display:flex; gap:8px; overflow-x:auto; padding-bottom:4px;
}
.mkt-screenshots::-webkit-scrollbar       { height:3px; }
.mkt-screenshots::-webkit-scrollbar-thumb { background:var(--scrollbar); }
.mkt-screenshot {
  border:1px solid var(--border); border-radius:8px;
  cursor:pointer; flex-shrink:0; height:100px;
  object-fit:cover; transition:border-color .15s; width:160px;
}
.mkt-screenshot:hover { border-color:var(--border-accent); }
.mkt-screenshot-ph {
  align-items:center; background:var(--bg-hover);
  border:1px solid var(--border); border-radius:8px;
  color:var(--text-muted); display:flex; flex-shrink:0;
  font-size:11px; height:100px; justify-content:center; width:160px;
}
.mkt-perm-chips { display:flex; flex-wrap:wrap; gap:5px; }
.mkt-perm-chip {
  align-items:center; background:var(--bg-hover);
  border:1px solid var(--border); border-radius:5px;
  color:var(--text-secondary); display:flex;
  font-family:var(--mono); font-size:10px; gap:4px; padding:3px 8px;
}
.mkt-perm-chip.danger { background:var(--red-dim); border-color:rgba(255,77,106,.25); color:var(--red); }
.mkt-stats-row { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; }
.mkt-stat {
  background:var(--bg-raised); border:1px solid var(--border);
  border-radius:8px; padding:8px 10px; text-align:center;
}
.mkt-stat-val { font-size:14px; font-weight:700; }
.mkt-stat-key { color:var(--text-muted); font-size:10px; margin-top:1px; }
.mkt-detail-footer {
  border-top:1px solid var(--border);
  display:flex; gap:8px; padding:12px 16px; flex-shrink:0;
  align-items:center;
}
.mkt-detail-back {
  background:none; border:1px solid var(--border);
  border-radius:7px; color:var(--text-secondary); cursor:pointer;
  font-family:var(--font); font-size:13px; padding:8px 14px;
}
.mkt-detail-back:hover { background:var(--bg-hover); color:var(--text-primary); }

/* Manual install strip */
.mkt-manual {
  border-top:1px solid var(--border);
  flex-shrink:0; padding:10px 16px;
}
.mkt-manual-toggle {
  background:none; border:none; color:var(--text-muted);
  cursor:pointer; font-family:var(--font); font-size:12px; padding:0;
}
.mkt-manual-toggle:hover { color:var(--text-primary); }
.mkt-manual-body          { display:none; margin-top:8px; }
.mkt-manual-body.open     { display:block; }
.mkt-manual-row           { display:flex; gap:8px; }

/* Lightbox */
.mkt-lightbox {
  align-items:center; background:rgba(0,0,0,.85);
  bottom:0; display:flex; justify-content:center;
  left:0; position:fixed; right:0; top:0; z-index:10001;
}
.mkt-lightbox.hidden { display:none; }
.mkt-lightbox img { border-radius:10px; max-height:90vh; max-width:90vw; object-fit:contain; }
`;

// ─── CSS INJECT ───────────────────────────────────────────────────────────────
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
  _buildMarketplaceModal();
  _patchSettingsModal();
}

// ═══════════════════════════════════════════════════════════════════════════════
// SETTINGS MODAL PATCH
// ═══════════════════════════════════════════════════════════════════════════════
function _patchSettingsModal() {
  if (document.getElementById('settings-panel-plugins')) return;

  const modal = document.getElementById('settings-modal');
  if (!modal) { console.warn('[plugin-ui] #settings-modal not in DOM'); return; }
  const inner = modal.querySelector('.modal');
  if (!inner) { console.warn('[plugin-ui] .modal not found'); return; }

  console.log('[plugin-ui] patching settings modal');

  const h2 = inner.querySelector('h2');
  const p  = inner.querySelector('p');

  // Tab bar
  const tabBar = document.createElement('div');
  tabBar.className = 'settings-tabs';
  tabBar.innerHTML = `
    <button class="settings-tab active" data-tab="identity">Identity</button>
    <button class="settings-tab"        data-tab="plugins">Personal Plugins</button>
  `;

  // Wrap existing content
  const identityPanel = document.createElement('div');
  identityPanel.className = 'settings-panel active';
  identityPanel.id = 'settings-panel-identity';
  [...inner.children]
    .filter(el => el.classList.contains('form-group') || el.classList.contains('btn-row'))
    .forEach(el => identityPanel.appendChild(el));

  // Plugins panel
  const pluginsPanel = document.createElement('div');
  pluginsPanel.className = 'settings-panel';
  pluginsPanel.id = 'settings-panel-plugins';
  pluginsPanel.innerHTML = _installedPanelHTML();

  // Assemble
  if (p) p.after(tabBar); else if (h2) h2.after(tabBar); else inner.prepend(tabBar);
  inner.appendChild(identityPanel);
  inner.appendChild(pluginsPanel);

  // Tab switching
  tabBar.addEventListener('click', e => {
    const btn = e.target.closest('[data-tab]');
    if (!btn) return;
    const tab = btn.dataset.tab;
    tabBar.querySelectorAll('.settings-tab').forEach(b =>
      b.classList.toggle('active', b.dataset.tab === tab));
    inner.querySelectorAll('.settings-panel').forEach(panel =>
      panel.classList.toggle('active', panel.id === `settings-panel-${tab}`));
    if (tab === 'plugins') _renderPluginList();
  });
}

// ─── INSTALLED PANEL HTML ─────────────────────────────────────────────────────
function _installedPanelHTML() {
  return `
  <div id="plugin-list-view">
    <div class="plugin-list" id="plugin-list-container"></div>
    <div class="plugin-panel-footer">
      <span id="dist-label" style="font-family:var(--mono);font-size:10px;color:var(--text-muted)"></span>
      <button class="explore-btn" id="explore-btn">
        <span style="font-size:15px">🧩</span> Explore Plugins
      </button>
    </div>
  </div>

  <div class="plugin-detail" id="plugin-detail-view">
    <button id="plugin-back-btn"
      style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:13px;padding:0;display:flex;align-items:center;gap:5px;font-family:var(--font)">
      ← Back
    </button>
    <div class="plugin-detail-header">
      <div class="plugin-detail-icon"   id="pd-icon"></div>
      <div>
        <div class="plugin-detail-title"   id="pd-name"></div>
        <div class="plugin-detail-version" id="pd-version"></div>
        <div class="plugin-detail-author"  id="pd-author"></div>
      </div>
    </div>
    <p class="plugin-detail-desc" id="pd-desc"></p>
    <div class="plugin-meta-grid">
      <div><div class="plugin-meta-label">Scope</div>     <div class="plugin-meta-value" id="pd-scope"></div></div>
      <div><div class="plugin-meta-label">Category</div>  <div class="plugin-meta-value" id="pd-category"></div></div>
      <div><div class="plugin-meta-label">Visibility</div><div class="plugin-meta-value" id="pd-visibility"></div></div>
      <div><div class="plugin-meta-label">Status</div>    <div class="plugin-meta-value" id="pd-status"></div></div>
    </div>
    <div>
      <div class="plugin-meta-label" style="margin-bottom:6px">Permissions</div>
      <div class="plugin-perms-list" id="pd-perms"></div>
    </div>
    <div class="plugin-detail-actions">
      <button id="pd-toggle-btn"   class="btn btn-secondary" style="font-size:12px;padding:7px 14px"></button>
      <button id="pd-remove-btn"   class="btn btn-secondary"
        style="font-size:12px;padding:7px 14px;color:var(--red);border-color:rgba(255,77,106,.3)"></button>
      <button id="pd-manifest-btn" class="btn btn-secondary" style="font-size:12px;padding:7px 14px">View Manifest</button>
    </div>
    <pre class="manifest-viewer" id="pd-manifest-viewer"></pre>
  </div>
  `;
}

// ─── RENDER INSTALLED LIST ────────────────────────────────────────────────────
function _renderPluginList() {
  if (!_host) return;
  const container = document.getElementById('plugin-list-container');
  const distLabel  = document.getElementById('dist-label');
  if (!container) return;

  if (distLabel) distLabel.textContent = _host.distConfig?.name || '';

  const exploreBtn = document.getElementById('explore-btn');
  if (exploreBtn && !exploreBtn._wired) {
    exploreBtn._wired = true;
    exploreBtn.addEventListener('click', openMarketplace);
  }

  // Show only personal-scope plugins in the settings modal
  const plugins = _host.getPluginList().filter(p =>
    !p.manifest.scope || p.manifest.scope === 'personal'
  );

  if (plugins.length === 0) {
    container.innerHTML = `
      <div style="color:var(--text-muted);font-size:13px;padding:24px 0;text-align:center;line-height:1.7">
        No plugins installed.<br>
        <span style="font-size:11px">Hit <strong>Explore Plugins</strong> to browse the marketplace.</span>
      </div>`;
    return;
  }

  container.innerHTML = plugins.map(p => {
    const m = p.manifest;
    return `
    <div class="plugin-card ${p.enabled ? '' : 'disabled'}" data-plugin-id="${p.id}">
      <div class="plugin-icon">${_esc(m.icon || '🔌')}</div>
      <div class="plugin-card-info">
        <div class="plugin-card-name">${_esc(m.name || p.id)}</div>
        <div class="plugin-card-meta">${_esc(m.description || '')} — v${_esc(m.version || '?')}</div>
      </div>
      <div class="plugin-badges">
        ${!p.removable ? '<span class="plugin-badge badge-locked">🔒 core</span>' : ''}
        <span class="plugin-badge ${p.enabled ? 'badge-enabled' : 'badge-disabled'}">${p.enabled ? 'on' : 'off'}</span>
      </div>
    </div>`;
  }).join('');

  container.querySelectorAll('.plugin-card').forEach(card =>
    card.addEventListener('click', () => openPluginDetail(card.dataset.pluginId))
  );
}

// ─── INSTALLED PLUGIN DETAIL ──────────────────────────────────────────────────
export function openPluginDetail(pluginId) {
  if (!_host) return;
  const info = _host.getPlugin(pluginId);
  if (!info) return;
  const m = info.manifest;

  document.querySelectorAll('.settings-tab').forEach(b =>
    b.classList.toggle('active', b.dataset.tab === 'plugins'));
  document.querySelectorAll('.settings-panel').forEach(p =>
    p.classList.toggle('active', p.id === 'settings-panel-plugins'));

  document.getElementById('plugin-list-view').style.display = 'none';
  const detail = document.getElementById('plugin-detail-view');
  detail.classList.add('active');

  _set('pd-icon',       m.icon || '🔌');
  _set('pd-name',       _esc(m.name || pluginId));
  _set('pd-version',    `v${_esc(m.version || '?')}`);
  _set('pd-author',     m.author ? `by ${_esc(m.author)}` : '');
  _set('pd-desc',       _esc(m.description || 'No description provided.'));
  _set('pd-scope',      _esc(m.scope      || '—'));
  _set('pd-category',   _esc(m.category   || '—'));
  _set('pd-visibility', _esc(m.visibility || '—'));
  _set('pd-status',     info.enabled
    ? '<span style="color:var(--green)">● Enabled</span>'
    : '<span style="color:var(--text-muted)">○ Disabled</span>');

  const permsEl = document.getElementById('pd-perms');
  if (permsEl) {
    const perms = m.permissions || [];
    permsEl.innerHTML = perms.length
      ? perms.map(p => `<span class="perm-chip">${_esc(p)}</span>`).join('')
      : '<span style="color:var(--text-muted);font-size:12px">None</span>';
  }

  const toggleBtn = document.getElementById('pd-toggle-btn');
  if (toggleBtn) {
    if (!info.removable) {
      toggleBtn.textContent = '🔒 Core Plugin';
      toggleBtn.disabled = true; toggleBtn.style.opacity = '.5';
    } else {
      toggleBtn.textContent = info.enabled ? 'Disable' : 'Enable';
      toggleBtn.disabled = false; toggleBtn.style.opacity = '';
      toggleBtn.onclick = () => {
        if (info.enabled) _host.disablePlugin(pluginId);
        else              _host.enablePlugin(pluginId);
        openPluginDetail(pluginId);
      };
    }
  }

  const removeBtn = document.getElementById('pd-remove-btn');
  if (removeBtn) {
    if (!info.removable) {
      removeBtn.style.display = 'none';
    } else {
      removeBtn.style.display = '';
      removeBtn.textContent   = 'Uninstall';
      removeBtn.onclick = async () => {
        if (!confirm(`Uninstall "${m.name || pluginId}"?`)) return;
        const ok = await window._gmRemovePlugin?.(pluginId);
        if (ok) {
          document.getElementById('plugin-list-view').style.display = '';
          detail.classList.remove('active');
          _renderPluginList();
        }
      };
    }
  }

  const manifestBtn    = document.getElementById('pd-manifest-btn');
  const manifestViewer = document.getElementById('pd-manifest-viewer');
  if (manifestBtn && manifestViewer) {
    manifestViewer.classList.remove('visible');
    manifestViewer.textContent = '';
    manifestBtn.textContent    = 'View Manifest';
    manifestBtn.onclick = () => {
      const v = manifestViewer.classList.toggle('visible');
      manifestBtn.textContent = v ? 'Hide Manifest' : 'View Manifest';
      if (v && !manifestViewer.textContent) {
        const d = { ...m }; delete d._internal;
        manifestViewer.textContent = JSON.stringify(d, null, 2);
      }
    };
  }

  const backBtn = document.getElementById('plugin-back-btn');
  if (backBtn) {
    backBtn.onclick = () => {
      document.getElementById('plugin-list-view').style.display = '';
      detail.classList.remove('active');
      _renderPluginList();
    };
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// MARKETPLACE MODAL
// ═══════════════════════════════════════════════════════════════════════════════
function _buildMarketplaceModal() {
  if (document.getElementById('mkt-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id        = 'mkt-overlay';
  overlay.className = 'mkt-overlay hidden';
  overlay.innerHTML = `
  <div class="mkt-modal" id="mkt-modal">

    <div class="mkt-header">
      <span style="font-size:20px">🧩</span>
      <div class="mkt-header-title">Plugin Marketplace</div>
      <div class="mkt-search-wrap">
        <span style="color:var(--text-muted);font-size:14px">⌕</span>
        <input type="text" id="mkt-search" placeholder="Search plugins…" autocomplete="off">
      </div>
      <button class="mkt-close" id="mkt-close-btn" title="Close">✕</button>
    </div>

    <div class="mkt-body">
      <div class="mkt-sidebar" id="mkt-sidebar"></div>

      <div class="mkt-grid-wrap" id="mkt-grid-wrap">
        <div class="mkt-grid" id="mkt-grid">
          <div class="mkt-loading">Loading marketplace…</div>
        </div>

        <div class="mkt-detail" id="mkt-detail">
          <div class="mkt-detail-scroll" id="mkt-detail-scroll"></div>
          <div class="mkt-detail-footer">
            <button class="mkt-detail-back" id="mkt-detail-back">← Back</button>
            <div style="flex:1"></div>
            <button class="btn btn-primary" id="mkt-install-btn"
              style="font-size:13px;padding:8px 20px">Install</button>
          </div>
        </div>
      </div>
    </div>

    <div class="mkt-manual">
      <button class="mkt-manual-toggle" id="mkt-manual-toggle">▸ Install from URL</button>
      <div class="mkt-manual-body" id="mkt-manual-body">
        <div class="mkt-manual-row">
          <input type="text" class="form-input" id="mkt-manual-url"
            placeholder="https://raw.githubusercontent.com/…/my-plugin"
            style="flex:1;font-size:12px;font-family:var(--mono)">
          <button class="btn btn-primary" id="mkt-manual-btn"
            style="font-size:12px;padding:8px 14px;white-space:nowrap">Install</button>
        </div>
        <div style="color:var(--text-muted);font-size:11px;margin-top:6px">
          Directory must contain <code style="font-family:var(--mono)">manifest.json</code> + entry script.
          Only install plugins from sources you trust.
        </div>
      </div>
    </div>
  </div>

  <div class="mkt-lightbox hidden" id="mkt-lightbox">
    <img id="mkt-lightbox-img" src="" alt="Screenshot">
  </div>
  `;

  document.body.appendChild(overlay);
  _wireMktEvents();
}

function _wireMktEvents() {
  document.getElementById('mkt-overlay').addEventListener('click', e => {
    if (e.target.id === 'mkt-overlay') closeMarketplace();
  });
  document.getElementById('mkt-close-btn').addEventListener('click', closeMarketplace);

  document.getElementById('mkt-search').addEventListener('input', e => {
    _mktQuery = e.target.value.trim().toLowerCase();
    _renderMktGrid();
  });

  document.getElementById('mkt-detail-back').addEventListener('click', _closeMktDetail);

  document.getElementById('mkt-install-btn').addEventListener('click', async () => {
    if (!_mktDetailEntry) return;
    await _installFromMarketplace(_mktDetailEntry);
  });

  document.getElementById('mkt-manual-toggle').addEventListener('click', () => {
    const body   = document.getElementById('mkt-manual-body');
    const toggle = document.getElementById('mkt-manual-toggle');
    const open   = body.classList.toggle('open');
    toggle.textContent = (open ? '▾' : '▸') + ' Install from URL';
  });

  document.getElementById('mkt-manual-btn').addEventListener('click', async () => {
    const inp = document.getElementById('mkt-manual-url');
    const url = inp.value.trim();
    if (!url) return;
    const btn = document.getElementById('mkt-manual-btn');
    btn.textContent = 'Installing…'; btn.disabled = true;
    const ok = await window._gmInstallPlugin?.({ baseUrl: url });
    btn.textContent = 'Install'; btn.disabled = false;
    if (ok) {
      inp.value = '';
      document.getElementById('mkt-manual-body').classList.remove('open');
      document.getElementById('mkt-manual-toggle').textContent = '▸ Install from URL';
      _mktCache = null;
      _renderMktGrid();
    }
  });

  document.getElementById('mkt-lightbox').addEventListener('click', () =>
    document.getElementById('mkt-lightbox').classList.add('hidden')
  );

  document.addEventListener('keydown', e => {
    if (e.key !== 'Escape') return;
    const lb = document.getElementById('mkt-lightbox');
    if (lb && !lb.classList.contains('hidden')) { lb.classList.add('hidden'); return; }
    const det = document.getElementById('mkt-detail');
    if (det?.classList.contains('open')) { _closeMktDetail(); return; }
    closeMarketplace();
  });
}

// ─── OPEN / CLOSE ─────────────────────────────────────────────────────────────
export function openMarketplace() {
  const overlay = document.getElementById('mkt-overlay');
  if (!overlay) { _buildMarketplaceModal(); return openMarketplace(); }
  overlay.classList.remove('hidden');
  document.getElementById('mkt-search').value = '';
  _mktQuery = ''; _mktCategory = 'All';
  _closeMktDetail();
  _fetchAndRender();
}

function closeMarketplace() {
  document.getElementById('mkt-overlay')?.classList.add('hidden');
  _closeMktDetail();
}

// ─── FETCH ────────────────────────────────────────────────────────────────────
async function _fetchMarketplace() {
  if (_mktCache) return _mktCache;
  try {
    const res = await fetch(MARKETPLACE_INDEX_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    _mktCache = Array.isArray(data) ? data : [];
  } catch (err) {
    console.error('[plugin-ui] marketplace fetch failed:', err);
    _mktCache = [];
  }
  return _mktCache;
}

async function _fetchAndRender() {
  document.getElementById('mkt-grid').innerHTML =
    '<div class="mkt-loading">Loading marketplace…</div>';
  document.getElementById('mkt-sidebar').innerHTML = '';

  const entries = await _fetchMarketplace();

  if (entries.length === 0) {
    document.getElementById('mkt-grid').innerHTML = `
      <div class="mkt-empty">
        <div class="mkt-empty-icon">🌐</div>
        <div>Could not load the marketplace.</div>
        <div style="font-size:11px">Check your connection or the index URL in plugin-ui.js.</div>
      </div>`;
    return;
  }

  _buildMktSidebar(entries);
  _renderMktGrid();
}

// ─── SIDEBAR ─────────────────────────────────────────────────────────────────
function _buildMktSidebar(entries) {
  const cats = ['All', ...new Set(entries.map(e => e.category || 'Other').sort())];
  const sidebar = document.getElementById('mkt-sidebar');
  sidebar.innerHTML = cats.map(c =>
    `<button class="mkt-cat-btn ${c === _mktCategory ? 'active' : ''}" data-cat="${_esc(c)}">${_esc(c)}</button>`
  ).join('');
  sidebar.querySelectorAll('.mkt-cat-btn').forEach(btn =>
    btn.addEventListener('click', () => {
      _mktCategory = btn.dataset.cat;
      sidebar.querySelectorAll('.mkt-cat-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.cat === _mktCategory));
      _renderMktGrid();
    })
  );
}

// ─── GRID ─────────────────────────────────────────────────────────────────────
function _renderMktGrid() {
  const entries      = _mktCache || [];
  const installedIds = new Set(_host?.getPluginList().map(p => p.id) || []);

  const filtered = entries.filter(e => {
    const matchCat   = _mktCategory === 'All' || (e.category || 'Other') === _mktCategory;
    const matchQuery = !_mktQuery ||
      [e.name, e.description, e.author, e.category]
        .some(f => (f || '').toLowerCase().includes(_mktQuery));
    return matchCat && matchQuery;
  });

  const grid = document.getElementById('mkt-grid');

  if (filtered.length === 0) {
    grid.innerHTML = `
      <div class="mkt-empty">
        <div class="mkt-empty-icon">🔍</div>
        <div>No plugins found${_mktQuery ? ` for "<strong>${_esc(_mktQuery)}</strong>"` : ''}.</div>
      </div>`;
    return;
  }

  grid.innerHTML = filtered.map(e => {
    const inst   = installedIds.has(e.id);
    const banner = e.banner
      ? `<img src="${_esc(e.banner)}" alt="" loading="lazy">`
      : '';
    return `
    <div class="mkt-card ${inst ? 'installed' : ''}" data-id="${_esc(e.id)}">
      <div class="mkt-card-banner">
        ${banner}
        <div class="mkt-card-icon-over">${_esc(e.icon || '🔌')}</div>
      </div>
      <div class="mkt-card-body">
        <div class="mkt-card-name">${_esc(e.name || e.id)}</div>
        <div class="mkt-card-author">by ${_esc(e.author || 'Unknown')}</div>
        <div class="mkt-card-desc">${_esc(e.description || '')}</div>
        <div class="mkt-card-footer">
          <span class="mkt-stars">${_starsHtml(e.rating || 0)}</span>
          <span class="mkt-installs">${e.installs ? _fmtInstalls(e.installs) + ' installs' : ''}</span>
          ${inst ? '<span class="mkt-installed-badge">installed</span>' : ''}
        </div>
      </div>
    </div>`;
  }).join('');

  grid.querySelectorAll('.mkt-card').forEach(card =>
    card.addEventListener('click', () => {
      const e = filtered.find(x => x.id === card.dataset.id);
      if (e) _openMktDetail(e, installedIds.has(e.id));
    })
  );
}

// ─── DETAIL PANEL ─────────────────────────────────────────────────────────────
function _openMktDetail(entry, isInstalled) {
  _mktDetailEntry = entry;

  const perms       = entry.permissions || [];
  const shots       = entry.screenshots || [];
  const ratingCount = entry.ratingCount
    ? `(${Number(entry.ratingCount).toLocaleString()} ratings)`
    : '';

  const shotsHtml = shots.length
    ? shots.map(url =>
        `<img class="mkt-screenshot" src="${_esc(url)}" data-src="${_esc(url)}" alt="Screenshot" loading="lazy">`
      ).join('')
    : '<div class="mkt-screenshot-ph">No screenshots yet</div>';

  const permsHtml = perms.length
    ? perms.map(p => {
        const d = DANGER_PERMS.has(p);
        return `<span class="mkt-perm-chip ${d ? 'danger' : ''}">${d ? '⚠ ' : ''}${_esc(p)}</span>`;
      }).join('')
    : '<span style="color:var(--text-muted);font-size:12px">No special permissions</span>';

  document.getElementById('mkt-detail-scroll').innerHTML = `
    <div class="mkt-detail-hero">
      <div class="mkt-detail-icon">${_esc(entry.icon || '🔌')}</div>
      <div style="flex:1;min-width:0">
        <div class="mkt-detail-title">${_esc(entry.name || entry.id)}</div>
        <div class="mkt-detail-author">by ${_esc(entry.author || 'Unknown')}</div>
        <div class="mkt-detail-ver">v${_esc(entry.version || '?')}</div>
      </div>
    </div>

    <div class="mkt-rating-row">
      <span class="mkt-rating-stars">${_starsHtml(entry.rating || 0, true)}</span>
      <span style="font-weight:600">${(entry.rating || 0).toFixed(1)}</span>
      <span class="mkt-rating-count">${ratingCount}</span>
    </div>

    <p class="mkt-detail-desc">${_esc(entry.longDescription || entry.description || 'No description provided.')}</p>

    <div class="mkt-stats-row">
      <div class="mkt-stat">
        <div class="mkt-stat-val">${entry.installs ? _fmtInstalls(entry.installs) : '—'}</div>
        <div class="mkt-stat-key">Installs</div>
      </div>
      <div class="mkt-stat">
        <div class="mkt-stat-val">${_esc(entry.version || '—')}</div>
        <div class="mkt-stat-key">Version</div>
      </div>
      <div class="mkt-stat">
        <div class="mkt-stat-val">${_esc(entry.category || '—')}</div>
        <div class="mkt-stat-key">Category</div>
      </div>
    </div>

    <div>
      <div class="mkt-section-label">Screenshots</div>
      <div class="mkt-screenshots">${shotsHtml}</div>
    </div>

    <div>
      <div class="mkt-section-label">Permissions Required</div>
      <div class="mkt-perm-chips">${permsHtml}</div>
      ${perms.some(p => DANGER_PERMS.has(p))
        ? '<div style="color:var(--text-muted);font-size:11px;margin-top:6px">⚠ Elevated permissions requested. Install only from sources you trust.</div>'
        : ''}
    </div>

    ${entry.homepage ? `
    <div>
      <div class="mkt-section-label">Links</div>
      <a href="${_esc(entry.homepage)}" style="color:var(--accent);font-size:13px" target="_blank" rel="noopener noreferrer">
        Homepage / Source ↗
      </a>
    </div>` : ''}

    ${entry.changelog ? `
    <div>
      <div class="mkt-section-label">What's New</div>
      <div style="color:var(--text-secondary);font-size:12px;line-height:1.6;background:var(--bg-raised);border:1px solid var(--border);border-radius:8px;padding:10px 12px;white-space:pre-wrap">${_esc(entry.changelog)}</div>
    </div>` : ''}
  `;

  // Screenshot lightbox
  document.querySelectorAll('#mkt-detail-scroll .mkt-screenshot').forEach(img =>
    img.addEventListener('click', () => {
      document.getElementById('mkt-lightbox-img').src = img.dataset.src;
      document.getElementById('mkt-lightbox').classList.remove('hidden');
    })
  );

  // Install button state
  const installBtn = document.getElementById('mkt-install-btn');
  if (isInstalled) {
    installBtn.textContent   = '✓ Installed';
    installBtn.disabled      = true;
    installBtn.style.opacity = '.6';
  } else {
    installBtn.textContent   = 'Install';
    installBtn.disabled      = false;
    installBtn.style.opacity = '';
  }

  document.getElementById('mkt-detail').classList.add('open');
}

function _closeMktDetail() {
  document.getElementById('mkt-detail')?.classList.remove('open');
  _mktDetailEntry = null;
}

// ─── INSTALL FROM MARKETPLACE ─────────────────────────────────────────────────
async function _installFromMarketplace(entry) {
  const installBtn = document.getElementById('mkt-install-btn');
  installBtn.textContent = 'Installing…';
  installBtn.disabled    = true;

  const ok = await window._gmInstallPlugin?.({ baseUrl: entry.baseUrl || null });

  if (ok) {
    installBtn.textContent   = '✓ Installed';
    installBtn.style.opacity = '.6';
    _mktCache = null;
    _renderMktGrid();
    _renderPluginList();
  } else {
    installBtn.textContent = 'Install';
    installBtn.disabled    = false;
  }
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function _starsHtml(rating, large = false) {
  const full  = Math.floor(rating);
  const half  = (rating - full) >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  return '★'.repeat(full) + (half ? '⯨' : '') + '☆'.repeat(empty);
}

function _fmtInstalls(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1)     + 'k';
  return String(n);
}

function _set(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}

function _esc(s) {
  return String(s || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ═══════════════════════════════════════════════════════════════════════════════
// ROOM PLUGINS MODAL
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * openRoomPluginsModal()
 * Opens a standalone modal listing all scope:rooms plugins.
 * Called from the Room Settings menu (window._gmOpenRoomPlugins → main.js).
 * Supports enable/disable/uninstall for removable plugins and
 * opens the Marketplace filtered to rooms category.
 */
export function openRoomPluginsModal() {
  _ensureRoomPluginsModal();
  _renderRoomPluginList();
  document.getElementById('room-plugins-overlay').classList.remove('hidden');
}

function _ensureRoomPluginsModal() {
  if (document.getElementById('room-plugins-overlay')) return;

  // Inject extra CSS for the room plugins modal (reuses most plugin-ui styles)
  const s = document.createElement('style');
  s.textContent = `
  .rp-overlay {
    align-items:center; background:rgba(0,0,0,.55);
    bottom:0; left:0; right:0; top:0;
    display:flex; justify-content:center;
    position:fixed; z-index:9998;
  }
  .rp-overlay.hidden { display:none; }
  .rp-modal {
    background:var(--bg-primary);
    border:1px solid var(--border); border-radius:14px;
    display:flex; flex-direction:column;
    max-height:min(82vh,580px); max-width:480px;
    overflow:hidden; width:min(96vw,480px);
  }
  .rp-header {
    align-items:center; border-bottom:1px solid var(--border);
    display:flex; gap:10px; padding:16px 18px 12px; flex-shrink:0;
  }
  .rp-header-title { font-size:15px; font-weight:700; flex:1; letter-spacing:-.01em; }
  .rp-close {
    background:none; border:none; border-radius:6px;
    color:var(--text-secondary); cursor:pointer;
    font-size:17px; height:28px; line-height:28px;
    text-align:center; width:28px;
  }
  .rp-close:hover { background:var(--bg-hover); color:var(--text-primary); }
  .rp-body { flex:1; overflow-y:auto; padding:14px 16px; display:flex; flex-direction:column; gap:8px; }
  .rp-body::-webkit-scrollbar       { width:4px; }
  .rp-body::-webkit-scrollbar-thumb { background:var(--scrollbar); border-radius:2px; }
  .rp-footer {
    border-top:1px solid var(--border);
    display:flex; align-items:center; justify-content:space-between;
    padding:10px 16px; flex-shrink:0;
  }
  .rp-empty {
    color:var(--text-muted); font-size:13px;
    padding:24px 0; text-align:center; line-height:1.7;
  }

  /* Detail panel inside room plugins modal */
  .rp-detail        { display:none; flex-direction:column; gap:14px; }
  .rp-detail.active { display:flex; }
  `;
  document.head.appendChild(s);

  const overlay = document.createElement('div');
  overlay.id        = 'room-plugins-overlay';
  overlay.className = 'rp-overlay hidden';
  overlay.innerHTML = `
  <div class="rp-modal">
    <div class="rp-header">
      <span style="font-size:18px">🧩</span>
      <div class="rp-header-title">Room Plugins</div>
      <button class="rp-close" id="rp-close-btn">✕</button>
    </div>

    <!-- List view -->
    <div class="rp-body" id="rp-list-view">
      <div id="rp-list-container"></div>
    </div>

    <!-- Detail view (hidden by default, shown on click) -->
    <div class="rp-body rp-detail" id="rp-detail-view">
      <button id="rp-back-btn"
        style="background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:13px;padding:0;display:flex;align-items:center;gap:5px;font-family:var(--font)">
        ← Back
      </button>
      <div class="plugin-detail-header">
        <div class="plugin-detail-icon" id="rp-d-icon"></div>
        <div>
          <div class="plugin-detail-title"   id="rp-d-name"></div>
          <div class="plugin-detail-version" id="rp-d-version"></div>
          <div class="plugin-detail-author"  id="rp-d-author"></div>
        </div>
      </div>
      <p class="plugin-detail-desc" id="rp-d-desc"></p>
      <div class="plugin-meta-grid">
        <div><div class="plugin-meta-label">Category</div>  <div class="plugin-meta-value" id="rp-d-category"></div></div>
        <div><div class="plugin-meta-label">Visibility</div><div class="plugin-meta-value" id="rp-d-visibility"></div></div>
        <div><div class="plugin-meta-label">Status</div>    <div class="plugin-meta-value" id="rp-d-status"></div></div>
      </div>
      <div>
        <div class="plugin-meta-label" style="margin-bottom:6px">Permissions</div>
        <div class="plugin-perms-list" id="rp-d-perms"></div>
      </div>
      <div class="plugin-detail-actions">
        <button id="rp-d-toggle-btn" class="btn btn-secondary" style="font-size:12px;padding:7px 14px"></button>
        <button id="rp-d-remove-btn" class="btn btn-secondary"
          style="font-size:12px;padding:7px 14px;color:var(--red);border-color:rgba(255,77,106,.3)"></button>
        <button id="rp-d-manifest-btn" class="btn btn-secondary" style="font-size:12px;padding:7px 14px">View Manifest</button>
      </div>
      <pre class="manifest-viewer" id="rp-d-manifest-viewer"></pre>
    </div>

    <div class="rp-footer">
      <span style="font-family:var(--mono);font-size:10px;color:var(--text-muted)" id="rp-dist-label"></span>
      <button class="explore-btn" id="rp-explore-btn" style="font-size:12px;padding:6px 12px">
        <span style="font-size:13px">🧩</span> Explore
      </button>
    </div>
  </div>
  `;
  document.body.appendChild(overlay);

  // Wire events
  document.getElementById('rp-close-btn').addEventListener('click', _closeRoomPluginsModal);
  overlay.addEventListener('click', e => { if (e.target === overlay) _closeRoomPluginsModal(); });
  document.getElementById('rp-explore-btn').addEventListener('click', () => {
    _closeRoomPluginsModal();
    // Open marketplace pre-filtered to rooms category if possible
    _mktCategory = 'rooms';
    openMarketplace();
  });
  document.getElementById('rp-back-btn').addEventListener('click', () => {
    document.getElementById('rp-list-view').style.display  = '';
    document.getElementById('rp-detail-view').classList.remove('active');
    _renderRoomPluginList();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !document.getElementById('room-plugins-overlay').classList.contains('hidden')) {
      _closeRoomPluginsModal();
    }
  });
}

function _closeRoomPluginsModal() {
  document.getElementById('room-plugins-overlay')?.classList.add('hidden');
}

function _renderRoomPluginList() {
  if (!_host) return;
  const container = document.getElementById('rp-list-container');
  const distLabel  = document.getElementById('rp-dist-label');
  if (!container) return;

  if (distLabel) distLabel.textContent = _host.distConfig?.name || '';

  // Only room-scope plugins
  const plugins = _host.getPluginList().filter(p => p.manifest.scope === 'rooms');

  if (plugins.length === 0) {
    container.innerHTML = `
      <div class="rp-empty">
        No room plugins installed.<br>
        <span style="font-size:11px">Hit <strong>Explore</strong> to browse the marketplace.</span>
      </div>`;
    return;
  }

  container.innerHTML = plugins.map(p => {
    const m = p.manifest;
    return `
    <div class="plugin-card ${p.enabled ? '' : 'disabled'}" data-plugin-id="${p.id}" id="rp-card-${p.id}">
      <div class="plugin-icon">${_esc(m.icon || '🔌')}</div>
      <div class="plugin-card-info">
        <div class="plugin-card-name">${_esc(m.name || p.id)}</div>
        <div class="plugin-card-meta">${_esc(m.description || '')} — v${_esc(m.version || '?')}</div>
      </div>
      <div class="plugin-badges">
        ${!p.removable ? '<span class="plugin-badge badge-locked">🔒 core</span>' : ''}
        <span class="plugin-badge ${p.enabled ? 'badge-enabled' : 'badge-disabled'}">${p.enabled ? 'on' : 'off'}</span>
      </div>
    </div>`;
  }).join('');

  container.querySelectorAll('.plugin-card').forEach(card =>
    card.addEventListener('click', () => _openRoomPluginDetail(card.dataset.pluginId))
  );
}

function _openRoomPluginDetail(pluginId) {
  if (!_host) return;
  const info = _host.getPlugin(pluginId);
  if (!info) return;
  const m = info.manifest;

  document.getElementById('rp-list-view').style.display = 'none';
  document.getElementById('rp-detail-view').classList.add('active');

  _rpSet('rp-d-icon',       m.icon || '🔌');
  _rpSet('rp-d-name',       _esc(m.name || pluginId));
  _rpSet('rp-d-version',    `v${_esc(m.version || '?')}`);
  _rpSet('rp-d-author',     m.author ? `by ${_esc(m.author)}` : '');
  _rpSet('rp-d-desc',       _esc(m.description || 'No description provided.'));
  _rpSet('rp-d-category',   _esc(m.category   || '—'));
  _rpSet('rp-d-visibility', _esc(m.visibility || '—'));
  _rpSet('rp-d-status',     info.enabled
    ? '<span style="color:var(--green)">● Enabled</span>'
    : '<span style="color:var(--text-muted)">○ Disabled</span>');

  const permsEl = document.getElementById('rp-d-perms');
  if (permsEl) {
    const perms = m.permissions || [];
    permsEl.innerHTML = perms.length
      ? perms.map(p => `<span class="perm-chip">${_esc(p)}</span>`).join('')
      : '<span style="color:var(--text-muted);font-size:12px">None</span>';
  }

  const toggleBtn = document.getElementById('rp-d-toggle-btn');
  if (toggleBtn) {
    if (!info.removable) {
      toggleBtn.textContent = '🔒 Core Plugin'; toggleBtn.disabled = true; toggleBtn.style.opacity = '.5';
    } else {
      toggleBtn.textContent = info.enabled ? 'Disable' : 'Enable';
      toggleBtn.disabled = false; toggleBtn.style.opacity = '';
      toggleBtn.onclick = () => {
        if (info.enabled) _host.disablePlugin(pluginId);
        else              _host.enablePlugin(pluginId);
        _openRoomPluginDetail(pluginId);
      };
    }
  }

  const removeBtn = document.getElementById('rp-d-remove-btn');
  if (removeBtn) {
    if (!info.removable) {
      removeBtn.style.display = 'none';
    } else {
      removeBtn.style.display = '';
      removeBtn.textContent   = 'Uninstall';
      removeBtn.onclick = async () => {
        if (!confirm(`Uninstall "${m.name || pluginId}"?`)) return;
        const ok = await window._gmRemovePlugin?.(pluginId);
        if (ok) {
          document.getElementById('rp-list-view').style.display = '';
          document.getElementById('rp-detail-view').classList.remove('active');
          _renderRoomPluginList();
        }
      };
    }
  }

  const manifestBtn    = document.getElementById('rp-d-manifest-btn');
  const manifestViewer = document.getElementById('rp-d-manifest-viewer');
  if (manifestBtn && manifestViewer) {
    manifestViewer.classList.remove('visible'); manifestViewer.textContent = '';
    manifestBtn.textContent = 'View Manifest';
    manifestBtn.onclick = () => {
      const v = manifestViewer.classList.toggle('visible');
      manifestBtn.textContent = v ? 'Hide Manifest' : 'View Manifest';
      if (v && !manifestViewer.textContent) {
        const d = { ...m }; delete d._internal;
        manifestViewer.textContent = JSON.stringify(d, null, 2);
      }
    };
  }
}

function _rpSet(id, html) {
  const el = document.getElementById(id);
  if (el) el.innerHTML = html;
}
