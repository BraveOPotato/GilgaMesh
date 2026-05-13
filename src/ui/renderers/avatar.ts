/**
 * src/ui/renderers/avatar.ts — Pure avatar HTML generation.
 * No DOM access. Returns HTML strings.
 */

import { stringToColor } from '../../utils/format.js';
import { escapeHtml } from './markdown.js';

export function avatarHtml(name: string, size: 'sm' | 'md' | 'lg' = 'md'): string {
  const initial = (name ?? '?')[0]?.toUpperCase() ?? '?';
  const color   = stringToColor(name);
  const sizeClass = `avatar-${size}`;
  return `<span class="avatar ${sizeClass}" style="background:${color}" aria-label="${escapeHtml(name)}">${escapeHtml(initial)}</span>`;
}

export function speakingRingHtml(name: string, speaking: boolean): string {
  const cls = speaking ? 'avatar-ring speaking' : 'avatar-ring';
  return `<span class="${cls}">${avatarHtml(name)}</span>`;
}
