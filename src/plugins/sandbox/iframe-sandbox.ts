/**
 * src/plugins/sandbox/iframe-sandbox.ts — Sandboxed iframe plugin container.
 *
 * Security properties:
 *  - sandbox="allow-scripts" only — no allow-same-origin → plugin cannot read
 *    host localStorage or cookies
 *  - Source origin verified against iframe.contentWindow in PluginHost
 *  - Plugin receives no DOM access to the host page
 */

import type { PluginId } from '../../core/types.js';
import type { PluginSandbox, PluginManifest } from '../types.js';

// SDK URL resolved at bundle time relative to this module.
const SDK_URL = new URL('../../plugin-sdk.js', import.meta.url).href;

export class IframeSandbox implements PluginSandbox {
  private iframe:  HTMLIFrameElement | null = null;
  private blobUrl: string | null            = null;

  constructor(readonly pluginId: PluginId) {}

  async load(manifest: PluginManifest, source: string): Promise<void> {
    const permissions = JSON.stringify(manifest.permissions ?? []);

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head><body>
<script>
const __PLUGIN_ID__   = ${JSON.stringify(this.pluginId)};
const __PERMISSIONS__ = ${permissions};
</script>
<script src="${SDK_URL}"></script>
<script>
${source}
</script>
</body></html>`;

    const blob    = new Blob([html], { type: 'text/html' });
    this.blobUrl  = URL.createObjectURL(blob);

    const iframe  = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts');
    iframe.style.cssText        = 'display:none;width:0;height:0;position:absolute;';
    iframe.dataset['pluginId']  = this.pluginId;
    iframe.src                  = this.blobUrl;

    iframe.addEventListener('load', () => {
      if (this.blobUrl) { URL.revokeObjectURL(this.blobUrl); this.blobUrl = null; }
    }, { once: true });

    document.body.appendChild(iframe);
    this.iframe = iframe;

    // Allow iframe to initialise SDK before caller proceeds.
    await new Promise<void>(resolve => setTimeout(resolve, 50));
  }

  send(msg: unknown): void {
    try { this.iframe?.contentWindow?.postMessage(msg, '*'); } catch {}
  }

  getIframe(): HTMLIFrameElement | null { return this.iframe; }

  isSource(source: MessageEventSource | null): boolean {
    return source != null && source === this.iframe?.contentWindow;
  }

  destroy(): void {
    this.send({ dir: 'host→plugin', type: 'hook', event: 'plugin:unloading', payload: {} });
    setTimeout(() => { try { this.iframe?.remove(); } catch {} this.iframe = null; }, 150);
  }
}
