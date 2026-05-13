// src/__tests__/files.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ShareManager } from '../files/share-manager.js';
import { EventBus } from '../core/events.js';
import type { PeerId } from '../core/types.js';

vi.mock('../core/state/identity.js', () => ({
  identityStore: {
    get: vi.fn(() => ({ myId: 'me' as PeerId, myName: 'Alice', peer: null, peerAliases: {}, currentTheme: 'dark' })),
  },
}));

vi.mock('../core/constants.js', () => ({
  FILE_LINK_TTL:       1000,
  STORAGE_KEY:         'test',
  MAX_CHILDREN:        5,
  SOFT_CHILD_LIMIT:    7,
  HARD_CHILD_LIMIT:    10,
  HEARTBEAT_INTERVAL:  1000,
  PING_TIMEOUT:        3000,
  CONN_TIMEOUT:        20000,
  ELECTION_INTERVAL:   300000,
  MSG_CACHE_SIZE:      10,
  SCORE_WINDOW:        10,
  RECONNECT_DELAY:     2000,
  RECOVERY_LOCK_MS:    2000,
  REBALANCE_INTERVAL:  30000,
  REBALANCE_THRESHOLD: 3,
}));

function makeFile(name: string, size = 100): File {
  return new File([new Uint8Array(size)], name, { type: 'text/plain' });
}

describe('ShareManager', () => {
  let bus:     EventBus;
  let manager: ShareManager;

  beforeEach(() => {
    bus     = new EventBus();
    manager = new ShareManager(bus);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it('createShare returns a FileShare with token', () => {
    const file  = makeFile('test.txt');
    const share = manager.createShare(file);
    expect(share.token).toBeTruthy();
    expect(share.filename).toBe('test.txt');
    expect(share.size).toBe(100);
    expect(share.fromId).toBe('me');
  });

  it('createShare emits file:share-created', () => {
    const events: string[] = [];
    bus.on('file:share-created', () => events.push('created'));
    manager.createShare(makeFile('doc.pdf'));
    expect(events).toContain('created');
  });

  it('getShare returns share before expiry', () => {
    const share = manager.createShare(makeFile('a.txt'));
    expect(manager.getShare(share.token)).not.toBeNull();
  });

  it('getShare returns null after expiry', () => {
    const share = manager.createShare(makeFile('a.txt'));
    vi.advanceTimersByTime(1500); // past 1000ms TTL
    expect(manager.getShare(share.token)).toBeNull();
  });

  it('file:share-expired emitted after TTL', () => {
    const events: string[] = [];
    bus.on('file:share-expired', () => events.push('expired'));
    manager.createShare(makeFile('b.txt'));
    vi.advanceTimersByTime(1500);
    expect(events).toContain('expired');
  });

  it('hasShare returns false for unknown token', () => {
    expect(manager.hasShare('nonexistent-token')).toBe(false);
  });

  it('buildShareUrl contains token and filename', () => {
    const share = manager.createShare(makeFile('img.png', 500));
    const url   = manager.buildShareUrl(share.token, share.filename, share.size);
    expect(url).toContain(share.token);
    expect(url).toContain('img.png');
    expect(url).toContain('500');
  });

  it('createShare with multiple files gives unique tokens', () => {
    const s1 = manager.createShare(makeFile('f1.txt'));
    const s2 = manager.createShare(makeFile('f2.txt'));
    expect(s1.token).not.toBe(s2.token);
  });
});
