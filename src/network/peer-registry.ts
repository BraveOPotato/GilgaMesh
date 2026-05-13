/**
 * src/network/peer-registry.ts — Central registry of all live PeerConnections.
 *
 * Responsibilities:
 *  - Deduplicates simultaneous incoming/outgoing connections (higher ID wins).
 *  - Manages connect() with polling fallback for cold-start PeerJS reliability.
 *  - Runs the heartbeat interval (ping / pong / timeout detection).
 *  - Sends handshakes when a connection opens.
 *  - Emits all peer lifecycle events via EventBus.
 *
 * Does NOT touch DOM. Does NOT know about rooms directly — it routes
 * data events so main dispatcher / mesh modules handle them.
 */

import { CONN_TIMEOUT, HEARTBEAT_INTERVAL, PING_TIMEOUT } from '../core/constants.js';
import type { EventBus, PeerId, RoomId } from '../core/events.js';
import type { Result } from '../core/types.js';
import { ok, err } from '../core/types.js';
import { PeerConnection } from './peer-connection.js';
import type { DataConnection, PeerInstance } from './peerjs-types.js';
import { roomsStore } from '../core/state/rooms.js';
import { identityStore } from '../core/state/identity.js';

export type ConnectError = 'self' | 'timeout' | 'peer-not-ready' | 'connect-returned-null' | 'error' | 'closed';

export interface HandshakePayload {
  readonly type:             'handshake';
  readonly roomId:           RoomId;
  readonly id:               PeerId;
  readonly name:             string;
  readonly parentId:         PeerId | null;
  readonly distanceFromRoot: number;
  readonly childCount:       number;
  readonly electionEpoch:    number;
  readonly clusterMap:       Record<string, unknown>;
  readonly voiceChannelId:   string | null;
}

export class PeerRegistry {
  private conns = new Map<PeerId, PeerConnection>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly bus:     EventBus,
    private readonly getPeer: () => PeerInstance | null,
    private readonly getMyId: () => PeerId | null,
  ) {}

  // ── Registration ─────────────────────────────────────────────────────────

  /** Get an existing open connection, or null. */
  get(peerId: PeerId): PeerConnection | null {
    const pc = this.conns.get(peerId);
    return pc?.isOpen() ? pc : null;
  }

  /** All currently open connections. */
  all(): ReadonlyMap<PeerId, PeerConnection> {
    return this.conns;
  }

  /**
   * Handle an incoming DataConnection from PeerJS.
   * Applies deterministic dedup: higher peer ID wins when both sides connect.
   */
  handleIncoming(conn: DataConnection): void {
    const pid   = conn.peer as PeerId;
    const myId  = this.getMyId();

    conn.on('open', () => {
      const existing = this.conns.get(pid);

      if (existing?.isOpen() && existing.getRawConn() !== conn) {
        // Both sides connected simultaneously — keep higher ID's conn.
        if (myId && myId > pid) {
          // We win — close the incoming duplicate.
          try { conn.close(); } catch {}
          return;
        }
        // They win — replace our outbound conn.
        existing.dispose();
      }

      this.register(pid, conn);
      this.sendHandshakesForAllRooms(this.conns.get(pid)!);
    });

    conn.on('error', () => {}); // open handler covers teardown
  }

  /**
   * Handle an incoming file DataConnection (label starts with 'file:').
   * Routes to file transfer handler via bus event.
   */
  handleIncomingFile(conn: DataConnection): void {
    const token = conn.label.replace('file:', '');
    conn.on('open', () => {
      conn.on('data', (msg: unknown) => {
        if (
          msg != null &&
          typeof msg === 'object' &&
          (msg as Record<string, unknown>)['type'] === 'file_request' &&
          (msg as Record<string, unknown>)['token'] === token
        ) {
          this.bus.emit('file:download-request', {
            token,
            fromId:   conn.peer as PeerId,
            filename: '',
          });
        }
      });
    });
  }

  // ── Connect ──────────────────────────────────────────────────────────────

  /**
   * Connect to a peer. Resolves with the PeerConnection on success.
   * Polls every 200ms as fallback for PeerJS cold-start open-event miss.
   * Reuses existing open connections immediately.
   */
  async connect(targetId: PeerId): Promise<Result<PeerConnection, ConnectError>> {
    const myId = this.getMyId();
    if (!targetId || targetId === myId) return err('self');

    // Reuse existing open connection.
    const existing = this.get(targetId);
    if (existing) {
      this.sendHandshakesForAllRooms(existing);
      return ok(existing);
    }

    const peer = this.getPeer();

    // Wait for PeerJS to open if needed.
    if (!peer?.open) {
      return this.waitForPeerThenConnect(targetId);
    }

    const conn = peer.connect(targetId, { reliable: true, serialization: 'json' });
    if (!conn) {
      console.warn(`[PeerRegistry] connect(${targetId}) — peer.connect() returned null`);
      return err('connect-returned-null');
    }

    return this.awaitOpen(targetId, conn);
  }

  /**
   * Scout connection — temporary, for cluster map fetch only.
   * Does NOT register in this.conns. Does NOT send handshakes.
   * The joiner is invisible to the cluster until adopt_request is sent.
   */
  async scoutConnect(
    targetId: PeerId,
    roomId:   RoomId,
  ): Promise<Result<DataConnection, ConnectError>> {
    const myId = this.getMyId();
    if (!targetId || targetId === myId) return err('self');

    // Reuse existing permanent connection for the map request.
    const existing = this.get(targetId);
    if (existing) {
      existing.send({
        type:   'cluster_map_request',
        roomId,
        id:     myId,
        name:   identityStore.get().myName,
      });
      // Signal caller that map will arrive via normal dispatch path.
      return ok(existing.getRawConn());
    }

    const peer = this.getPeer();
    if (!peer?.open) return err('peer-not-ready');

    const conn = peer.connect(targetId, {
      reliable:      true,
      serialization: 'json',
      label:         'scout',
    });
    if (!conn) return err('connect-returned-null');

    return this.awaitOpenRaw(targetId, conn);
  }

  // ── Handshake ────────────────────────────────────────────────────────────

  sendHandshake(conn: PeerConnection, roomId: RoomId): void {
    const { rooms }  = roomsStore.get();
    const { myId, myName } = identityStore.get();
    const room = rooms[roomId];
    if (!room || !myId) return;

    conn.send({
      type:             'handshake',
      roomId,
      id:               myId,
      name:             myName,
      parentId:         room.parentId,
      distanceFromRoot: room.distanceFromRoot,
      childCount:       room.childIds.length,
      electionEpoch:    room.electionEpoch,
      clusterMap:       room.clusterMap,
      voiceChannelId:   room.myVoiceChannelId ?? null,
    } satisfies HandshakePayload);
  }

  private sendHandshakesForAllRooms(pc: PeerConnection): void {
    const { rooms } = roomsStore.get();
    for (const roomId of Object.keys(rooms) as RoomId[]) {
      pc.addRoom(roomId);
      this.sendHandshake(pc, roomId);
    }
  }

  // ── Heartbeat ─────────────────────────────────────────────────────────────

  startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => this.doHeartbeat(), HEARTBEAT_INTERVAL);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private doHeartbeat(): void {
    const now  = Date.now();
    const myId = this.getMyId();

    for (const [pid, pc] of this.conns) {
      if (!pc.isOpen()) {
        this.conns.delete(pid);
        this.bus.emit('peer:offline', { peerId: pid });
        continue;
      }
      pc.send({ type: 'ping', ts: now, id: myId });
      if (now - pc.getLastSeen() > PING_TIMEOUT) {
        pc.dispose();
        this.conns.delete(pid);
      }
    }

    // Topology re-render triggered downstream by peer:offline events above.
  }

  handlePong(data: { ts: number }, peerId: PeerId): void {
    this.conns.get(peerId)?.recordPong(data.ts);
  }

  // ── Remove ───────────────────────────────────────────────────────────────

  remove(peerId: PeerId): void {
    const pc = this.conns.get(peerId);
    if (pc) {
      pc.dispose();
      this.conns.delete(peerId);
    }
  }

  // ── Private helpers ───────────────────────────────────────────────────────

  private register(peerId: PeerId, conn: DataConnection): PeerConnection {
    // Guard: don't register handlers twice on same conn object.
    const pc = new PeerConnection(peerId, conn, this.bus, this.getMyId() ?? '' as PeerId);
    this.conns.set(peerId, pc);
    this.bus.emit('peer:online', { peerId });

    // Send friend verification token if applicable.
    // Emitting an event keeps this decoupled from friends module.
    this.bus.emit('peer:connection-opened' as never, { peerId, conn: pc } as never);

    return pc;
  }

  private async awaitOpen(
    targetId: PeerId,
    conn:     DataConnection,
  ): Promise<Result<PeerConnection, ConnectError>> {
    return new Promise((resolve) => {
      let settled = false;

      const succeed = () => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        clearInterval(pollTimer);

        // Prefer racing incoming conn (higher ID won dedup).
        const ex = this.get(targetId);
        if (ex && ex.getRawConn() !== conn) {
          try { conn.close(); } catch {}
          resolve(ok(ex));
          return;
        }

        const pc = this.register(targetId, conn);
        this.sendHandshakesForAllRooms(pc);
        resolve(ok(pc));
      };

      const fail = (reason: ConnectError) => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        clearInterval(pollTimer);
        try { conn.close(); } catch {}
        resolve(err(reason));
      };

      const pollTimer = setInterval(() => { if (conn.open) succeed(); }, 200);
      const hardTimer = setTimeout(() => fail('timeout'), CONN_TIMEOUT);

      conn.on('open',  () => succeed());
      conn.on('error', (e) => fail((e.type ?? 'error') as ConnectError));
    });
  }

  private async awaitOpenRaw(
    _targetId: PeerId,
    conn:      DataConnection,
  ): Promise<Result<DataConnection, ConnectError>> {
    return new Promise((resolve) => {
      let settled     = false;
      let mapRequested = false;

      const open = () => {
        if (mapRequested) return;
        mapRequested = true;
        resolve(ok(conn));
      };

      const fail = (reason: ConnectError) => {
        if (settled) return;
        settled = true;
        clearInterval(pollTimer);
        clearTimeout(hardTimer);
        try { conn.close(); } catch {}
        resolve(err(reason));
      };

      const pollTimer = setInterval(() => { if (conn.open) open(); }, 200);
      const hardTimer = setTimeout(() => fail('timeout'), CONN_TIMEOUT);

      conn.on('open',  () => open());
      conn.on('error', (e) => fail((e.type ?? 'error') as ConnectError));
      conn.on('close', () => { if (!settled) fail('closed'); });
    });
  }

  private async waitForPeerThenConnect(
    targetId: PeerId,
  ): Promise<Result<PeerConnection, ConnectError>> {
    return new Promise((resolve) => {
      const peer = this.getPeer();
      if (!peer) { resolve(err('peer-not-ready')); return; }

      const retry = () => this.connect(targetId).then(resolve);
      peer.once('open', retry);
      setTimeout(() => {
        peer.off('open', retry);
        resolve(err('timeout'));
      }, CONN_TIMEOUT);
    });
  }
}
