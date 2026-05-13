/**
 * src/network/message-router.ts — Tree-based message relay.
 *
 * Propagation rules (mirror of messaging.js):
 *  - Leaf: sends UP to parent. Shows as pending until msg_ack from root.
 *  - Intermediate: relay UP (if from child) AND DOWN (to all children excl. sender).
 *  - Root: deliver locally + broadcast DOWN to all children + send msg_ack hop-by-hop.
 *  - pending flag is stripped before relaying so only the origin node sees it gray.
 *
 * Typing relay:
 *  - fromChild  → relay UP + fan DOWN to other children (siblings need to see it)
 *  - fromParent → fan DOWN
 *  - Dedup via tid to prevent loops regardless of topology.
 */

import { MSG_CACHE_SIZE } from '../core/constants.js';
import type { EventBus, PeerId, RoomId } from '../core/events.js';
import type { Message } from '../core/types.js';
import type { MeshNode } from './mesh-node.js';
import type { PeerRegistry } from './peer-registry.js';

export class MessageRouter {
  constructor(
    private readonly bus:      EventBus,
    private readonly registry: PeerRegistry,
  ) {}

  // ── Incoming message from wire ────────────────────────────────────────────

  route(
    node:      MeshNode,
    msg:       Message,
    fromPeerId: PeerId,
  ): void {
    const roomId = node.roomId;

    // Dedup.
    if (msg.id) {
      if (node.hasSeen(msg.id)) return;
      node.markSeen(msg.id, MSG_CACHE_SIZE);
    }

    // Strip pending flag for relay — only the origin shows pending state.
    const cleanMsg: Message = msg.pending ? { ...msg, pending: false } : msg;

    // Deliver to local UI.
    this.bus.emit('room:message', { roomId, msg: cleanMsg, fromPeerId });

    if (node.isRoot()) {
      // Root: broadcast clean copy DOWN (excluding sender).
      node.sendToAllChildren({ type: 'relay_message', roomId, payload: cleanMsg }, fromPeerId);

      // Send ack hop-by-hop toward origin (not directly to origin — may not be adjacent).
      if (fromPeerId !== (node as unknown as { getMyId?: () => PeerId }).getMyId?.()) {
        const senderConn = node.getChildren().get(fromPeerId) ?? this.registry.get(fromPeerId);
        senderConn?.send({ type: 'msg_ack', roomId, msgId: msg.id, originId: msg.originId });
      }
    } else {
      // Intermediate / leaf: relay UP if came from child, DOWN excluding sender.
      if (fromPeerId !== node.getParentId()) {
        node.sendToParent({ type: 'relay_message', roomId, payload: cleanMsg });
      }
      node.sendToAllChildren({ type: 'relay_message', roomId, payload: cleanMsg }, fromPeerId);

      // Also send to backup peer.
      const backupConn = node.getBackupConn();
      if (backupConn && node.getBackupPeerId() !== fromPeerId) {
        backupConn.send({ type: 'relay_message', roomId, payload: cleanMsg });
      }
    }
  }

  // ── Msg ack relay ─────────────────────────────────────────────────────────

  routeAck(node: MeshNode, data: { roomId: RoomId; msgId: string; originId: PeerId }): void {
    const myId = this.getMyId(node);

    if (data.originId && data.originId !== myId) {
      // Forward hop-by-hop: try direct child first, then broadcast to all children.
      const directConn = node.getChildren().get(data.originId);
      if (directConn) {
        directConn.send(data);
        return;
      }
      // Not a direct child — broadcast so the right subtree absorbs it.
      node.sendToAllChildren(data);
      return;
    }

    // Ack is for us — emit event so UI un-grays the message.
    this.bus.emit('room:msg-acked', { roomId: node.roomId, msgId: data.msgId as unknown as import('../core/types.js').MessageId });
  }

  // ── Typing relay ──────────────────────────────────────────────────────────

  routeTyping(
    node:     MeshNode,
    data:     { roomId: RoomId; id: PeerId; name: string; channel: string; tid?: string },
    senderId: PeerId,
  ): void {
    const roomId = node.roomId;

    // Dedup by tid.
    if (data.tid) {
      if (node.hasSeenTyping(data.tid)) return;
      node.markTypingSeen(data.tid);
    }

    const fromChild  = node.getChildren().has(senderId);
    const fromParent = senderId === node.getParentId();

    if (fromChild) {
      // Relay UP toward root.
      node.sendToParent(data);
      // Fan DOWN to other children so the whole subtree sees the indicator.
      node.sendToAllChildren(data, senderId);
    } else if (fromParent) {
      // Fan DOWN.
      node.sendToAllChildren(data);
    }

    // Deliver locally.
    this.bus.emit('room:typing', {
      roomId,
      channel:  data.channel as import('../core/types.js').ChannelId,
      peerId:   senderId,
      name:     data.name,
    });
  }

  private getMyId(node: MeshNode): string {
    // Access via closure in main — node exposes room-level identity.
    // In practice callers also pass identity separately; this is a fallback.
    return node.getClusterMap()[node.roomId as unknown as string]?.name ?? '';
  }
}
