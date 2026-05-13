/**
 * src/ui/components/toast-container.ts — Toast notifications.
 *
 * Subscribes to ui:toast bus events.
 * Manages its own DOM container — no external dependencies.
 */

import { bus } from '../../core/events.js';

type ToastKind = 'info' | 'success' | 'error' | 'warning';

const DURATIONS: Record<ToastKind, number> = {
  info:    3000,
  success: 3000,
  error:   5000,
  warning: 4000,
};

let container: HTMLElement | null = null;

export function initToasts(): () => void {
  container = document.createElement('div');
  container.id        = 'toast-container';
  container.className = 'toast-container';
  container.setAttribute('aria-live', 'polite');
  document.body.appendChild(container);

  const unsub = bus.on('ui:toast', ({ message, kind }) => {
    showToast(message, kind);
  });

  return () => {
    unsub();
    container?.remove();
    container = null;
  };
}

export function showToast(message: string, kind: ToastKind = 'info'): void {
  if (!container) return;

  const el        = document.createElement('div');
  el.className    = `toast toast-${kind}`;
  el.textContent  = message;
  el.setAttribute('role', 'status');

  container.appendChild(el);

  // Animate in.
  requestAnimationFrame(() => el.classList.add('toast-visible'));

  // Remove after duration.
  const duration = DURATIONS[kind] ?? 3000;
  setTimeout(() => {
    el.classList.remove('toast-visible');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    // Fallback if no transition.
    setTimeout(() => el.remove(), 400);
  }, duration);
}
