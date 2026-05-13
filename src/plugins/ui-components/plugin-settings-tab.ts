/**
 * src/plugins/ui-components/plugin-settings-tab.ts — Plugin UI coordinator.
 *
 * TypeScript port of plugin-ui.js.
 * Patches the settings modal with a Plugins tab, builds the marketplace modal,
 * and exposes openMarketplace() / openRoomPluginsModal().
 *
 * No state.cb calls. All install/remove/toggle go through the EventBus.
 */

import { bus } from '../../core/events.js';
import { fetchMarketplace } from '../marketplace/client.js';
import { pluginsStore } from '../../core/state/plugins.js';
import { escapeHtml } from '../../utils/format.js';
import { InstalledPluginList } from './installed-list.js';
import { DetailPanel } from './detail-panel.js';
import { MarketplaceGrid } from './marketplace-grid.js';
import { MarketplaceDetail } from './marketplace-detail.js';
import type { PluginId } from '../../core/types.js';
import type { PluginInfo } from '../host.js';

// ─── Plugin Settings Tab ──────────────────────────────────────────────────────

export function initPluginSettingsTab(getPluginList: () => readonly PluginInfo[], distName = ''): void {
  injectMarketplaceModal(getPluginList);
  patchSettingsModal(getPluginList, distName);
}

function patchSettingsModal(getPluginList: () => readonly PluginInfo[], distName: string): void {
  if (document.getElementById('settings-panel-plugins')) return;

  const modal = document.getElementById('settings-modal');
  if (!modal) { console.warn('[plugin-ui] #settings-modal not in DOM'); return; }
  const inner = modal.querySelector<HTMLElement>('.modal');
  if (!inner) return;

  // Tab bar
  const tabBar = document.createElement('div');
  tabBar.className = 'settings-tabs';
  tabBar.innerHTML = `
    <button class="settings-tab active" data-tab="identity">Identity</button>
    <button class="settings-tab"        data-tab="plugins">Personal Plugins</button>
  `;

  // Wrap existing form groups
  const identityPanel = document.createElement('div');
  identityPanel.className = 'settings-panel active';
  identityPanel.id        = 'settings-panel-identity';
  [...inner.children]
    .filter(el => el.classList.contains('form-group') || el.classList.contains('btn-row'))
    .forEach(el => identityPanel.appendChild(el));

  // Plugins panel
  const pluginsPanel = document.createElement('div');
  pluginsPanel.className = 'settings-panel';
  pluginsPanel.id        = 'settings-panel-plugins';
  pluginsPanel.innerHTML = installedPanelHTML('plugin-list-container', 'plugin-detail-view', 'plugin-list-view');

  const h2 = inner.querySelector('h2');
  if (h2) h2.after(tabBar); else inner.prepend(tabBar);
  inner.appendChild(identityPanel);
  inner.appendChild(pluginsPanel);

  // Tab switching
  tabBar.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]');
    if (!btn) return;
    const tab = btn.dataset['tab'];
    tabBar.querySelectorAll('.settings-tab').forEach(b =>
      b.classList.toggle('active', (b as HTMLElement).dataset['tab'] === tab));
    inner.querySelectorAll('.settings-panel').forEach(panel =>
      panel.classList.toggle('active', panel.id === `settings-panel-${tab}`));
    if (tab === 'plugins') list.render();
  });

  const detail = new DetailPanel(
    {
      icon: 'pd-icon', name: 'pd-name', version: 'pd-version', author: 'pd-author',
      desc: 'pd-desc', scope: 'pd-scope', category: 'pd-category',
      visibility: 'pd-visibility', status: 'pd-status', perms: 'pd-perms',
      toggleBtn: 'pd-toggle-btn', removeBtn: 'pd-remove-btn',
      manifestBtn: 'pd-manifest-btn', manifestViewer: 'pd-manifest-viewer',
      backBtn: 'plugin-back-btn', listView: 'plugin-list-view',
      detailView: 'plugin-detail-view',
    },
    () => list.render(),
  );

  const list = new InstalledPluginList(
    {
      scope:       'personal',
      containerId: 'plugin-list-container',
      onDetail:    (pluginId) => {
        const info = getPluginList().find(p => p.id === pluginId);
        if (info) detail.show(info);
      },
      onExplore:   () => openMarketplace(getPluginList),
      distName,
    },
    getPluginList,
  );
  list.mount();

  // Wire explore button
  document.getElementById('explore-btn')?.addEventListener('click', () => openMarketplace(getPluginList));
}

// ─── Installed panel HTML ─────────────────────────────────────────────────────

function installedPanelHTML(listId: string, detailId: string, listViewId: string): string {
  return `
  <div id="${listViewId}">
    <div class="plugin-list" id="${listId}"></div>
    <div class="plugin-panel-footer">
      <button class="explore-btn" id="explore-btn">
        <span style="font-size:15px">🧩</span> Explore Plugins
      </button>
    </div>
  </div>

  <div class="plugin-detail" id="${detailId}">
    <button id="plugin-back-btn" style="background:none;border:none;cursor:pointer;color:var(--text2);font-size:13px;padding:0;display:flex;align-items:center;gap:5px;font-family:var(--font)">
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
      <div><div class="plugin-meta-label">Scope</div>      <div class="plugin-meta-value" id="pd-scope"></div></div>
      <div><div class="plugin-meta-label">Category</div>   <div class="plugin-meta-value" id="pd-category"></div></div>
      <div><div class="plugin-meta-label">Visibility</div> <div class="plugin-meta-value" id="pd-visibility"></div></div>
      <div><div class="plugin-meta-label">Status</div>     <div class="plugin-meta-value" id="pd-status"></div></div>
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
  </div>`;
}

// ─── Marketplace Modal ────────────────────────────────────────────────────────

let _mktGrid:   MarketplaceGrid   | null = null;
let _mktDetail: MarketplaceDetail | null = null;

function injectMarketplaceModal(getPluginList: () => readonly PluginInfo[]): void {
  if (document.getElementById('mkt-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id        = 'mkt-overlay';
  overlay.className = 'mkt-overlay hidden';
  overlay.innerHTML = marketplaceModalHTML();
  document.body.appendChild(overlay);

  _mktGrid   = new MarketplaceGrid('mkt-grid', 'mkt-sidebar', {
    onCardClick: (entry, isInstalled) => _mktDetail?.open(entry, isInstalled),
  });
  _mktDetail = new MarketplaceDetail({
    detailPanel: 'mkt-detail', scrollArea: 'mkt-detail-scroll',
    backBtn: 'mkt-detail-back', installBtn: 'mkt-install-btn',
    lightbox: 'mkt-lightbox', lightboxImg: 'mkt-lightbox-img',
  });
  _mktDetail.wire();

  // Events
  overlay.addEventListener('click', (e) => {
    if ((e.target as HTMLElement).id === 'mkt-overlay') closeMarketplace();
  });
  document.getElementById('mkt-close-btn')?.addEventListener('click', closeMarketplace);
  document.getElementById('mkt-search')?.addEventListener('input', (e) => {
    _mktGrid?.setQuery((e.target as HTMLInputElement).value);
  });
  document.getElementById('mkt-detail-back')?.addEventListener('click', () => _mktDetail?.close());

  // Manual install
  document.getElementById('mkt-manual-toggle')?.addEventListener('click', () => {
    const body   = document.getElementById('mkt-manual-body');
    const toggle = document.getElementById('mkt-manual-toggle');
    const open   = body?.classList.toggle('open') ?? false;
    if (toggle) toggle.textContent = (open ? '▾' : '▸') + ' Install from URL';
  });
  document.getElementById('mkt-manual-btn')?.addEventListener('click', () => {
    const inp = document.getElementById('mkt-manual-url') as HTMLInputElement | null;
    const url = inp?.value.trim() ?? '';
    if (!url) return;
    bus.emit('ui:plugin-install-requested', { baseUrl: url });
    if (inp) inp.value = '';
    bus.emit('ui:toast', { message: 'Installing plugin…', kind: 'info' });
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const lb = document.getElementById('mkt-lightbox');
    if (lb && !lb.classList.contains('hidden')) { lb.classList.add('hidden'); return; }
    if (_mktDetail?.isOpen()) { _mktDetail.close(); return; }
    closeMarketplace();
  });
}

export async function openMarketplace(getPluginList: () => readonly PluginInfo[]): Promise<void> {
  const overlay = document.getElementById('mkt-overlay');
  if (!overlay) { injectMarketplaceModal(getPluginList); return openMarketplace(getPluginList); }

  overlay.classList.remove('hidden');
  _mktDetail?.close();

  const searchEl = document.getElementById('mkt-search') as HTMLInputElement | null;
  if (searchEl) searchEl.value = '';
  _mktGrid?.setQuery('');

  const grid = document.getElementById('mkt-grid');
  if (grid) grid.innerHTML = '<div class="mkt-loading">Loading marketplace…</div>';

  try {
    const entries = await fetchMarketplace();
    _mktGrid?.setEntries(entries, getPluginList());
  } catch {
    if (grid) grid.innerHTML = `
      <div class="mkt-empty">
        <div class="mkt-empty-icon">🌐</div>
        <div>Could not load the marketplace.</div>
      </div>`;
  }
}

function closeMarketplace(): void {
  document.getElementById('mkt-overlay')?.classList.add('hidden');
  _mktDetail?.close();
}

// ─── Room Plugins Modal ───────────────────────────────────────────────────────

export function openRoomPluginsModal(getPluginList: () => readonly PluginInfo[]): void {
  ensureRoomPluginsModal(getPluginList);
  renderRoomPluginList(getPluginList);
  document.getElementById('room-plugins-overlay')?.classList.remove('hidden');
}

function ensureRoomPluginsModal(getPluginList: () => readonly PluginInfo[]): void {
  if (document.getElementById('room-plugins-overlay')) return;

  const overlay = document.createElement('div');
  overlay.id        = 'room-plugins-overlay';
  overlay.className = 'rp-overlay hidden';
  overlay.innerHTML = roomPluginsModalHTML();
  document.body.appendChild(overlay);

  const detail = new DetailPanel(
    {
      icon: 'rp-d-icon', name: 'rp-d-name', version: 'rp-d-version', author: 'rp-d-author',
      desc: 'rp-d-desc', scope: 'pd-scope', category: 'rp-d-category',
      visibility: 'rp-d-visibility', status: 'rp-d-status', perms: 'rp-d-perms',
      toggleBtn: 'rp-d-toggle-btn', removeBtn: 'rp-d-remove-btn',
      manifestBtn: 'rp-d-manifest-btn', manifestViewer: 'rp-d-manifest-viewer',
      backBtn: 'rp-back-btn', listView: 'rp-list-view',
      detailView: 'rp-detail-view',
    },
    () => renderRoomPluginList(getPluginList),
  );

  const list = new InstalledPluginList(
    { scope: 'rooms', containerId: 'rp-list-container', onDetail: (pid) => {
        const info = getPluginList().find(p => p.id === pid);
        if (info) detail.show(info);
      }, onExplore: () => {} },
    getPluginList,
  );

  overlay.addEventListener('click', (e) => {
    if ((e.target as HTMLElement) === overlay) overlay.classList.add('hidden');
  });
  document.getElementById('rp-close-btn')?.addEventListener('click', () => overlay.classList.add('hidden'));
  document.getElementById('rp-explore-btn')?.addEventListener('click', () => {
    overlay.classList.add('hidden');
    void openMarketplace(getPluginList);
  });

  list.mount();
}

function renderRoomPluginList(getPluginList: () => readonly PluginInfo[]): void {
  const container = document.getElementById('rp-list-container');
  if (!container) return;
  const plugins = getPluginList().filter(p => (p.manifest.scope ?? 'personal') === 'rooms');
  if (!plugins.length) {
    container.innerHTML = '<div class="rp-empty">No room plugins installed.</div>';
    return;
  }
  container.innerHTML = plugins.map(p => {
    const m = p.manifest;
    return `<div class="plugin-card ${p.enabled ? '' : 'disabled'}" data-plugin-id="${escapeHtml(p.id)}">
      <div class="plugin-icon">${escapeHtml(m.icon ?? '🔌')}</div>
      <div class="plugin-card-info">
        <div class="plugin-card-name">${escapeHtml(m.name || p.id)}</div>
        <div class="plugin-card-meta">${escapeHtml(m.description ?? '')} — v${escapeHtml(m.version ?? '?')}</div>
      </div>
      <div class="plugin-badges">
        ${!p.removable ? '<span class="plugin-badge badge-locked">🔒 core</span>' : ''}
        <span class="plugin-badge ${p.enabled ? 'badge-enabled' : 'badge-disabled'}">${p.enabled ? 'on' : 'off'}</span>
      </div>
    </div>`;
  }).join('');
}

// ─── HTML templates ───────────────────────────────────────────────────────────

function marketplaceModalHTML(): string {
  return `
  <div class="mkt-modal" id="mkt-modal">
    <div class="mkt-header">
      <span style="font-size:20px">🧩</span>
      <div class="mkt-header-title">Plugin Marketplace</div>
      <div class="mkt-search-wrap">
        <span style="color:var(--text2);font-size:14px">⌕</span>
        <input type="text" id="mkt-search" placeholder="Search plugins…" autocomplete="off">
      </div>
      <button class="mkt-close" id="mkt-close-btn" title="Close">✕</button>
    </div>
    <div class="mkt-body">
      <div class="mkt-sidebar"    id="mkt-sidebar"></div>
      <div class="mkt-grid-wrap"  id="mkt-grid-wrap">
        <div class="mkt-grid"     id="mkt-grid"><div class="mkt-loading">Loading…</div></div>
        <div class="mkt-detail"   id="mkt-detail">
          <div class="mkt-detail-scroll" id="mkt-detail-scroll"></div>
          <div class="mkt-detail-footer">
            <button class="mkt-detail-back" id="mkt-detail-back">← Back</button>
            <div style="flex:1"></div>
            <button class="btn btn-primary" id="mkt-install-btn" style="font-size:13px;padding:8px 20px">Install</button>
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
            style="flex:1;font-size:12px;font-family:var(--font-mono)">
          <button class="btn btn-primary" id="mkt-manual-btn" style="font-size:12px;padding:8px 14px;white-space:nowrap">Install</button>
        </div>
        <div style="color:var(--text2);font-size:11px;margin-top:6px">
          Directory must contain <code style="font-family:var(--font-mono)">manifest.json</code> + entry script.
          Only install plugins from sources you trust.
        </div>
      </div>
    </div>
  </div>
  <div class="mkt-lightbox hidden" id="mkt-lightbox">
    <img id="mkt-lightbox-img" src="" alt="Screenshot">
  </div>`;
}

function roomPluginsModalHTML(): string {
  return `
  <div class="rp-modal">
    <div class="rp-header">
      <span style="font-size:18px">🧩</span>
      <div class="rp-header-title">Room Plugins</div>
      <button class="rp-close" id="rp-close-btn">✕</button>
    </div>
    <div class="rp-body" id="rp-list-view">
      <div id="rp-list-container"></div>
    </div>
    <div class="rp-body rp-detail" id="rp-detail-view">
      <button id="rp-back-btn" style="background:none;border:none;cursor:pointer;color:var(--text2);font-size:13px;padding:0;display:flex;align-items:center;gap:5px;font-family:var(--font)">← Back</button>
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
        <div><div class="plugin-meta-label">Category</div>   <div class="plugin-meta-value" id="rp-d-category"></div></div>
        <div><div class="plugin-meta-label">Visibility</div> <div class="plugin-meta-value" id="rp-d-visibility"></div></div>
        <div><div class="plugin-meta-label">Status</div>     <div class="plugin-meta-value" id="rp-d-status"></div></div>
      </div>
      <div>
        <div class="plugin-meta-label" style="margin-bottom:6px">Permissions</div>
        <div class="plugin-perms-list" id="rp-d-perms"></div>
      </div>
      <div class="plugin-detail-actions">
        <button id="rp-d-toggle-btn"   class="btn btn-secondary" style="font-size:12px;padding:7px 14px"></button>
        <button id="rp-d-remove-btn"   class="btn btn-secondary" style="font-size:12px;padding:7px 14px;color:var(--red);border-color:rgba(255,77,106,.3)"></button>
        <button id="rp-d-manifest-btn" class="btn btn-secondary" style="font-size:12px;padding:7px 14px">View Manifest</button>
      </div>
      <pre class="manifest-viewer" id="rp-d-manifest-viewer"></pre>
    </div>
    <div class="rp-footer">
      <button class="explore-btn" id="rp-explore-btn" style="font-size:12px;padding:6px 12px">
        <span style="font-size:13px">🧩</span> Explore
      </button>
    </div>
  </div>`;
}
