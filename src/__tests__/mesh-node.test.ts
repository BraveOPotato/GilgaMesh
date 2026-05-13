// src/__tests__/mesh-node.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MeshNode } from '../network/mesh-node.js';
import { EventBus } from '../core/events.js';
import type { PeerId, RoomId } from '../core/types.js';

// ── Mocks ─────────────────────────────────────────────────────────────────────

function makePeerId(s: string): PeerId { return s as PeerId; }
function makeRoomId(s: string): RoomId { return s as RoomId; }

function makeRegistry(connectOk = true) {
  return {
    connect: vi.fn(async (peerId: PeerId) => {
      if (!connectOk) return { ok: false as const, error: 'connection_failed' as const };
      return { ok: true as const, value: makeConn(peerId) };
    }),
    get: vi.fn((_peerId: PeerId) => null),
    scoutConnect: vi.fn(),
    sendHandshake: vi.fn(),
    all: vi.fn(() => new Map()),
    handleIncoming: vi.fn(),
    handleIncomingFile: vi.fn(),
    startHeartbeat: vi.fn(),
    stopHeartbeat: vi.fn(),
    handlePong: vi.fn(),
    remove: vi.fn(),
  };
}

function makeConn(peerId: PeerId) {
  return {
    peerId,
    send:           vi.fn(() => true),
    dispose:        vi.fn(),
    isOpen:         vi.fn(() => true),
    isDisposed:     vi.fn(() => false),
    getAverageRtt:  vi.fn(() => 50),
    getScores:      vi.fn(() => []),
    getRooms:       vi.fn(() => new Set<string>()),
    addRoom:        vi.fn(),
    removeRoom:     vi.fn(),
    getLastSeen:    vi.fn(() => Date.now()),
    touchLastSeen:  vi.fn(),
    recordPong:     vi.fn(),
    getRawConn:     vi.fn(),
    connStart:      Date.now(),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('MeshNode', () => {
  let bus:      EventBus;
  let registry: ReturnType<typeof makeRegistry>;
  let node:     MeshNode;

  const roomId = makeRoomId('room-1');
  const myId   = makePeerId('me');
  const peerA  = makePeerId('peer-a');
  const peerB  = makePeerId('peer-b');

  beforeEach(() => {
    bus      = new EventBus();
    registry = makeRegistry();
    node     = new MeshNode(roomId, registry as never, bus, () => myId, () => 'Alice');
  });

  // ── Initial state ────────────────────────────────────────────────────────

  it('starts in orphan state', () => {
    expect(node.isOrphan()).toBe(true);
    expect(node.isRoot()).toBe(false);
    expect(node.isChild()).toBe(false);
    expect(node.getChildCount()).toBe(0);
    expect(node.getParentId()).toBeNull();
    expect(node.getDistanceFromRoot()).toBe(0);
  });

  // ── becomeRoot ───────────────────────────────────────────────────────────

  it('transitions to root state', () => {
    const emitted: string[] = [];
    bus.on('room:became-root', () => emitted.push('became-root'));

    const result = node.becomeRoot();
    expect(result.ok).toBe(true);
    expect(node.isRoot()).toBe(true);
    expect(node.isOrphan()).toBe(false);
    expect(emitted).toContain('became-root');
  });

  it('becomeRoot is idempotent — returns already_root on second call', () => {
    node.becomeRoot();
    const second = node.becomeRoot();
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toBe('already_root');
  });

  // ── joinParent ───────────────────────────────────────────────────────────

  it('cannot join parent when not in orphan state', async () => {
    node.becomeRoot();
    const result = await node.joinParent(peerA);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('not_orphan');
  });

  it('transitions to joining state when connect succeeds', async () => {
    const promise = node.joinParent(peerA);
    // Immediately after call, still resolving
    await promise;
    // After connect, node should be in joining state (awaiting adopt_ack)
    expect(node.isJoining()).toBe(true);
  });

  it('stays orphan when connect fails', async () => {
    const failRegistry = makeRegistry(false);
    const failNode = new MeshNode(roomId, failRegistry as never, bus, () => myId, () => 'Alice');
    const result = await failNode.joinParent(peerA);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe('connection_failed');
    expect(failNode.isOrphan()).toBe(true);
  });

  // ── onAdoptAck ───────────────────────────────────────────────────────────

  it('transitions to child after adopt ack', async () => {
    const joined: string[] = [];
    bus.on('room:joined', () => joined.push('joined'));

    await node.joinParent(peerA);
    node.onAdoptAck(peerA, 1, null, {}, [], 0);

    expect(node.isChild()).toBe(true);
    expect(node.getParentId()).toBe(peerA);
    expect(node.getDistanceFromRoot()).toBe(1);
    expect(joined).toHaveLength(1);
  });

  it('ignores adopt ack when not in joining state', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    node.onAdoptAck(peerA, 1, null, {}, [], 0);
    expect(node.isOrphan()).toBe(true);
    warn.mockRestore();
  });

  // ── onAdoptReject ────────────────────────────────────────────────────────

  it('returns to orphan on adopt reject', async () => {
    await node.joinParent(peerA);
    node.onAdoptReject('full');
    expect(node.isOrphan()).toBe(true);
    expect(node.isJoiningParent()).toBe(false);
  });

  // ── addChild ─────────────────────────────────────────────────────────────

  it('adds children up to SOFT_CHILD_LIMIT', () => {
    node.becomeRoot();
    for (let i = 0; i < 7; i++) {
      const conn   = makeConn(makePeerId(`child-${i}`));
      const result = node.addChild(conn as never);
      expect(result.ok).toBe(true);
    }
    expect(node.getChildCount()).toBe(7);
  });

  it('rejects child beyond SOFT_CHILD_LIMIT', () => {
    node.becomeRoot();
    for (let i = 0; i < 7; i++) {
      node.addChild(makeConn(makePeerId(`child-${i}`)) as never);
    }
    const overflow = node.addChild(makeConn(makePeerId('overflow')) as never);
    expect(overflow.ok).toBe(false);
    if (!overflow.ok) expect(overflow.error).toBe('full');
  });

  it('rejects duplicate child', () => {
    node.becomeRoot();
    const conn   = makeConn(peerA);
    node.addChild(conn as never);
    const dup    = node.addChild(conn as never);
    expect(dup.ok).toBe(false);
    if (!dup.ok) expect(dup.error).toBe('already_child');
  });

  // ── removeChild ──────────────────────────────────────────────────────────

  it('removes child', () => {
    node.becomeRoot();
    const conn = makeConn(peerA);
    node.addChild(conn as never);
    expect(node.getChildCount()).toBe(1);
    node.removeChild(peerA);
    expect(node.getChildCount()).toBe(0);
  });

  // ── onParentLost ─────────────────────────────────────────────────────────

  it('emits room:parent-lost and becomes orphan', async () => {
    const events: string[] = [];
    bus.on('room:parent-lost',      () => events.push('parent-lost'));
    bus.on('room:recovery-started', () => events.push('recovery-started'));

    await node.joinParent(peerA);
    node.onAdoptAck(peerA, 1, null, {}, [], 0);
    expect(node.isChild()).toBe(true);

    node.onParentLost(peerA);

    expect(node.isOrphan()).toBe(true);
    expect(events).toContain('parent-lost');
    expect(events).toContain('recovery-started');
  });

  it('ignores onParentLost when recovery is locked', async () => {
    await node.joinParent(peerA);
    node.onAdoptAck(peerA, 1, null, {}, [], 0);

    node.setRecoveryLock(Date.now() + 60_000); // lock for 60 s
    node.onParentLost(peerA);

    expect(node.isChild()).toBe(true); // still child — ignored
  });

  // ── dedup ────────────────────────────────────────────────────────────────

  it('deduplicates seen message IDs', () => {
    expect(node.hasSeen('msg-1')).toBe(false);
    node.markSeen('msg-1', 10);
    expect(node.hasSeen('msg-1')).toBe(true);
  });

  it('typing dedup', () => {
    expect(node.hasSeenTyping('tid-1')).toBe(false);
    node.markTypingSeen('tid-1');
    expect(node.hasSeenTyping('tid-1')).toBe(true);
  });

  // ── clusterMap / descendantCount ──────────────────────────────────────────

  it('descendant count is 1 when no children', () => {
    node.becomeRoot();
    expect(node.getDescendantCount()).toBe(1);
  });

  it('descendant count includes children', () => {
    node.becomeRoot();
    node.addChild(makeConn(peerA) as never);
    node.addChild(makeConn(peerB) as never);
    // Direct children: 1 + 1 + 1 (self) = 3
    expect(node.getDescendantCount()).toBe(3);
  });

  // ── dispose ───────────────────────────────────────────────────────────────

  it('dispose does not throw', async () => {
    await node.joinParent(peerA);
    expect(() => node.dispose()).not.toThrow();
  });
});
