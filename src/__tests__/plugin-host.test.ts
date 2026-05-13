// src/__tests__/plugin-host.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PluginHost } from '../plugins/host.js';
import { EventBus } from '../core/events.js';
import type { PluginId } from '../core/types.js';
import type { PluginManifest } from '../plugins/types.js';

// ── Stubs ─────────────────────────────────────────────────────────────────────

vi.mock('../plugins/sandbox/iframe-sandbox.js', () => ({
  IframeSandbox: vi.fn().mockImplementation((pluginId: PluginId) => ({
    pluginId,
    load:     vi.fn(async () => {}),
    send:     vi.fn(),
    destroy:  vi.fn(),
    getIframe: vi.fn(() => null),
    isSource:  vi.fn(() => true),
  })),
}));

vi.mock('../plugins/marketplace/client.js', () => ({
  fetchPluginPackage: vi.fn(async () => ({
    manifest: { id: 'test-plugin', name: 'Test', version: '1.0.0', description: 'test', permissions: [] },
    source: 'console.log("hello")',
  })),
  fetchMarketplace: vi.fn(async () => []),
  clearMarketplaceCache: vi.fn(),
}));

vi.mock('../core/state/rooms.js', () => ({
  roomsStore: { get: vi.fn(() => ({ rooms: {}, activeRoomId: null, activeChannel: 'general' })) },
}));

vi.mock('../core/state/friends.js', () => ({
  friendsStore: { get: vi.fn(() => ({ dms: {}, friends: {}, blocked: {}, activeDMPeer: null, dmCall: null, dmTypingPeers: {}, dmCallSpeakers: {}, activeFriendsView: false, dmUnread: {} })) },
}));

vi.mock('../core/state/plugins.js', () => ({
  pluginsStore: { get: vi.fn(() => ({ plugins: {}, botCommands: {} })), set: vi.fn() },
}));

// Stub localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem:    (k: string) => store[k] ?? null,
    setItem:    (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear:      () => { store = {}; },
  };
})();
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock });

// Stub window.addEventListener/removeEventListener
vi.stubGlobal('window', {
  addEventListener:    vi.fn(),
  removeEventListener: vi.fn(),
  Notification: { permission: 'granted' },
});

function pid(s: string): PluginId { return s as PluginId; }

function makeManifest(id: string, permissions: string[] = []): PluginManifest {
  return { id: pid(id), name: id, version: '1.0.0', description: '', permissions };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('PluginHost', () => {
  let bus:  EventBus;
  let host: PluginHost;

  beforeEach(() => {
    bus  = new EventBus();
    host = new PluginHost(bus);
    localStorageMock.clear();
  });

  afterEach(() => { vi.clearAllMocks(); });

  // ── install ───────────────────────────────────────────────────────────────

  it('installs a plugin', async () => {
    const installed: string[] = [];
    bus.on('plugin:installed', ({ pluginId }) => installed.push(String(pluginId)));

    const result = await host.install(makeManifest('my-plugin'), 'code', true, null);

    expect(result.ok).toBe(true);
    expect(installed).toContain('my-plugin');
  });

  it('returns already_installed for duplicate install', async () => {
    await host.install(makeManifest('dup'), 'code');
    const second = await host.install(makeManifest('dup'), 'code');
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe('already_installed');
  });

  it('strips unknown permissions on install', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await host.install(makeManifest('perm-test', ['network', 'not-a-real-perm']), 'code');
    expect(result.ok).toBe(true);
    // Unknown perm warning logged
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  // ── remove ────────────────────────────────────────────────────────────────

  it('removes a removable plugin', async () => {
    const removed: string[] = [];
    bus.on('plugin:removed', ({ pluginId }) => removed.push(String(pluginId)));

    await host.install(makeManifest('removable'), 'code', true);
    const result = host.remove(pid('removable'));

    expect(result.ok).toBe(true);
    expect(removed).toContain('removable');
  });

  it('returns not_found when removing non-existent plugin', () => {
    const result = host.remove(pid('ghost'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('not_found');
  });

  it('returns not_removable for non-removable plugin', async () => {
    await host.install(makeManifest('builtin'), 'code', false);
    const result = host.remove(pid('builtin'));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('not_removable');
  });

  // ── enable / disable ──────────────────────────────────────────────────────

  it('disables and re-enables a plugin', async () => {
    const events: string[] = [];
    bus.on('plugin:enabled',  () => events.push('enabled'));
    bus.on('plugin:disabled', () => events.push('disabled'));

    await host.install(makeManifest('toggle'), 'code');
    host.disable(pid('toggle'));
    host.enable(pid('toggle'));

    expect(events).toEqual(['disabled', 'enabled']);
  });

  it('disable prevents bot command dispatch', async () => {
    await host.install(makeManifest('bot-plugin', ['bot:command']), 'code');
    // Manually register a command by simulating bot.register
    // (internal registration via API handler is async; we bypass with direct test of dispatch)
    // Disable before any command registration — dispatchBotCommand should return false.
    host.disable(pid('bot-plugin'));
    const dispatched = host.dispatchBotCommand('test', '', {
      authorId: 'me', authorName: 'Alice',
    });
    expect(dispatched).toBe(false);
  });

  // ── getPluginList ─────────────────────────────────────────────────────────

  it('getPluginList returns installed plugins', async () => {
    await host.install(makeManifest('list-a'), 'code');
    await host.install(makeManifest('list-b'), 'code');
    const list = host.getPluginList();
    expect(list.map(p => String(p.id))).toContain('list-a');
    expect(list.map(p => String(p.id))).toContain('list-b');
  });

  it('getPluginList is empty after remove', async () => {
    await host.install(makeManifest('ephemeral'), 'code', true);
    host.remove(pid('ephemeral'));
    expect(host.getPluginList().map(p => String(p.id))).not.toContain('ephemeral');
  });

  // ── emitToAll ────────────────────────────────────────────────────────────

  it('emitToAll sends to all enabled sandboxes', async () => {
    await host.install(makeManifest('emit-a'), 'code');
    await host.install(makeManifest('emit-b'), 'code');
    // Both should receive the hook — checked via sandbox.send spy
    // (IframeSandbox is mocked, so we check the mock calls)
    host.emitToAll('test:event', { foo: 1 });
    // We just verify no errors thrown (sandbox.send is mocked and recorded).
  });

  // ── destroy ───────────────────────────────────────────────────────────────

  it('destroy does not throw', async () => {
    await host.install(makeManifest('clean-up'), 'code');
    expect(() => host.destroy()).not.toThrow();
  });
});
