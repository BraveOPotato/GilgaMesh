/**
 * src/plugins/sdk/sdk.ts — TypeScript source of the plugin SDK.
 *
 * This file is compiled to a standalone IIFE (plugin-sdk.js) and injected into
 * every plugin's sandboxed iframe before the plugin's own source runs.
 *
 * Exposes a global `GilgaMesh` object — see api-types.ts for the full surface.
 *
 * __PLUGIN_ID__ and __PERMISSIONS__ are injected as globals by IframeSandbox
 * before this script executes.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

// These globals are set by IframeSandbox in the iframe HTML.
declare const __PLUGIN_ID__:   string;
declare const __PERMISSIONS__: string[];

(function () {
  'use strict';

  const PLUGIN_ID   = typeof __PLUGIN_ID__   !== 'undefined' ? __PLUGIN_ID__   : 'unknown';
  const PERMISSIONS = typeof __PERMISSIONS__ !== 'undefined' ? __PERMISSIONS__ : [] as string[];

  // ── Pending request map: reqId → { resolve, reject } ──────────────────────
  const _pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  let   _reqCounter = 0;

  // ── Event listeners: event → [callback, ...] ──────────────────────────────
  const _listeners = new Map<string, Array<(p: unknown) => void>>();

  // ── Listen for messages from the host ────────────────────────────────────
  window.addEventListener('message', (event: MessageEvent) => {
    const msg = event.data as Record<string, unknown>;
    if (!msg || msg['dir'] !== 'host→plugin') return;

    const type = msg['type'] as string;

    if (type === 'api:response') {
      const entry = _pending.get(msg['reqId'] as string);
      if (entry) {
        _pending.delete(msg['reqId'] as string);
        if (msg['error']) entry.reject(new Error(msg['error'] as string));
        else              entry.resolve(msg['result']);
      }
      return;
    }

    if (type === 'hook') {
      const cbs = _listeners.get(msg['event'] as string) ?? [];
      for (const cb of cbs) {
        try { cb(msg['payload']); } catch (err) {
          console.error(`[GilgaMesh SDK] Error in hook "${msg['event'] as string}":`, err);
        }
      }
    }
  });

  // ── Core: send a request to the host, return a Promise ───────────────────
  function _call(method: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const reqId = `${PLUGIN_ID}:${++_reqCounter}`;
      _pending.set(reqId, { resolve, reject });

      window.parent.postMessage({
        dir:      'plugin→host',
        type:     'api',
        pluginId: PLUGIN_ID,
        method,
        args,
        reqId,
      }, '*');

      // Timeout after 10 s.
      setTimeout(() => {
        if (_pending.has(reqId)) {
          _pending.delete(reqId);
          reject(new Error(`API call "${method}" timed out`));
        }
      }, 10_000);
    });
  }

  // ── Public API surface ────────────────────────────────────────────────────
  const GilgaMesh = {
    pluginId:    PLUGIN_ID,
    permissions: new Set<string>(PERMISSIONS),

    /** Subscribe to a hook event. Returns unsubscribe function. */
    on(event: string, callback: (p: unknown) => void): () => void {
      if (typeof callback !== 'function') throw new TypeError('callback must be a function');
      if (!_listeners.has(event)) _listeners.set(event, []);
      _listeners.get(event)!.push(callback);
      return () => {
        const arr = _listeners.get(event) ?? [];
        const idx = arr.indexOf(callback);
        if (idx !== -1) arr.splice(idx, 1);
      };
    },

    /** Emit an inter-plugin event (NOT to the app itself). */
    emit(event: string, payload: unknown = {}): void {
      window.parent.postMessage({
        dir:      'plugin→host',
        type:     'emit',
        pluginId: PLUGIN_ID,
        event,
        payload,
      }, '*');
    },

    api: {
      fetch:       (url: string, options: RequestInit = {}) => _call('fetch',       { url, options }),
      notify:      (title: string, body = '')             => _call('notify',      { title, body }),
      isPeerOnline:(peerId: string)                        => _call('isPeerOnline', { peerId }),

      dm: {
        getHistory: (peerId: string)                     => _call('dm.getHistory', { peerId }),
        send:       (peerId: string, content: string)    => _call('dm.send',       { peerId, content }),
      },

      room: {
        getHistory: (roomId: string, channel = 'general') => _call('room.getHistory', { roomId, channel }),
        send:       (roomId: string, channel: string, content: string) =>
                                                             _call('room.send',       { roomId, channel, content }),
      },

      storage: {
        get:    (key: string)                  => _call('storage.get',    { key }),
        set:    (key: string, value: unknown)  => _call('storage.set',    { key, value }),
        delete: (key: string)                  => _call('storage.delete', { key }),
      },

      ui: {
        addButton: (opts: unknown) => _call('ui.addButton', opts as Record<string, unknown>),
      },

      bot: {
        register: (opts: unknown)                         => _call('bot.register', opts as Record<string, unknown>),
        respond:  (content: string, context: unknown)     => _call('bot.respond',  { content, context }),
      },
    },
  };

  // Expose globally inside the sandboxed iframe.
  (window as unknown as Record<string, unknown>)['GilgaMesh'] = GilgaMesh;

  // Signal ready to the host.
  window.parent.postMessage({ dir: 'plugin→host', type: 'ready', pluginId: PLUGIN_ID }, '*');
})();
