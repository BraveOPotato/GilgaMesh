// src/utils/format.ts
// ─── FORMAT UTILITIES ─────────────────────────────────────────────────────────
// Pure functions. No imports, no side effects.

export function escapeHtml(s: string): string {
  if (!s) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function formatBytes(b: number): string {
  if (!b) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'] as const;
  let i = 0;
  let v = b;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return v.toFixed(1) + ' ' + units[i];
}

const COLOR_PALETTE = [
  '#5b6cf9','#3ddc84','#f5a623','#e06c75',
  '#c678dd','#56b6c2','#61afef','#d19a66',
] as const;

export function stringToColor(s: string): string {
  let h = 0;
  for (let i = 0; i < (s || '').length; i++) {
    h = s.charCodeAt(i) + ((h << 5) - h);
  }
  return COLOR_PALETTE[Math.abs(h) % COLOR_PALETTE.length] ?? COLOR_PALETTE[0];
}

export function formatRelativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000)  return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
