/**
 * src/network/mesh-node.ts — Per-room tree topology state machine.
 *
 * One MeshNode per room. Tracks parent/child relationships and owns
 * all state transitions. Never touches DOM. All side-effects go through
 * EventBus or PeerRegistry.
 *
 * State machine:
 *   orphan → joining → child
 *   orphan → root
 *   child  → orphan  (parent lost)
 *   root   → child   (demoted by election)
 */

import {
  SOFT_CHILD_LIMIT,
  HARD_CHILD_LIMIT,
  RECOVERY_LOCK_MS,
} from '../core/constants.js';
import type { EventBus, PeerId, RoomId, ChannelId } from '../core/events.js';
import type { Result } from '../core/types.js';
import { ok, err } from '../core/types.js';
import type { PeerConnection } from './peer-connection.js';
import type { PeerRegistry } from './peer-registry.js';
import { roomsStore, type ClusterMapEntry } from '../core/state/rooms.js';
import { identityStore } from '../core/state/identity.js';

// ── Node state ────────────────────────────────────────────────────────────────

export type NodeState =
  | { readonly type: 'orphan';  readonly since: number }
  | { readonly type: 'joining'; readonly candidate: PeerId; readonly since: number; readonly timeout: ReturnType<typeof setTimeout> }
  | { readonly type: 'child';   readonly parentId: PeerId; readonly distanceFromRoot: number; readonly since: number }
  | { readonly type: 'root';    readonly since: number };

export type JoinError =
  | 'not_orphan'
  | 'already_root'
  | 'connection_failed'
  | 'adopt_rejected'
  | 'cycle_detected'
  | 'timeout'
  | 'recovery_lock_active';

export type AddChildError = 'full' | 'cycle' | 'already_child';

// ─────────────────────────────────────────────────────────────────────────────

export class MeshNode {
  private nodeState:    NodeState;
  private children      = new Map<PeerId, PeerConnection>();
  private backupPeerId: PeerId | null = null;
  private backupConn:   PeerConnection | null = null;
  private recoveryLock  = 0;
  private joiningParent = false;

  /** Siblings (children of our parent, excl. us) — from child_list msgs. */
  private siblings:    PeerId[] = [];
  private bestSibling: PeerId | null = null;
  private grandparentId: PeerId | null = null;

  /** clusterMap entry for each known peer. */
  private clusterMap: Record<string, ClusterMapEntry> = {};

  /** Election state. */
  private electionEpoch  = 0;
  private electionVotes: Record<string, number> = {};

  /** dedup caches */
  private seenMsgIds:    string[] = [];
  private seenTypingIds: string[] = [];

  constructor(
    readonly roomId: RoomId,
    private readonly registry: PeerRegistry,
    private readonly bus:      EventBus,
    private readonly getMyId:  () => PeerId,
    private readonly getMyName: () => string,
  ) {
    this.nodeState = { type: 'orphan', since: Date.now() };
  }

  // ── State queries ──────────────────────────────────────────────────────────

  getState():            NodeState { return this.nodeState; }
  isRoot():              boolean   { return this.nodeState.type === 'root'; }
  isOrphan():            boolean   { return this.nodeState.type === 'orphan'; }
  isJoining():           boolean   { return this.nodeState.type === 'joining'; }
  isChild():             boolean   { return this.nodeState.type === 'child'; }
  getChildCount():       number    { return this.children.size; }
  getChildren():         ReadonlyMap<PeerId, PeerConnection> { return this.children; }
  getSiblings():         readonly PeerId[] { return this.siblings; }
  getBestSibling():      PeerId | null     { return this.bestSibling; }
  getGrandparentId():    PeerId | null     { return this.grandparentId; }
  getRecoveryLock():     number            { return this.recoveryLock; }
  isRecoveryLocked():    boolean           { return this.recoveryLock > Date.now(); }
  isJoiningParent():     boolean           { return this.joiningParent; }
  getClusterMap():       Readonly<Record<string, ClusterMapEntry>> { return this.clusterMap; }
  getElectionEpoch():    number            { return this.electionEpoch; }
  getSeenMsgIds():       readonly string[] { return this.seenMsgIds; }
  getSeenTypingIds():    readonly string[] { return this.seenTypingIds; }
  getBackupPeerId():     PeerId | null     { return this.backupPeerId; }
  getBackupConn():       PeerConnection | null { return this.backupConn; }

  getParentId(): PeerId | null {
    return this.nodeState.type === 'child' ? this.nodeState.parentId : null;
  }

  getDistanceFromRoot(): number {
    return this.nodeState.type === 'child' ? this.nodeState.distanceFromRoot : 0;
  }

  getDescendantCount(): number {
    let count = 1;
    for (const [cid] of this.children) {
      count += this.clusterMap[cid]?.descendantCount ?? 1;
    }
    return count;
  }

  // ── Dedup ────────────────────────────────────────────────────────────────

  hasSeen(msgId: string): boolean {
    return this.seenMsgIds.includes(msgId);
  }

  markSeen(msgId: string, cacheSize: number): void {
    this.seenMsgIds.push(msgId);
    if (this.seenMsgIds.length > cacheSize) this.seenMsgIds.shift();
  }

  hasSeenTyping(tid: string): boolean {
    return this.seenTypingIds.includes(tid);
  }

  markTypingSeen(tid: string): void {
    this.seenTypingIds.push(tid);
    if (this.seenTypingIds.length > 60) this.seenTypingIds.shift();
  }

  // ── Transitions ───────────────────────────────────────────────────────────

  /** Start join attempt toward candidate. */
  async joinParent(candidate: PeerId): Promise<Result<void, JoinError>> {
    if (this.nodeState.type !== 'orphan')         return err('not_orphan');
    if (this.recoveryLock > Date.now())            return err('recovery_lock_active');
    if (this.children.has(candidate))             return err('cycle_detected');

    const result = await this.registry.connect(candidate);
    if (!result.ok) return err('connection_failed');

    const conn = result.value;

    const timeout = setTimeout(() => this.onJoinTimeout(), 20_000);
    this.nodeState = { type: 'joining', candidate, since: Date.now(), timeout };
    this.joiningParent = true;

    conn.send({
      type:          'adopt_request',
      roomId:        this.roomId,
      id:            this.getMyId(),
      name:          this.getMyName(),
      voiceChannelId: this.getMyVoiceChannelId(),
    });

    return ok(undefined);
  }

  /** Root calls this to add an incoming child. */
  addChild(conn: PeerConnection): Result<void, AddChildError> {
    const peerId = conn.peerId;

    if (this.children.has(peerId))  return err('already_child');
    if (this.isAncestor(peerId))    return err('cycle');

    const limit = this.isRecoveryLocked() ? HARD_CHILD_LIMIT : SOFT_CHILD_LIMIT;
    if (this.children.size >= limit) return err('full');

    this.children.set(peerId, conn);
    this.bus.emit('room:topology-changed', { roomId: this.roomId });
    return ok(undefined);
  }

  removeChild(peerId: PeerId): void {
    this.children.delete(peerId);
    delete this.clusterMap[peerId];
    this.bus.emit('room:topology-changed', { roomId: this.roomId });
  }

  setBackup(peerId: PeerId | null, conn: PeerConnection | null): void {
    this.backupPeerId = peerId;
    this.backupConn   = conn;
  }

  /** Become root (no parent). Idempotent. */
  becomeRoot(): Result<void, 'already_root'> {
    if (this.nodeState.type === 'root') return err('already_root');

    if (this.nodeState.type === 'joining') {
      clearTimeout(this.nodeState.timeout);
    }

    this.joiningParent = false;
    this.nodeState = { type: 'root', since: Date.now() };
    this.updateClusterMapSelf();

    this.bus.emit('room:became-root',      { roomId: this.roomId });
    this.bus.emit('room:topology-changed', { roomId: this.roomId });
    return ok(undefined);
  }

  // ── Adopt ack/reject ─────────────────────────────────────────────────────

  onAdoptAck(
    parentId:         PeerId,
    distanceFromRoot: number,
    grandparentId:    PeerId | null,
    receivedMap:      Record<string, ClusterMapEntry>,
    siblings:         readonly PeerId[],
    electionEpoch:    number,
  ): void {
    if (this.nodeState.type !== 'joining') {
      console.warn(`[MeshNode:${this.roomId}] adopt_ack received in state "${this.nodeState.type}" — ignoring`);
      return;
    }

    clearTimeout(this.nodeState.timeout);
    this.joiningParent    = false;
    this.grandparentId    = grandparentId;
    this.electionEpoch    = electionEpoch;

    // Merge cluster map — our local entries take precedence for our own data.
    for (const [pid, entry] of Object.entries(receivedMap)) {
      if (pid !== this.getMyId()) {
        this.clusterMap[pid] = entry;
      }
    }

    // Remove new parent from children list if it was there (role-swap guard).
    if (this.children.has(parentId)) {
      this.children.get(parentId)?.dispose();
      this.children.delete(parentId);
    }

    this.siblings    = siblings.filter(s => s !== this.getMyId());
    this.bestSibling = this.siblings[0] ?? null;

    this.nodeState = {
      type:             'child',
      parentId,
      distanceFromRoot,
      since:            Date.now(),
    };

    this.updateClusterMapSelf();
    this.bus.emit('room:joined',           { roomId: this.roomId, channel: 'general' as ChannelId });
    this.bus.emit('room:topology-changed', { roomId: this.roomId });
  }

  onAdoptReject(_reason: string): void {
    if (this.nodeState.type === 'joining') {
      clearTimeout(this.nodeState.timeout);
    }
    this.joiningParent = false;
    this.nodeState = { type: 'orphan', since: Date.now() };
    // RecoveryEngine will be notified via topology-changed to start recovery.
    this.bus.emit('room:topology-changed', { roomId: this.roomId });
  }

  private onJoinTimeout(): void {
    if (this.nodeState.type !== 'joining') return;
    this.joiningParent = false;
    this.nodeState = { type: 'orphan', since: Date.now() };
    this.bus.emit('room:topology-changed', { roomId: this.roomId });
  }

  // ── Parent lost ───────────────────────────────────────────────────────────

  onParentLost(lostParentId: PeerId): void {
    if (this.isRecoveryLocked()) return;
    this.recoveryLock = Date.now() + RECOVERY_LOCK_MS;

    // Preserve sibling entries in clusterMap before removing dead parent.
    for (const sibId of this.siblings) {
      if (sibId !== this.getMyId() && !this.clusterMap[sibId]) {
        this.clusterMap[sibId] = {
          name:            this.getPeerName(sibId),
          distance:        1,
          childCount:      0,
          connCount:       0,
          descendantCount: 1,
        };
      }
    }
    delete this.clusterMap[lostParentId];

    const hadGrandparent = this.grandparentId;
    this.grandparentId = null;

    if (this.nodeState.type === 'joining') {
      clearTimeout(this.nodeState.timeout);
    }
    this.nodeState = { type: 'orphan', since: Date.now() };
    this.joiningParent = false;

    this.updateClusterMapSelf();

    // Notify siblings so they can run their own recovery.
    for (const sibId of this.siblings) {
      const sibConn = this.registry.get(sibId);
      sibConn?.send({
        type:         'parent_lost',
        roomId:       this.roomId,
        lostParentId,
        newCandidate: this.getMyId(),
      });
    }

    this.bus.emit('room:parent-lost',      { roomId: this.roomId, lostParentId });
    this.bus.emit('room:recovery-started', { roomId: this.roomId });

    // Recovery engine listens to room:parent-lost and will call the
    // appropriate strategy (grandparent fast-path or recoverProcedure).
    // Store grandparentId for the engine to read.
    if (hadGrandparent) {
      this.grandparentId = hadGrandparent; // restore so engine can read it
    }
  }

  // ── Sibling notification ──────────────────────────────────────────────────

  onSiblingParentLost(lostParentId: PeerId, newCandidate: PeerId): void {
    if (this.getParentId() !== lostParentId) return;
    if (this.isRecoveryLocked()) return;

    // Add notifying sibling as recovery candidate if not already in map.
    if (!this.clusterMap[newCandidate]) {
      this.clusterMap[newCandidate] = {
        name:            this.getPeerName(newCandidate),
        distance:        1,
        childCount:      0,
        connCount:       0,
        descendantCount: 1,
      };
    }

    this.onParentLost(lostParentId);
  }

  // ── Child list update ─────────────────────────────────────────────────────

  onChildList(children: readonly PeerId[], bestChild: PeerId | null): void {
    this.siblings    = children.filter(id => id !== this.getMyId());
    this.bestSibling = bestChild !== this.getMyId() ? bestChild : (this.siblings[0] ?? null);
  }

  // ── Cluster map ───────────────────────────────────────────────────────────

  mergeClusterMap(incomingMap: Record<string, ClusterMapEntry>): void {
    for (const [pid, entry] of Object.entries(incomingMap)) {
      if (pid !== this.getMyId()) {
        this.clusterMap[pid] = entry;
      }
    }
    this.updateClusterMapSelf();
  }

  updateClusterMapSelf(): void {
    const myId  = this.getMyId();
    const vcId  = this.getMyVoiceChannelId();
    const voiceSubtree = vcId !== null && Array.from(this.children.keys()).every(
      cid => this.clusterMap[cid]?.voiceChannelId === vcId,
    );

    this.clusterMap[myId] = {
      name:            this.getMyName(),
      distance:        this.getDistanceFromRoot(),
      connCount:       this.getTotalConnCount(),
      childCount:      this.children.size,
      descendantCount: this.getDescendantCount(),
      voiceChannelId:  vcId ?? null,
      voiceSubtree,
    };
  }

  broadcastClusterMap(): void {
    const msg = { type: 'cluster_map', roomId: this.roomId, map: this.clusterMap };
    for (const [, conn] of this.children) conn.send(msg);
    const parentConn = this.getParentConn();
    parentConn?.send(msg);
    this.backupConn?.send(msg);
  }

  broadcastChildList(): void {
    const ranked = Array.from(this.children.entries())
      .map(([id, conn]) => ({ id, rtt: conn.getAverageRtt() }))
      .sort((a, b) => a.rtt - b.rtt);

    const msg = {
      type:      'child_list',
      roomId:    this.roomId,
      children:  ranked.map(e => e.id),
      bestChild: ranked[0]?.id ?? null,
    };

    for (const [, conn] of this.children) conn.send(msg);

    // Also inform parent of updated child count.
    const parentConn = this.getParentConn();
    if (parentConn) {
      parentConn.send({
        type:            'child_count_update',
        roomId:          this.roomId,
        count:           this.children.size,
        childCount:      this.children.size,
        id:              this.getMyId(),
        descendantCount: this.getDescendantCount(),
      });
    }
  }

  // ── Election ─────────────────────────────────────────────────────────────

  setElectionEpoch(epoch: number): void   { this.electionEpoch = epoch; }
  recordVote(peerId: PeerId, score: number): void { this.electionVotes[peerId] = score; }
  getVotes(): Readonly<Record<string, number>> { return this.electionVotes; }
  clearVotes(): void { this.electionVotes = {}; }

  /** Score = uptime_ms × (siblingCount + 1). */
  calcElectionScore(connStartTime: number): number {
    const uptime       = Date.now() - connStartTime;
    const siblingCount = this.siblings.length + this.children.size;
    return uptime * (siblingCount + 1);
  }

  // ── Recovery lock ────────────────────────────────────────────────────────

  setRecoveryLock(until: number): void { this.recoveryLock = until; }

  // ── Voice affinity ────────────────────────────────────────────────────────

  /**
   * Check if this node can accept a child with the given voice channel.
   * Voice nodes only accept children in the same voice channel (or non-voice).
   */
  canAcceptVoiceChild(
    requesterVcId: string | null,
  ): { allow: boolean; reason: string; redirectTo: PeerId | null } {
    const myVcId = this.getMyVoiceChannelId();

    if (!myVcId) {
      // Non-voice node — accepts everyone.
      return { allow: true, reason: 'non-voice', redirectTo: null };
    }

    if (requesterVcId === myVcId) {
      // Same channel — accept.
      return { allow: true, reason: 'same-channel', redirectTo: null };
    }

    // Voice mismatch — redirect to a compatible node.
    const redirectTo = this.findCompatibleNode(requesterVcId) ?? null;
    return {
      allow:      false,
      reason:     `voice-mismatch (mine=${myVcId}, theirs=${requesterVcId ?? 'none'})`,
      redirectTo,
    };
  }

  private findCompatibleNode(requesterVcId: string | null): PeerId | undefined {
    // Find a cluster node that either has no voice or same voice as requester.
    for (const [pid, entry] of Object.entries(this.clusterMap)) {
      if (pid === this.getMyId()) continue;
      const entryVc = entry.voiceChannelId ?? null;
      if (!entryVc || entryVc === requesterVcId) {
        const childCount = entry.childCount ?? 0;
        if (childCount < SOFT_CHILD_LIMIT) return pid as PeerId;
      }
    }
    return undefined;
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  getParentConn(): PeerConnection | null {
    const parentId = this.getParentId();
    return parentId ? this.registry.get(parentId) : null;
  }

  sendToAllChildren(msg: unknown, excludePid?: PeerId): void {
    for (const [pid, conn] of this.children) {
      if (pid === excludePid) continue;
      conn.send(msg);
    }
  }

  sendToParent(msg: unknown): boolean {
    return this.getParentConn()?.send(msg) ?? false;
  }

  getTotalConnCount(): number {
    let n = this.children.size;
    if (this.getParentId()) n++;
    if (this.backupPeerId)  n++;
    return n;
  }

  private isAncestor(peerId: PeerId): boolean {
    // Walk parent chain (bounded). We only have direct parent pointer —
    // for deeper ancestors we rely on distance heuristic.
    const parent = this.getParentId();
    return parent === peerId;
  }

  private getMyVoiceChannelId(): string | null {
    const room = roomsStore.get().rooms[this.roomId];
    return room?.myVoiceChannelId ?? null;
  }

  private getPeerName(peerId: PeerId): string {
    return roomsStore.get().rooms[this.roomId]?.peers[peerId]?.name ?? peerId;
  }

  // ── Dispose ───────────────────────────────────────────────────────────────

  dispose(): void {
    if (this.nodeState.type === 'joining') {
      clearTimeout(this.nodeState.timeout);
    }
    for (const [, conn] of this.children) conn.dispose();
    this.children.clear();
  }
}
