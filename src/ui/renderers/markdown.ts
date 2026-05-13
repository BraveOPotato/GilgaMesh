/**
 * src/ui/renderers/markdown.ts — Pure markdown → HTML renderer.
 *
 * Supports: fenced code blocks, blockquotes, headings (h1-h3),
 * unordered/ordered lists, inline code, bold/italic/strikethrough,
 * links, bare URLs, @mentions.
 *
 * No DOM access. No imports. Returns a sanitised HTML string.
 */

export interface MarkdownOptions {
  readonly mentionNames?: readonly string[];
  readonly myName?:       string;
}

export function renderMarkdown(raw: string, options: MarkdownOptions = {}): string {
  if (!raw) return '';

  const lines = raw.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? '';

    // ── Fenced code block ────────────────────────────────────────────────────
    if (line.trimStart().startsWith('```')) {
      const lang = line.trimStart().slice(3).trim();
      const code: string[] = [];
      i++;
      while (i < lines.length && !(lines[i] ?? '').trimStart().startsWith('```')) {
        code.push(escapeHtml(lines[i] ?? ''));
        i++;
      }
      const langAttr = lang ? ` class="md-code lang-${escapeHtml(lang)}"` : ' class="md-code"';
      out.push(`<pre class="md-pre"><code${langAttr}>${code.join('\n')}</code></pre>`);
      i++;
      continue;
    }

    // ── Blockquote ───────────────────────────────────────────────────────────
    if (line.startsWith('> ')) {
      const qlines: string[] = [];
      while (i < lines.length && (lines[i] ?? '').startsWith('> ')) {
        qlines.push((lines[i] ?? '').slice(2));
        i++;
      }
      out.push(`<blockquote class="md-blockquote">${renderMarkdown(qlines.join('\n'), options)}</blockquote>`);
      continue;
    }

    // ── Headings ─────────────────────────────────────────────────────────────
    const hMatch = line.match(/^(#{1,3})\s+(.*)/);
    if (hMatch) {
      const level = (hMatch[1] ?? '#').length;
      out.push(`<h${level} class="md-h${level}">${inlineMarkdown(hMatch[2] ?? '', options)}</h${level}>`);
      i++;
      continue;
    }

    // ── Unordered list ────────────────────────────────────────────────────────
    if (/^[-*]\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s/.test(lines[i] ?? '')) {
        items.push(`<li>${inlineMarkdown((lines[i] ?? '').slice(2), options)}</li>`);
        i++;
      }
      out.push(`<ul class="md-ul">${items.join('')}</ul>`);
      continue;
    }

    // ── Ordered list ──────────────────────────────────────────────────────────
    if (/^\d+\.\s/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s/.test(lines[i] ?? '')) {
        items.push(`<li>${inlineMarkdown((lines[i] ?? '').replace(/^\d+\.\s/, ''), options)}</li>`);
        i++;
      }
      out.push(`<ol class="md-ol">${items.join('')}</ol>`);
      continue;
    }

    // ── Blank line ────────────────────────────────────────────────────────────
    if (line.trim() === '') {
      out.push('<div class="md-spacer"></div>');
      i++;
      continue;
    }

    // ── Paragraph ────────────────────────────────────────────────────────────
    out.push(`<p class="md-p">${inlineMarkdown(line, options)}</p>`);
    i++;
  }

  return out.join('');
}

// ─── INLINE ───────────────────────────────────────────────────────────────────

function inlineMarkdown(text: string, options: MarkdownOptions): string {
  let s = escapeHtml(text);

  // Inline code (must run before bold/italic to avoid double-processing).
  s = s.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');

  // Bold + italic.
  s = s.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  s = s.replace(/\*\*(.+?)\*\*/g,    '<strong>$1</strong>');
  s = s.replace(/\*([^*\s][^*]*?)\*/g,  '<em>$1</em>');
  s = s.replace(/_([^_\s][^_]*?)_/g,    '<em>$1</em>');

  // Strikethrough.
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');

  // Explicit links [text](url) — only allow https?:// to block javascript: injection.
  s = s.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    '<a class="md-link" href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
  );
  // Non-http schemes → render as plain text (no <a>).
  s = s.replace(/\[([^\]]+)\]\((?!https?:\/\/)[^)]*\)/g, '$1');

  // Bare URLs — don't re-link already-linked text.
  s = s.replace(
    /(^|[^"=])(https?:\/\/[^\s<>"]+)/g,
    '$1<a class="md-link" href="$2" target="_blank" rel="noopener noreferrer">$2</a>',
  );

  // @mentions.
  if (options.mentionNames && options.mentionNames.length > 0) {
    const escaped = options.mentionNames.map(n =>
      escapeHtml(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'),
    );
    const pattern = new RegExp(
      `@(${escaped.join('|')})(?=[\\s,!?.\\u00a0]|$)`,
      'g',
    );
    const myName = options.myName ?? '';
    s = s.replace(pattern, (_match: string, name: string) => {
      const isMe = name.toLowerCase() === myName.toLowerCase();
      return `<span class="mention${isMe ? ' mention-me' : ''}" data-peer-id="">@${name}</span>`;
    });
  }

  return s;
}

// ─── ESCAPE ───────────────────────────────────────────────────────────────────

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g,  '&amp;')
    .replace(/</g,  '&lt;')
    .replace(/>/g,  '&gt;')
    .replace(/"/g,  '&quot;')
    .replace(/'/g,  '&#39;');
}
