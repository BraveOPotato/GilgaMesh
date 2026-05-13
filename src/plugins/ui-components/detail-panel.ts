/**
 * src/plugins/ui-components/detail-panel.ts — Plugin detail view.
 *
 * Reusable for both the settings modal and the room plugins modal.
 * Emits bus events for enable/disable/remove — never calls PluginHost directly.
 */

import { bus } from '../../core/events.js';
import type { PluginId } from '../../core/types.js';
import { escapeHtml } from '../../utils/format.js';
import { permChipsHtml } from './installed-list.js';
import type { PluginInfo } from '../host.js';

export interface DetailPanelIds {
  readonly icon:           string;
  readonly name:           string;
  readonly version:        string;
  readonly author:         string;
  readonly desc:           string;
  readonly scope:          string;
  readonly category:       string;
  readonly visibility:     string;
  readonly status:         string;
  readonly perms:          string;
  readonly toggleBtn:      string;
  readonly removeBtn:      string;
  readonly manifestBtn:    string;
  readonly manifestViewer: string;
  readonly backBtn:        string;
  readonly listView:       string;
  readonly detailView:     string;
}

export class DetailPanel {
  constructor(
    private readonly ids:       DetailPanelIds,
    private readonly onBack:    () => void,
  ) {}

  show(info: PluginInfo): void {
    const m = info.manifest;

    this.set(this.ids.icon,       m.icon ?? '🔌');
    this.set(this.ids.name,       escapeHtml(m.name || info.id));
    this.set(this.ids.version,    `v${escapeHtml(m.version ?? '?')}`);
    this.set(this.ids.author,     m.author ? `by ${escapeHtml(m.author)}` : '');
    this.set(this.ids.desc,       escapeHtml(m.description ?? 'No description.'));
    this.set(this.ids.scope,      escapeHtml(m.scope ?? '—'));
    this.set(this.ids.category,   escapeHtml(m.category ?? '—'));
    this.set(this.ids.visibility, escapeHtml(m.visibility ?? '—'));
    this.set(this.ids.status,     info.enabled
      ? '<span style="color:var(--green)">● Enabled</span>'
      : '<span style="color:var(--text2)">○ Disabled</span>');

    const permsEl = document.getElementById(this.ids.perms);
    if (permsEl) permsEl.innerHTML = permChipsHtml(m.permissions ?? []);

    // Toggle button
    const toggleBtn = document.getElementById(this.ids.toggleBtn) as HTMLButtonElement | null;
    if (toggleBtn) {
      if (!info.removable) {
        toggleBtn.textContent = '🔒 Core Plugin';
        toggleBtn.disabled    = true;
        toggleBtn.style.opacity = '0.5';
      } else {
        toggleBtn.textContent   = info.enabled ? 'Disable' : 'Enable';
        toggleBtn.disabled      = false;
        toggleBtn.style.opacity = '';
        toggleBtn.onclick = () => {
          bus.emit('ui:plugin-toggle-requested', { pluginId: info.id, enabled: !info.enabled });
          // Re-render detail after toggle (store subscription handles list)
        };
      }
    }

    // Remove button
    const removeBtn = document.getElementById(this.ids.removeBtn) as HTMLButtonElement | null;
    if (removeBtn) {
      if (!info.removable) {
        removeBtn.style.display = 'none';
      } else {
        removeBtn.style.display = '';
        removeBtn.textContent   = 'Uninstall';
        removeBtn.onclick = () => {
          const label = m.name || info.id;
          if (!confirm(`Uninstall "${label}"?`)) return;
          bus.emit('ui:plugin-remove-requested', { pluginId: info.id });
          this.hide();
        };
      }
    }

    // Manifest viewer
    const manifestBtn    = document.getElementById(this.ids.manifestBtn) as HTMLButtonElement | null;
    const manifestViewer = document.getElementById(this.ids.manifestViewer);
    if (manifestBtn && manifestViewer) {
      manifestViewer.classList.remove('visible');
      manifestViewer.textContent = '';
      manifestBtn.textContent    = 'View Manifest';
      manifestBtn.onclick = () => {
        const visible = manifestViewer.classList.toggle('visible');
        manifestBtn.textContent = visible ? 'Hide Manifest' : 'View Manifest';
        if (visible && !manifestViewer.textContent) {
          const copy = { ...m } as Record<string, unknown>;
          delete copy['_internal'];
          manifestViewer.textContent = JSON.stringify(copy, null, 2);
        }
      };
    }

    // Back button
    const backBtn = document.getElementById(this.ids.backBtn);
    if (backBtn) backBtn.onclick = () => this.hide();

    // Switch visibility
    const listView   = document.getElementById(this.ids.listView);
    const detailView = document.getElementById(this.ids.detailView);
    if (listView)   listView.style.display = 'none';
    if (detailView) detailView.classList.add('active');
  }

  hide(): void {
    const listView   = document.getElementById(this.ids.listView);
    const detailView = document.getElementById(this.ids.detailView);
    if (listView)   listView.style.display = '';
    if (detailView) detailView.classList.remove('active');
    this.onBack();
  }

  private set(id: string, html: string): void {
    const el = document.getElementById(id);
    if (el) el.innerHTML = html;
  }
}
