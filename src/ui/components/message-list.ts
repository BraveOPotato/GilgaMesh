/**
 * src/ui/components/message-list.ts — Renders + incrementally updates the message list.
 *
 * mount()    — Initial full render into container element.
 * append()   — Appends a single new message (fast path, no full re-render).
 * unPend()   — Removes pending state from a message by ID.
 */

import type { Message } from '../../core/types.js';
import { renderMessageItem, type MessageItemOptions } from './message-item.js';

export class MessageList {
  private container: HTMLElement;
  private opts:      MessageItemOptions;

  constructor(container: HTMLElement, opts: MessageItemOptions = {}) {
    this.container = container;
    this.opts      = opts;
  }

  /** Full render — replaces all children. */
  mount(messages: readonly Message[]): void {
    this.container.innerHTML = messages
      .map(m => renderMessageItem(m, this.opts))
      .join('');
  }

  /** Append one new message without touching existing DOM. */
  append(msg: Message): void {
    const html = renderMessageItem(msg, this.opts);
    const el   = document.createElement('div');
    el.innerHTML = html;
    const child = el.firstElementChild;
    if (child) this.container.appendChild(child);
  }

  /** Remove pending state from a message element (msg_ack received). */
  unPend(msgId: string): void {
    const el = document.getElementById(`msg-${msgId}`);
    if (!el) return;
    el.classList.remove('msg-pending');
    el.closest('.msg-group')?.classList.remove('msg-pending');
    el.closest('.msg-group')?.querySelector('.msg-pending-badge')?.remove();
  }

  scrollToBottom(smooth = false): void {
    this.container.scrollTo({
      top:      this.container.scrollHeight,
      behavior: smooth ? 'smooth' : 'instant',
    });
  }

  isScrolledToBottom(threshold = 80): boolean {
    return (
      this.container.scrollHeight - this.container.scrollTop - this.container.clientHeight
      <= threshold
    );
  }
}
