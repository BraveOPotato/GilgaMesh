/**
 * plugin-sdk.js — Injected into every plugin's sandboxed iframe.
 *
 * Exposes a global `GilgaMesh` object with:
 *   GilgaMesh.on(event, cb)         — subscribe to hook events
 *   GilgaMesh.emit(event, payload)  — emit inter-plugin event
 *   GilgaMesh.api.*                 — permission-gated API calls
 *   GilgaMesh.pluginId              — this plugin's ID
 *   GilgaMesh.permissions           — Set of granted permissions
 *
 * __PLUGIN_ID__ and __PERMISSIONS__ are injected as globals by the host
 * before this script runs.
 */

(function () {
  'use strict';

  // These are set by the host in the iframe HTML before this script loads
  const PLUGIN_ID   = typeof __PLUGIN_ID__   !== 'undefined' ? __PLUGIN_ID__   : 'unknown';
  const PERMISSIONS = typeof __PERMISSIONS__ !== 'undefined' ? __PERMISSIONS__ : [];

  // ── Pending request map: reqId → { resolve, reject } ───────────────────
  const _pending = new Map();
  let _reqCounter = 0;

  // ── Event listeners: event name → [callback, ...] ──────────────────────
  const _listeners = new Map();

  // ── Listen for messages from the host ──────────────────────────────────
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || msg.dir !== 'host→plugin') return;

    switch (msg.type) {
      case 'api:response':
        if (_pending.has(msg.reqId)) {
          const { resolve, reject } = _pending.get(msg.reqId);
          _pending.delete(msg.reqId);
          if (msg.error) reject(new Error(msg.error));
          else           resolve(msg.result);
        }
        break;

      case 'hook':
        const cbs = _listeners.get(msg.event) || [];
        for (const cb of cbs) {
          try { cb(msg.payload); } catch (err) {
            console.error(`[GilgaMesh SDK] Error in hook "${msg.event}":`, err);
          }
        }
        break;
    }
  });

  // ── Core: send a request to the host, return a Promise ─────────────────
  function _call(method, args = {}) {
    return new Promise((resolve, reject) => {
      const reqId = PLUGIN_ID + ':' + (++_reqCounter);
      _pending.set(reqId, { resolve, reject });
      window.parent.postMessage({
        dir: 'plugin→host',
        type: 'api',
        pluginId: PLUGIN_ID,
        method,
        args,
        reqId,
      }, '*');

      // Timeout after 10s
      setTimeout(() => {
        if (_pending.has(reqId)) {
          _pending.delete(reqId);
          reject(new Error(`API call "${method}" timed out`));
        }
      }, 10000);
    });
  }

  // ── Public API surface ──────────────────────────────────────────────────
  const GilgaMesh = {
    pluginId:    PLUGIN_ID,
    permissions: new Set(PERMISSIONS),

    /** Subscribe to a hook event */
    on(event, callback) {
      if (typeof callback !== 'function') throw new TypeError('callback must be a function');
      if (!_listeners.has(event)) _listeners.set(event, []);
      _listeners.get(event).push(callback);
      return () => {
        // Returns an unsubscribe function
        const arr = _listeners.get(event) || [];
        const idx = arr.indexOf(callback);
        if (idx !== -1) arr.splice(idx, 1);
      };
    },

    /** Emit an event to other plugins (NOT to the app) */
    emit(event, payload = {}) {
      window.parent.postMessage({
        dir: 'plugin→host',
        type: 'emit',
        pluginId: PLUGIN_ID,
        event,
        payload,
      }, '*');
    },

    api: {
      /**
       * Proxied fetch. Requires 'network' permission.
       * Returns { ok, status, body } where body is text.
       * Parse JSON yourself: JSON.parse(result.body)
       */
      fetch(url, options = {}) {
        return _call('fetch', { url, options });
      },

      /**
       * Push a browser notification. Requires 'notifications' permission.
       */
      notify(title, body = '') {
        return _call('notify', { title, body });
      },

      /** Check if a peer is currently online */
      isPeerOnline(peerId) {
        return _call('isPeerOnline', { peerId });
      },

      dm: {
        /** Get DM history with a peer. Requires 'dm:read'. */
        getHistory(peerId) { return _call('dm.getHistory', { peerId }); },
        /** Send a DM. Requires 'dm:write'. */
        send(peerId, content) { return _call('dm.send', { peerId, content }); },
      },

      room: {
        /** Get message history. Requires 'room:read'. */
        getHistory(roomId, channel = 'general') { return _call('room.getHistory', { roomId, channel }); },
        /** Inject a message. Requires 'room:write'. */
        send(roomId, channel, content) { return _call('room.send', { roomId, channel, content }); },
      },

      storage: {
        /** Read from isolated plugin store. Requires 'storage:read'. */
        get(key) { return _call('storage.get', { key }); },
        /** Write to isolated plugin store. Requires 'storage:write'. */
        set(key, value) { return _call('storage.set', { key, value }); },
        /** Delete from isolated plugin store. Requires 'storage:write'. */
        delete(key) { return _call('storage.delete', { key }); },
      },

      ui: {
        /**
         * Add a button to an app chrome area. Requires 'ui:inject'.
         * @param {{ label, icon, targetArea, eventName }} opts
         *   - label: tooltip text
         *   - icon: emoji or text character shown on the button
         *   - targetArea: DOM id to append button to (default: 'header-right')
         *   - eventName: hook event name fired back to this plugin when clicked
         */
        addButton(opts) { return _call('ui.addButton', opts); },
      },
    },
  };

  // Expose globally inside the sandboxed iframe
  window.GilgaMesh = GilgaMesh;

  // Signal ready
  window.parent.postMessage({
    dir: 'plugin→host', type: 'ready', pluginId: PLUGIN_ID,
  }, '*');

})();
