/**
 * src/ui/components/message-item.ts — Renders a single chat message.
 *
 * Pure function: Message → HTML string.
 * No DOM access, no side effects.
 */

import type { Message } from '../../core/types.js';
import { renderMarkdown, escapeHtml } from '../renderers/markdown.js';
import { avatarHtml } from '../renderers/avatar.js';
import { formatTime } from '../renderers/time.js';
import { formatBytes } from '../renderers/time.js';

export interface MessageItemOptions {
  readonly mentionNames?: readonly string[];
  readonly myName?:       string;
  readonly myId?:         string;
}

export function renderMessageItem(msg: Message, opts: MessageItemOptions = {}): string {
  if (msg.type === 'system') return renderSystemMessage(msg);
  if (msg.msgType === 'file' || msg.fileShare) return renderFileMessage(msg);
  return renderChatMessage(msg, opts);
}

// ─── CHAT MESSAGE ─────────────────────────────────────────────────────────────

function renderChatMessage(msg: Message, opts: MessageItemOptions): string {
  const isMe      = msg.authorId === opts.myId;
  const pending   = msg.pending ? ' msg-pending' : '';
  const meClass   = isMe ? ' msg-mine' : '';
  const avatar    = avatarHtml(msg.author, 'sm');
  const time      = formatTime(msg.ts);
  const html      = renderMarkdown(msg.content ?? '', {
    mentionNames: opts.mentionNames,
    myName:       opts.myName,
  });

  const replyBar = msg.replyTo
    ? `<div class="msg-reply-preview">
         <span class="reply-author">${escapeHtml(msg.replyTo.author)}</span>
         <span class="reply-content">${escapeHtml(msg.replyTo.content ?? '')}</span>
       </div>`
    : '';

  const pendingBadge = msg.pending
    ? '<span class="msg-pending-badge" title="Sending…">●</span>'
    : '';

  return `
    <div class="msg-group${meClass}${pending}" id="msg-${escapeHtml(msg.id ?? '')}">
      <div class="msg-avatar">${avatar}</div>
      <div class="msg-body">
        <div class="msg-header">
          <span class="msg-author">${escapeHtml(msg.author)}</span>
          <span class="msg-time">${escapeHtml(time)}</span>
          ${pendingBadge}
        </div>
        ${replyBar}
        <div class="msg-content">${html}</div>
        <div class="msg-actions">
          <button class="msg-reply-btn icon-btn" data-msg-id="${escapeHtml(msg.id ?? '')}"
                  title="Reply" aria-label="Reply">↩</button>
        </div>
      </div>
    </div>`.trim();
}

// ─── FILE MESSAGE ──────────────────────────────────────────────────────────────

function renderFileMessage(msg: Message): string {
  const fs = msg.fileShare;
  if (!fs) return renderChatMessage(msg, {});

  const size    = formatBytes(fs.size);
  const expires = new Date(fs.expires).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  return `
    <div class="msg-group msg-file" id="msg-${escapeHtml(msg.id ?? '')}">
      <div class="msg-avatar">${avatarHtml(msg.author, 'sm')}</div>
      <div class="msg-body">
        <div class="msg-header">
          <span class="msg-author">${escapeHtml(msg.author)}</span>
          <span class="msg-time">${formatTime(msg.ts)}</span>
        </div>
        <div class="msg-file-card">
          <span class="file-icon">📎</span>
          <div class="file-info">
            <span class="file-name">${escapeHtml(fs.filename)}</span>
            <span class="file-meta">${escapeHtml(size)} · expires ${escapeHtml(expires)}</span>
          </div>
          <a class="file-download-btn btn btn-sm"
             href="#"
             data-file-token="${escapeHtml(fs.token)}"
             data-file-from="${escapeHtml(fs.fromId)}"
             data-file-name="${escapeHtml(fs.filename)}">
            Download
          </a>
        </div>
      </div>
    </div>`.trim();
}

// ─── SYSTEM MESSAGE ───────────────────────────────────────────────────────────

function renderSystemMessage(msg: Message): string {
  return `<div class="msg-system" id="msg-${escapeHtml(msg.id ?? '')}">
    <span class="msg-system-text">${escapeHtml(msg.content ?? '')}</span>
    <span class="msg-system-time">${formatTime(msg.ts)}</span>
  </div>`.trim();
}
