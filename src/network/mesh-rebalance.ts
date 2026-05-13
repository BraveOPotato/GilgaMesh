/**
 * src/network/mesh-rebalance.ts — Background rebalancing.
 *
 * Every REBALANCE_INTERVAL ms: if |myDescendants - peer's| > REBALANCE_THRESHOLD
 * and no lock is active, apply the deterministic priority rule to move nodes
 * toward a balanced tree.
 */

import { REBALANCE_INTERVAL, REBALANCE_THRESHOLD, RECOVERY_LOCK_MS, SOFT_CHILD_LIMIT } from '../core/constants.js';
import type { PeerId, RoomId } from '../core/events.js';
import type { MeshNode } from './mesh-node.js';
import type { PeerRegistry } from './peer-registry.js';
import { identityStore } from '../core/state/identity.js';

export class Rebalancer {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly node:     MeshNode,
    private readonly roomId:   RoomId,
    private readonly registry: PeerRegistry,
  ) {}

  start(): void {
    this.stop();
    this.timer = setInterval(() => this.doRebalance(), REBALANCE_INTERVAL);
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  private doRebalance(): void {
    const node = this.node;
    if (node.isRecoveryLocked()) return;

    const myId  = identityStore.get().myId ?? ('' as PeerId);
    const myDC  = node.getDescendantCount();
    const map   = node.getClusterMap();
    const descendants = new Set(node.getChildren().keys());

    const candidates = Object.entries(map)
      .filter(([pid, e]) =>
        pid !== myId &&
        !descendants.has(pid as PeerId) &&
        e.descendantCount !== undefined &&
        Math.abs((e.descendantCount ?? 0) - myDC) > REBALANCE_THRESHOLD,
      )
      .sort(([, a], [, b]) =>
        Math.abs((b.descendantCount ?? 0) - myDC) - Math.abs((a.descendantCount ?? 0) - myDC),
      );

    if (!candidates.length) return;

    const [bestPid, bestEntry] = candidates[0]!;
    const targetDC = bestEntry.descendantCount ?? 0;

    node.setRecoveryLock(Date.now() + RECOVERY_LOCK_MS);

    if (this.priorityHigherThan(targetDC, bestPid as PeerId, myDC, myId)) {
      this.registry.connect(bestPid as PeerId).then(result => {
        if (!result.ok) { node.setRecoveryLock(0); return; }
        result.value.send({
          type:          'adopt_request',
          roomId:        this.roomId,
          id:            myId,
          name:          identityStore.get().myName,
          voiceChannelId: null,
        });
      });
    } else {
      const existing = this.registry.get(bestPid as PeerId);
      if (existing) {
        existing.send({ type: 'connect_to_me', roomId: this.roomId, id: myId, name: identityStore.get().myName });
      }
    }
  }

  private priorityHigherThan(aDC: number, aId: PeerId, bDC: number, bId: PeerId): boolean {
    if (aDC !== bDC) return aDC > bDC;
    return aId > bId;
  }
}
