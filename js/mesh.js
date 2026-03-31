/**
 * mesh.js — Tree-based P2P topology
 *
 * Each node maintains:
 *   parentId / parentConn    — upstream peer (null = root)
 *   grandparentId            — parent's parent; used for upstream reconnect after parent loss
 *   childIds[]               — up to SOFT_CHILD_LIMIT official children (ranked by RTT)
 *   backupId / backupConn    — random redundancy peer (not shown in topology)
 *   distanceFromRoot         — hops from root (0 = root)
 *   clusterMap               — { peerId → { distance, connCount, name, descendantCount } }
 *   recoveryLock             — timestamp ms until which no new recovery is started
 *   rebalanceTimer           — setInterval handle for background rebalancing
 *
 * ── Failover (onParentLost) ───────────────────────────────────────────────────
 *  When B loses parent A:
 *   1. B clears parentId. B keeps all its own children — tree stays intact below B.
 *   2. B notifies its siblings (parent_lost) so they can reconnect independently.
 *   3. B tries to connect to grandparent first (fastest re-integration path).
 *   4. If grandparent unreachable → RECOVER_PROCEDURE.
 *
 * ── RECOVER_PROCEDURE ─────────────────────────────────────────────────────────
 *  B iterates known non-descendant peers, sends descendant_count_request to each.
 *  Priority = (descendantCount, nodeId) — larger wins.
 *  if target.priority > mine → we attach upward (adopt_request to target)
 *  if mine > target → we pull target down (send connect_to_me; become root meanwhile)
 *  Recovery lock for RECOVERY_LOCK_MS prevents oscillation after a decision.
 *
 * ── Background Rebalancing ────────────────────────────────────────────────────
 *  Every REBALANCE_INTERVAL ms: if |myDescendants - peer's| > REBALANCE_THRESHOLD
 *  and no lock is active, apply the same deterministic priority rule.
 */

import {
  RECONNECT_DELAY,
  SOFT_CHILD_LIMIT, HARD_CHILD_LIMIT,
  RECOVERY_LOCK_MS, REBALANCE_INTERVAL, REBALANCE_THRESHOLD,
} from './constants.js';
import { state } from './state.js';
import { saveStorage } from './storage.js';

// ─── TOTAL CONNECTION COUNT ───────────────────────────────────────────────────
export function totalConnCount(rid) {
  const r = state.rooms[rid]; if (!r) return 0;
  let n = r.childIds.length;
  if (r.parentId) n++;
  if (r.backupId) n++;
  return n;
}

// ─── DESCENDANT COUNT ─────────────────────────────────────────────────────────
function myDescendantCount(rid) {
  const r = state.rooms[rid]; if (!r) return 1;
  let count = 1;
  for (const cid of r.childIds) {
    count += r.clusterMap[cid]?.descendantCount ?? 1;
  }
  return count;
}

// ─── PRIORITY ─────────────────────────────────────────────────────────────────
// Deterministic: larger descendantCount wins; tie-break by nodeId (lexicographic).
function priorityHigherThan(aDC, aId, bDC, bId) {
  if (aDC !== bDC) return aDC > bDC;
  return aId > bId;
}

// ─── PARENT SCORE (for initial join) ─────────────────────────────────────────
function parentScore(entry) {
  return -(entry.distance * 1000 + entry.connCount);
}

// ─── JOIN CLUSTER ─────────────────────────────────────────────────────────────
export function findAndJoinParent(rid) {
  const r = state.rooms[rid]; if (!r) return;
  const candidates = Object.entries(r.clusterMap)
    .filter(([pid, e]) => pid !== state.myId && e.connCount < SOFT_CHILD_LIMIT)
    .sort(([, a], [, b]) => parentScore(b) - parentScore(a))
    .map(([pid]) => pid);

  if (!candidates.length) { becomeRoot(rid); return; }
  tryParentCandidates(rid, candidates, 0);
}

function tryParentCandidates(rid, candidates, idx) {
  if (idx >= candidates.length) { becomeRoot(rid); return; }
  const r = state.rooms[rid]; if (!r) { becomeRoot(rid); return; }
  const pid = candidates[idx];

  // Skip peers that are already our children — connecting to them as a parent
  // would create a cycle (we'd be both parent and child of the same node).
  if (r.childIds.includes(pid)) {
    tryParentCandidates(rid, candidates, idx + 1);
    return;
  }

  state.cb.connectTo?.(pid, conn => {
    conn.send({ type: 'adopt_request', roomId: rid, id: state.myId, name: state.myName });
  }, () => {
    setTimeout(() => tryParentCandidates(rid, candidates, idx + 1), RECONNECT_DELAY);
  });
}

export function becomeRoot(rid) {
  const r = state.rooms[rid]; if (!r) return;
  const wasAlreadyRoot = r.parentId === null && r.distanceFromRoot === 0 && !r.grandparentId;
  r.parentId         = null;
  r.parentConn       = null;
  r.grandparentId    = null;
  r.distanceFromRoot = 0;
  updateClusterMapSelf(rid);
  broadcastClusterMap(rid);
  if (rid === state.activeRoomId) {
    if (!wasAlreadyRoot) state.cb.toast?.("You're the room root!", 'success');
    state.cb.updateNetworkPanel?.();
  }
  state.cb.flushPendingMessages?.(rid);
  state.cb.startLocalElection?.(rid);
  // Always (re)start rebalancing — this is the fix for the phantom-root case
  // where the node is already distance-0 but has no children and peers are online.
  startRebalancing(rid);
}

// ─── ADOPT REQUEST / RESPONSE ─────────────────────────────────────────────────
export function handleAdoptRequest(data, conn) {
  const rid = data.roomId, pid = conn.peer;
  const r   = state.rooms[rid]; if (!r) return;

  // Cycle guard: reject if the requester is already our ancestor.
  // Walk up our own parent chain; if we hit pid, accepting would create a cycle.
  let cursor = r.parentId;
  let steps  = 0;
  while (cursor && steps < 20) {
    if (cursor === pid) {
      // pid is our ancestor — accepting it as a child would create a cycle.
      conn.send({ type: 'adopt_reject', roomId: rid, reason: 'cycle' });
      return;
    }
    // We can only walk as far as direct parent; for deeper ancestors we rely
    // on distanceFromRoot heuristic: if pid claims distance <= ours it cannot
    // be our descendant but might be an ancestor.
    break;
  }

  // Use hard limit during recovery, soft limit otherwise
  const limit = r.recoveryLock > Date.now() ? HARD_CHILD_LIMIT : SOFT_CHILD_LIMIT;
  if (r.childIds.length >= limit) {
    conn.send({ type: 'adopt_redirect', roomId: rid, targetId: leastLoadedChild(rid) || null });
    return;
  }

  addChild(rid, pid, conn);
  conn.send({
    type:             'adopt_ack',
    roomId:           rid,
    parentId:         state.myId,
    grandparentId:    r.parentId,   // child stores this for upstream reconnect on parent loss
    distanceFromRoot: r.distanceFromRoot + 1,
    clusterMap:       r.clusterMap,
    siblings:         r.childIds.filter(id => id !== pid),
    electionEpoch:    r.electionEpoch,
  });
  broadcastChildList(rid);
  broadcastClusterMap(rid);
  updateClusterMapSelf(rid);
}

export function handleAdoptAck(data, conn) {
  const rid = data.roomId;
  const r   = state.rooms[rid]; if (!r) return;

  // If we already have a different parent (race: two adopt_acks arrived),
  // reject this one to avoid cycles or double-parenting.
  if (r.parentId && r.parentId !== data.parentId) {
    try { conn.send({ type: 'adopt_reject', roomId: rid, reason: 'already_parented' }); } catch {}
    return;
  }

  r.parentId         = data.parentId;
  r.parentConn       = conn;
  r.grandparentId    = data.grandparentId ?? null;
  r.distanceFromRoot = data.distanceFromRoot;
  r.electionEpoch    = data.electionEpoch;

  if (data.clusterMap) {
    r.clusterMap = { ...data.clusterMap, ...r.clusterMap };
    for (const [pid, entry] of Object.entries(r.clusterMap)) {
      if (pid !== state.myId && !r.peers[pid]) {
        r.peers[pid] = { id: pid, name: entry.name || pid };
      }
    }
  }
  updateClusterMapSelf(rid);
  pickBackupPeer(rid);

  if (rid === state.activeRoomId) {
    import('./ui.js').then(ui => {
      ui.setStatus('connected', 'connected');
      ui.renderRoomSidebar();
      ui.updateNetworkPanel();
    });
  }
  state.cb.flushPendingMessages?.(rid);
  state.cb.startLocalElection?.(rid);
  startRebalancing(rid);
}

export function handleAdoptRedirect(data) {
  const rid = data.roomId;
  if (!data.targetId) { becomeRoot(rid); return; }
  state.cb.connectTo?.(data.targetId, conn => {
    conn.send({ type: 'adopt_request', roomId: rid, id: state.myId, name: state.myName });
  }, () => becomeRoot(rid));
}

// Peer rejected our adopt_request (cycle detected or already parented).
// Run recovery so we find a valid parent rather than hanging.
export function handleAdoptReject(data) {
  const rid = data.roomId, r = state.rooms[rid]; if (!r) return;
  if (r.parentId) return; // already found a parent via another path
  recoverProcedure(rid);
}

// ─── CHILD LIST BROADCAST ─────────────────────────────────────────────────────
function broadcastChildList(rid) {
  const r = state.rooms[rid]; if (!r) return;
  const ranked = r.childIds.map(pid => {
    const pc  = state.peerConns[pid];
    const rtt = pc?.scores?.length
      ? pc.scores.slice(-3).reduce((a, b) => a + b, 0) / Math.min(3, pc.scores.length)
      : 9999;
    return { pid, rtt };
  }).sort((a, b) => a.rtt - b.rtt);

  const msg = {
    type:      'child_list',
    roomId:    rid,
    children:  ranked.map(e => e.pid),
    bestChild: ranked[0]?.pid ?? null,
  };
  sendToAllChildren(rid, msg);

  if (r.parentConn?.open) {
    try {
      r.parentConn.send({
        type:            'child_count_update',
        roomId:          rid,
        count:           r.childIds.length,
        id:              state.myId,
        descendantCount: myDescendantCount(rid),
      });
    } catch {}
  }
}

export function handleChildList(data) {
  const r = state.rooms[data.roomId]; if (!r) return;
  r.siblings    = (data.children || []).filter(id => id !== state.myId);
  r.bestSibling = data.bestChild !== state.myId ? data.bestChild : (r.siblings[0] ?? null);
}

// ─── PEER DISCONNECT ─────────────────────────────────────────────────────────
export function handlePeerDisconnect(pid) {
  const pc = state.peerConns[pid]; if (!pc) return;
  const roomsAffected = [...(pc.rooms || [])];
  delete state.peerConns[pid];

  for (const rid of roomsAffected) {
    const r = state.rooms[rid]; if (!r) continue;
    delete r.clusterMap[pid];
    delete r.peers[pid];

    if (pid === r.parentId)            onParentLost(rid);
    else if (r.childIds.includes(pid)) onChildLost(rid, pid);
    else if (pid === r.backupId)       { r.backupId = null; r.backupConn = null; pickBackupPeer(rid); }
  }
  state.cb.renderTopology?.();
  state.cb.updateNetworkPanel?.();
}

// ─── PARENT LOST ─────────────────────────────────────────────────────────────
function onParentLost(rid) {
  const r = state.rooms[rid]; if (!r) return;

  // Recovery lock: ignore if a recovery is already in flight
  if (r.recoveryLock > Date.now()) return;
  r.recoveryLock = Date.now() + RECOVERY_LOCK_MS;

  const lostParentId  = r.parentId;
  const grandparentId = r.grandparentId;

  // Clear upstream state. Our children stay our children — we do NOT promote them.
  r.parentId         = null;
  r.parentConn       = null;
  r.grandparentId    = null;
  r.distanceFromRoot = 0;   // unknown until reconnected; 0 is a safe temporary value
  updateClusterMapSelf(rid);

  if (rid === state.activeRoomId) {
    state.cb.toast?.('Parent disconnected — reconnecting…', 'info');
    import('./ui.js').then(ui => ui.setStatus('searching', 'reconnecting…'));
  }

  // Notify siblings so they can run their own recovery concurrently
  for (const sibId of (r.siblings || [])) {
    const sibConn = state.peerConns[sibId]?.conn;
    if (sibConn?.open) {
      try {
        sibConn.send({ type: 'parent_lost', roomId: rid, lostParentId, newCandidate: state.myId });
      } catch {}
    }
  }

  // Step 1: try grandparent directly (fastest path back into the tree)
  if (grandparentId) {
    state.cb.connectTo?.(grandparentId, conn => {
      conn.send({ type: 'adopt_request', roomId: rid, id: state.myId, name: state.myName });
    }, () => recoverProcedure(rid));
    return;
  }

  // No grandparent known → full recovery
  recoverProcedure(rid);
}

// A sibling told us the parent is gone. Run our own recovery.
export function handleParentLost(data) {
  const rid = data.roomId;
  const r   = state.rooms[rid]; if (!r) return;
  if (r.parentId !== data.lostParentId) return;
  if (r.recoveryLock > Date.now()) return;
  onParentLost(rid);
}

// ─── RECOVER_PROCEDURE ────────────────────────────────────────────────────────
function recoverProcedure(rid) {
  const r = state.rooms[rid]; if (!r) return;

  const myDC          = myDescendantCount(rid);
  const myDescendants = getDescendantIds(rid);

  // Candidates: known peers that are not us and not our descendants
  const candidates = Object.keys(r.clusterMap).filter(pid =>
    pid !== state.myId && !myDescendants.has(pid)
  );

  if (!candidates.length) { becomeRoot(rid); return; }

  const pending = new Set(candidates.slice(0, 5));
  const results = {};   // pid → descendantCount
  let decided   = false;

  const decide = () => {
    if (decided) return;
    decided = true;

    if (!Object.keys(results).length) { becomeRoot(rid); return; }

    // Find highest-priority candidate
    let bestPid = null, bestDC = -1;
    for (const [pid, dc] of Object.entries(results)) {
      if (priorityHigherThan(dc, pid, bestDC, bestPid ?? '')) {
        bestDC = dc; bestPid = pid;
      }
    }

    r.recoveryLock = Date.now() + RECOVERY_LOCK_MS;

    if (priorityHigherThan(bestDC, bestPid, myDC, state.myId)) {
      // Target wins → we attach upward
      state.cb.connectTo?.(bestPid, conn => {
        conn.send({ type: 'adopt_request', roomId: rid, id: state.myId, name: state.myName });
      }, () => becomeRoot(rid));
    } else {
      // We win → pull target down, become root in the meantime
      const conn = state.peerConns[bestPid]?.conn;
      const doConnect = c => {
        try { c.send({ type: 'connect_to_me', roomId: rid, id: state.myId, name: state.myName }); } catch {}
      };
      if (conn?.open) doConnect(conn);
      else state.cb.connectTo?.(bestPid, doConnect, () => {});
      becomeRoot(rid);
    }
  };

  // Request descendant counts; decide after 2 s or when all replied
  const collectTimer = setTimeout(decide, 2000);
  r._recoverCollect = (respPid, dc) => {
    results[respPid] = dc;
    pending.delete(respPid);
    if (pending.size === 0) { clearTimeout(collectTimer); decide(); }
  };

  for (const pid of pending) {
    const conn = state.peerConns[pid]?.conn;
    const req  = c => {
      try { c.send({ type: 'descendant_count_request', roomId: rid, requesterId: state.myId }); } catch {}
    };
    if (conn?.open) req(conn);
    else {
      state.cb.connectTo?.(pid, req, () => {
        pending.delete(pid);
        if (pending.size === 0) { clearTimeout(collectTimer); decide(); }
      });
    }
  }
}

export function handleDescendantCountRequest(data, conn) {
  const rid = data.roomId, r = state.rooms[rid]; if (!r) return;
  try {
    conn.send({
      type:            'descendant_count_response',
      roomId:          rid,
      requesterId:     data.requesterId,
      responderId:     state.myId,
      descendantCount: myDescendantCount(rid),
    });
  } catch {}
}

export function handleDescendantCountResponse(data) {
  const rid = data.roomId, r = state.rooms[rid]; if (!r) return;
  if (data.requesterId !== state.myId) return;
  r._recoverCollect?.(data.responderId, data.descendantCount);
}

// ─── CONNECT_TO_ME ────────────────────────────────────────────────────────────
// A higher-priority peer wants us to attach as its child.
export function handleConnectToMe(data) {
  const rid = data.roomId, r = state.rooms[rid]; if (!r) return;
  if (r.recoveryLock > Date.now()) return;
  state.cb.connectTo?.(data.id, conn => {
    conn.send({ type: 'adopt_request', roomId: rid, id: state.myId, name: state.myName });
  }, () => {});
}

// ─── BECOME_PARENT ────────────────────────────────────────────────────────────
// Sent by a parent promoting one of its children (e.g. during a graceful leave).
// The promoted node keeps its own children and accepts siblings.
export function handleBecomeParent(data) {
  const rid = data.roomId;
  const r   = state.rooms[rid]; if (!r) return;

  r.parentId         = null;
  r.parentConn       = null;
  r.grandparentId    = null;
  r.distanceFromRoot = data.distanceFromRoot ?? r.distanceFromRoot;
  updateClusterMapSelf(rid);

  // Accept siblings as additional children
  for (const sibId of (data.siblings || [])) {
    const sibConn = state.peerConns[sibId]?.conn;
    if (sibConn?.open) {
      try { sibConn.send({ type: 'adopt_request', roomId: rid, id: state.myId, name: state.myName }); } catch {}
    } else {
      state.cb.connectTo?.(sibId, sc => {
        sc.send({ type: 'adopt_request', roomId: rid, id: state.myId, name: state.myName });
      }, () => {});
    }
  }

  if (rid === state.activeRoomId) {
    import('./ui.js').then(ui => { ui.setStatus('server', 'parent'); ui.updateNetworkPanel?.(); });
  }
  state.cb.startLocalElection?.(rid);
  startRebalancing(rid);
}

// ─── REASSIGN_PARENT ─────────────────────────────────────────────────────────
// Sent to a child when we are overloaded and want it to find a new parent.
export function handleReassignParent(data) {
  const rid = data.roomId, r = state.rooms[rid]; if (!r) return;
  if (r.recoveryLock > Date.now()) return;
  state.cb.connectTo?.(data.newParentId, conn => {
    conn.send({ type: 'adopt_request', roomId: rid, id: state.myId, name: state.myName });
  }, () => {});
}

// ─── TOPOLOGY_REQUEST ─────────────────────────────────────────────────────────
export function handleTopologyRequest(data, conn) {
  const rid = data.roomId, r = state.rooms[rid]; if (!r) return;
  updateClusterMapSelf(rid);
  conn.send({ type: 'cluster_map', roomId: rid, map: r.clusterMap });
}

// ─── CHILD LOST ───────────────────────────────────────────────────────────────
function onChildLost(rid, pid) {
  const r = state.rooms[rid]; if (!r) return;
  r.childIds = r.childIds.filter(id => id !== pid);
  delete r.childConns[pid];
  delete r.clusterMap[pid];
  broadcastChildList(rid);
  broadcastClusterMap(rid);
  updateClusterMapSelf(rid);
}

// ─── RECONNECT (on peer startup) ─────────────────────────────────────────────
function rejoinCluster(rid) {
  const r = state.rooms[rid]; if (!r) return;
  const toTry = r.savedPeers.filter(id =>
    id !== state.myId && !(state.peerConns[id]?.conn?.open)
  );
  if (!toTry.length) { becomeRoot(rid); return; }

  let tried = false;
  for (const pid of toTry.slice(0, 3)) {
    state.cb.connectTo?.(pid, conn => {
      if (tried) return; tried = true;
      conn.send({ type: 'cluster_map_request', roomId: rid, id: state.myId, name: state.myName });
    }, () => {});
  }
  setTimeout(() => {
    const room = state.rooms[rid];
    if (room && !room.parentId && !room.childIds.length) becomeRoot(rid);
  }, 5000);
}

export function attemptRoomReconnect(rid) {
  const r = state.rooms[rid]; if (!r) return;
  const toTry = r.savedPeers.filter(id =>
    id !== state.myId && !(state.peerConns[id]?.conn?.open)
  );
  if (!toTry.length) return;

  r.parentId         = null;
  r.parentConn       = null;
  r.grandparentId    = null;
  r.distanceFromRoot = 0;

  let gotResponse = false;
  toTry.slice(0, 3).forEach(id => {
    state.cb.connectTo?.(id, conn => {
      if (!gotResponse) {
        gotResponse = true;
        conn.send({ type: 'cluster_map_request', roomId: rid, id: state.myId, name: state.myName });
      }
    }, () => {});
  });

  setTimeout(() => {
    const room = state.rooms[rid];
    if (!room) return;
    if (!room.parentId && !room.childIds.length) {
      // Still isolated after 6 s — run recoverProcedure if we know any peers,
      // otherwise officially become root.
      const knownPeers = Object.keys(room.clusterMap).filter(pid => pid !== state.myId);
      if (knownPeers.length) {
        recoverProcedure(rid);
      } else {
        becomeRoot(rid);
      }
    }
  }, 6000);
}

// ─── BACKGROUND REBALANCING ───────────────────────────────────────────────────
function startRebalancing(rid) {
  const r = state.rooms[rid]; if (!r) return;
  if (r.rebalanceTimer) clearInterval(r.rebalanceTimer);
  r.rebalanceTimer = setInterval(() => doRebalance(rid), REBALANCE_INTERVAL);
}

function doRebalance(rid) {
  const r = state.rooms[rid]; if (!r) return;
  if (r.recoveryLock > Date.now()) return;

  const myDC          = myDescendantCount(rid);
  const myDescendants = getDescendantIds(rid);

  const candidates = Object.entries(r.clusterMap)
    .filter(([pid, e]) =>
      pid !== state.myId &&
      !myDescendants.has(pid) &&
      e.descendantCount !== undefined &&
      Math.abs((e.descendantCount ?? 0) - myDC) > REBALANCE_THRESHOLD
    )
    .sort(([, a], [, b]) =>
      Math.abs((b.descendantCount ?? 0) - myDC) - Math.abs((a.descendantCount ?? 0) - myDC)
    );

  if (!candidates.length) return;
  const [bestPid, bestEntry] = candidates[0];
  const targetDC = bestEntry.descendantCount ?? 0;

  r.recoveryLock = Date.now() + RECOVERY_LOCK_MS;

  if (priorityHigherThan(targetDC, bestPid, myDC, state.myId)) {
    state.cb.connectTo?.(bestPid, conn => {
      conn.send({ type: 'adopt_request', roomId: rid, id: state.myId, name: state.myName });
    }, () => { r.recoveryLock = 0; });
  } else {
    const conn = state.peerConns[bestPid]?.conn;
    if (conn?.open) {
      try { conn.send({ type: 'connect_to_me', roomId: rid, id: state.myId, name: state.myName }); } catch {}
    }
  }
}

// ─── CLUSTER MAP ─────────────────────────────────────────────────────────────
export function updateClusterMapSelf(rid) {
  const r = state.rooms[rid]; if (!r) return;
  r.clusterMap[state.myId] = {
    name:            state.myName,
    distance:        r.distanceFromRoot,
    connCount:       totalConnCount(rid),
    descendantCount: myDescendantCount(rid),
  };
}

export function broadcastClusterMap(rid) {
  const r = state.rooms[rid]; if (!r) return;
  const msg = { type: 'cluster_map', roomId: rid, map: r.clusterMap };
  sendToAllChildren(rid, msg);
  if (r.parentConn?.open) try { r.parentConn.send(msg); } catch {}
  if (r.backupConn?.open) try { r.backupConn.send(msg); } catch {}
}

export function handleClusterMap(data) {
  const r = state.rooms[data.roomId]; if (!r || !data.map) return;
  for (const [pid, entry] of Object.entries(data.map)) {
    if (pid === state.myId) continue;
    r.clusterMap[pid] = entry;
    if (!r.peers[pid]) r.peers[pid] = { id: pid, name: entry.name || pid };
  }
  updateClusterMapSelf(data.roomId);
  if (data.roomId === state.activeRoomId) {
    import('./ui.js').then(ui => { ui.renderRoomSidebar(); ui.updatePeerCount(); });
  }
}

export function handleClusterMapRequest(data, conn) {
  const rid = data.roomId, r = state.rooms[rid]; if (!r) return;
  updateClusterMapSelf(rid);
  if (!r.peers[conn.peer]) r.peers[conn.peer] = { name: data.name || conn.peer };
  if (state.peerConns[conn.peer]) state.peerConns[conn.peer].rooms.add(rid);
  conn.send({ type: 'cluster_map', roomId: rid, map: r.clusterMap });
  state.cb.sendHandshake?.(conn, rid, r);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
export function addChild(rid, pid, conn) {
  const r = state.rooms[rid]; if (!r) return;
  if (!r.childIds.includes(pid)) r.childIds.push(pid);
  r.childConns[pid] = conn;
  if (!r.peers[pid]) r.peers[pid] = { name: pid };
  if (state.peerConns[pid]) state.peerConns[pid].rooms.add(rid);
  savePeerToRoom(rid, pid);
  updateClusterMapSelf(rid);
}

function leastLoadedChild(rid) {
  const r = state.rooms[rid]; if (!r || !r.childIds.length) return null;
  return r.childIds.reduce((best, pid) => {
    const be = r.clusterMap[best], ce = r.clusterMap[pid];
    return (ce?.connCount ?? 99) < (be?.connCount ?? 99) ? pid : best;
  }, r.childIds[0]);
}

function getDescendantIds(rid) {
  const r = state.rooms[rid];
  const result = new Set();
  if (!r) return result;
  // Direct children only — we don't have exact subtree lists for indirect nodes
  for (const cid of r.childIds) result.add(cid);
  return result;
}

function sendToAllChildren(rid, msg, excludePid = null) {
  const r = state.rooms[rid]; if (!r) return;
  for (const pid of r.childIds) {
    if (pid === excludePid) continue;
    const conn = r.childConns[pid] || state.peerConns[pid]?.conn;
    if (conn?.open) try { conn.send(msg); } catch {}
  }
}

export function sendToAllChildrenPublic(rid, msg, excludePid = null) {
  sendToAllChildren(rid, msg, excludePid);
}

function pickBackupPeer(rid) {
  const r = state.rooms[rid]; if (!r) return;
  const exclude = new Set([state.myId, r.parentId, ...r.childIds]);
  const candidates = Object.keys(r.clusterMap).filter(id => !exclude.has(id));
  if (!candidates.length) return;
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  if (chosen === r.backupId) return;
  r.backupId = chosen;
  state.cb.connectTo?.(chosen, conn => {
    r.backupConn = conn;
    if (state.peerConns[chosen]) state.peerConns[chosen].rooms.add(rid);
  }, () => { r.backupId = null; });
}

export function savePeerToRoom(rid, pid) {
  const r = state.rooms[rid]; if (!r || !pid) return;
  if (!r.savedPeers.includes(pid)) {
    r.savedPeers.unshift(pid);
    if (r.savedPeers.length > 100) r.savedPeers.pop();
    saveStorage();
  }
}

export function roomIsRoot(rid) {
  const r = state.rooms[rid]; return r ? r.parentId === null : false;
}
