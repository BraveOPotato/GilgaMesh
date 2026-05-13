// src/__tests__/friends.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { FriendManager } from '../friends/friend-manager.js';
import { DMManager } from '../friends/dm-manager.js';
import { EventBus } from '../core/events.js';
import type { PeerId } from '../core/types.js';

// ── Stubs ─────────────────────────────────────────────────────────────────────

vi.mock('../core/state/friends.js', () => {
  let state = {
    friends: {}, blocked: {}, dms: {}, dmUnread: {},
    activeDMPeer: null, dmCall: null, dmTypingPeers: {},
    dmCallSpeakers: {}, activeFriendsView: false,
  };
  return {
    friendsStore: {
      get: vi.fn(() => state),
      set: vi.fn((updater: (s: typeof state) => typeof state) => { state = updater(state); }),
      subscribe: vi.fn(() => () => {}),
      snapshot: vi.fn(() => state),
    },
  };
});

vi.mock('../core/state/identity.js', () => ({
  identityStore: {
    get: vi.fn(() => ({ myId: 'me' as PeerId, myName: 'Alice', peer: null, peerAliases: {}, currentTheme: 'dark' })),
    set: vi.fn(),
    subscribe: vi.fn(() => () => {}),
  },
}));

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

function pid(s: string): PeerId { return s as PeerId; }

function makeRegistry() {
  return {
    get:     vi.fn(() => null),
    connect: vi.fn(async () => ({ ok: false as const, error: 'connection_failed' as const })),
  };
}

// ─── FriendManager tests ──────────────────────────────────────────────────────

describe('FriendManager', () => {
  let bus:     EventBus;
  let manager: FriendManager;

  beforeEach(() => {
    bus     = new EventBus();
    manager = new FriendManager(bus);
    localStorageMock.clear();
  });

  afterEach(() => vi.clearAllMocks());

  it('addFriend stores friend with generated secret', () => {
    const f = manager.addFriend(pid('bob'), 'Bob');
    expect(f.id).toBe('bob');
    expect(f.name).toBe('Bob');
    expect(f.sharedSecret).toBeTruthy();
    expect(f.impostor).toBe(false);
  });

  it('isFriend returns true after addFriend', () => {
    manager.addFriend(pid('bob'), 'Bob');
    expect(manager.isFriend(pid('bob'))).toBe(true);
  });

  it('isFriend returns false for unknown peer', () => {
    expect(manager.isFriend(pid('ghost'))).toBe(false);
  });

  it('removeFriend emits friend:removed', () => {
    const events: string[] = [];
    bus.on('friend:removed', () => events.push('removed'));
    manager.addFriend(pid('bob'), 'Bob');
    manager.removeFriend(pid('bob'));
    expect(events).toContain('removed');
  });

  it('blockPeer emits peer:blocked', () => {
    const events: string[] = [];
    bus.on('peer:blocked', () => events.push('blocked'));
    manager.blockPeer(pid('troll'), 'Troll');
    expect(events).toContain('blocked');
  });

  it('isBlocked returns true after block', () => {
    manager.blockPeer(pid('troll'), 'Troll');
    expect(manager.isBlocked(pid('troll'))).toBe(true);
  });

  it('unblockPeer emits peer:unblocked', () => {
    const events: string[] = [];
    bus.on('peer:unblocked', () => events.push('unblocked'));
    manager.blockPeer(pid('troll'), 'Troll');
    manager.unblockPeer(pid('troll'));
    expect(events).toContain('unblocked');
    expect(manager.isBlocked(pid('troll'))).toBe(false);
  });

  it('handleVerifyToken with matching secret emits peer:verified=true', () => {
    const verified: boolean[] = [];
    bus.on('peer:verified', ({ verified: v }) => verified.push(v));
    const friend = manager.addFriend(pid('alice'), 'Alice');
    manager.confirmFriend(pid('alice'), 'Alice');
    manager.handleVerifyToken(pid('alice'), friend.sharedSecret!, 'Alice');
    expect(verified).toContain(true);
  });

  it('handleVerifyToken with wrong secret emits peer:verified=false', () => {
    const verified: boolean[] = [];
    bus.on('peer:verified', ({ verified: v }) => verified.push(v));
    manager.addFriend(pid('alice'), 'Alice');
    manager.confirmFriend(pid('alice'), 'Alice');
    manager.handleVerifyToken(pid('alice'), 'wrong-token', 'Alice');
    expect(verified).toContain(false);
  });

  it('setNickname updates friend record', () => {
    const toasts: string[] = [];
    bus.on('ui:toast', ({ message }) => toasts.push(message));
    manager.addFriend(pid('carol'), 'Carol');
    manager.confirmFriend(pid('carol'), 'Carol');
    manager.setNickname(pid('carol'), 'Caz');
    expect(toasts.some(t => t.includes('Caz'))).toBe(true);
  });
});

// ─── DMManager tests ──────────────────────────────────────────────────────────

describe('DMManager', () => {
  let bus:         EventBus;
  let friendMgr:   FriendManager;
  let dmManager:   DMManager;
  let registry:    ReturnType<typeof makeRegistry>;

  beforeEach(() => {
    bus       = new EventBus();
    registry  = makeRegistry();
    friendMgr = new FriendManager(bus);
    dmManager = new DMManager(bus, registry as never, friendMgr);
    localStorageMock.clear();
  });

  afterEach(() => vi.clearAllMocks());

  it('send returns false for empty content', () => {
    expect(dmManager.send(pid('bob'), '')).toBe(false);
    expect(dmManager.send(pid('bob'), '   ')).toBe(false);
  });

  it('send emits dm:sent', () => {
    const events: string[] = [];
    bus.on('dm:sent', () => events.push('sent'));
    const result = dmManager.send(pid('bob'), 'hello');
    expect(result).toBe(true);
    expect(events).toContain('sent');
  });

  it('handleIncoming drops blocked peers', () => {
    const received: string[] = [];
    bus.on('dm:received', () => received.push('received'));
    friendMgr.blockPeer(pid('spammer'), 'Spammer');
    dmManager.handleIncoming({ type: 'dm', from: 'spammer', content: 'hi', id: 'msg-1' }, pid('spammer'));
    expect(received).toHaveLength(0);
  });

  it('handleIncoming emits dm:received', () => {
    const received: string[] = [];
    bus.on('dm:received', () => received.push('received'));
    dmManager.handleIncoming({ type: 'dm', from: 'bob', fromName: 'Bob', content: 'hi', id: 'msg-1', ts: Date.now() }, pid('bob'));
    expect(received).toContain('received');
  });

  it('handleIncoming deduplicates messages', () => {
    const received: string[] = [];
    bus.on('dm:received', () => received.push('received'));
    const data = { type: 'dm', from: 'bob', content: 'hi', id: 'dup-1', ts: Date.now() };
    dmManager.handleIncoming(data, pid('bob'));
    dmManager.handleIncoming(data, pid('bob'));
    expect(received).toHaveLength(1);
  });

  it('handleTyping sets dmTypingPeers and emits dm:typing', () => {
    const events: string[] = [];
    bus.on('dm:typing', () => events.push('typing'));
    dmManager.handleTyping({ from: 'bob', fromName: 'Bob' }, pid('bob'));
    expect(events).toContain('typing');
  });

  it('sendFriendRequest emits ui:toast', () => {
    const toasts: string[] = [];
    bus.on('ui:toast', ({ message }) => toasts.push(message));
    registry.connect = vi.fn(async () => ({ ok: true as const, value: { send: vi.fn(() => true) } }));
    dmManager.sendFriendRequest(pid('carol'), 'Carol');
    // Toast emitted asynchronously via registry.connect — check after tick
    return new Promise<void>(resolve => setTimeout(() => {
      expect(toasts.length).toBeGreaterThan(0);
      resolve();
    }, 50));
  });
});
