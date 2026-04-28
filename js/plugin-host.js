/**
 * plugin-host.js — Loads plugins into sandboxed iframes, brokers postMessage,
 * enforces permissions, and fires app lifecycle hooks into each plugin.
 *
 * Usage (in main.js after boot):
 *   import { PluginHost } from './plugin-host.js';
 *   import distConfig    from './distributions/community.dist.js';
 *   export const pluginHost = new PluginHost(distConfig, state);
 *   await pluginHost.init();
 *
 *   // Wire app events:
 *   pluginHost.emit('dm:sent',      { msg, peerId });
 *   pluginHost.emit('peer:online',  { peerId });
 *   pluginHost.emit('room:message', { msg, roomId });
 *   // etc.
 */

import { state } from './state.js';

// ─── PERMISSION DEFINITIONS ───────────────────────────────────────────────────
// Each permission is a string key. The host checks these before proxying API calls.
export const KNOWN_PERMISSIONS = new Set([
  'network',          // can fetch() external URLs (proxied by host)
  'notifications',    // can push browser Notifications
  'dm:read',          // can read DM message history / queue
  'dm:write',         // can send DMs on behalf of the user
  'room:read',        // can read room messages
  'room:write',       // can inject messages into rooms
  'voice',            // can interact with voice channels
  'ui:inject',        // can add buttons/panels to the app chrome
  'storage:read',     // can read plugin's own isolated key-value store
  'storage:write',    // can write plugin's own isolated key-value store
  'bot:command',      // registers a /slash command that appears in autocomplete
]);

// ─── PLUGIN HOST CLASS ────────────────────────────────────────────────────────
export class PluginHost {
  /**
   * @param {object} distConfig   Distribution manifest (from *.dist.js)
   * @param {object} appState     The shared `state` object from state.js
   */
  constructor(distConfig, appState) {
    this.distConfig  = distConfig;
    this.appState    = appState;

    // pluginId → { manifest, iframe, removable, enabled, store:{} }
    this._plugins    = new Map();

    // pluginId → isolated key-value store (in-memory; persisted to localStorage per plugin)
    this._stores     = new Map();

    // Handlers registered by the app for plugin→app API calls
    this._apiHandlers = new Map();

    // Bot command registry: commandName → { pluginId, description, scope }
    // scope: 'room' | 'dm' | 'both'
    this._botCommands = new Map();

    // Bound so we can removeEventListener later
    this._onMessage  = this._onMessage.bind(this);
  }

  // ─── INIT ─────────────────────────────────────────────────────────────────
  async init() {
    window.addEventListener('message', this._onMessage);

    // Register built-in API handlers
    this._registerBuiltinHandlers();

    // Load all plugins declared in the distribution
    const pluginEntries = this.distConfig.plugins || [];
    for (const entry of pluginEntries) {
      try {
        await this._loadPlugin(entry.id, entry.removable ?? true);
      } catch (err) {
        console.warn(`[PluginHost] Failed to load plugin "${entry.id}":`, err);
      }
    }

    console.log(`[PluginHost] Initialized "${this.distConfig.name}" with ${this._plugins.size} plugin(s).`);
    this.emit('app:boot', {});
  }

  // ─── LOAD ONE PLUGIN ──────────────────────────────────────────────────────
  async _loadPlugin(pluginId, removable = true) {
    // Fetch manifest
    const manifestUrl = `./plugins/builtin/${pluginId}/manifest.json`;
    const manifestRes = await fetch(manifestUrl);
    if (!manifestRes.ok) throw new Error(`manifest not found at ${manifestUrl}`);
    const manifest = await manifestRes.json();

    // Validate permissions
    const permissions = new Set(manifest.permissions || []);
    for (const p of permissions) {
      if (!KNOWN_PERMISSIONS.has(p)) {
        console.warn(`[PluginHost] Plugin "${pluginId}" requests unknown permission "${p}" — ignored.`);
        permissions.delete(p);
      }
    }
    manifest.permissions = [...permissions]; // normalised

    // Load plugin source
    const srcUrl = `./plugins/builtin/${pluginId}/${manifest.entry || 'index.js'}`;
    const srcRes = await fetch(srcUrl);
    if (!srcRes.ok) throw new Error(`plugin source not found at ${srcUrl}`);
    const pluginSrc = await srcRes.text();

    // Restore or create isolated store
    const storeKey = `gilgamesh_plugin_${pluginId}`;
    let store = {};
    try { store = JSON.parse(localStorage.getItem(storeKey) || '{}'); } catch {}
    this._stores.set(pluginId, store);

    // Create sandboxed iframe
    const iframe = this._createSandbox(pluginId, manifest, pluginSrc);
    document.body.appendChild(iframe);

    this._plugins.set(pluginId, {
      manifest,
      iframe,
      removable,
      enabled: true,
      store,
      _baseUrl: `./plugins/builtin/${pluginId}`,
      _source:  pluginSrc,
    });

    console.log(`[PluginHost] Loaded plugin "${pluginId}" (v${manifest.version})`);
  }

  // ─── CREATE SANDBOX IFRAME ────────────────────────────────────────────────
  _createSandbox(pluginId, manifest, pluginSrc) {
    const sdkUrl    = new URL('./plugin-sdk.js', import.meta.url).href;
    const permissions = JSON.stringify(manifest.permissions || []);

    // We build a self-contained HTML blob. The SDK is inlined via importScripts
    // approach via a blob URL so we avoid needing allow-same-origin.
    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head><body>
<script>
// ── Injected by PluginHost ──
const __PLUGIN_ID__   = ${JSON.stringify(pluginId)};
const __PERMISSIONS__ = ${permissions};
</script>
<script src="${sdkUrl}"></script>
<script>
// ── Plugin source ──
${pluginSrc}
</script>
</body></html>`;

    const blob  = new Blob([html], { type: 'text/html' });
    const blobUrl = URL.createObjectURL(blob);

    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-scripts'); // NO allow-same-origin
    iframe.style.cssText = 'display:none;width:0;height:0;position:absolute;';
    iframe.src = blobUrl;
    iframe.dataset.pluginId = pluginId;

    // Revoke blob URL after load (iframe keeps a reference internally)
    iframe.addEventListener('load', () => URL.revokeObjectURL(blobUrl), { once: true });

    return iframe;
  }

  // ─── INCOMING MESSAGES FROM PLUGINS ──────────────────────────────────────
  _onMessage(event) {
    const msg = event.data;
    if (!msg || msg.dir !== 'plugin→host') return;

    const { pluginId, type, reqId } = msg;
    const entry = this._plugins.get(pluginId);
    if (!entry || !entry.enabled) return;

    // Verify the message actually came from this plugin's iframe
    if (event.source !== entry.iframe.contentWindow) {
      console.warn(`[PluginHost] Message from "${pluginId}" source mismatch — dropped.`);
      return;
    }

    switch (type) {
      case 'api':    this._handleApiCall(entry, msg); break;
      case 'emit':   this._handlePluginEmit(entry, msg); break;
      case 'ready':  console.log(`[PluginHost] Plugin "${pluginId}" ready.`); break;
      default:       console.warn(`[PluginHost] Unknown msg type "${type}" from "${pluginId}"`);
    }
  }

  // ─── API CALL FROM PLUGIN ─────────────────────────────────────────────────
  async _handleApiCall(entry, msg) {
    const { pluginId, method, args, reqId } = msg;
    const permissions = new Set(entry.manifest.permissions || []);

    const respond = (result, error = null) => {
      this._send(entry.iframe, {
        dir: 'host→plugin', type: 'api:response',
        reqId, result, error,
      });
    };

    // Built-in handlers
    const handler = this._apiHandlers.get(method);
    if (!handler) { respond(null, `Unknown API method "${method}"`); return; }

    try {
      const result = await handler({ args, permissions, pluginId, entry });
      respond(result);
    } catch (err) {
      respond(null, err.message || String(err));
    }
  }

  // ─── INTER-PLUGIN EVENTS ──────────────────────────────────────────────────
  _handlePluginEmit(entry, msg) {
    const { event, payload } = msg;
    // Broadcast to all OTHER plugins (they subscribed via GilgaMesh.on)
    for (const [id, other] of this._plugins) {
      if (id === entry.manifest.id || !other.enabled) continue;
      this._send(other.iframe, {
        dir: 'host→plugin', type: 'hook', event, payload,
      });
    }
  }

  // ─── EMIT APP EVENT TO ALL PLUGINS ───────────────────────────────────────
  emit(event, payload) {
    for (const [, entry] of this._plugins) {
      if (!entry.enabled) continue;
      this._send(entry.iframe, {
        dir: 'host→plugin', type: 'hook', event, payload,
      });
    }
  }

  // ─── SEND TO IFRAME ───────────────────────────────────────────────────────
  _send(iframe, msg) {
    try { iframe.contentWindow?.postMessage(msg, '*'); } catch {}
  }

  // ─── HOT-SWAP: LOAD AT RUNTIME ───────────────────────────────────────────
  /**
   * Install a new plugin while the app is running.
   * Called by main.js installPlugin() after it has fetched the source.
   *
   * @param {object}  manifest   — parsed manifest.json
   * @param {string}  source     — plugin JS source text
   * @param {boolean} removable  — whether the user can uninstall it
   * @param {string}  [baseUrl]  — original URL (stored for reload persistence)
   */
  async hotLoad(manifest, source, removable = true, baseUrl = null) {
    const pluginId   = manifest.id;
    const permissions = new Set(manifest.permissions || []);
    for (const p of [...permissions]) {
      if (!KNOWN_PERMISSIONS.has(p)) permissions.delete(p);
    }
    manifest.permissions = [...permissions];

    // Restore or create isolated store
    const storeKey = `gilgamesh_plugin_${pluginId}`;
    let store = {};
    try { store = JSON.parse(localStorage.getItem(storeKey) || '{}'); } catch {}
    this._stores.set(pluginId, store);

    const iframe = this._createSandbox(pluginId, manifest, source);
    document.body.appendChild(iframe);

    this._plugins.set(pluginId, {
      manifest,
      iframe,
      removable,
      enabled: true,
      store,
      _baseUrl: baseUrl,
      _source:  source,
    });

    // Give the iframe a moment to initialise before firing app:boot
    await new Promise(r => setTimeout(r, 100));
    this._send(iframe, { dir: 'host→plugin', type: 'hook', event: 'app:boot', payload: {} });

    console.log(`[PluginHost] Hot-loaded plugin "${pluginId}" (v${manifest.version})`);
  }

  /**
   * Unload a plugin at runtime — tears down its iframe and removes all state.
   * @param {string} pluginId
   * @returns {boolean}
   */
  hotUnload(pluginId) {
    const entry = this._plugins.get(pluginId);
    if (!entry) return false;
    if (!entry.removable) {
      console.warn(`[PluginHost] hotUnload("${pluginId}") — plugin is non-removable.`);
      return false;
    }

    // Notify the plugin it is being torn down (best-effort)
    this._send(entry.iframe, { dir: 'host→plugin', type: 'hook', event: 'plugin:unloading', payload: {} });

    // Small delay so the plugin can clean up, then destroy the iframe
    setTimeout(() => {
      try { entry.iframe.remove(); } catch {}
    }, 150);

    this._plugins.delete(pluginId);
    this._stores.delete(pluginId);
    console.log(`[PluginHost] Hot-unloaded plugin "${pluginId}"`);
    return true;
  }

  // ─── PLUGIN MANAGEMENT ───────────────────────────────────────────────────
  disablePlugin(pluginId) {
    const entry = this._plugins.get(pluginId);
    if (!entry) return false;
    if (!entry.removable) { console.warn(`[PluginHost] Plugin "${pluginId}" is non-removable.`); return false; }
    entry.enabled = false;
    this._send(entry.iframe, { dir: 'host→plugin', type: 'hook', event: 'plugin:disabled', payload: {} });
    return true;
  }

  enablePlugin(pluginId) {
    const entry = this._plugins.get(pluginId);
    if (!entry) return false;
    entry.enabled = true;
    this._send(entry.iframe, { dir: 'host→plugin', type: 'hook', event: 'plugin:enabled', payload: {} });
    return true;
  }

  /** Returns array of plugin info objects for the UI */
  getPluginList() {
    return [...this._plugins.entries()].map(([id, entry]) => ({
      id,
      manifest:  entry.manifest,
      removable: entry.removable,
      enabled:   entry.enabled,
      _baseUrl:  entry._baseUrl || null,
      _source:   entry._source  || null,
    }));
  }

  getPlugin(pluginId) {
    const entry = this._plugins.get(pluginId);
    if (!entry) return null;
    return {
      id:        pluginId,
      manifest:  entry.manifest,
      removable: entry.removable,
      enabled:   entry.enabled,
    };
  }

  // ─── BUILT-IN API HANDLERS ────────────────────────────────────────────────
  _registerBuiltinHandlers() {

    // ── network: proxied fetch ─────────────────────────────────────────────
    this._apiHandlers.set('fetch', async ({ args, permissions }) => {
      if (!permissions.has('network')) throw new Error('Permission denied: network');
      const { url, options = {} } = args;
      // Strip dangerous headers
      delete options.headers?.['Authorization'];
      const res = await fetch(url, options);
      const text = await res.text();
      return { ok: res.ok, status: res.status, body: text };
    });

    // ── notifications ──────────────────────────────────────────────────────
    this._apiHandlers.set('notify', async ({ args, permissions }) => {
      if (!permissions.has('notifications')) throw new Error('Permission denied: notifications');
      if (Notification.permission === 'granted') {
        new Notification(args.title || 'GilgaMesh', { body: args.body || '' });
      } else if (Notification.permission !== 'denied') {
        const perm = await Notification.requestPermission();
        if (perm === 'granted') new Notification(args.title || 'GilgaMesh', { body: args.body || '' });
      }
      return { sent: true };
    });

    // ── DM read ───────────────────────────────────────────────────────────
    this._apiHandlers.set('dm.getHistory', async ({ args, permissions }) => {
      if (!permissions.has('dm:read')) throw new Error('Permission denied: dm:read');
      const { peerId } = args;
      return this.appState.dms?.[peerId] || [];
    });

    // ── DM write ──────────────────────────────────────────────────────────
    this._apiHandlers.set('dm.send', async ({ args, permissions }) => {
      if (!permissions.has('dm:write')) throw new Error('Permission denied: dm:write');
      // Delegate to app callback (set by main.js)
      if (!this.appState.cb.sendDM) throw new Error('sendDM callback not registered');
      await this.appState.cb.sendDM(args.peerId, args.content);
      return { sent: true };
    });

    // ── isPeerOnline ───────────────────────────────────────────────────────
    this._apiHandlers.set('isPeerOnline', async ({ args }) => {
      const pc = this.appState.peerConns[args.peerId];
      return { online: !!(pc?.conn?.open) };
    });

    // ── room write ────────────────────────────────────────────────────────
    this._apiHandlers.set('room.send', async ({ args, permissions }) => {
      if (!permissions.has('room:write')) throw new Error('Permission denied: room:write');
      if (!this.appState.cb.sendRoomMessage) throw new Error('sendRoomMessage callback not registered');
      await this.appState.cb.sendRoomMessage(args.roomId, args.channel, args.content);
      return { sent: true };
    });

    // ── room read ─────────────────────────────────────────────────────────
    this._apiHandlers.set('room.getHistory', async ({ args, permissions }) => {
      if (!permissions.has('room:read')) throw new Error('Permission denied: room:read');
      const r = this.appState.rooms[args.roomId];
      if (!r) return [];
      return r.messages[args.channel || 'general'] || [];
    });

    // ── isolated plugin storage ────────────────────────────────────────────
    this._apiHandlers.set('storage.get', async ({ args, permissions, pluginId }) => {
      if (!permissions.has('storage:read')) throw new Error('Permission denied: storage:read');
      const store = this._stores.get(pluginId) || {};
      return { value: store[args.key] ?? null };
    });

    this._apiHandlers.set('storage.set', async ({ args, permissions, pluginId }) => {
      if (!permissions.has('storage:write')) throw new Error('Permission denied: storage:write');
      const store = this._stores.get(pluginId) || {};
      store[args.key] = args.value;
      this._stores.set(pluginId, store);
      try { localStorage.setItem(`gilgamesh_plugin_${pluginId}`, JSON.stringify(store)); } catch {}
      return { ok: true };
    });

    this._apiHandlers.set('storage.delete', async ({ args, permissions, pluginId }) => {
      if (!permissions.has('storage:write')) throw new Error('Permission denied: storage:write');
      const store = this._stores.get(pluginId) || {};
      delete store[args.key];
      this._stores.set(pluginId, store);
      try { localStorage.setItem(`gilgamesh_plugin_${pluginId}`, JSON.stringify(store)); } catch {}
      return { ok: true };
    });

    // ── ui:inject — request host to add UI element ─────────────────────────
    this._apiHandlers.set('ui.addButton', async ({ args, permissions, pluginId }) => {
      if (!permissions.has('ui:inject')) throw new Error('Permission denied: ui:inject');
      this._injectPluginButton(pluginId, args);
      return { injected: true };
    });

    // ── bot: register a slash command ─────────────────────────────────────
    this._apiHandlers.set('bot.register', async ({ args, permissions, pluginId, entry }) => {
      if (!permissions.has('bot:command')) throw new Error('Permission denied: bot:command');
      const { command, description = '', icon = '🤖' } = args;
      // Normalise scope: manifest uses 'rooms'/'dms', internals use 'room'/'dm'
      const rawScope = args.scope || entry.manifest.scope || 'both';
      const scope = rawScope === 'rooms' ? 'room' : rawScope === 'dms' ? 'dm' : rawScope;
      if (!command || typeof command !== 'string') throw new Error('bot.register: command name required');
      const cmd = command.toLowerCase().replace(/^\/+/, '');
      this._botCommands.set(cmd, { pluginId, description, scope, icon });
      console.log(`[PluginHost] Bot command "/${cmd}" registered by "${pluginId}" (scope: ${scope})`);
      this.onBotRegistered?.();
      return { registered: true, command: cmd };
    });

    // ── bot: send a response message back to the chat ──────────────────────
    this._apiHandlers.set('bot.respond', async ({ args, permissions, pluginId }) => {
      if (!permissions.has('bot:command')) throw new Error('Permission denied: bot:command');
      if (!this.appState.cb.botRespond) throw new Error('botRespond callback not registered');
      const { content, context } = args;
      await this.appState.cb.botRespond({ pluginId, content, context });
      return { sent: true };
    });
  }

  // ─── UI INJECTION ─────────────────────────────────────────────────────────
  _injectPluginButton(pluginId, { label, icon, targetArea = 'header-right', eventName }) {
    const container = document.getElementById(targetArea);
    if (!container) return;
    const existing = document.getElementById(`plugin-btn-${pluginId}-${eventName}`);
    if (existing) return; // already injected
    const btn = document.createElement('button');
    btn.id        = `plugin-btn-${pluginId}-${eventName}`;
    btn.className = 'icon-btn';
    btn.title     = label || pluginId;
    btn.textContent = icon || '🔌';
    btn.onclick   = () => {
      const entry = this._plugins.get(pluginId);
      if (entry) this._send(entry.iframe, { dir: 'host→plugin', type: 'hook', event: eventName, payload: {} });
    };
    container.appendChild(btn);
  }

  // ─── BOT COMMAND REGISTRY ─────────────────────────────────────────────────

  /**
   * Returns bot commands available in the current context.
   * @param {'room'|'dm'} context
   * @param {string} [query]  prefix filter (without leading /)
   */
  getBotCommands(context = 'room', query = '') {
    const results = [];
    for (const [cmd, info] of this._botCommands) {
      const scope = info.scope === 'rooms' ? 'room' : info.scope === 'dms' ? 'dm' : (info.scope || 'both');
      if (scope !== 'both' && scope !== context) continue;
      if (query && !cmd.startsWith(query.toLowerCase())) continue;
      const entry = this._plugins.get(info.pluginId);
      if (!entry?.enabled) continue;
      results.push({ command: cmd, description: info.description, pluginId: info.pluginId, icon: info.icon || '🤖', scope });
    }
    return results;
  }

  /**
   * Dispatch a /command to its owning plugin.
   * @param {string} commandName  without leading /
   * @param {string} args         everything after the command
   * @param {object} ctx          { roomId?, channel?, dmPeerId?, authorId, authorName }
   */
  dispatchBotCommand(commandName, args, ctx) {
    const info = this._botCommands.get(commandName.toLowerCase());
    if (!info) return false;
    const entry = this._plugins.get(info.pluginId);
    if (!entry?.enabled) return false;
    // Enforce scope: ctx.dmPeerId present → dm context, else room context
    const context = ctx.dmPeerId ? 'dm' : 'room';
    const scope = info.scope === 'rooms' ? 'room' : info.scope === 'dms' ? 'dm' : (info.scope || 'both');
    if (scope !== 'both' && scope !== context) return false;
    this._send(entry.iframe, {
      dir: 'host→plugin', type: 'hook', event: 'bot:command',
      payload: { command: commandName, args, context: ctx },
    });
    return true;
  }

  // ─── TEARDOWN ─────────────────────────────────────────────────────────────
  destroy() {
    window.removeEventListener('message', this._onMessage);
    for (const [, entry] of this._plugins) {
      try { entry.iframe.remove(); } catch {}
    }
    this._plugins.clear();
  }
}
