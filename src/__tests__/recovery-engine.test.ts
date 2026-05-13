// src/__tests__/recovery-engine.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RecoveryEngine } from '../network/mesh-recovery.js';
import { EventBus } from '../core/events.js';
import type { PeerId, RoomId } from '../core/types.js';

function pid(s: string): PeerId { return s as PeerId; }
function rid(s: string): RoomId { return s as RoomId; }

function makeNode(overrides: Partial<{
  isChild:           boolean;
  childCount:        number;
  grandparentId:     PeerId | null;
  clusterMapPeers:   string[];
  descendantCount:   number;
  isRecoveryLocked:  boolean;
}> = {}) {
  const children = new Map<PeerId, unknown>();
  for (let i = 0; i < (overrides.childCount ?? 0); i++) {
    children.set(pid(`child-${i}`), {});
  }

  return {
    roomId:            rid('room-1'),
    isOrphan:          vi.fn(() => !overrides.isChild && !overrides.childCount),
    isChild:           vi.fn(() => overrides.isChild ?? false),
    isRoot:            vi.fn(() => false),
    getChildren:       vi.fn(() => children),
    getParentId:       vi.fn(() => overrides.isChild ? pid('parent') : null),
    getGrandparentId:  vi.fn(() => overrides.grandparentId ?? null),
    getDescendantCount: vi.fn(() => overrides.descendantCount ?? 1),
    getClusterMap:     vi.fn(() => {
      const map: Record<string, { descendantCount: number }> = {};
      for (const p of (overrides.clusterMapPeers ?? [])) {
        map[p] = { descendantCount: 2 };
      }
      return map;
    }),
    isRecoveryLocked:  vi.fn(() => overrides.isRecoveryLocked ?? false),
    setRecoveryLock:   vi.fn(),
    becomeRoot:        vi.fn(),
    getSiblings:       vi.fn(() => []),
  };
}

function makeRegistry(connectOk = true, existingConn: unknown = null) {
  const fakeConn = {
    send:    vi.fn(() => true),
    dispose: vi.fn(),
    peerId:  pid('target'),
  };
  return {
    get:     vi.fn((_id: PeerId) => existingConn),
    connect: vi.fn(async (_id: PeerId) =>
      connectOk
        ? { ok: true  as const, value: fakeConn }
        : { ok: false as const, error: 'connection_failed' as const },
    ),
  };
}

describe('RecoveryEngine', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('calls becomeRoot when no candidates exist', async () => {
    const node     = makeNode({ clusterMapPeers: [] });
    const registry = makeRegistry();
    const engine   = new RecoveryEngine(node as never, bus, registry as never);

    engine.start();
    await new Promise(r => setTimeout(r, 1600)); // wait for 1500ms delay

    expect(node.becomeRoot).toHaveBeenCalled();
  });

  it('cancel() stops the engine before it decides', async () => {
    const node     = makeNode({ clusterMapPeers: ['peer-a'] });
    const registry = makeRegistry();
    const engine   = new RecoveryEngine(node as never, bus, registry as never);

    engine.start();
    engine.cancel();
    await new Promise(r => setTimeout(r, 1600));

    expect(node.becomeRoot).not.toHaveBeenCalled();
  });

  it('handleDescendantCountResponse triggers decide when all respond', async () => {
    const node     = makeNode({ clusterMapPeers: ['peer-a'], descendantCount: 1 });
    const registry = makeRegistry();
    const engine   = new RecoveryEngine(node as never, bus, registry as never);

    engine.start();
    await new Promise(r => setTimeout(r, 1600)); // past initial delay

    // Simulate response — high DC so peer wins and we should try to attach
    engine.handleDescendantCountResponse(pid('peer-a'), 5);

    await new Promise(r => setTimeout(r, 50));
    // With peer-a DC=5 > ours=1, we should try to connect to it (not becomeRoot)
    expect(node.becomeRoot).not.toHaveBeenCalled();
    expect(registry.connect).toHaveBeenCalled();
  });

  it('becomes root when peer has lower DC than us', async () => {
    const node     = makeNode({ clusterMapPeers: ['peer-a'], descendantCount: 10 });
    const registry = makeRegistry();
    const engine   = new RecoveryEngine(node as never, bus, registry as never);

    engine.start();
    await new Promise(r => setTimeout(r, 1600));

    // peer-a DC=1 < ours=10 — we win, becomeRoot
    engine.handleDescendantCountResponse(pid('peer-a'), 1);
    await new Promise(r => setTimeout(r, 50));

    expect(node.becomeRoot).toHaveBeenCalled();
  });

  it('uses existing connection for grandparent fast-path', async () => {
    const gpConn  = { send: vi.fn(() => true) };
    const node    = makeNode({ grandparentId: pid('grandparent') });
    const registry = makeRegistry(true, gpConn);

    const engine = new RecoveryEngine(node as never, bus, registry as never);
    engine.start();
    await new Promise(r => setTimeout(r, 50));

    expect(registry.connect).toHaveBeenCalledWith(pid('grandparent'));
  });
});
