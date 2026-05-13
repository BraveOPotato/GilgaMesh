/**
 * src/network/topology-scout.ts — Cluster map discovery before join.
 *
 * Opens a temporary scout connection to a known peer, requests the
 * cluster_map, closes the connection, and returns the map.
 * The joiner is invisible to the cluster until adopt_request is sent.
 */

import type { PeerId, RoomId } from '../core/events.js';
import type { Result } from '../core/types.js';
import { ok, err } from '../core/types.js';
import type { PeerRegistry } from './peer-registry.js';
import type { ClusterMapEntry } from '../core/state/rooms.js';
import { identityStore } from '../core/state/identity.js';
import { CONN_TIMEOUT } from '../core/constants.js';

export type ScoutError = 'invalid_target' | 'connection_failed' | 'timeout' | 'existing_conn';

export class TopologyScout {
  constructor(private readonly registry: PeerRegistry) {}

  /**
   * Scout the cluster map from `targetId` for `roomId`.
   * Returns the map entries, or err if unreachable.
   *
   * If an existing permanent connection to targetId exists, the map request
   * is sent through it and null is returned as a signal that the map will
   * arrive via normal dispatch. Caller should handle this gracefully.
   */
  async scout(
    targetId: PeerId,
    roomId:   RoomId,
  ): Promise<Result<Record<string, ClusterMapEntry> | null, ScoutError>> {
    const { myId, myName } = identityStore.get();
    if (!myId || targetId === myId) return err('invalid_target');

    // Reuse existing permanent connection — map arrives via normal dispatch.
    const existing = this.registry.get(targetId);
    if (existing) {
      existing.send({ type: 'cluster_map_request', roomId, id: myId, name: myName });
      return ok(null); // null = map arriving via existing dispatch path
    }

    // Open a temporary scout connection.
    const scoutResult = await this.registry.scoutConnect(targetId, roomId);
    if (!scoutResult.ok) return err('connection_failed');

    const conn = scoutResult.value;

    // Wait for cluster_map response.
    return new Promise<Result<Record<string, ClusterMapEntry> | null, ScoutError>>((resolve) => {
      let settled = false;

      const hardTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { conn.close(); } catch {}
        resolve(err('timeout'));
      }, CONN_TIMEOUT);

      conn.on('data', (msg: unknown) => {
        if (settled) return;
        const m = msg as Record<string, unknown>;
        if (m['type'] === 'cluster_map' && m['roomId'] === roomId) {
          settled = true;
          clearTimeout(hardTimer);
          try { conn.close(); } catch {}
          resolve(ok(m['map'] as Record<string, ClusterMapEntry>));
        }
      });

      conn.on('error', () => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        resolve(err('connection_failed'));
      });

      conn.on('close', () => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        resolve(err('connection_failed'));
      });

      // Send map request now that connection is open (scoutConnect waited for open).
      conn.send({ type: 'cluster_map_request', roomId, id: myId, name: myName });
    });
  }

  /**
   * Retry scout up to `maxAttempts` times with `intervalMs` between tries.
   */
  async scoutWithRetry(
    targetId:    PeerId,
    roomId:      RoomId,
    maxAttempts  = 6,
    intervalMs   = 200,
  ): Promise<Result<Record<string, ClusterMapEntry> | null, ScoutError>> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      console.log(`[TopologyScout:${roomId}] attempt ${attempt}/${maxAttempts} via ${targetId}`);
      const result = await this.scout(targetId, roomId);
      if (result.ok) return result;
      if (attempt < maxAttempts) {
        await delay(intervalMs);
      }
    }
    return err('timeout');
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
