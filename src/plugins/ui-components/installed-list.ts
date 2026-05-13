/**
 * src/plugins/ui-components/installed-list.ts — Installed plugins list panel.
 *
 * Renders into #plugin-list-container (injected into settings modal).
 * Pure DOM manipulation; subscribes to pluginsStore for live updates.
 * All install/remove actions emitted via bus — no direct PluginHost calls.
 */

import { bus } from '../../core/events.js';
import type { PluginId } from '../../core/types.js';
import { pluginsStore } from '../../core/state/plugins.js';
import { escapeHtml } from '../../utils/format.js';
import type { PluginInfo } from '../host.js';

const DANGER_PERMS = new Set(['network', 'dm:write', 'room:write', 'ui:inject']);

export type PluginScope = 'personal' | 'rooms' | 'all';

export interface InstalledListOptions {
  readonly scope:       PluginScope;
  readonly containerId: string;
  readonly onDetail:    (pluginId: PluginId) => void;
  readonly onExplore:   () => void;
  readonly distName?:   string;
}

export class InstalledPluginList {
  private unsub: (() => void) | null = null;

  constructor(
    private readonly opts:    InstalledListOptions,
    private readonly getList: () => readonly PluginInfo[],
  ) {}

  mount(): void {
    this.render();
    this.unsub = pluginsStore.subscribe(() => this.render());
  }

  unmount(): void {
    this.unsub?.();
    this.unsub = null;
  }

  render(): void {
    const container = document.getElementById(this.opts.containerId);
    if (!container) return;

    const all     = this.getList();
    const plugins = this.opts.scope === 'all'
      ? all
      : all.filter(p => {
          const scope = p.manifest.scope ?? 'personal';
          return scope === this.opts.scope;
        });

    if (plugins.length === 0) {
      container.innerHTML = `
        <div class="rp-empty">
          No plugins installed.<br>
          <span style="font-size:11px">Hit <strong>Explore Plugins</strong> to browse the marketplace.</span>
        </div>`;
      return;
    }

    container.innerHTML = plugins.map(p => pluginCardHtml(p)).join('');

    container.querySelectorAll<HTMLElement>('.plugin-card').forEach(card => {
      card.addEventListener('click', () => {
        const pluginId = card.dataset['pluginId'] as PluginId | undefined;
        if (pluginId) this.opts.onDetail(pluginId);
      });
    });
  }
}

// ─── Plugin card HTML ─────────────────────────────────────────────────────────

export function pluginCardHtml(p: PluginInfo): string {
  const m = p.manifest;
  return `
  <div class="plugin-card ${p.enabled ? '' : 'disabled'}" data-plugin-id="${escapeHtml(p.id)}">
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
}

// ─── Permission chip HTML ────────────────────────────────────────────────────

export function permChipsHtml(permissions: readonly string[]): string {
  if (!permissions.length) {
    return '<span style="color:var(--text2);font-size:12px">None</span>';
  }
  return permissions.map(p => {
    const danger = DANGER_PERMS.has(p);
    return `<span class="perm-chip${danger ? ' danger' : ''}">${danger ? '⚠ ' : ''}${escapeHtml(p)}</span>`;
  }).join('');
}
