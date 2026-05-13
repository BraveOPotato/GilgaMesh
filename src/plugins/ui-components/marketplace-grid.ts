/**
 * src/plugins/ui-components/marketplace-grid.ts — Marketplace browse grid.
 *
 * Renders entries into #mkt-grid.
 * Handles category sidebar, search filtering, and card clicks.
 */

import { escapeHtml } from '../../utils/format.js';
import type { MarketplaceEntry } from '../types.js';
import type { PluginInfo } from '../host.js';

const DANGER_PERMS = new Set(['network', 'dm:write', 'room:write', 'ui:inject']);

export interface MarketplaceGridCallbacks {
  readonly onCardClick: (entry: MarketplaceEntry, isInstalled: boolean) => void;
}

export class MarketplaceGrid {
  private category = 'All';
  private query    = '';
  private entries: readonly MarketplaceEntry[] = [];
  private installedIds = new Set<string>();

  constructor(
    private readonly gridId:   string,
    private readonly sidebarId: string,
    private readonly cbs:      MarketplaceGridCallbacks,
  ) {}

  setEntries(entries: readonly MarketplaceEntry[], installed: readonly PluginInfo[]): void {
    this.entries      = entries;
    this.installedIds = new Set(installed.map(p => p.id));
    this.buildSidebar();
    this.render();
  }

  setQuery(q: string): void {
    this.query = q.trim().toLowerCase();
    this.render();
  }

  setCategory(cat: string): void {
    this.category = cat;
    this.syncSidebarActive();
    this.render();
  }

  // ── Sidebar ───────────────────────────────────────────────────────────────

  private buildSidebar(): void {
    const sidebar = document.getElementById(this.sidebarId);
    if (!sidebar) return;

    const cats = ['All', ...new Set(this.entries.map(e => (e as Record<string,unknown>)['category'] as string || 'Other').sort())];

    sidebar.innerHTML = cats.map(c =>
      `<button class="mkt-cat-btn ${c === this.category ? 'active' : ''}" data-cat="${escapeHtml(c)}">${escapeHtml(c)}</button>`,
    ).join('');

    sidebar.querySelectorAll<HTMLElement>('.mkt-cat-btn').forEach(btn => {
      btn.addEventListener('click', () => this.setCategory(btn.dataset['cat'] ?? 'All'));
    });
  }

  private syncSidebarActive(): void {
    const sidebar = document.getElementById(this.sidebarId);
    sidebar?.querySelectorAll<HTMLElement>('.mkt-cat-btn').forEach(btn => {
      btn.classList.toggle('active', btn.dataset['cat'] === this.category);
    });
  }

  // ── Grid ──────────────────────────────────────────────────────────────────

  render(): void {
    const grid = document.getElementById(this.gridId);
    if (!grid) return;

    const filtered = this.entries.filter(e => {
      const entryCat = (e as Record<string,unknown>)['category'] as string || 'Other';
      const matchCat = this.category === 'All' || entryCat === this.category;
      const matchQ   = !this.query || [e.name, e.description, (e as Record<string,unknown>)['author'] as string, entryCat]
        .some(f => (f ?? '').toLowerCase().includes(this.query));
      return matchCat && matchQ;
    });

    if (filtered.length === 0) {
      grid.innerHTML = `
        <div class="mkt-empty">
          <div class="mkt-empty-icon">🔍</div>
          <div>No plugins found${this.query ? ` for "<strong>${escapeHtml(this.query)}</strong>"` : ''}.</div>
        </div>`;
      return;
    }

    grid.innerHTML = filtered.map(e => this.cardHtml(e)).join('');

    grid.querySelectorAll<HTMLElement>('.mkt-card').forEach(card => {
      card.addEventListener('click', () => {
        const entry = filtered.find(x => x.id === card.dataset['id']);
        if (entry) this.cbs.onCardClick(entry, this.installedIds.has(entry.id));
      });
    });
  }

  private cardHtml(e: MarketplaceEntry): string {
    const ext      = e as Record<string, unknown>;
    const inst     = this.installedIds.has(e.id);
    const icon     = escapeHtml((ext['icon'] as string) ?? '🔌');
    const author   = escapeHtml((ext['author'] as string) ?? 'Unknown');
    const rating   = Number(ext['rating'] ?? 0);
    const installs = ext['installs'] as number | undefined;
    const banner   = ext['banner'] as string | undefined;

    return `
    <div class="mkt-card ${inst ? 'installed' : ''}" data-id="${escapeHtml(e.id)}">
      <div class="mkt-card-banner">
        ${banner ? `<img src="${escapeHtml(banner)}" alt="" loading="lazy">` : ''}
        <div class="mkt-card-icon-over">${icon}</div>
      </div>
      <div class="mkt-card-body">
        <div class="mkt-card-name">${escapeHtml(e.name || e.id)}</div>
        <div class="mkt-card-author">by ${author}</div>
        <div class="mkt-card-desc">${escapeHtml(e.description ?? '')}</div>
        <div class="mkt-card-footer">
          <span class="mkt-stars">${starsHtml(rating)}</span>
          <span class="mkt-installs">${installs ? fmtInstalls(installs) + ' installs' : ''}</span>
          ${inst ? '<span class="mkt-installed-badge">installed</span>' : ''}
        </div>
      </div>
    </div>`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

export function starsHtml(rating: number): string {
  const full  = Math.floor(rating);
  const half  = (rating - full) >= 0.5 ? 1 : 0;
  const empty = 5 - full - half;
  return '★'.repeat(full) + (half ? '⯨' : '') + '☆'.repeat(empty);
}

export function fmtInstalls(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000)     return (n / 1_000).toFixed(1)     + 'k';
  return String(n);
}

export function dangerPermsHtml(permissions: readonly string[]): string {
  return permissions.map(p => {
    const danger = DANGER_PERMS.has(p);
    return `<span class="mkt-perm-chip${danger ? ' danger' : ''}">${danger ? '⚠ ' : ''}${escapeHtml(p)}</span>`;
  }).join('');
}
