/**
 * election.js — Local elections (parent + its ≤5 children every 5 min)
 *
 * Vote metric: connection_uptime_ms × sibling_connection_count
 * If parent wins → stays parent
 * If a sibling wins → swap: sibling becomes parent,
 *   old parent takes the sibling's children
 */

import { ELECTION_INTERVAL } from './constants.js';
import { state } from './state.js';
import { toast, updateNetworkPanel } from './ui.js';
import { connectTo } from './peer.js';   // ← FIX: was missing, caused ReferenceError on election win

// Election timers per room
const electionTimers = {};

// Track when each peer connection was established (peerId → timestamp ms)
const connStartTimes = {};

/**
 * Call this whenever a connection to a peer is first confirmed open,
 * so we can compute uptime-based scores.
 */
export function recordConnStart(pid) {
  if (!connStartTimes[pid]) connStartTimes[pid] = Date.now();
}

export function startLocalElection(rid) {
  if (electionTimers[rid]) { clearInterval(electionTimers[rid]); }
  electionTimers[rid] = setInterval(() => runElection(rid), ELECTION_INTERVAL);
}

export function stopLocalElection(rid) {
  if (electionTimers[rid]) { clearInterval(electionTimers[rid]); delete electionTimers[rid]; }
}

// ─── INITIATE ELECTION ────────────────────────────────────────────────────────
function runElection(rid) {
  const r = state.rooms[rid]; if (!r) return;

  // Only the parent (root-of-local-group) initiates
  if (r.parentId !== null) return; // We're a child — wait for parent to initiate

  const myScore = calcScore(rid);
  const epoch   = Date.now();
  r.electionEpoch  = epoch;
  r.electionVotes  = { [state.myId]: myScore };

  const msg = {
    type:          'election_start',
    roomId:        rid,
    epoch,
    initiatorId:   state.myId,
  };
  state.cb.sendToAllChildren?.(rid, msg);

  // Resolve after 3s to give children time to reply
  setTimeout(() => resolveElection(rid, epoch), 3000);
}

// Child receives election_start
export function handleElectionStart(data, conn) {
  const rid = data.roomId, r = state.rooms[rid]; if (!r) return;
  if (r.electionEpoch === data.epoch) return; // already processing this epoch
  r.electionEpoch = data.epoch;

  const score = calcScore(rid);
  try {
    conn.send({ type: 'election_vote', roomId: rid, epoch: data.epoch,
      voterId: state.myId, score });
  } catch {}
}

// Parent receives votes
export function handleElectionVote(data) {
  const r = state.rooms[data.roomId]; if (!r) return;
  if (data.epoch !== r.electionEpoch) return; // stale
  r.electionVotes[data.voterId] = data.score;
}

function resolveElection(rid, epoch) {
  const r = state.rooms[rid]; if (!r) return;
  if (epoch !== r.electionEpoch) return; // superseded

  let winner = state.myId, best = r.electionVotes[state.myId] ?? 0;
  for (const [id, score] of Object.entries(r.electionVotes)) {
    if (score > best) { best = score; winner = id; }
  }
  r.electionVotes = {};

  if (winner === state.myId) {
    // We stay parent — nothing changes
    return;
  }

  // A child won — swap: winner becomes parent, we take winner's children
  const winnerConn = r.childConns[winner] || state.peerConns[winner]?.conn;
  if (!winnerConn?.open) return; // winner gone, abort

  // Tell winner to become parent, passing our other children to it
  try {
    winnerConn.send({
      type:    'election_won',
      roomId:  rid,
      epoch,
      myChildrenForYou: r.childIds.filter(id => id !== winner),
    });
  } catch { return; }

  // We demote ourselves — become a child of the winner.
  // Close all existing child connections; winner will re-adopt them.
  r.childIds = [];
  Object.values(r.childConns).forEach(c => { try { c.close(); } catch {} });
  r.childConns = {};

  // Connect to winner as our new parent
  connectTo(winner, conn => {
    r.parentId        = winner;
    r.parentConn      = conn;
    r.distanceFromRoot = (r.distanceFromRoot ?? 0) + 1;
    state.cb.updateClusterMapSelf?.(rid);
    state.cb.broadcastClusterMap?.(rid);
    if (rid === state.activeRoomId) {
      toast(`${r.peers[winner]?.name || winner} is now the local parent`, 'info');
      updateNetworkPanel();
    }
    state.cb.flushPendingMessages?.(rid);
  }, () => {});
}

// Winner receives election_won
export function handleElectionWon(data, conn) {
  const rid = data.roomId, r = state.rooms[rid]; if (!r) return;

  // We become the new root of this local group (no parent)
  r.parentId         = null;
  r.parentConn       = null;
  r.distanceFromRoot = Math.max(0, (r.distanceFromRoot ?? 1) - 1);

  // Adopt the old parent's other children (they will connect to us)
  // We proactively reach out so the swap is fast
  for (const sibId of (data.myChildrenForYou || [])) {
    connectTo(sibId, sibConn => {
      sibConn.send({ type: 'adopt_request', roomId: rid, id: state.myId, name: state.myName });
    }, () => {});
  }
  // The old parent will connect to us as a child via its own demote logic above.

  state.cb.updateClusterMapSelf?.(rid);
  state.cb.broadcastClusterMap?.(rid);

  if (rid === state.activeRoomId) {
    import('./ui.js').then(ui => { ui.setStatus('server', 'local parent'); ui.updateNetworkPanel(); });
  }
  state.cb.flushPendingMessages?.(rid);
}

// ─── SCORE — connection_uptime_ms × sibling_connection_count ─────────────────
// FIX: spec says uptime × sibling count, not RTT-based.
function calcScore(rid) {
  const r = state.rooms[rid]; if (!r) return 0;

  // Uptime of our connection to the parent (or our own uptime if root)
  const pid     = r.parentId;
  const startTs = pid ? (connStartTimes[pid] ?? Date.now()) : (connStartTimes[state.myId] ?? Date.now());
  const uptime  = Date.now() - startTs;  // ms we have been connected

  // sibling_connection_count: how many siblings (peers at same level) we know of
  const siblingCount = r.siblings?.length ?? r.childIds.length;

  return uptime * (siblingCount + 1);  // +1 so isolated nodes still get a non-zero score
}
