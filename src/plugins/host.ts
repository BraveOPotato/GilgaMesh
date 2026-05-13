/**
 * src/plugins/host.ts — PluginHost: orchestrates the plugin lifecycle.
 *
 * Responsibilities:
 *  - Load plugins from dist config at boot.
 *  - Hot-install / hot-remove at runtime.
 *  - Broker postMessage between sandboxes and the app.
 *  - Enforce permissions on every API call.
 *  - Maintain bot command registry.
 *  - Emit domain bus events for install/remove/enable/disable.
 *
 * Does NOT touch DOM except via IframeSandbox.
 * Does NOT import from ui/ — UI reacts to bus events.
 */

import type { EventBus, PluginId } from '../core/events.js';
import type { Result } from '../core/types.js';
import { ok, err } from '../core/types.js';
import { IframeSandbox } from './sandbox/iframe-sandbox.js';
import { PermissionEngine } from './permissions/engine.js';
import { fetchPluginPackage } from './marketplace/client.js';
import type { PluginManifest, PluginEntry, BotCommandRegistration, ApiHandler, DistConfig } from './types.js';
import { pluginsStore } from '../core/state/plugins.js';
import { roomsStore } from '../core/state/rooms.js';
import { friendsStore } from '../core/state/friends.js';

export type InstallError = 'already_installed' | 'fetch_failed' | 'invalid_manifest';
export type RemoveError  = 'not_found' | 'not_removable';

export interface PluginInfo {
  readonly id:        PluginId;
  readonly manifest:  PluginManifest;
  readonly removable: boolean;
  readonly enabled:   boolean;
  readonly baseUrl:   string | null;
}

export interface BotCommandResult {
  readonly command:     string;
  readonly description: string;
  readonly pluginId:    PluginId;
  readonly icon:        string;
  readonly scope:       'room' | 'dm' | 'both';
}

export interface BotCommandContext {
  readonly roomId?:     string;
  readonly channel?:    string;
  readonly dmPeerId?:   string;
  readonly authorId:    string;
  readonly authorName:  string;
}

// ─────────────────────────────────────────────────────────────────────────────

export class PluginHost {
  private sandboxes   = new Map<PluginId, IframeSandbox>();
  private manifests   = new Map<PluginId, PluginManifest>();
  private enabledMap  = new Map<PluginId, boolean>();
  private stores      = new Map<PluginId, Record<string, unknown>>();
  private removableMap = new Map<PluginId, boolean>();
  private sources     = new Map<PluginId, string>();
  private baseUrls    = new Map<PluginId, string | null>();
  private permsMap    = new Map<PluginId, ReadonlySet<string>>();

  private botCommands = new Map<string, BotCommandRegistration>();
  private apiHandlers = new Map<string, ApiHandler>();
  private permEngine  = new PermissionEngine();
  private msgHandler: (e: MessageEvent) => void;

  /** Callback for UI to refresh autocomplete when bot commands change. */
  onBotRegistered?: () => void;

  constructor(private readonly bus: EventBus) {
    this.msgHandler = this.handleMessage.bind(this);
    this.registerBuiltinHandlers();
  }

  // ── Bootstrap ─────────────────────────────────────────────────────────────

  async init(distConfig: DistConfig): Promise<void> {
    window.addEventListener('message', this.msgHandler);

    for (const entry of distConfig.plugins) {
      try {
        await this.loadBuiltin(entry.id as PluginId, entry.removable ?? true);
      } catch (e) {
        console.warn(`[PluginHost] Failed to load "${entry.id}":`, e);
      }
    }

    console.log(`[PluginHost] "${distConfig.name}" — ${this.sandboxes.size} plugin(s) loaded.`);
    this.emitToAll('app:boot', {});
  }

  private async loadBuiltin(pluginId: PluginId, removable: boolean): Promise<void> {
    const baseUrl = `./plugins/builtin/${pluginId}`;
    const { manifest, source } = await fetchPluginPackage(baseUrl);
    await this.install(manifest as PluginManifest, source, removable, baseUrl);
  }

  // ── Install ───────────────────────────────────────────────────────────────

  async install(
    rawManifest: PluginManifest,
    source:      string,
    removable    = true,
    baseUrl:     string | null = null,
  ): Promise<Result<void, InstallError>> {
    const pluginId = rawManifest.id;
    if (this.sandboxes.has(pluginId)) return err('already_installed');

    const { permissions, warnings } = this.permEngine.validateManifest(rawManifest);
    warnings.forEach(w => console.warn(`[PluginHost:${pluginId}] ${w}`));

    const manifest: PluginManifest = { ...rawManifest, permissions };

    // Restore persisted isolated store.
    let store: Record<string, unknown> = {};
    try {
      const raw = localStorage.getItem(`gilgamesh_plugin_${pluginId}`);
      store = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {}

    const sandbox = new IframeSandbox(pluginId);
    await sandbox.load(manifest, source);

    this.sandboxes.set(pluginId, sandbox);
    this.manifests.set(pluginId, manifest);
    this.enabledMap.set(pluginId, true);
    this.stores.set(pluginId, store);
    this.removableMap.set(pluginId, removable);
    this.sources.set(pluginId, source);
    this.baseUrls.set(pluginId, baseUrl);
    this.permsMap.set(pluginId, new Set(permissions));

    pluginsStore.set(prev => ({
      ...prev,
      plugins: {
        ...prev.plugins,
        [pluginId]: { id: pluginId, manifest, enabled: true, removable, store: {} },
      },
    }));

    this.bus.emit('plugin:installed', { pluginId, manifest });
    console.log(`[PluginHost] Loaded "${pluginId}" v${manifest.version}`);
    return ok(undefined);
  }

  async installFromUrl(baseUrl: string): Promise<Result<void, InstallError>> {
    let pkg: { manifest: unknown; source: string };
    try {
      pkg = await fetchPluginPackage(baseUrl);
    } catch {
      return err('fetch_failed');
    }
    if (!isManifest(pkg.manifest)) return err('invalid_manifest');
    return this.install(pkg.manifest, pkg.source, true, baseUrl);
  }

  // ── Remove ────────────────────────────────────────────────────────────────

  remove(pluginId: PluginId): Result<void, RemoveError> {
    if (!this.sandboxes.has(pluginId)) return err('not_found');
    if (!this.removableMap.get(pluginId)) return err('not_removable');

    this.sandboxes.get(pluginId)!.destroy();
    this.unregisterPlugin(pluginId);

    pluginsStore.set(prev => {
      const plugins = { ...prev.plugins };
      delete (plugins as Record<string, unknown>)[pluginId];
      return { ...prev, plugins };
    });

    this.bus.emit('plugin:removed', { pluginId });
    return ok(undefined);
  }

  // ── Enable / disable ──────────────────────────────────────────────────────

  enable(pluginId: PluginId): void {
    if (!this.sandboxes.has(pluginId)) return;
    this.enabledMap.set(pluginId, true);
    this.sandboxes.get(pluginId)!.send({ dir: 'host→plugin', type: 'hook', event: 'plugin:enabled', payload: {} });
    pluginsStore.set(prev => setEnabled(prev, pluginId, true));
    this.bus.emit('plugin:enabled', { pluginId });
  }

  disable(pluginId: PluginId): void {
    if (!this.sandboxes.has(pluginId)) return;
    this.enabledMap.set(pluginId, false);
    this.sandboxes.get(pluginId)!.send({ dir: 'host→plugin', type: 'hook', event: 'plugin:disabled', payload: {} });
    pluginsStore.set(prev => setEnabled(prev, pluginId, false));
    this.bus.emit('plugin:disabled', { pluginId });
  }

  // ── Bot commands ──────────────────────────────────────────────────────────

  getBotCommands(context: 'room' | 'dm' = 'room', query = ''): readonly BotCommandResult[] {
    const results: BotCommandResult[] = [];
    for (const [cmd, info] of this.botCommands) {
      if (info.scope !== 'both' && info.scope !== context) continue;
      if (query && !cmd.startsWith(query.toLowerCase())) continue;
      if (!this.enabledMap.get(info.pluginId)) continue;
      results.push({ command: cmd, description: info.description, pluginId: info.pluginId, icon: info.icon, scope: info.scope });
    }
    return results;
  }

  dispatchBotCommand(name: string, args: string, ctx: BotCommandContext): boolean {
    const info = this.botCommands.get(name.toLowerCase());
    if (!info || !this.enabledMap.get(info.pluginId)) return false;

    const context = ctx.dmPeerId ? 'dm' : 'room';
    if (info.scope !== 'both' && info.scope !== context) return false;

    this.sandboxes.get(info.pluginId)?.send({
      dir: 'host→plugin', type: 'hook', event: 'bot:command',
      payload: { command: name, args, context: ctx },
    });
    this.bus.emit('plugin:command', { pluginId: info.pluginId, command: name, args, context: ctx as never });
    return true;
  }

  emitToAll(event: string, payload: unknown): void {
    for (const [pid, sandbox] of this.sandboxes) {
      if (!this.enabledMap.get(pid)) continue;
      sandbox.send({ dir: 'host→plugin', type: 'hook', event, payload });
    }
  }

  getPluginList(): readonly PluginInfo[] {
    return Array.from(this.sandboxes.keys()).map(pid => ({
      id:        pid,
      manifest:  this.manifests.get(pid)!,
      removable: this.removableMap.get(pid) ?? true,
      enabled:   this.enabledMap.get(pid)   ?? true,
      baseUrl:   this.baseUrls.get(pid)     ?? null,
    }));
  }

  destroy(): void {
    window.removeEventListener('message', this.msgHandler);
    for (const sandbox of this.sandboxes.values()) sandbox.destroy();
    this.sandboxes.clear();
  }

  // ── Message handling ──────────────────────────────────────────────────────

  private handleMessage(event: MessageEvent): void {
    const msg = event.data as Record<string, unknown>;
    if (!msg || msg['dir'] !== 'plugin→host') return;

    const pluginId = msg['pluginId'] as PluginId;
    const type     = msg['type'] as string;
    const sandbox  = this.sandboxes.get(pluginId);

    if (!sandbox || !this.enabledMap.get(pluginId)) return;
    if (!sandbox.isSource(event.source)) {
      console.warn(`[PluginHost] Source mismatch for "${pluginId}" — dropped.`);
      return;
    }

    switch (type) {
      case 'api':   void this.handleApi(pluginId, msg); break;
      case 'emit':  this.handlePluginEmit(pluginId, msg); break;
      case 'ready': console.log(`[PluginHost] "${pluginId}" ready.`); break;
      default: console.warn(`[PluginHost] Unknown msg type "${type}" from "${pluginId}"`);
    }
  }

  private async handleApi(pluginId: PluginId, msg: Record<string, unknown>): Promise<void> {
    const { method, args, reqId } = msg as { method: string; args: Record<string, unknown>; reqId: string };
    const respond = (result: unknown, error: string | null = null) =>
      this.sandboxes.get(pluginId)?.send({ dir: 'host→plugin', type: 'api:response', reqId, result, error });

    const handler = this.apiHandlers.get(method);
    if (!handler) { respond(null, `Unknown method "${method}"`); return; }

    try {
      const perms  = this.permsMap.get(pluginId) ?? new Set<string>();
      const entry  = this.buildEntry(pluginId);
      const result = await handler({ args, permissions: perms, pluginId, entry });
      respond(result);
    } catch (e) {
      respond(null, e instanceof Error ? e.message : String(e));
    }
  }

  private handlePluginEmit(fromId: PluginId, msg: Record<string, unknown>): void {
    const { event, payload } = msg as { event: string; payload: unknown };
    for (const [pid, sandbox] of this.sandboxes) {
      if (pid === fromId || !this.enabledMap.get(pid)) continue;
      sandbox.send({ dir: 'host→plugin', type: 'hook', event, payload });
    }
  }

  // ── API handlers ──────────────────────────────────────────────────────────

  private registerBuiltinHandlers(): void {
    const h  = (name: string, fn: ApiHandler) => this.apiHandlers.set(name, fn);
    const pe = this.permEngine;

    h('fetch', async ({ args, permissions }) => {
      pe.check(permissions, 'network');
      const res  = await fetch(String(args['url'] ?? ''), (args['options'] ?? {}) as RequestInit);
      const text = await res.text();
      return { ok: res.ok, status: res.status, body: text };
    });

    h('notify', async ({ args, permissions }) => {
      pe.check(permissions, 'notifications');
      const title = String(args['title'] ?? 'GilgaMesh');
      const body  = String(args['body']  ?? '');
      if (Notification.permission === 'granted') {
        new Notification(title, { body });
      } else if (Notification.permission !== 'denied') {
        const perm = await Notification.requestPermission();
        if (perm === 'granted') new Notification(title, { body });
      }
      return { sent: true };
    });

    h('isPeerOnline', async ({ args }) => {
      const peerId = String(args['peerId'] ?? '');
      const { rooms } = roomsStore.get();
      const online = Object.values(rooms).some(r => Boolean(r.peers[peerId]));
      return { online };
    });

    h('dm.getHistory', async ({ args, permissions }) => {
      pe.check(permissions, 'dm:read');
      const peerId = String(args['peerId'] ?? '');
      return friendsStore.get().dms[peerId]?.messages ?? [];
    });

    h('dm.send', async ({ args, permissions }) => {
      pe.check(permissions, 'dm:write');
      this.bus.emit('ui:dm-send-requested', { peerId: args['peerId'] as never, content: String(args['content'] ?? '') });
      return { sent: true };
    });

    h('room.getHistory', async ({ args, permissions }) => {
      pe.check(permissions, 'room:read');
      const roomId  = String(args['roomId']  ?? '');
      const channel = String(args['channel'] ?? 'general');
      return roomsStore.get().rooms[roomId as never]?.messages[channel as never] ?? [];
    });

    h('room.send', async ({ args, permissions }) => {
      pe.check(permissions, 'room:write');
      this.bus.emit('ui:message-send-requested', { roomId: args['roomId'] as never, channel: args['channel'] as never, content: String(args['content'] ?? '') });
      return { sent: true };
    });

    h('storage.get', async ({ args, permissions, pluginId }) => {
      pe.check(permissions, 'storage:read');
      return { value: (this.stores.get(pluginId) ?? {})[String(args['key'])] ?? null };
    });

    h('storage.set', async ({ args, permissions, pluginId }) => {
      pe.check(permissions, 'storage:write');
      const store = this.stores.get(pluginId) ?? {};
      store[String(args['key'])] = args['value'];
      this.stores.set(pluginId, store);
      try { localStorage.setItem(`gilgamesh_plugin_${pluginId}`, JSON.stringify(store)); } catch {}
      return { ok: true };
    });

    h('storage.delete', async ({ args, permissions, pluginId }) => {
      pe.check(permissions, 'storage:write');
      const store = this.stores.get(pluginId) ?? {};
      delete store[String(args['key'])];
      this.stores.set(pluginId, store);
      try { localStorage.setItem(`gilgamesh_plugin_${pluginId}`, JSON.stringify(store)); } catch {}
      return { ok: true };
    });

    h('ui.addButton', async ({ args, permissions, pluginId }) => {
      pe.check(permissions, 'ui:inject');
      this.injectButton(pluginId, args);
      return { injected: true };
    });

    h('bot.register', async ({ args, permissions, pluginId }) => {
      pe.check(permissions, 'bot:command');
      const cmd   = String(args['command'] ?? '').toLowerCase().replace(/^\/+/, '');
      const rawSc = String(args['scope'] ?? 'both');
      const scope = rawSc === 'rooms' ? 'room' : rawSc === 'dms' ? 'dm' : rawSc as 'room' | 'dm' | 'both';
      if (!cmd) throw new Error('bot.register: command required');
      const icon = String(args['icon'] ?? '🤖');
      const desc = String(args['description'] ?? '');
      this.botCommands.set(cmd, { pluginId, description: desc, scope, icon });
      pluginsStore.set(prev => ({
        ...prev,
        botCommands: { ...prev.botCommands, [cmd]: { def: { command: cmd, description: desc, scope, icon }, pluginId } },
      }));
      this.onBotRegistered?.();
      return { registered: true, command: cmd };
    });

    h('bot.respond', async ({ args, permissions }) => {
      pe.check(permissions, 'bot:command');
      const ctx = (args['context'] ?? {}) as Record<string, unknown>;
      if (ctx['roomId']) {
        this.bus.emit('ui:message-send-requested', { roomId: ctx['roomId'] as never, channel: (ctx['channel'] ?? 'general') as never, content: String(args['content'] ?? '') });
      } else if (ctx['dmPeerId']) {
        this.bus.emit('ui:dm-send-requested', { peerId: ctx['dmPeerId'] as never, content: String(args['content'] ?? '') });
      }
      return { sent: true };
    });
  }

  private injectButton(pluginId: PluginId, args: Record<string, unknown>): void {
    const area = String(args['targetArea'] ?? 'header-right');
    const ev   = String(args['eventName']  ?? 'plugin:button');
    const el   = document.getElementById(area);
    if (!el) return;

    const btnId = `plugin-btn-${pluginId}-${ev}`;
    if (document.getElementById(btnId)) return;

    const btn = document.createElement('button');
    btn.id          = btnId;
    btn.className   = 'icon-btn';
    btn.title       = String(args['label'] ?? pluginId);
    btn.textContent = String(args['icon']  ?? '🔌');
    btn.addEventListener('click', () =>
      this.sandboxes.get(pluginId)?.send({ dir: 'host→plugin', type: 'hook', event: ev, payload: {} })
    );
    el.appendChild(btn);
  }

  private unregisterPlugin(pluginId: PluginId): void {
    this.sandboxes.delete(pluginId);
    this.manifests.delete(pluginId);
    this.enabledMap.delete(pluginId);
    this.stores.delete(pluginId);
    this.removableMap.delete(pluginId);
    this.sources.delete(pluginId);
    this.baseUrls.delete(pluginId);
    this.permsMap.delete(pluginId);
    for (const [cmd, info] of this.botCommands) {
      if (info.pluginId === pluginId) this.botCommands.delete(cmd);
    }
  }

  private buildEntry(pluginId: PluginId): PluginEntry {
    return {
      manifest:  this.manifests.get(pluginId)!,
      iframe:    this.sandboxes.get(pluginId)!.getIframe()!,
      removable: this.removableMap.get(pluginId) ?? true,
      enabled:   this.enabledMap.get(pluginId)   ?? true,
      store:     this.stores.get(pluginId)        ?? {},
      baseUrl:   this.baseUrls.get(pluginId)      ?? null,
      source:    this.sources.get(pluginId)       ?? '',
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setEnabled(
  prev: import('../core/state/plugins.js').PluginsState,
  pluginId: PluginId,
  enabled: boolean,
): import('../core/state/plugins.js').PluginsState {
  const existing = prev.plugins[pluginId];
  if (!existing) return prev;
  return { ...prev, plugins: { ...prev.plugins, [pluginId]: { ...existing, enabled } } };
}

function isManifest(v: unknown): v is PluginManifest {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return typeof m['id'] === 'string' && typeof m['name'] === 'string' && typeof m['version'] === 'string';
}
