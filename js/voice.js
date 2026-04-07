/**
 * voice.js — Voice channels for GilgaMesh
 *
 * Each voice channel is a subtree of the cluster tree.  Nodes in the same
 * voice channel cluster together so voice data travels the shortest path.
 *
 * ── Joining a voice channel ────────────────────────────────────────────────
 *  1. Node sets r.myVoiceChannelId and calls joinVoiceChannel(rid, vcId).
 *  2. Node disconnects from its current parent and calls findAndJoinParent
 *     with voice-affinity filtering active.
 *  3. findAndJoinParent prefers voice-channel peers at the minimum distance,
 *     then falls back to regular nodes if none exist.
 *  4. handleAdoptRequest on the receiving side checks affinity:
 *     - If receiver is a voice node: only accept children of the same channel.
 *       Non-matching nodes get adopt_redirect toward a non-voice parent.
 *     - If receiver is a regular node: accepts anyone (normal behaviour).
 *
 * ── Audio routing ──────────────────────────────────────────────────────────
 *  Voice data is relayed as ArrayBuffer chunks over existing DataConnections
 *  (no extra RTCPeerConnection needed for the tree topology).
 *  - Upstream: send to parent only if parent is in the same channel.
 *  - Downstream: send to all children (guaranteed same channel by topology).
 *  - Backup peer: excluded from voice routing.
 *
 * ── Cluster map fields added ───────────────────────────────────────────────
 *  clusterMap[peerId].voiceChannelId  — channel this node is in (null = none)
 *  clusterMap[peerId].voiceSubtree    — true if ALL descendants are same channel
 */

import { state } from './state.js';
import { genId } from './ids.js';
import { toast } from './ui.js';
import { updateClusterMapSelf, broadcastClusterMap, findAndJoinParent } from './mesh.js';
import { saveStorage } from './storage.js';

// ─── LOCAL AUDIO STATE ────────────────────────────────────────────────────────
const voiceState = {
  localStream:    null,   // MediaStream from getUserMedia

  // Capture graph — used by MediaRecorder and VAD analyser
  captureCtx:     null,   // AudioContext for capture/VAD only
  analyser:       null,   // AnalyserNode for VAD (set by _startMediaRecorder)

  // Playback graph — created lazily on first received audio chunk,
  // so it is never blocked by the "user gesture required" policy
  playCtx:        null,   // AudioContext for playback
  gainNode:       null,   // master output gain on playCtx

  muted:          false,
  deafened:       false,
};

// Lazily initialise the playback AudioContext.
// Safe to call from any event handler (data receive counts as user-initiated
// once the peer connection is established).
function _ensurePlayCtx() {
  if (!voiceState.playCtx || voiceState.playCtx.state === 'closed') {
    voiceState.playCtx = new AudioContext();
    voiceState.gainNode = voiceState.playCtx.createGain();
    voiceState.gainNode.gain.value = voiceState.deafened ? 0 : 1;
    voiceState.gainNode.connect(voiceState.playCtx.destination);
    console.log('[voice] playback AudioContext created, sampleRate:', voiceState.playCtx.sampleRate);
  }
  // Resume if suspended — this can happen after tab backgrounding or on
  // first use in browsers that require a user gesture before audio plays.
  if (voiceState.playCtx.state === 'suspended') {
    voiceState.playCtx.resume().catch(e => console.warn('[voice] playCtx resume failed:', e));
  }
}

// Active speaker tracking: peerId → setTimeout handle
// When a voice chunk arrives from a peer, their ID goes here.
// The sidebar re-renders with a speaking glow; it auto-clears after 1.5 s silence.
const _activeSpeakers = {};   // peerId → timeout handle
const SPEAKING_TIMEOUT_MS = 1500;

function _markSpeaking(peerId, rid) {
  // Clear existing timeout for this peer
  if (_activeSpeakers[peerId]) clearTimeout(_activeSpeakers[peerId]);
  // Set speaking state on the room
  const r = state.rooms[rid]; if (r) { if (!r.activeSpeakers) r.activeSpeakers = {}; r.activeSpeakers[peerId] = true; }
  // Schedule silence (re-render to remove glow)
  _activeSpeakers[peerId] = setTimeout(() => {
    delete _activeSpeakers[peerId];
    const rr = state.rooms[rid]; if (rr?.activeSpeakers) delete rr.activeSpeakers[peerId];
    if (rid === state.activeRoomId) import('./ui.js').then(ui => ui.renderVoiceSpeakers(rid));
  }, SPEAKING_TIMEOUT_MS);
  // Re-render immediately so glow appears
  if (rid === state.activeRoomId) import('./ui.js').then(ui => ui.renderVoiceSpeakers(rid));
}

// Sequence number for audio chunks (per-room dedup)
let _voiceSeq = 0;

// ─── CREATE VOICE CHANNEL ─────────────────────────────────────────────────────
export function createVoiceChannel(rid) {
  const r = state.rooms[rid]; if (!r) return;
  const name = prompt('Voice channel name:', 'Voice');
  if (!name?.trim()) return;
  const vcId = 'vc-' + genId();
  const vc = { id: vcId, name: name.trim() };
  if (!r.voiceChannels) r.voiceChannels = [];
  r.voiceChannels.push(vc);
  saveStorage();

  // Broadcast to room
  const evt = { type: 'voice_channel_created', roomId: rid, channel: vc };
  if (r.parentConn?.open) try { r.parentConn.send(evt); } catch {}
  for (const cid of r.childIds) {
    const conn = r.childConns[cid] || state.peerConns[cid]?.conn;
    if (conn?.open) try { conn.send(evt); } catch {}
  }

  import('./ui.js').then(ui => ui.renderRoomSidebar());
  toast(`Voice channel #${vc.name} created`, 'success');
  return vcId;
}

export function handleVoiceChannelCreated(rid, data) {
  const r = state.rooms[rid]; if (!r || !data.channel) return;
  if (!r.voiceChannels) r.voiceChannels = [];
  if (r.voiceChannels.find(v => v.id === data.channel.id)) return;
  r.voiceChannels.push(data.channel);
  saveStorage();
  // Relay
  if (r.parentConn?.open) try { r.parentConn.send(data); } catch {}
  for (const cid of r.childIds) {
    const conn = r.childConns[cid] || state.peerConns[cid]?.conn;
    if (conn?.open) try { conn.send(data); } catch {}
  }
  import('./ui.js').then(ui => { if (rid === state.activeRoomId) ui.renderRoomSidebar(); });
}

// ─── JOIN / LEAVE VOICE CHANNEL ───────────────────────────────────────────────
export async function joinVoiceChannel(rid, vcId) {
  const r = state.rooms[rid]; if (!r) return;

  // Already in this channel
  if (r.myVoiceChannelId === vcId) return;

  // Leave current voice channel first
  if (r.myVoiceChannelId) await leaveVoiceChannel(rid, false);

  console.log(`[voice] joining voice channel ${vcId} in room ${rid}`);
  r.myVoiceChannelId = vcId;

  // Acquire microphone
  try {
    await startLocalAudio();
  } catch (e) {
    toast('Microphone access denied — voice channel unavailable', 'error');
    r.myVoiceChannelId = null;
    return;
  }

  // Notify current connections about voice intent before disconnecting
  // so they can update their clusterMaps
  broadcastVoiceIntent(rid);

  // Detach from current parent and re-join with voice affinity
  // (the parent will be re-selected by findAndJoinParent with voice filter)
  await rejoineVoiceSubtree(rid, vcId);

  import('./ui.js').then(ui => {
    if (rid === state.activeRoomId) { ui.renderRoomSidebar(); ui.updateNetworkPanel(); }
  });
  const vc = r.voiceChannels?.find(v => v.id === vcId);
  toast(`Joined voice channel ${vc ? '#' + vc.name : vcId}`, 'success');
}

export async function leaveVoiceChannel(rid, rejoinNormal = true) {
  const r = state.rooms[rid]; if (!r || !r.myVoiceChannelId) return;
  console.log(`[voice] leaving voice channel ${r.myVoiceChannelId} in room ${rid}`);

  stopLocalAudio();
  stopAllPeerAudio();

  r.myVoiceChannelId = null;
  updateClusterMapSelf(rid);
  broadcastClusterMap(rid);

  if (rejoinNormal) {
    // Detach and re-join without voice affinity
    await rejoineVoiceSubtree(rid, null);
  }

  import('./ui.js').then(ui => {
    if (rid === state.activeRoomId) { ui.renderRoomSidebar(); ui.updateNetworkPanel(); }
  });
  toast('Left voice channel', 'info');
}

// ─── REJOIN WITH VOICE AFFINITY ───────────────────────────────────────────────
// Coordinates a deterministic hand-off when joining or leaving a voice channel.
//
// Joining (vcId != null):
//   1. Among our current children, separate voice-same-channel kids from non-voice kids.
//   2. If there are non-voice children, pick the best one (fewest children, most
//      capacity) as the "relay node" C.
//      - Tell all other non-voice children to reassign their parent to C.
//      - Tell C to become the relay (it will accept those siblings as children).
//      - After a short delay (C needs time to accept them), we send adopt_request to C.
//   3. If there are no non-voice children (all kids are same-channel voice nodes,
//      or we have no children at all), fall through to a plain findAndJoinParent.
//
// Leaving (vcId == null):
//   Detach from the current parent and run a plain findAndJoinParent — no special
//   child coordination needed because we are no longer a voice node.
async function rejoineVoiceSubtree(rid, vcId) {
  const r = state.rooms[rid]; if (!r) return;

  if (vcId) {
    // ── JOINING a voice channel ──────────────────────────────────────────────
    // Separate children into same-channel voice kids (keep) vs non-voice kids
    // (need a relay). Children in a *different* voice channel are treated the
    // same as non-voice for relay purposes.
    const sameVoiceChildren = r.childIds.filter(
      cid => r.clusterMap[cid]?.voiceChannelId === vcId
    );
    const nonVoiceChildren = r.childIds.filter(
      cid => r.clusterMap[cid]?.voiceChannelId !== vcId
    );

    console.log(`[voice] rejoineVoiceSubtree(${rid}) joining vcId=${vcId} — sameVoice:${sameVoiceChildren.length}, nonVoice:${nonVoiceChildren.length}`);

    if (nonVoiceChildren.length > 0) {
      // ── Pick relay node C: non-voice child with most remaining capacity ────
      // "Closest to centre" = fewest current children (most room to accept more).
      const relayId = nonVoiceChildren.reduce((best, cid) => {
        const bc = r.clusterMap[best]?.childCount ?? 0;
        const cc = r.clusterMap[cid]?.childCount  ?? 0;
        return cc < bc ? cid : best;
      }, nonVoiceChildren[0]);

      const siblingsForRelay = nonVoiceChildren.filter(cid => cid !== relayId);

      console.log(`[voice] rejoineVoiceSubtree(${rid}) — relay=${relayId}, redirecting ${siblingsForRelay.length} sibling(s) to relay`);

      // Tell every non-relay, non-voice child to connect to C as their new parent.
      for (const cid of siblingsForRelay) {
        const conn = r.childConns[cid] || state.peerConns[cid]?.conn;
        if (conn?.open) {
          try {
            conn.send({ type: 'reassign_parent', roomId: rid, newParentId: relayId });
          } catch {}
        }
      }

      // Tell C: you are the relay — accept the incoming siblings and expect A.
      const relayConn = r.childConns[relayId] || state.peerConns[relayId]?.conn;
      if (relayConn?.open) {
        try {
          relayConn.send({
            type:             'voice_relay_promote',
            roomId:           rid,
            incomingSiblings: siblingsForRelay,
            voiceNodeId:      state.myId,
          });
        } catch {}
      }

      // Detach C (and other non-voice children) from our child list now.
      // Same-channel voice children stay — we keep them as children because
      // they will remain in our voice subtree.
      for (const cid of nonVoiceChildren) {
        delete r.childConns[cid];
      }
      r.childIds = sameVoiceChildren;
      updateClusterMapSelf(rid);

      // Detach from our own parent if we have one.
      if (r.parentId) {
        console.log(`[voice] rejoineVoiceSubtree(${rid}) — detaching from parent ${r.parentId}`);
        if (r.parentConn?.open) {
          try { r.parentConn.send({ type: 'peer_leaving', roomId: rid, id: state.myId, name: state.myName }); } catch {}
        }
        r.parentId         = null;
        r.parentConn       = null;
        r.grandparentId    = null;
        r.distanceFromRoot = 0;
      }

      r._joiningParent   = false;
      r._becomeRootRetries = 0;
      updateClusterMapSelf(rid);
      broadcastClusterMap(rid);

      // Give C time to accept the reassigned siblings before we knock on its door.
      await new Promise(res => setTimeout(res, 600));

      console.log(`[voice] rejoineVoiceSubtree(${rid}) — sending adopt_request to relay ${relayId}`);
      state.cb.connectTo?.(relayId, conn => {
        conn.send({
          type:           'adopt_request',
          roomId:         rid,
          id:             state.myId,
          name:           state.myName,
          voiceChannelId: vcId,
        });
      }, () => {
        // Relay unreachable — fall back to a general search
        console.warn(`[voice] rejoineVoiceSubtree(${rid}) — relay ${relayId} unreachable, falling back to findAndJoinParent`);
        findAndJoinParent(rid, { force: true });
      });
      return;
    }

    // No non-voice children — nothing to hand off. Just detach upward if needed
    // and let findAndJoinParent place us (same-channel peer or regular node).
    if (r.parentId) {
      if (r.parentConn?.open) {
        try { r.parentConn.send({ type: 'peer_leaving', roomId: rid, id: state.myId, name: state.myName }); } catch {}
      }
      r.parentId         = null;
      r.parentConn       = null;
      r.grandparentId    = null;
      r.distanceFromRoot = 0;
    }
    r._joiningParent   = false;
    r._becomeRootRetries = 0;
    updateClusterMapSelf(rid);
    broadcastClusterMap(rid);
    await new Promise(res => setTimeout(res, 300));
    findAndJoinParent(rid, { force: true });
    return;
  }

  // ── LEAVING a voice channel (vcId == null) ───────────────────────────────
  // We were a voice node. Evict all children (they'll self-recover), detach
  // from parent, and re-join as a plain node.
  const evictedChildIds = [...r.childIds];
  if (evictedChildIds.length > 0) {
    console.log(`[voice] rejoineVoiceSubtree(${rid}) leaving — evicting ${evictedChildIds.length} children`);
    const evictMsg = { type: 'voice_evict_children', roomId: rid, vcId: null, lostParentId: state.myId };
    for (const cid of evictedChildIds) {
      const conn = r.childConns[cid] || state.peerConns[cid]?.conn;
      if (conn?.open) try { conn.send(evictMsg); } catch {}
    }
    r.childIds   = [];
    r.childConns = {};
    await new Promise(res => setTimeout(res, 400));
  }

  if (r.parentId) {
    console.log(`[voice] rejoineVoiceSubtree(${rid}) leaving — detaching from parent ${r.parentId}`);
    if (r.parentConn?.open) {
      try { r.parentConn.send({ type: 'peer_leaving', roomId: rid, id: state.myId, name: state.myName }); } catch {}
    }
    r.parentId         = null;
    r.parentConn       = null;
    r.grandparentId    = null;
    r.distanceFromRoot = 0;
  }
  r._joiningParent   = false;
  r._becomeRootRetries = 0;
  updateClusterMapSelf(rid);
  await new Promise(res => setTimeout(res, 300));
  findAndJoinParent(rid, { force: true, excludeIds: evictedChildIds });
}

// ─── HANDLE CHILD EVICTION ────────────────────────────────────────────────────
// Called on a child when its parent sends voice_evict_children.
// Triggers the same recovery path as a genuine parent disconnect.
export function handleVoiceEvictChildren(data) {
  const rid = data.roomId;
  const r   = state.rooms[rid]; if (!r) return;
  if (r.parentId !== data.lostParentId) return; // not our parent
  console.log(`[voice] handleVoiceEvictChildren(${rid}) — parent ${data.lostParentId} joining voice(${data.vcId}), running recovery`);
  // Import mesh dynamically to avoid circular dep at module load
  import('./mesh.js').then(mesh => mesh.onParentLostPublic(rid, data.lostParentId));
}

// ─── HANDLE VOICE RELAY PROMOTE ──────────────────────────────────────────────
// Sent by a voice node (A) to the chosen relay child (C).
// C detaches from its current parent and becomes an independent root-level
// node so it can accept A (and any reassigned siblings) as its children.
// The relay is becoming a PARENT, not seeking one — _joiningParent must stay
// false so it can freely accept incoming adopt_requests.
export function handleVoiceRelayPromote(data) {
  const rid = data.roomId;
  const r   = state.rooms[rid]; if (!r) return;
  console.log(`[voice] handleVoiceRelayPromote(${rid}) — promoted as relay by ${data.voiceNodeId}, current parent=${r.parentId||'(none)'}, incoming siblings: ${(data.incomingSiblings||[]).join(', ')||'(none)'}`);

  // Register the voice node as a pending adopter so checkVoiceAdoptAffinity
  // accepts it directly without redirecting to same-channel peers.
  if (!r._pendingVoiceAdopters) r._pendingVoiceAdopters = new Set();
  r._pendingVoiceAdopters.add(data.voiceNodeId);

  // Detach from our current parent (may be the voice node itself, or any
  // other node). We need to be parentless so the voice node can adopt us
  // as its child (making us C's parent in the new topology).
  if (r.parentId) {
    if (r.parentConn?.open) {
      try { r.parentConn.send({ type: 'peer_leaving', roomId: rid, id: state.myId, name: state.myName }); } catch {}
    }
    r.parentId         = null;
    r.parentConn       = null;
    r.grandparentId    = null;
    r.distanceFromRoot = 0;
  }

  // Do NOT set _joiningParent=true here. The relay is becoming a root that
  // accepts incoming adopt_requests — it is not seeking a parent itself.
  // _joiningParent=true would block becomeRoot's suppression logic but would
  // also prevent normal recovery if the voice node never arrives.
  r._joiningParent     = false;
  r._becomeRootRetries = 0;

  import('./mesh.js').then(mesh => {
    mesh.updateClusterMapSelf(rid);
    mesh.broadcastClusterMap(rid);
  });

  for (const sibId of (data.incomingSiblings || [])) {
    console.log(`[voice] handleVoiceRelayPromote(${rid}) — expecting adopt_request from sibling ${sibId}`);
  }
}

// ─── VOICE INTENT BROADCAST ───────────────────────────────────────────────────
function broadcastVoiceIntent(rid) {
  const r = state.rooms[rid]; if (!r) return;
  updateClusterMapSelf(rid);
  broadcastClusterMap(rid);
}

// ─── ADOPT REQUEST VOICE CHECKS (called from mesh.js) ────────────────────────
/**
 * Returns an object describing whether an adopt_request should be accepted,
 * rejected, or redirected based on voice channel affinity.
 *
 * Returns: { allow: bool, redirectTo: peerId|null, reason: string }
 */
export function checkVoiceAdoptAffinity(rid, requesterVoiceChannelId, conn) {
  const r = state.rooms[rid]; if (!r) return { allow: true, redirectTo: null, reason: 'no room' };

  // If this node was promoted as a relay and the requester is the expected
  // voice node, accept unconditionally — redirecting would send A back to one
  // of A's own descendants (cycle). Clear the pending entry after accepting.
  if (r._pendingVoiceAdopters?.has(conn.peer)) {
    r._pendingVoiceAdopters.delete(conn.peer);
    console.log(`[voice] checkVoiceAdoptAffinity — accepting pending voice adopter ${conn.peer} (relay handshake)`);
    return { allow: true, redirectTo: null, reason: 'pending voice adopter' };
  }

  const myVcId  = r.myVoiceChannelId || null;
  const reqVcId = requesterVoiceChannelId || null;

  // Neither side is in a voice channel — plain tree join, always allow
  if (!myVcId && !reqVcId) return { allow: true, redirectTo: null, reason: 'both non-voice' };

  // I am in a voice channel
  if (myVcId) {
    if (reqVcId === myVcId) {
      // Same channel — accept
      return { allow: true, redirectTo: null, reason: 'same voice channel' };
    }
    // Requester is in different channel or no channel — redirect to a non-voice node
    const redirect = findNonVoiceParentCandidate(rid, conn.peer);
    console.log(`[voice] checkVoiceAdoptAffinity — I am voice(${myVcId}), requester is ${reqVcId||'non-voice'}, redirecting to ${redirect||'(none)'}`);
    return { allow: false, redirectTo: redirect, reason: 'voice channel mismatch' };
  }

  // I am NOT in a voice channel, requester IS in a voice channel
  // Regular nodes accept voice nodes (they will appear as normal children topology-wise)
  // but ideally the voice node should find a same-channel parent.
  // If there's a same-channel peer available (other than the requester itself), redirect;
  // otherwise accept — the requester is the first (or only) node in this voice channel.
  if (reqVcId) {
    const requesterId = conn.peer;
    const sameChannelPeer = findVoiceChannelParentCandidate(rid, reqVcId, requesterId);
    if (sameChannelPeer) {
      console.log(`[voice] checkVoiceAdoptAffinity — redirecting voice(${reqVcId}) requester to same-channel peer ${sameChannelPeer}`);
      return { allow: false, redirectTo: sameChannelPeer, reason: 'better voice parent available' };
    }
    // No same-channel peer exists (other than the requester) — accept them
    return { allow: true, redirectTo: null, reason: 'first node in voice channel' };
  }

  return { allow: true, redirectTo: null, reason: 'fallback allow' };
}

/**
 * Voice-affinity parent scoring for findAndJoinParent.
 * Returns a list of candidate peer IDs sorted by voice affinity + distance.
 */
export function voiceAwareCandidates(rid, allCandidates) {
  const r = state.rooms[rid]; if (!r) return allCandidates;
  const myVcId = r.myVoiceChannelId;
  if (!myVcId) return allCandidates; // not in voice channel — use default scoring

  // Prefer same-channel nodes at minimum distance, then non-voice nodes,
  // never prefer nodes in a different voice channel
  const sameChannel   = [];
  const nonVoice      = [];
  const otherChannel  = [];

  for (const pid of allCandidates) {
    const entry = r.clusterMap[pid];
    const pVcId = entry?.voiceChannelId || null;
    if (pVcId === myVcId)   sameChannel.push(pid);
    else if (!pVcId)        nonVoice.push(pid);
    else                    otherChannel.push(pid); // different voice channel — avoid
  }

  console.log(`[voice] voiceAwareCandidates(${rid}) — sameChannel:${sameChannel.length}, nonVoice:${nonVoice.length}, otherChannel:${otherChannel.length}`);
  // Never connect to a different-channel voice node unless there's truly no alternative
  return [...sameChannel, ...nonVoice, ...otherChannel];
}

function findVoiceChannelParentCandidate(rid, vcId, excludeId = null) {
  const r = state.rooms[rid]; if (!r) return null;
  const SOFT_CHILD_LIMIT = 7;
  let best = null, bestDist = Infinity;
  for (const [pid, e] of Object.entries(r.clusterMap)) {
    if (pid === state.myId) continue;
    if (pid === excludeId) continue;  // never redirect the requester back to themselves
    if (e.voiceChannelId !== vcId) continue;
    const children = e.childCount ?? 0;
    if (children >= SOFT_CHILD_LIMIT) continue;
    if (e.distance < bestDist) { bestDist = e.distance; best = pid; }
  }
  return best;
}

function findNonVoiceParentCandidate(rid, excludeId = null) {
  const r = state.rooms[rid]; if (!r) return null;
  const SOFT_CHILD_LIMIT = 7;
  let best = null, bestDist = Infinity;
  for (const [pid, e] of Object.entries(r.clusterMap)) {
    if (pid === state.myId) continue;
    if (pid === excludeId) continue;  // never redirect the requester back to themselves
    if (e.voiceChannelId) continue; // skip voice nodes
    const children = e.childCount ?? 0;
    if (children >= SOFT_CHILD_LIMIT) continue;
    if (e.distance < bestDist) { bestDist = e.distance; best = pid; }
  }
  return best;
}

// ─── LOCAL AUDIO ──────────────────────────────────────────────────────────────
async function startLocalAudio() {
  if (voiceState.localStream) return; // already running
  voiceState.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  // Capture context — only used for VAD analyser; not for playback
  voiceState.captureCtx  = new AudioContext();
  // Playback context created lazily on first received chunk (_ensurePlayCtx)
  _startMediaRecorder();
  console.log('[voice] local audio started');
}

function stopLocalAudio() {
  _stopMediaRecorder();
  if (voiceState.localStream) {
    voiceState.localStream.getTracks().forEach(t => t.stop());
    voiceState.localStream = null;
  }
  if (voiceState.captureCtx) {
    voiceState.captureCtx.close().catch(() => {});
    voiceState.captureCtx = null;
  }
  // Leave playCtx open — peer audio may still be in flight
  console.log('[voice] local audio stopped');
}

function stopAllPeerAudio() {
  if (voiceState.playCtx) {
    voiceState.playCtx.close().catch(() => {});
    voiceState.playCtx = null;
    voiceState.gainNode = null;
  }
}

// ─── RAW PCM CAPTURE (ScriptProcessorNode) ───────────────────────────────────
// MediaRecorder splits a streaming container (WebM/Ogg) into chunks that are
// NOT independently decodable — decodeAudioData requires a complete file with
// headers, so every chunk after the first fails with "unknown content type".
//
// Instead we use ScriptProcessorNode to capture raw Float32 PCM from the mic,
// downsample to TARGET_SAMPLE_RATE, convert to Int16, base64-encode, and send.
// The receiver reconstructs an AudioBuffer directly — no codec, no container,
// no decodeAudioData needed.

const TARGET_SAMPLE_RATE = 16000; // 16 kHz — good voice quality, low bandwidth
const SCRIPT_BUFFER_SIZE = 4096;  // samples per callback (~85 ms at 48 kHz input)
const VAD_THRESHOLD      = 0.01;  // RMS 0-1; skip silent frames

let _scriptProcessor = null;
let _analyserNode    = null;
let _vadBuffer       = null;

function _startMediaRecorder() {
  if (!voiceState.localStream || !voiceState.captureCtx) return;

  const ctx        = voiceState.captureCtx;
  const source     = ctx.createMediaStreamSource(voiceState.localStream);
  const nativeSR   = ctx.sampleRate;                       // typically 48000
  const downsample = Math.max(1, Math.round(nativeSR / TARGET_SAMPLE_RATE));

  // AnalyserNode for VAD — not connected to destination, mic never plays locally
  _analyserNode         = ctx.createAnalyser();
  _analyserNode.fftSize = 256;
  _vadBuffer            = new Float32Array(_analyserNode.frequencyBinCount);
  source.connect(_analyserNode);

  // ScriptProcessorNode captures raw PCM
  _scriptProcessor = ctx.createScriptProcessor(SCRIPT_BUFFER_SIZE, 1, 1);
  source.connect(_scriptProcessor);

  // Route output to a silent gain node (ScriptProcessor must be connected to run)
  const muteGain = ctx.createGain();
  muteGain.gain.value = 0;
  _scriptProcessor.connect(muteGain);
  muteGain.connect(ctx.destination);

  _scriptProcessor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0); // Float32, nativeSR

    // VAD — skip silent frames
    _analyserNode.getFloatTimeDomainData(_vadBuffer);
    let sumSq = 0;
    for (let i = 0; i < _vadBuffer.length; i++) sumSq += _vadBuffer[i] * _vadBuffer[i];
    if (Math.sqrt(sumSq / _vadBuffer.length) < VAD_THRESHOLD) return;

    // Downsample: take every Nth sample
    const outLen = Math.floor(input.length / downsample);
    const pcm16  = new Int16Array(outLen);
    for (let i = 0; i < outLen; i++) {
      const s = Math.max(-1, Math.min(1, input[i * downsample]));
      pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }

    // Base64-encode the raw Int16 bytes
    const bytes  = new Uint8Array(pcm16.buffer);
    let   binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    const b64 = btoa(binary);

    _routeVoiceChunk(b64, TARGET_SAMPLE_RATE);
  };

  console.log(`[voice] ScriptProcessor started — nativeSR:${nativeSR} downsample:${downsample}x -> ${TARGET_SAMPLE_RATE} Hz`);
}

function _stopMediaRecorder() {
  if (_scriptProcessor) {
    try { _scriptProcessor.disconnect(); } catch {}
    _scriptProcessor = null;
  }
  _analyserNode = null;
  _vadBuffer    = null;
}

// ─── ROUTE VOICE CHUNK ────────────────────────────────────────────────────────
// b64 = base64-encoded Int16 PCM at sampleRate Hz.
function _routeVoiceChunk(b64, sampleRate) {
  for (const [rid, r] of Object.entries(state.rooms)) {
    if (!r.myVoiceChannelId) continue;
    _markSpeaking(state.myId, rid);

    const packet = {
      type:       'voice_data',
      roomId:     rid,
      vcId:       r.myVoiceChannelId,
      authorId:   state.myId,
      authorName: state.myName,
      seq:        _voiceSeq++,
      sampleRate,        // receiver needs this to build AudioBuffer
      audio:      b64,   // base64-encoded Int16 PCM
    };

    if (r.parentConn?.open) _sendVoicePacket(r.parentConn, packet);

    for (const cid of r.childIds) {
      const conn = r.childConns[cid] || state.peerConns[cid]?.conn;
      if (conn?.open) _sendVoicePacket(conn, packet);
    }
  }
}

function _sendVoicePacket(conn, packet) {
  try { conn.send(packet); } catch {}
}

// ─── RECEIVE VOICE DATA ───────────────────────────────────────────────────────
// Each voice_data packet is self-contained (audio field is base64).
// handleVoiceBinary is kept as a no-op stub so main.js import doesn't break.

export function handleVoiceData(data, conn) {
  const { roomId: rid, vcId, authorId, authorName, audio, sampleRate } = data;
  const r = state.rooms[rid]; if (!r || !audio) return;

  // Relay to other nodes — always relay regardless of whether we are in the
  // voice channel, so intermediate/root nodes that are not voice participants
  // still forward audio through the tree.
  // Only skip relay if we are the original author (prevents echo loops).
  if (authorId !== state.myId) {
    // Relay upstream (skip if packet came from parent to avoid sending it back)
    if (r.parentConn?.open && conn.peer !== r.parentId) {
      _sendVoicePacket(r.parentConn, data);
    }
    // Relay downstream (skip the sender)
    for (const cid of r.childIds) {
      if (cid === conn.peer) continue;
      const c = r.childConns[cid] || state.peerConns[cid]?.conn;
      if (c?.open) _sendVoicePacket(c, data);
    }
  }

  // Play locally if we're in this channel and it's not our own audio
  if (r.myVoiceChannelId === vcId && authorId !== state.myId && !voiceState.deafened) {
    _markSpeaking(authorId, rid);
    _playVoiceChunk(authorId, audio, sampleRate);
  }
}

// Stub — binary frames are no longer sent; kept so main.js import compiles.
export function handleVoiceBinary(buf, conn) {}

// ─── AUDIO PLAYBACK ───────────────────────────────────────────────────────────
// Receives base64-encoded Int16 PCM (from ScriptProcessorNode capture).
// Reconstructs an AudioBuffer directly — no decodeAudioData, no codec needed.
function _playVoiceChunk(peerId, b64, sampleRate) {
  _ensurePlayCtx();
  const ctx = voiceState.playCtx;
  if (!ctx || ctx.state === 'closed') return;
  if (voiceState.deafened) return;

  let pcm16;
  try {
    const binary = atob(b64);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    // View the bytes as Int16 (2 bytes per sample, little-endian)
    pcm16 = new Int16Array(bytes.buffer);
  } catch (e) {
    console.warn('[voice] base64 decode error:', e.message);
    return;
  }

  // Convert Int16 → Float32 and load into an AudioBuffer
  const numSamples = pcm16.length;
  const sr         = sampleRate || TARGET_SAMPLE_RATE;
  let   audioBuf;
  try {
    audioBuf = ctx.createBuffer(1, numSamples, sr);
  } catch (e) {
    console.warn('[voice] createBuffer error:', e.message);
    return;
  }
  const f32 = audioBuf.getChannelData(0);
  for (let i = 0; i < numSamples; i++) {
    f32[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7FFF);
  }

  const src = ctx.createBufferSource();
  src.buffer = audioBuf;
  src.connect(voiceState.gainNode);
  src.start(0);
}

// ─── MUTE / DEAFEN ────────────────────────────────────────────────────────────
export function toggleMute(rid) {
  voiceState.muted = !voiceState.muted;
  if (voiceState.localStream) {
    voiceState.localStream.getAudioTracks().forEach(t => { t.enabled = !voiceState.muted; });
  }
  import('./ui.js').then(ui => { if (rid === state.activeRoomId) ui.renderVoicePanel(rid); });
  toast(voiceState.muted ? 'Microphone muted' : 'Microphone unmuted', 'info');
}

export function toggleDeafen(rid) {
  voiceState.deafened = !voiceState.deafened;
  if (voiceState.gainNode) voiceState.gainNode.gain.value = voiceState.deafened ? 0 : 1;
  import('./ui.js').then(ui => { if (rid === state.activeRoomId) ui.renderVoicePanel(rid); });
  toast(voiceState.deafened ? 'Audio deafened' : 'Audio undeafened', 'info');
}

export function isMuted()   { return voiceState.muted; }
export function isDeafened(){ return voiceState.deafened; }

// ─── FULLY PARTITIONED CLUSTER EDGE CASE ─────────────────────────────────────
// If ALL nodes in the cluster are voice nodes and a regular node wants to join:
// The new node asks the root to become ITS child, making the new node the root.
export function handleBecomeMyChild(data, conn) {
  const rid = data.roomId;
  const r   = state.rooms[rid]; if (!r) return;
  // Only honour this if we are root
  if (r.parentId) {
    try { conn.send({ type: 'become_my_child_reject', roomId: rid, reason: 'not_root' }); } catch {}
    return;
  }
  console.log(`[voice] handleBecomeMyChild(${rid}) — ${data.requesterId} wants to become new root`);

  // Send adopt_request to the requester (they become our parent)
  state.cb.connectTo?.(data.requesterId, c => {
    c.send({ type: 'adopt_request', roomId: rid, id: state.myId, name: state.myName });
  }, () => {});
}

// ─── VOICE STATE ACCESSORS ───────────────────────────────────────────────────
export function getVoiceParticipants(rid, vcId) {
  const r = state.rooms[rid]; if (!r) return [];
  return Object.entries(r.clusterMap)
    .filter(([pid, e]) => e.voiceChannelId === vcId)
    .map(([pid, e]) => ({ id: pid, name: e.name || pid }));
}

export function myVoiceChannelId(rid) {
  return state.rooms[rid]?.myVoiceChannelId || null;
}

export function getActiveSpeakers(rid) {
  return state.rooms[rid]?.activeSpeakers || {};
}
