/**
 * src/network/peer-connection.ts — Lifecycle-managed wrapper around a PeerJS DataConnection.
 *
 * Responsibilities:
 *  - Owns one DataConnection. Cleans up on close/error.
 *  - Tracks RTT samples (rolling window).
 *  - Tracks which rooms this peer is a member of.
 *  - Emits bus events instead of calling other modules directly.
 *  - Idempotent dispose() — safe to call multiple times.
 */

import type { EventBus, PeerId } from '../core/events.js';
import { SCORE_WINDOW } from '../core/constants.js';
import type { DataConnection } from './peerjs-types.js';

export class PeerConnection {
  private lastSeen  = Date.now();
  private scores:   number[] = [];
  private rooms     = new Set<string>();
  private disposed  = false;
  /** Connection start time — used by election score calc. */
  readonly connStart = Date.now();

  constructor(
    readonly peerId: PeerId,
    private conn:    DataConnection,
    private bus:     EventBus,
    private myId:    PeerId,
  ) {
    this.bindEvents();
  }

  // ── Events ───────────────────────────────────────────────────────────────

  private bindEvents(): void {
    this.conn.on('data', (data: unknown) => {
      this.lastSeen = Date.now();
      // Raw data routing is handled by PeerRegistry / main dispatcher.
      // We expose the data via an event so no module holds a reference to us.
      this.bus.emit('peer:data-received' as never, {
        peerId: this.peerId,
        data,
        conn:   this,
      } as never);
    });

    this.conn.on('close', () => this.dispose());
    this.conn.on('error', (err) => {
      console.error(`[PeerConnection] ${this.peerId}:`, err);
      this.dispose();
    });
  }

  // ── Send ─────────────────────────────────────────────────────────────────

  send(data: unknown): boolean {
    if (this.disposed || !this.conn.open) return false;
    try {
      this.conn.send(data);
      return true;
    } catch {
      return false;
    }
  }

  // ── RTT ──────────────────────────────────────────────────────────────────

  recordPong(sentTime: number): void {
    const rtt = Date.now() - sentTime;
    this.scores.push(rtt);
    if (this.scores.length > SCORE_WINDOW * 2) this.scores.shift();
    this.lastSeen = Date.now();
    this.bus.emit('peer:latency-update', { peerId: this.peerId, rtt });
  }

  /**
   * Average RTT over last `sampleSize` pongs.
   * Returns Infinity if no samples yet (peer should be ranked last).
   */
  getAverageRtt(sampleSize = SCORE_WINDOW): number {
    const samples = this.scores.slice(-sampleSize);
    if (samples.length === 0) return Infinity;
    return samples.reduce((a, b) => a + b, 0) / samples.length;
  }

  getScores(): readonly number[] {
    return this.scores;
  }

  // ── Rooms ────────────────────────────────────────────────────────────────

  addRoom(roomId: string): void    { this.rooms.add(roomId); }
  removeRoom(roomId: string): void { this.rooms.delete(roomId); }
  getRooms(): ReadonlySet<string>  { return this.rooms; }

  // ── State ─────────────────────────────────────────────────────────────────

  isOpen():     boolean { return !this.disposed && this.conn.open; }
  isDisposed(): boolean { return this.disposed; }
  getLastSeen(): number { return this.lastSeen; }

  touchLastSeen(): void { this.lastSeen = Date.now(); }

  getRawConn(): DataConnection { return this.conn; }

  // ── Dispose ──────────────────────────────────────────────────────────────

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try { this.conn.close(); } catch {}
    this.bus.emit('peer:offline', { peerId: this.peerId });
  }
}
