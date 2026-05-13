/**
 * src/network/mesh-recovery.ts — Recovery engine for parent loss events.
 *
 * Strategy (mirrors mesh.js recoverProcedure):
 *  1. Try grandparent directly (fastest path).
 *  2. Query up to 5 known non-descendant peers for descendant counts.
 *  3. After 5 s (or all replied): pick winner by (descendantCount, nodeId).
 *     - winner > us  → attach upward (adopt_request)
 *     - us > winner  → pull winner down (connect_to_me), becomeRoot
 *  4. Recovery lock prevents oscillation after decision.
 */

import { RECONNECT_DELAY, RECOVERY_LOCK_MS } from '../core/constants.js';
import type { EventBus, PeerId, RoomId } from '../core/events.js';
import type { MeshNode } from './mesh-node.js';
import type { PeerRegistry } from './peer-registry.js';
import { identityStore } from '../core/state/identity.js';

export class RecoveryEngine {
  private active       = false;
  private collectTimer: ReturnType<typeof setTimeout> | null = null;
  private results: Record<string, number> = {};
  private pending = new Set<PeerId>();

  constructor(
    private readonly node:     MeshNode,
    private readonly bus:      EventBus,
    private readonly registry: PeerRegistry,
  ) {}

  // ── Entry point ───────────────────────────────────────────────────────────

  start(): void {
    if (this.active) return;
    this.active = true;

    const grandparent = this.node.getGrandparentId();
    if (grandparent) {
      this.tryGrandparent(grandparent);
    } else {
      // Small delay so sibling connectTo (triggered by parent_lost notify) can
      // establish before we query descendant counts.
      setTimeout(() => this.runProcedure(), 1500);
    }
  }

  cancel(): void {
    this.active = false;
    if (this.collectTimer) { clearTimeout(this.collectTimer); this.collectTimer = null; }
    this.results = {};
    this.pending.clear();
  }

  // ── Incoming response from a queried peer ─────────────────────────────────

  handleDescendantCountResponse(responderId: PeerId, count: number): void {
    if (!this.active) return;
    this.results[responderId] = count;
    this.pending.delete(responderId);
    if (this.pending.size === 0) {
      if (this.collectTimer) clearTimeout(this.collectTimer);
      this.decide();
    }
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private tryGrandparent(grandparentId: PeerId): void {
    const roomId = this.node.roomId;
    this.registry.connect(grandparentId).then(result => {
      if (!result.ok) {
        console.log(`[RecoveryEngine:${roomId}] grandparent unreachable, running procedure`);
        this.runProcedure();
        return;
      }
      result.value.send({
        type:          'adopt_request',
        roomId,
        id:            this.myId(),
        name:          this.myName(),
        voiceChannelId: null,
      });
      // adopt_ack / adopt_reject arrives via normal dispatch and calls
      // MeshNode.onAdoptAck / onAdoptReject, which will set active=false.
      this.active = false;
    });
  }

  private runProcedure(): void {
    if (!this.active) return;

    const roomId = this.node.roomId;
    const myDC   = this.node.getDescendantCount();
    const myId   = this.myId();

    // Collect candidate peers: known non-descendants.
    const descendants = new Set(this.node.getChildren().keys());
    const clusterMap  = this.node.getClusterMap();

    const candidates = Object.keys(clusterMap).filter(
      pid => pid !== myId && !descendants.has(pid as PeerId),
    ) as PeerId[];

    console.log(`[RecoveryEngine:${roomId}] procedure — myDC=${myDC}, candidates: ${candidates.join(', ') || '(none)'}`);

    if (!candidates.length) {
      this.node.becomeRoot();
      this.active = false;
      return;
    }

    const batch = candidates.slice(0, 5) as PeerId[];
    this.results = {};
    this.pending = new Set(batch);

    // Collect for up to 5 s then decide.
    this.collectTimer = setTimeout(() => this.decide(), 5000);

    for (const pid of batch) {
      const existing = this.registry.get(pid);
      const req = (conn: { send(d: unknown): boolean }) => {
        conn.send({
          type:        'descendant_count_request',
          roomId,
          requesterId: myId,
        });
      };

      if (existing) {
        req(existing);
      } else {
        this.registry.connect(pid).then(result => {
          if (!result.ok) {
            this.pending.delete(pid);
            if (this.pending.size === 0 && this.active) {
              if (this.collectTimer) clearTimeout(this.collectTimer);
              this.decide();
            }
            return;
          }
          req(result.value);
        });
      }
    }
  }

  private decide(): void {
    if (!this.active) return;
    this.active = false;

    const roomId = this.node.roomId;
    const myId   = this.myId();
    const myDC   = this.node.getDescendantCount();

    // Re-check — join may have succeeded while we were waiting.
    if (this.node.isChild() || this.node.getChildren().size > 0) {
      console.log(`[RecoveryEngine:${roomId}] decide() — already placed, aborting`);
      return;
    }

    if (!Object.keys(this.results).length) {
      console.log(`[RecoveryEngine:${roomId}] decide() — no responses, becoming root`);
      this.node.becomeRoot();
      return;
    }

    // Find highest priority peer.
    let bestPid: PeerId | null = null;
    let bestDC  = -1;

    for (const [pid, dc] of Object.entries(this.results)) {
      if (this.priorityHigherThan(dc, pid as PeerId, bestDC, bestPid ?? ('' as PeerId))) {
        bestDC = dc; bestPid = pid as PeerId;
      }
    }

    if (!bestPid) { this.node.becomeRoot(); return; }

    this.node.setRecoveryLock(Date.now() + RECOVERY_LOCK_MS);

    if (this.priorityHigherThan(bestDC, bestPid, myDC, myId)) {
      console.log(`[RecoveryEngine:${roomId}] decide() — attaching to ${bestPid} (DC=${bestDC} > mine=${myDC})`);
      this.registry.connect(bestPid).then(result => {
        if (!result.ok) {
          setTimeout(() => this.start(), RECONNECT_DELAY);
          return;
        }
        result.value.send({
          type:          'adopt_request',
          roomId,
          id:            myId,
          name:          this.myName(),
          voiceChannelId: null,
        });
      });
    } else {
      console.log(`[RecoveryEngine:${roomId}] decide() — we win (DC=${myDC}), pulling ${bestPid} down`);
      const existing = this.registry.get(bestPid);
      const doConnect = (conn: { send(d: unknown): boolean }) => {
        conn.send({ type: 'connect_to_me', roomId, id: myId, name: this.myName() });
      };
      if (existing) { doConnect(existing); }
      else { this.registry.connect(bestPid).then(r => { if (r.ok) doConnect(r.value); }); }
      this.node.becomeRoot();
    }
  }

  /**
   * Deterministic priority: larger descendantCount wins; tie-break by nodeId (lex).
   */
  private priorityHigherThan(aDC: number, aId: PeerId, bDC: number, bId: PeerId): boolean {
    if (aDC !== bDC) return aDC > bDC;
    return aId > bId;
  }

  private myId():   PeerId { return identityStore.get().myId ?? ('' as PeerId); }
  private myName(): string { return identityStore.get().myName; }
}
