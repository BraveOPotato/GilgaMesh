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
// Priority: shortest distance from root first (fan, not chain).
// Among equal-distance nodes, prefer fewest children (most capacity).
// Uses explicit childCount so parent/backup slots don't skew capacity math.
function parentScore(entry) {
  const children = entry.childCount ?? entry.connCount; // fall back for old map entries
  return -(entry.distance * 10000 + children);
}

// ─── JOIN CLUSTER ─────────────────────────────────────────────────────────────
export function findAndJoinParent(rid, { force = false, excludeIds = [] } = {}) {
  const r = state.rooms[rid]; if (!r) return;
  if (r.parentId || r.childIds.length) {
    console.log(`[mesh] findAndJoinParent(${rid}) skipped — already placed (parent=${r.parentId}, children=${r.childIds.length})`);
    return;
  }
  if (r._joiningParent && !force) {
    console.log(`[mesh] findAndJoinParent(${rid}) skipped — join already in progress`);
    return;
  }
  r._joiningParent = true;

  const excludeSet = new Set(excludeIds);
  const mapEntries = Object.entries(r.clusterMap).filter(([p]) => p !== state.myId && !excludeSet.has(p));
  if (excludeSet.size) {
    console.log(`[mesh] findAndJoinParent(${rid}) — excluding recently-evicted peers: ${[...excludeSet].join(', ')}`);
  }
  console.log(`[mesh] findAndJoinParent(${rid}) — clusterMap has ${mapEntries.length} peers:`,
    mapEntries.map(([p, e]) => `${e.name||p}(dist=${e.distance},children=${e.childCount??e.connCount??'?'})`).join(', ') || '(none)');

  const candidates = mapEntries
    .filter(([pid, e]) => {
      const children = e.childCount ?? Math.max(0, e.connCount - (e.distance === 0 ? 0 : 1));
      return children < SOFT_CHILD_LIMIT;
    })
    .sort(([, a], [, b]) => parentScore(b) - parentScore(a))
    .map(([pid]) => pid);

  // Voice-aware sort: same channel first, then non-voice nodes, then other-channel nodes
  const myVcId = r.myVoiceChannelId || null;
  const sortedCandidates = myVcId ? candidates.sort((a, b) => {
    const aVc = r.clusterMap[a]?.voiceChannelId || null;
    const bVc = r.clusterMap[b]?.voiceChannelId || null;
    const aScore = aVc === myVcId ? 0 : (aVc === null ? 1 : 2);
    const bScore = bVc === myVcId ? 0 : (bVc === null ? 1 : 2);
    return aScore - bScore;
  }) : candidates;

  console.log(`[mesh] findAndJoinParent(${rid}) — ${sortedCandidates.length} eligible candidates (voice=${myVcId||'none'}):`, sortedCandidates.join(', ') || '(none)');

  if (!sortedCandidates.length) {
    r._joiningParent = false;
    // Explain exactly why each map entry was rejected
    const rejections = mapEntries.map(([pid, e]) => {
      const children = e.childCount ?? Math.max(0, e.connCount - (e.distance === 0 ? 0 : 1));
      return `${e.name||pid}(dist=${e.distance},childCount=${e.childCount??'undef'},connCount=${e.connCount??'undef'},computed=${children},limit=${SOFT_CHILD_LIMIT},full=${children >= SOFT_CHILD_LIMIT})`;
    });
    console.log(`[mesh] findAndJoinParent(${rid}) — NO ELIGIBLE CANDIDATES. Rejections:`, rejections.join(' | ') || '(clusterMap was empty)');
    becomeRoot(rid); return;
  }
  tryParentCandidates(rid, sortedCandidates, 0);
}

function tryParentCandidates(rid, candidates, idx) {
  const r = state.rooms[rid];
  if (idx >= candidates.length) {
    console.log(`[mesh] tryParentCandidates(${rid}) — exhausted all ${candidates.length} candidates, calling becomeRoot`);
    if (r) r._joiningParent = false;
    becomeRoot(rid); return;
  }
  if (!r) { becomeRoot(rid); return; }

  if (r.parentId) {
    console.log(`[mesh] tryParentCandidates(${rid}) — already have parent ${r.parentId}, aborting`);
    r._joiningParent = false; return;
  }

  const pid = candidates[idx];

  if (r.childIds.includes(pid)) {
    console.log(`[mesh] tryParentCandidates(${rid}) — skipping ${pid} (already our child)`);
    tryParentCandidates(rid, candidates, idx + 1);
    return;
  }

  console.log(`[mesh] tryParentCandidates(${rid}) — trying candidate [${idx}] ${pid}`);
  state.cb.connectTo?.(pid, conn => {
    const rr = state.rooms[rid];
    if (rr?.parentId) {
      console.log(`[mesh] tryParentCandidates(${rid}) — connected to ${pid} but already parented to ${rr.parentId}, aborting`);
      rr._joiningParent = false; return;
    }
    console.log(`[mesh] tryParentCandidates(${rid}) — connected to ${pid}, sending adopt_request`);
    conn.send({ type: 'adopt_request', roomId: rid, id: state.myId, name: state.myName, voiceChannelId: state.rooms[rid]?.myVoiceChannelId || null });
  }, () => {
    console.log(`[mesh] tryParentCandidates(${rid}) — connect to ${pid} failed, trying next`);
    setTimeout(() => tryParentCandidates(rid, candidates, idx + 1), RECONNECT_DELAY);
  });
}

export function becomeRoot(rid) {
  const r = state.rooms[rid]; if (!r) return;

  // Never become root if a join is actively in progress — the adopt flow
  // will resolve shortly and calling becomeRoot now would clobber it.
  if (r._joiningParent) return;

  // Never become root if there are live open connections to peers we know
  // belong to this room, OR peers listed in our clusterMap (which means
  // the cluster exists even if pc.rooms hasn't been updated yet).
  // pc.rooms may not contain rid yet if the connection was just established
  // for the cluster_map_request before handleClusterMapRequest ran.
  // Check 1: live open peerConns that belong to this room
  const livePeerEntries = Object.entries(state.peerConns).filter(([pid, pc]) => {
    if (!pc?.conn?.open || pid === state.myId) return false;
    return pc.rooms?.has(rid) || r.clusterMap?.[pid];
  });

  // Check 2: clusterMap has entries from OTHER peers — even if the scout conn
  // has already closed, the map entries tell us the cluster exists.
  // Only skip this check if we were explicitly created as the room's first node
  // (createdBy === myId), which means WE are legitimately the root.
  const clusterPeersInMap = Object.keys(r.clusterMap).filter(p => p !== state.myId);
  const clusterExistsInMap = clusterPeersInMap.length > 0 && r.createdBy !== state.myId;

  const hasLivePeer = livePeerEntries.length > 0;
  const shouldSuppress = hasLivePeer || clusterExistsInMap;

  if (shouldSuppress) {
    const reason = hasLivePeer
      ? `${livePeerEntries.length} live peerConn(s): ${livePeerEntries.map(([p])=>p).join(', ')}`
      : `clusterMap has ${clusterPeersInMap.length} peer(s) and we didn't create this room`;

    r._becomeRootRetries = (r._becomeRootRetries || 0) + 1;
    const MAX_RETRIES = 8;

    if (r._becomeRootRetries > MAX_RETRIES) {
      // We've been trying for a long time and still can't attach.
      // Clear the clusterMap so we stop thinking a cluster exists,
      // then become root. The rebalancer will re-integrate us if peers reconnect.
      console.warn(`[mesh] becomeRoot(${rid}) — suppressed ${r._becomeRootRetries}x but still can't attach. Clearing stale clusterMap and becoming root.`);
      r._becomeRootRetries = 0;
      for (const pid of clusterPeersInMap) {
        const pc = state.peerConns[pid];
        if (!pc?.conn?.open) delete r.clusterMap[pid];
      }
      // Fall through to become root below
    } else {
      const delay = Math.min(500 * Math.pow(1.5, r._becomeRootRetries - 1), 8000);
      console.log(`[mesh] becomeRoot(${rid}) SUPPRESSED (attempt ${r._becomeRootRetries}/${MAX_RETRIES}) — ${reason} — retrying findAndJoinParent in ${Math.round(delay)}ms`);
      if (!r.parentId && !r.childIds.length) {
        setTimeout(() => findAndJoinParent(rid), delay);
      }
      return;
    }
  }

  r._joiningParent   = false;
  const wasAlreadyRoot = r.parentId === null && r.distanceFromRoot === 0 && !r.grandparentId;
  if (!wasAlreadyRoot) {
    // Log exactly why we passed all guards and became root
    const clusterPeers = Object.keys(r.clusterMap).filter(p => p !== state.myId);
    const openConns = Object.entries(state.peerConns)
      .filter(([pid, pc]) => pc?.conn?.open && pid !== state.myId)
      .map(([pid]) => pid);
    console.log(`[mesh] becomeRoot(${rid}) — BECOMING ROOT`,
      `| clusterMap peers: ${clusterPeers.join(', ') || '(none)'}`,
      `| open peerConns: ${openConns.join(', ') || '(none)'}`,
      `| _joiningParent was: ${r._joiningParent}`);
  }
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

  // Use hard limit during recovery, soft limit (7) otherwise
  const limit = r.recoveryLock > Date.now() ? HARD_CHILD_LIMIT : SOFT_CHILD_LIMIT;
  if (r.childIds.length >= limit) {
    // Find the best available node in the whole cluster: closest to root,
    // fewest children, with room to spare. This ensures BFS-style fan-out
    // rather than bouncing the newcomer between random full nodes.
    const available = Object.entries(r.clusterMap)
      .filter(([pid, e]) => {
        if (pid === state.myId || pid === conn.peer) return false;
        const children = e.childCount ?? Math.max(0, e.connCount - (e.distance === 0 ? 0 : 1));
        return children < SOFT_CHILD_LIMIT;
      })
      .sort(([, a], [, b]) => {
        if (a.distance !== b.distance) return a.distance - b.distance;
        const ac = a.childCount ?? a.connCount;
        const bc = b.childCount ?? b.connCount;
        return ac - bc;
      });
    const target = available[0]?.[0] ?? null;
    console.log(`[mesh] handleAdoptRequest(${rid}) — full (${r.childIds.length} children), redirecting ${pid} to ${target || '(none)'}`);
    conn.send({ type: 'adopt_redirect', roomId: rid, targetId: target });
    return;
  }

  console.log(`[mesh] handleAdoptRequest(${rid}) — accepting ${pid} as child (now ${r.childIds.length + 1} children)`);
  // Voice affinity check — voice nodes only accept same-channel children
  const requesterVcId = data.voiceChannelId || null;
  import('./voice.js').then(voice => {
    const affinity = voice.checkVoiceAdoptAffinity(rid, requesterVcId, conn);
    if (!affinity.allow) {
      console.log(`[mesh] handleAdoptRequest(${rid}) — voice affinity mismatch (${affinity.reason}), redirecting to ${affinity.redirectTo || '(none)'}`);
      conn.send({ type: 'adopt_redirect', roomId: rid, targetId: affinity.redirectTo });
      return;
    }
    _doAddChild(rid, pid, conn, data);
  });
}

// Internal: complete adoption after voice affinity check passes
function _doAddChild(rid, pid, conn, data) {
  const r = state.rooms[rid]; if (!r) return;
  // Re-check limit (async path — state may have changed)
  const limit = r.recoveryLock > Date.now() ? HARD_CHILD_LIMIT : SOFT_CHILD_LIMIT;
  if (r.childIds.length >= limit) {
    const available = Object.entries(r.clusterMap)
      .filter(([p, e]) => {
        if (p === state.myId || p === conn.peer) return false;
        const children = e.childCount ?? Math.max(0, e.connCount - (e.distance === 0 ? 0 : 1));
        return children < SOFT_CHILD_LIMIT;
      })
      .sort(([, a], [, b]) => {
        if (a.distance !== b.distance) return a.distance - b.distance;
        return (a.childCount ?? a.connCount) - (b.childCount ?? b.connCount);
      });
    conn.send({ type: 'adopt_redirect', roomId: rid, targetId: available[0]?.[0] ?? null });
    return;
  }

  addChild(rid, pid, conn);
  updateClusterMapSelf(rid); // must happen before adopt_ack so child gets accurate childCount
  conn.send({
    type:             'adopt_ack',
    roomId:           rid,
    parentId:         state.myId,
    grandparentId:    r.parentId,
    distanceFromRoot: r.distanceFromRoot + 1,
    clusterMap:       r.clusterMap,
    siblings:         r.childIds.filter(id => id !== pid),
    electionEpoch:    r.electionEpoch,
    voiceChannels:    r.voiceChannels || [],   // propagate voice channel definitions
  });
  broadcastChildList(rid);
  broadcastClusterMap(rid);
  updateClusterMapSelf(rid); // refresh again after broadcastChildList updates descendant counts
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

  console.log(`[mesh] handleAdoptAck(${rid}) — joined cluster, parent=${data.parentId}, dist=${data.distanceFromRoot}`);
  r._joiningParent = false;
  r._becomeRootRetries = 0;
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
  // Merge voice channel definitions — joiner learns which voice channels exist
  if (data.voiceChannels?.length) {
    if (!r.voiceChannels) r.voiceChannels = [];
    for (const vc of data.voiceChannels) {
      if (!r.voiceChannels.find(v => v.id === vc.id)) r.voiceChannels.push(vc);
    }
  }
  updateClusterMapSelf(rid);
  // Push our accurate entry up to the parent immediately — this ensures the
  // parent (and root) know our real childCount before any subsequent node
  // sends an adopt_request and gets redirected based on stale data.
  broadcastClusterMap(rid);
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
  const r = state.rooms[rid];
  console.log(`[mesh] handleAdoptRedirect(${rid}) — redirected to ${data.targetId || '(none)'}`);
  if (r) r._joiningParent = false;
  if (!data.targetId) {
    // No redirect target — retry the full candidate search
    setTimeout(() => findAndJoinParent(rid), RECONNECT_DELAY);
    return;
  }
  state.cb.connectTo?.(data.targetId, conn => {
    conn.send({ type: 'adopt_request', roomId: rid, id: state.myId, name: state.myName, voiceChannelId: state.rooms[rid]?.myVoiceChannelId || null });
  }, () => {
    // Connect to redirect target failed — retry the full candidate search
    setTimeout(() => findAndJoinParent(rid), RECONNECT_DELAY);
  });
}

// Peer rejected our adopt_request (cycle detected or already parented).
// Run recovery so we find a valid parent rather than hanging.
export function handleAdoptReject(data) {
  const rid = data.roomId, r = state.rooms[rid]; if (!r) return;
  console.log(`[mesh] handleAdoptReject(${rid}) — reason: ${data.reason}`);
  r._joiningParent = false;
  if (r.parentId) return;
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
        childCount:      r.childIds.length,   // explicit field for capacity math
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

    // Keep r.peers[pid] intact — the peer is offline, not forgotten.
    // renderRoomSidebar checks peerConns to determine online/offline status
    // and shows a gray dot for peers not currently connected.

    if (pid === r.parentId) {
      // Do NOT delete the dead parent's clusterMap entry yet.
      // It contains sibling IDs that recoverProcedure needs as candidates.
      // onParentLost will delete it after extracting what it needs.
      onParentLost(rid);
    } else if (r.childIds.includes(pid)) {
      delete r.clusterMap[pid];
      onChildLost(rid, pid);
    } else if (pid === r.backupId) {
      delete r.clusterMap[pid];
      r.backupId = null; r.backupConn = null; pickBackupPeer(rid);
    } else {
      delete r.clusterMap[pid];
    }
  }
  state.cb.renderTopology?.();
  state.cb.updateNetworkPanel?.();
}

// ─── PARENT LOST ─────────────────────────────────────────────────────────────
// Public wrapper so voice.js can trigger recovery without a circular import at load time
export function onParentLostPublic(rid, expectedParentId) {
  const r = state.rooms[rid]; if (!r) return;
  // Only trigger if expectedParentId is still our parent (guard against stale calls)
  if (expectedParentId && r.parentId !== expectedParentId) {
    console.log(`[mesh] onParentLostPublic(${rid}) — skipped, parentId is ${r.parentId} not ${expectedParentId}`);
    return;
  }
  onParentLost(rid);
}

function onParentLost(rid) {
  const r = state.rooms[rid]; if (!r) return;

  if (r.recoveryLock > Date.now()) {
    console.log(`[mesh] onParentLost(${rid}) — recovery lock active, ignoring`);
    return;
  }
  r.recoveryLock = Date.now() + RECOVERY_LOCK_MS;

  const lostParentId  = r.parentId;
  const grandparentId = r.grandparentId;

  // Extract sibling IDs from the dead parent's clusterMap entry BEFORE deleting it.
  // In a flat 2-level tree (root → B, C) the siblings have never connected directly
  // and won't be in our clusterMap any other way. We need them as recovery candidates.
  const deadParentEntry = r.clusterMap[lostParentId];
  if (deadParentEntry) {
    // The parent's own clusterMap lists all cluster members — copy any we don't know.
    // Also preserve siblings from r.siblings which came via child_list messages.
    const knownSiblings = new Set([...(r.siblings || [])]);
    for (const sibId of knownSiblings) {
      if (sibId !== state.myId && !r.clusterMap[sibId]) {
        r.clusterMap[sibId] = { name: r.peers[sibId]?.name || sibId, distance: 1, childCount: 0, connCount: 0, descendantCount: 1 };
        console.log(`[mesh] onParentLost(${rid}) — preserved sibling ${sibId} in clusterMap from r.siblings`);
      }
    }
  }
  // Now safe to remove the dead parent
  delete r.clusterMap[lostParentId];

  console.log(`[mesh] onParentLost(${rid}) — lost parent ${lostParentId}, grandparent=${grandparentId}, clusterMap now: ${Object.keys(r.clusterMap).filter(p=>p!==state.myId).join(', ')||'(empty)'}`);

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

  // Notify siblings so they can run their own recovery concurrently.
  // This also gives them our ID as a candidate in case they don't have it.
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
    console.log(`[mesh] onParentLost(${rid}) — trying grandparent ${grandparentId} first`);
    state.cb.connectTo?.(grandparentId, conn => {
      conn.send({ type: 'adopt_request', roomId: rid, id: state.myId, name: state.myName, voiceChannelId: state.rooms[rid]?.myVoiceChannelId || null });
    }, () => {
      console.log(`[mesh] onParentLost(${rid}) — grandparent unreachable, running recoverProcedure`);
      recoverProcedure(rid);
    });
    return;
  }

  // No grandparent → delay briefly before recoverProcedure so the sibling's
  // connectTo (triggered by parent_lost notification) has time to establish
  // a direct WebRTC connection before we query descendant counts.
  const RECOVERY_DELAY_MS = 1500;
  console.log(`[mesh] onParentLost(${rid}) — no grandparent, waiting ${RECOVERY_DELAY_MS}ms before recoverProcedure`);
  setTimeout(() => recoverProcedure(rid), RECOVERY_DELAY_MS);
}

// A sibling told us the parent is gone. Run our own recovery.
// Add the notifying sibling to our clusterMap as a candidate if not already there.
export function handleParentLost(data) {
  const rid = data.roomId;
  const r   = state.rooms[rid]; if (!r) return;
  if (r.parentId !== data.lostParentId) return;
  if (r.recoveryLock > Date.now()) return;

  // The sibling that notified us is a valid recovery candidate — make sure it's in the map.
  if (data.newCandidate && data.newCandidate !== state.myId && !r.clusterMap[data.newCandidate]) {
    r.clusterMap[data.newCandidate] = {
      name: r.peers[data.newCandidate]?.name || data.newCandidate,
      distance: 1, childCount: 0, connCount: 0, descendantCount: 1,
    };
    console.log(`[mesh] handleParentLost(${rid}) — added sibling ${data.newCandidate} to clusterMap`);
  }
  onParentLost(rid);
}

// ─── RECOVER_PROCEDURE ────────────────────────────────────────────────────────
function recoverProcedure(rid) {
  const r = state.rooms[rid]; if (!r) return;
  if (r._joiningParent) {
    console.log(`[mesh] recoverProcedure(${rid}) — skipped, join in progress`);
    return;
  }

  const myDC          = myDescendantCount(rid);
  const myDescendants = getDescendantIds(rid);

  // Also include known siblings that may not be in clusterMap yet
  // (they connect through the now-dead parent and may not have been broadcast)
  const knownPeerIds = new Set([
    ...Object.keys(r.clusterMap),
    ...(r.siblings || []),
    ...Object.keys(r.peers).filter(pid => state.peerConns[pid]?.conn?.open),
  ]);
  const candidates = [...knownPeerIds].filter(pid =>
    pid !== state.myId && !myDescendants.has(pid)
  );

  console.log(`[mesh] recoverProcedure(${rid}) — myDC=${myDC}, candidates: ${candidates.join(', ') || '(none)'}`);
  if (!candidates.length) { becomeRoot(rid); return; }

  const pending = new Set(candidates.slice(0, 5));
  const results = {};   // pid → descendantCount
  let decided   = false;

  const decide = () => {
    if (decided) return;
    decided = true;
    // Re-check: join may have succeeded while we were waiting for responses
    const rr = state.rooms[rid];
    if (!rr || rr.parentId || rr.childIds.length) return;

    if (!Object.keys(results).length) {
      console.log(`[mesh] recoverProcedure(${rid}) decide() — no responses received, calling becomeRoot`);
      becomeRoot(rid); return;
    }

    // Find highest-priority candidate
    let bestPid = null, bestDC = -1;
    for (const [pid, dc] of Object.entries(results)) {
      if (priorityHigherThan(dc, pid, bestDC, bestPid ?? '')) {
        bestDC = dc; bestPid = pid;
      }
    }

    r.recoveryLock = Date.now() + RECOVERY_LOCK_MS;

    if (priorityHigherThan(bestDC, bestPid, myDC, state.myId)) {
      console.log(`[mesh] recoverProcedure(${rid}) decide() — attaching to ${bestPid} (DC=${bestDC} > mine=${myDC})`);
      state.cb.connectTo?.(bestPid, conn => {
        conn.send({ type: 'adopt_request', roomId: rid, id: state.myId, name: state.myName, voiceChannelId: state.rooms[rid]?.myVoiceChannelId || null });
      }, () => setTimeout(() => findAndJoinParent(rid), RECONNECT_DELAY));
    } else {
      console.log(`[mesh] recoverProcedure(${rid}) decide() — we win (DC=${myDC} >= best=${bestDC}), pulling ${bestPid} down`);
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

  // Request descendant counts; decide after 5 s or when all replied.
  // 2 s was too short for TURN-relayed connections and caused spurious becomeRoot.
  const collectTimer = setTimeout(decide, 5000);
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
    conn.send({ type: 'adopt_request', roomId: rid, id: state.myId, name: state.myName, voiceChannelId: state.rooms[rid]?.myVoiceChannelId || null });
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
    conn.send({ type: 'adopt_request', roomId: rid, id: state.myId, name: state.myName, voiceChannelId: state.rooms[rid]?.myVoiceChannelId || null });
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
    if (!room) return;
    if (room.parentId || room.childIds.length || room._joiningParent) return;
    becomeRoot(rid);
  }, 12000);
}

export function attemptRoomReconnect(rid) {
  const r = state.rooms[rid]; if (!r) return;
  const toTry = r.savedPeers.filter(id =>
    id !== state.myId && !(state.peerConns[id]?.conn?.open)
  );
  if (!toTry.length) {
    console.log(`[mesh] attemptRoomReconnect(${rid}) — no savedPeers to try`);
    return;
  }

  console.log(`[mesh] attemptRoomReconnect(${rid}) — trying ${toTry.slice(0,3).join(', ')}`);
  r.parentId         = null;
  r.parentConn       = null;
  r.grandparentId    = null;
  r.distanceFromRoot = 0;

  let gotResponse = false;
  toTry.slice(0, 3).forEach(id => {
    state.cb.connectTo?.(id, conn => {
      if (!gotResponse) {
        gotResponse = true;
        console.log(`[mesh] attemptRoomReconnect(${rid}) — connected to ${id}, sending cluster_map_request`);
        conn.send({ type: 'cluster_map_request', roomId: rid, id: state.myId, name: state.myName });
      }
    }, () => {
      console.log(`[mesh] attemptRoomReconnect(${rid}) — connect to ${id} failed`);
    });
  });

  // Wait long enough for a normal join (ICE + adopt) to complete before
  // concluding we are isolated. 12 s covers TURN negotiation (up to ~10 s)
  // plus the adopt round-trip. If _joiningParent is still set the join is
  // actively in flight — back off and let it resolve on its own.
  setTimeout(() => {
    const room = state.rooms[rid];
    if (!room) return;
    if (room.parentId || room.childIds.length) return; // already joined
    if (room._joiningParent) {
      // Join still in progress — check again after another 10 s
      setTimeout(() => {
        const r2 = state.rooms[rid];
        if (r2 && !r2.parentId && !r2.childIds.length && !r2._joiningParent) {
          const kp = Object.keys(r2.clusterMap).filter(p => p !== state.myId);
          kp.length ? recoverProcedure(rid) : becomeRoot(rid);
        }
      }, 10000);
      return;
    }
    const knownPeers = Object.keys(room.clusterMap).filter(pid => pid !== state.myId);
    if (knownPeers.length) {
      recoverProcedure(rid);
    } else {
      becomeRoot(rid);
    }
  }, 12000);
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
      conn.send({ type: 'adopt_request', roomId: rid, id: state.myId, name: state.myName, voiceChannelId: state.rooms[rid]?.myVoiceChannelId || null });
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
  const vcId = r.myVoiceChannelId || null;
  // voiceSubtree: true if every child is also in the same voice channel
  const voiceSubtree = vcId !== null && r.childIds.every(cid =>
    r.clusterMap[cid]?.voiceChannelId === vcId
  );
  r.clusterMap[state.myId] = {
    name:            state.myName,
    distance:        r.distanceFromRoot,
    connCount:       totalConnCount(rid),
    childCount:      r.childIds.length,
    descendantCount: myDescendantCount(rid),
    voiceChannelId:  vcId,
    voiceSubtree:    voiceSubtree,
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
  const newPeers = [];
  for (const [pid, entry] of Object.entries(data.map)) {
    if (pid === state.myId) continue;
    r.clusterMap[pid] = entry;
    if (!r.peers[pid]) { r.peers[pid] = { id: pid, name: entry.name || pid }; newPeers.push(pid); }
  }
  console.log(`[mesh] handleClusterMap(${data.roomId}) — merged ${Object.keys(data.map).length} entries, clusterMap now has ${Object.keys(r.clusterMap).length} peers`);
  updateClusterMapSelf(data.roomId);
  if (data.roomId === state.activeRoomId) {
    import('./ui.js').then(ui => { ui.renderRoomSidebar(); ui.updatePeerCount(); });
  }
}

export function handleClusterMapRequest(data, conn) {
  const rid = data.roomId, r = state.rooms[rid]; if (!r) return;
  console.log(`[mesh] handleClusterMapRequest(${rid}) — from ${data.name || conn.peer}, sending map with ${Object.keys(r.clusterMap).length} entries`);
  updateClusterMapSelf(rid);
  if (!r.peers[conn.peer]) r.peers[conn.peer] = { id: conn.peer, name: data.name || conn.peer };
  // Ensure this room is tracked in peerConns so becomeRoot's live-peer check sees it
  if (!state.peerConns[conn.peer]) state.peerConns[conn.peer] = { conn, rooms: new Set(), lastSeen: Date.now(), scores: [] };
  state.peerConns[conn.peer].rooms.add(rid);
  // Send the full cluster map — this is all the joiner needs to call findAndJoinParent.
  // Do NOT also send a handshake here; the joiner will receive handshakes naturally
  // when the adopted parent calls setupChatConn and sendHandshake as part of adopt_ack.
  // Sending both races with findAndJoinParent and can trigger it twice.
  conn.send({ type: 'cluster_map', roomId: rid, map: r.clusterMap });
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
    const bc = be?.childCount ?? be?.connCount ?? 99;
    const cc = ce?.childCount ?? ce?.connCount ?? 99;
    return cc < bc ? pid : best;
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
