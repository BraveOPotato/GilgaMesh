// src/__tests__/markdown.test.ts
import { describe, it, expect } from 'vitest';
import { renderMarkdown, escapeHtml } from '../ui/renderers/markdown.js';

describe('renderMarkdown', () => {
  it('returns empty string for empty input', () => {
    expect(renderMarkdown('')).toBe('');
  });

  // ── Escape ────────────────────────────────────────────────────────────────
  it('escapes HTML entities', () => {
    const out = renderMarkdown('<script>alert("xss")</script>');
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  // ── Paragraphs ────────────────────────────────────────────────────────────
  it('wraps plain text in <p>', () => {
    expect(renderMarkdown('Hello world')).toContain('<p class="md-p">Hello world</p>');
  });

  // ── Headings ─────────────────────────────────────────────────────────────
  it('renders h1', () => {
    expect(renderMarkdown('# Title')).toContain('<h1 class="md-h1">Title</h1>');
  });
  it('renders h2', () => {
    expect(renderMarkdown('## Sub')).toContain('<h2 class="md-h2">Sub</h2>');
  });
  it('renders h3', () => {
    expect(renderMarkdown('### Sub')).toContain('<h3 class="md-h3">Sub</h3>');
  });

  // ── Code ─────────────────────────────────────────────────────────────────
  it('renders fenced code block', () => {
    const out = renderMarkdown('```js\nconsole.log("hi")\n```');
    expect(out).toContain('<pre class="md-pre">');
    expect(out).toContain('console.log');
  });
  it('renders inline code', () => {
    expect(renderMarkdown('Use `const x = 1`')).toContain('<code class="md-inline-code">const x = 1</code>');
  });

  // ── Bold / italic / strikethrough ─────────────────────────────────────────
  it('renders bold', () => {
    expect(renderMarkdown('**bold**')).toContain('<strong>bold</strong>');
  });
  it('renders italic with *', () => {
    expect(renderMarkdown('*italic*')).toContain('<em>italic</em>');
  });
  it('renders italic with _', () => {
    expect(renderMarkdown('_italic_')).toContain('<em>italic</em>');
  });
  it('renders strikethrough', () => {
    expect(renderMarkdown('~~struck~~')).toContain('<del>struck</del>');
  });
  it('renders bold+italic', () => {
    expect(renderMarkdown('***both***')).toContain('<strong><em>both</em></strong>');
  });

  // ── Lists ─────────────────────────────────────────────────────────────────
  it('renders unordered list', () => {
    const out = renderMarkdown('- foo\n- bar');
    expect(out).toContain('<ul class="md-ul">');
    expect(out).toContain('<li>foo</li>');
    expect(out).toContain('<li>bar</li>');
  });
  it('renders ordered list', () => {
    const out = renderMarkdown('1. one\n2. two');
    expect(out).toContain('<ol class="md-ol">');
    expect(out).toContain('<li>one</li>');
  });

  // ── Blockquote ────────────────────────────────────────────────────────────
  it('renders blockquote', () => {
    const out = renderMarkdown('> quote text');
    expect(out).toContain('<blockquote class="md-blockquote">');
    expect(out).toContain('quote text');
  });

  // ── Links ─────────────────────────────────────────────────────────────────
  it('renders explicit links', () => {
    const out = renderMarkdown('[click](https://example.com)');
    expect(out).toContain('<a class="md-link" href="https://example.com"');
    expect(out).toContain('click');
  });
  it('renders bare URLs', () => {
    const out = renderMarkdown('Visit https://example.com now');
    expect(out).toContain('href="https://example.com"');
  });
  it('links open in new tab', () => {
    const out = renderMarkdown('[x](https://x.com)');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  // ── Mentions ─────────────────────────────────────────────────────────────
  it('highlights @mention when name is in list', () => {
    const out = renderMarkdown('@Alice ', { mentionNames: ['Alice'], myName: 'Bob' });
    expect(out).toContain('<span class="mention"');
    expect(out).toContain('@Alice');
  });
  it('adds mention-me class when name matches myName', () => {
    const out = renderMarkdown('@Alice ', { mentionNames: ['Alice'], myName: 'Alice' });
    expect(out).toContain('mention-me');
  });
  it('does not highlight unknown name', () => {
    const out = renderMarkdown('@Unknown ', { mentionNames: ['Alice'] });
    expect(out).not.toContain('<span class="mention"');
  });

  // ── XSS prevention ────────────────────────────────────────────────────────
  it('does not allow href injection via link syntax', () => {
    const out = renderMarkdown('[evil](javascript:alert(1))');
    // Non-http URLs should not produce an <a> tag with href
    expect(out).not.toContain('javascript:');
  });
  it('escapes content inside code blocks', () => {
    const out = renderMarkdown('```\n<b>not bold</b>\n```');
    expect(out).toContain('&lt;b&gt;');
    expect(out).not.toContain('<b>');
  });
});

describe('escapeHtml', () => {
  it('escapes all five entities', () => {
    expect(escapeHtml('& < > " \'')).toBe('&amp; &lt; &gt; &quot; &#39;');
  });
  it('returns empty string unchanged', () => {
    expect(escapeHtml('')).toBe('');
  });
  it('returns plain text unchanged', () => {
    expect(escapeHtml('hello world')).toBe('hello world');
  });
});
