/**
 * src/plugins/ui-components/marketplace-detail.ts — Marketplace detail slide-in panel.
 *
 * Shows full entry info: description, screenshots, permissions, stats.
 * Install action emits ui:plugin-install-requested via bus.
 */

import { bus } from '../../core/events.js';
import { escapeHtml } from '../../utils/format.js';
import type { MarketplaceEntry } from '../types.js';
import { starsHtml, fmtInstalls, dangerPermsHtml } from './marketplace-grid.js';

const DANGER_PERMS = new Set(['network', 'dm:write', 'room:write', 'ui:inject']);

export interface MarketplaceDetailIds {
  readonly detailPanel:  string;
  readonly scrollArea:   string;
  readonly backBtn:      string;
  readonly installBtn:   string;
  readonly lightbox:     string;
  readonly lightboxImg:  string;
}

export class MarketplaceDetail {
  private currentEntry: MarketplaceEntry | null = null;

  constructor(private readonly ids: MarketplaceDetailIds) {}

  wire(): void {
    document.getElementById(this.ids.backBtn)?.addEventListener('click', () => this.close());
    document.getElementById(this.ids.installBtn)?.addEventListener('click', () => this.install());
    document.getElementById(this.ids.lightbox)?.addEventListener('click', () => {
      document.getElementById(this.ids.lightbox)?.classList.add('hidden');
    });
  }

  open(entry: MarketplaceEntry, isInstalled: boolean): void {
    this.currentEntry = entry;
    this.renderContent(entry, isInstalled);
    document.getElementById(this.ids.detailPanel)?.classList.add('open');
  }

  close(): void {
    document.getElementById(this.ids.detailPanel)?.classList.remove('open');
    this.currentEntry = null;
  }

  isOpen(): boolean {
    return document.getElementById(this.ids.detailPanel)?.classList.contains('open') ?? false;
  }

  private install(): void {
    if (!this.currentEntry) return;
    const entry     = this.currentEntry;
    const installBtn = document.getElementById(this.ids.installBtn) as HTMLButtonElement | null;

    if (installBtn) {
      installBtn.textContent = 'Installing…';
      installBtn.disabled    = true;
    }

    bus.emit('ui:plugin-install-requested', { baseUrl: (entry as Record<string,unknown>)['baseUrl'] as string ?? '' });

    // Optimistically update button — actual state syncs via pluginsStore subscription.
    setTimeout(() => {
      if (installBtn) {
        installBtn.textContent   = '✓ Installed';
        installBtn.style.opacity = '0.6';
      }
    }, 800);
  }

  private renderContent(entry: MarketplaceEntry, isInstalled: boolean): void {
    const scroll = document.getElementById(this.ids.scrollArea);
    if (!scroll) return;

    const ext         = entry as Record<string, unknown>;
    const perms       = (ext['permissions'] as string[] | undefined) ?? [];
    const shots       = (ext['screenshots'] as string[] | undefined) ?? [];
    const rating      = Number(ext['rating'] ?? 0);
    const ratingCount = ext['ratingCount']
      ? `(${Number(ext['ratingCount']).toLocaleString()} ratings)` : '';
    const installs    = ext['installs'] as number | undefined;
    const author      = escapeHtml((ext['author'] as string) ?? 'Unknown');
    const longDesc    = escapeHtml((ext['longDescription'] as string) ?? entry.description ?? '');
    const homepage    = ext['homepage'] as string | undefined;
    const changelog   = ext['changelog'] as string | undefined;

    const shotsHtml = shots.length
      ? shots.map(url => `<img class="mkt-screenshot" src="${escapeHtml(url)}" data-src="${escapeHtml(url)}" alt="Screenshot" loading="lazy">`).join('')
      : '<div class="mkt-screenshot-ph">No screenshots yet</div>';

    const permsHtml   = dangerPermsHtml(perms);
    const hasDanger   = perms.some(p => DANGER_PERMS.has(p));

    scroll.innerHTML = `
      <div class="mkt-detail-hero">
        <div class="mkt-detail-icon">${escapeHtml((ext['icon'] as string) ?? '🔌')}</div>
        <div style="flex:1;min-width:0">
          <div class="mkt-detail-title">${escapeHtml(entry.name || entry.id)}</div>
          <div class="mkt-detail-author">by ${author}</div>
          <div class="mkt-detail-ver">v${escapeHtml(entry.version ?? '?')}</div>
        </div>
      </div>

      <div class="mkt-rating-row">
        <span class="mkt-rating-stars">${starsHtml(rating)}</span>
        <span style="font-weight:600">${rating.toFixed(1)}</span>
        <span class="mkt-rating-count">${ratingCount}</span>
      </div>

      <p class="mkt-detail-desc">${longDesc}</p>

      <div class="mkt-stats-row">
        <div class="mkt-stat">
          <div class="mkt-stat-val">${installs ? fmtInstalls(installs) : '—'}</div>
          <div class="mkt-stat-key">Installs</div>
        </div>
        <div class="mkt-stat">
          <div class="mkt-stat-val">${escapeHtml(entry.version ?? '—')}</div>
          <div class="mkt-stat-key">Version</div>
        </div>
        <div class="mkt-stat">
          <div class="mkt-stat-val">${escapeHtml((ext['category'] as string) ?? '—')}</div>
          <div class="mkt-stat-key">Category</div>
        </div>
      </div>

      <div>
        <div class="mkt-section-label">Screenshots</div>
        <div class="mkt-screenshots">${shotsHtml}</div>
      </div>

      <div>
        <div class="mkt-section-label">Permissions Required</div>
        <div class="mkt-perm-chips">${permsHtml || '<span style="color:var(--text2);font-size:12px">No special permissions</span>'}</div>
        ${hasDanger ? '<div style="color:var(--text2);font-size:11px;margin-top:6px">⚠ Elevated permissions. Install only from sources you trust.</div>' : ''}
      </div>

      ${homepage ? `
      <div>
        <div class="mkt-section-label">Links</div>
        <a href="${escapeHtml(homepage)}" style="color:var(--accent);font-size:13px" target="_blank" rel="noopener noreferrer">
          Homepage / Source ↗
        </a>
      </div>` : ''}

      ${changelog ? `
      <div>
        <div class="mkt-section-label">What's New</div>
        <div style="color:var(--text2);font-size:12px;line-height:1.6;background:var(--bg3);border:1px solid var(--border);border-radius:8px;padding:10px 12px;white-space:pre-wrap">${escapeHtml(changelog)}</div>
      </div>` : ''}
    `;

    // Wire screenshot lightbox
    scroll.querySelectorAll<HTMLElement>('.mkt-screenshot').forEach(img => {
      img.addEventListener('click', () => {
        const lb    = document.getElementById(this.ids.lightbox);
        const lbImg = document.getElementById(this.ids.lightboxImg) as HTMLImageElement | null;
        if (lb && lbImg) {
          lbImg.src = img.dataset['src'] ?? '';
          lb.classList.remove('hidden');
        }
      });
    });

    // Install button state
    const installBtn = document.getElementById(this.ids.installBtn) as HTMLButtonElement | null;
    if (installBtn) {
      installBtn.textContent   = isInstalled ? '✓ Installed' : 'Install';
      installBtn.disabled      = isInstalled;
      installBtn.style.opacity = isInstalled ? '0.6' : '';
    }
  }
}
