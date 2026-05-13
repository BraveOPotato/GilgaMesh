/**
 * src/network/mesh-election.ts — Local elections among a parent and its children.
 *
 * Every ELECTION_INTERVAL ms the current root of the local group initiates
 * an election. Vote metric: connection_uptime_ms × (siblingCount + 1).
 *
 * Winner logic:
 *  - If we win → stay root, nothing changes.
 *  - If a child wins → child becomes parent, we demote to child.
 */

import { ELECTION_INTERVAL } from '../core/constants.js';
import type { EventBus, PeerId, RoomId } from '../core/events.js';
import type { MeshNode } from './mesh-node.js';
import type { PeerRegistry } from './peer-registry.js';
import { identityStore } from '../core/state/identity.js';

// Connection start times for uptime scoring: peerId → epoch ms
const connStartTimes = new Map<PeerId, number>();

export function recordConnStart(peerId: PeerId): void {
  if (!connStartTimes.has(peerId)) connStartTimes.set(peerId, Date.now());
}

export class ElectionManager {
  private timers = new Map<RoomId, ReturnType<typeof setInterval>>();

  constructor(
    private readonly bus:      EventBus,
    private readonly registry: PeerRegistry,
  ) {}

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  start(roomId: RoomId, node: MeshNode): void {
    this.stop(roomId);
    this.timers.set(roomId, setInterval(() => this.runElection(roomId, node), ELECTION_INTERVAL));
  }

  stop(roomId: RoomId): void {
    const t = this.timers.get(roomId);
    if (t) { clearInterval(t); this.timers.delete(roomId); }
  }

  stopAll(): void {
    for (const roomId of this.timers.keys()) this.stop(roomId);
  }

  // ── Initiate ──────────────────────────────────────────────────────────────

  private runElection(roomId: RoomId, node: MeshNode): void {
    // Only root (no parent) initiates.
    if (!node.isRoot()) return;

    const myId  = this.myId();
    const epoch = Date.now();
    const score = this.calcScore(node);

    node.setElectionEpoch(epoch);
    node.clearVotes();
    node.recordVote(myId, score);

    node.sendToAllChildren({
      type: 'election_start', roomId, epoch, initiatorId: myId,
    });

    setTimeout(() => this.resolve(roomId, node, epoch), 3000);
  }

  // ── Incoming messages ─────────────────────────────────────────────────────

  /** Child receives election_start — sends its score back to parent. */
  handleStart(data: Record<string, unknown>, fromPeerId: PeerId, node: MeshNode): void {
    const roomId = data['roomId'] as RoomId;
    const epoch  = Number(data['epoch']);
    if (node.getElectionEpoch() === epoch) return; // already processing
    node.setElectionEpoch(epoch);

    const score = this.calcScore(node);
    const conn  = this.registry.get(fromPeerId);
    conn?.send({ type: 'election_vote', roomId, epoch, voterId: this.myId(), score });
  }

  /** Parent receives votes from children. */
  handleVote(data: Record<string, unknown>, node: MeshNode): void {
    const epoch = Number(data['epoch']);
    if (epoch !== node.getElectionEpoch()) return; // stale
    node.recordVote(data['voterId'] as PeerId, Number(data['score'] ?? 0));
  }

  /** Winner receives election_won — becomes root, old parent demotes to child. */
  async handleWon(data: Record<string, unknown>, fromPeerId: PeerId, node: MeshNode): Promise<void> {
    const roomId = data['roomId'] as RoomId;

    // We become root of this local group.
    node.becomeRoot();

    // Adopt old parent's other children (they will connect to us).
    for (const sibId of (data['myChildrenForYou'] as PeerId[] ?? [])) {
      const result = await this.registry.connect(sibId);
      if (result.ok) {
        result.value.send({
          type:          'adopt_request',
          roomId,
          id:            this.myId(),
          name:          identityStore.get().myName,
          voiceChannelId: null,
        });
      }
    }

    node.updateClusterMapSelf();
    node.broadcastClusterMap();

    this.bus.emit('ui:toast', { message: 'Became local root after election', kind: 'info' });
  }

  // ── Resolve ───────────────────────────────────────────────────────────────

  private async resolve(roomId: RoomId, node: MeshNode, epoch: number): Promise<void> {
    if (epoch !== node.getElectionEpoch()) return; // superseded

    const myId   = this.myId();
    const votes  = node.getVotes();
    let   winner = myId;
    let   best   = votes[myId] ?? 0;

    for (const [id, score] of Object.entries(votes)) {
      if (score > best) { best = score; winner = id as PeerId; }
    }
    node.clearVotes();

    if (winner === myId) return; // we stay root

    // A child won — tell them, then demote ourselves.
    const winnerConn = this.registry.get(winner as PeerId) ?? node.getChildren().get(winner as PeerId);
    if (!winnerConn) return; // winner gone

    const myChildren = Array.from(node.getChildren().keys()).filter(id => id !== winner) as PeerId[];
    winnerConn.send({ type: 'election_won', roomId, epoch, myChildrenForYou: myChildren });

    // Demote: close all child connections, then connect to winner as parent.
    node.sendToAllChildren({ type: 'peer_leaving', roomId, id: myId, name: identityStore.get().myName });

    // Remove all children from node.
    for (const childId of Array.from(node.getChildren().keys())) {
      node.removeChild(childId as PeerId);
    }

    // Re-join as child of winner.
    await node.joinParent(winner as PeerId);

    this.bus.emit('ui:toast', { message: `${winner} is now the local parent`, kind: 'info' });
  }

  // ── Score ────────────────────────────────────────────────────────────────

  private calcScore(node: MeshNode): number {
    const myId     = this.myId();
    const startTs  = connStartTimes.get(myId) ?? Date.now();
    const uptime   = Date.now() - startTs;
    const siblings = node.getSiblings().length + node.getChildCount();
    return uptime * (siblings + 1);
  }

  private myId(): PeerId { return identityStore.get().myId ?? '' as PeerId; }
}
