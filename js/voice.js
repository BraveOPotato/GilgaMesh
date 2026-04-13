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
//   Among current children, pick one non-voice child as relay (C).
//   - Tell other non-voice children: reassign_parent → C
//   - Tell C: voice_relay_promote (detach, become root, wait for A)
//   - After 600ms, A sends adopt_request directly to C
//   Same-channel voice children are kept as A's children unchanged.
//
// Leaving (vcId == null):
//   Evict all children (they self-recover), detach from parent, findAndJoinParent.
async function rejoineVoiceSubtree(rid, vcId) {
  const r = state.rooms[rid]; if (!r) return;

  if (vcId) {
    // ── JOINING ──────────────────────────────────────────────────────────────
    const sameVoiceChildren = r.childIds.filter(
      cid => r.clusterMap[cid]?.voiceChannelId === vcId
    );
    const nonVoiceChildren = r.childIds.filter(
      cid => r.clusterMap[cid]?.voiceChannelId !== vcId
    );

    console.log(`[voice] rejoineVoiceSubtree(${rid}) joining vcId=${vcId} — sameVoice:${sameVoiceChildren.length}, nonVoice:${nonVoiceChildren.length}`);

    if (nonVoiceChildren.length > 0) {
      // Pick relay C: non-voice child with fewest children (most capacity)
      const relayId = nonVoiceChildren.reduce((best, cid) => {
        const bc = r.clusterMap[best]?.childCount ?? 0;
        const cc = r.clusterMap[cid]?.childCount  ?? 0;
        return cc < bc ? cid : best;
      }, nonVoiceChildren[0]);

      const siblingsForRelay = nonVoiceChildren.filter(cid => cid !== relayId);

      console.log(`[voice] rejoineVoiceSubtree(${rid}) — relay=${relayId}, redirecting ${siblingsForRelay.length} sibling(s) to relay`);

      // Tell non-relay non-voice children to connect to C
      for (const cid of siblingsForRelay) {
        const conn = r.childConns[cid] || state.peerConns[cid]?.conn;
        if (conn?.open) {
          try { conn.send({ type: 'reassign_parent', roomId: rid, newParentId: relayId }); } catch {}
        }
      }

      // Tell C: you are the relay
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

      // Detach non-voice children from our child list; keep same-voice children
      for (const cid of nonVoiceChildren) delete r.childConns[cid];
      r.childIds = sameVoiceChildren;
      updateClusterMapSelf(rid);

      // Detach from our own parent if we have one
      if (r.parentId) {
        console.log(`[voice] rejoineVoiceSubtree(${rid}) — detaching from parent ${r.parentId}`);
        if (r.parentConn?.open) {
          try { r.parentConn.send({ type: 'peer_leaving', roomId: rid, id: state.myId, name: state.myName }); } catch {}
        }
        r.parentId = null; r.parentConn = null; r.grandparentId = null; r.distanceFromRoot = 0;
      }

      r._joiningParent = false; r._becomeRootRetries = 0;
      updateClusterMapSelf(rid);
      broadcastClusterMap(rid);

      // Give C time to accept reassigned siblings before we knock
      await new Promise(res => setTimeout(res, 600));

      console.log(`[voice] rejoineVoiceSubtree(${rid}) — sending adopt_request to relay ${relayId}`);
      state.cb.connectTo?.(relayId, conn => {
        conn.send({ type: 'adopt_request', roomId: rid, id: state.myId, name: state.myName, voiceChannelId: vcId });
      }, () => {
        console.warn(`[voice] rejoineVoiceSubtree(${rid}) — relay ${relayId} unreachable, falling back`);
        findAndJoinParent(rid, { force: true });
      });
      return;
    }

    // No non-voice children — just detach upward and findAndJoinParent
    if (r.parentId) {
      if (r.parentConn?.open) {
        try { r.parentConn.send({ type: 'peer_leaving', roomId: rid, id: state.myId, name: state.myName }); } catch {}
      }
      r.parentId = null; r.parentConn = null; r.grandparentId = null; r.distanceFromRoot = 0;
    }
    r._joiningParent = false; r._becomeRootRetries = 0;
    updateClusterMapSelf(rid);
    broadcastClusterMap(rid);
    await new Promise(res => setTimeout(res, 300));
    findAndJoinParent(rid, { force: true });
    return;
  }

  // ── LEAVING (vcId == null) ────────────────────────────────────────────────
  const evictedChildIds = [...r.childIds];
  if (evictedChildIds.length > 0) {
    console.log(`[voice] rejoineVoiceSubtree(${rid}) leaving — evicting ${evictedChildIds.length} children`);
    const evictMsg = { type: 'voice_evict_children', roomId: rid, vcId: null, lostParentId: state.myId };
    for (const cid of evictedChildIds) {
      const conn = r.childConns[cid] || state.peerConns[cid]?.conn;
      if (conn?.open) try { conn.send(evictMsg); } catch {}
    }
    r.childIds = []; r.childConns = {};
    await new Promise(res => setTimeout(res, 400));
  }

  if (r.parentId) {
    console.log(`[voice] rejoineVoiceSubtree(${rid}) leaving — detaching from parent ${r.parentId}`);
    if (r.parentConn?.open) {
      try { r.parentConn.send({ type: 'peer_leaving', roomId: rid, id: state.myId, name: state.myName }); } catch {}
    }
    r.parentId = null; r.parentConn = null; r.grandparentId = null; r.distanceFromRoot = 0;
  }
  r._joiningParent = false; r._becomeRootRetries = 0;
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
export function handleVoiceRelayPromote(data) {
  const rid = data.roomId;
  const r   = state.rooms[rid]; if (!r) return;
  console.log(`[voice] handleVoiceRelayPromote(${rid}) — promoted as relay by ${data.voiceNodeId}, current parent=${r.parentId||'(none)'}, incoming siblings: ${(data.incomingSiblings||[]).join(', ')||'(none)'}`);

  // Register the voice node as a pending adopter so checkVoiceAdoptAffinity
  // accepts it directly without redirecting to same-channel peers.
  if (!r._pendingVoiceAdopters) r._pendingVoiceAdopters = new Set();
  r._pendingVoiceAdopters.add(data.voiceNodeId);

  // Detach from our current parent unconditionally — we need to be parentless
  // so the voice node can adopt us. The relay becomes a root, not a seeker.
  if (r.parentId) {
    if (r.parentConn?.open) {
      try { r.parentConn.send({ type: 'peer_leaving', roomId: rid, id: state.myId, name: state.myName }); } catch {}
    }
    r.parentId         = null;
    r.parentConn       = null;
    r.grandparentId    = null;
    r.distanceFromRoot = 0;
  }

  // Do NOT set _joiningParent=true — the relay is becoming a root that
  // accepts adopt_requests, not a node waiting to be adopted.
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
export function checkVoiceAdoptAffinity(rid, requesterVoiceChannelId, conn, data = {}) {
  const r = state.rooms[rid]; if (!r) return { allow: true, redirectTo: null, reason: 'no room' };

  // If this node was promoted as a relay and the requester is the expected
  // voice node, accept unconditionally — any redirect would send A back to
  // one of A's own descendants (cycle). Clear the pending entry after use.
  if (r._pendingVoiceAdopters?.has(conn.peer)) {
    r._pendingVoiceAdopters.delete(conn.peer);
    console.log(`[voice] checkVoiceAdoptAffinity — accepting pending voice adopter ${conn.peer} (relay handshake)`);
    return { allow: true, redirectTo: null, reason: 'pending voice adopter' };
  }

  // The fromBecomeMyChild flag means this adopt_request was sent by a voice
  // root in response to our become_my_child message.  Accept unconditionally —
  // redirecting would create the Zen→Brave→Zen infinite loop.
  if (data?.fromBecomeMyChild) {
    // Also register them so any duplicate arrive also passes cleanly
    if (!r._pendingVoiceAdopters) r._pendingVoiceAdopters = new Set();
    console.log(`[voice] checkVoiceAdoptAffinity — accepting fromBecomeMyChild adopter ${conn.peer}`);
    return { allow: true, redirectTo: null, reason: 'fromBecomeMyChild' };
  }

  const myVcId  = r.myVoiceChannelId || null;
  const reqVcId = requesterVoiceChannelId || null;

  // Neither side is in a voice channel — plain tree join, always allow
  if (!myVcId && !reqVcId) return { allow: true, redirectTo: null, reason: 'both non-voice' };

  // I am in a voice channel
  if (myVcId) {
    if (reqVcId === myVcId) {
      return { allow: true, redirectTo: null, reason: 'same voice channel' };
    }
    // Redirect to a non-voice node — exclude the requester to prevent self-redirect
    const redirect = findNonVoiceParentCandidate(rid, conn.peer);
    console.log(`[voice] checkVoiceAdoptAffinity — I am voice(${myVcId}), requester is ${reqVcId||'non-voice'}, redirecting to ${redirect||'(none)'}`);
    return { allow: false, redirectTo: redirect, reason: 'voice channel mismatch' };
  }

  // I am NOT in a voice channel, requester IS — redirect to same-channel peer if one exists
  // (exclude the requester itself to prevent self-redirect loops)
  if (reqVcId) {
    const sameChannelPeer = findVoiceChannelParentCandidate(rid, reqVcId, conn.peer);
    if (sameChannelPeer) {
      console.log(`[voice] checkVoiceAdoptAffinity — redirecting voice(${reqVcId}) requester to same-channel peer ${sameChannelPeer}`);
      return { allow: false, redirectTo: sameChannelPeer, reason: 'better voice parent available' };
    }
    // No other same-channel peer — accept as first/only voice node
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
    if (pid === excludeId) continue;  // never redirect requester back to themselves
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
    if (pid === excludeId) continue;  // never redirect requester back to themselves
    if (e.voiceChannelId) continue;
    const children = e.childCount ?? 0;
    if (children >= SOFT_CHILD_LIMIT) continue;
    if (e.distance < bestDist) { bestDist = e.distance; best = pid; }
  }
  return best;
}


// ─── LOCAL AUDIO ──────────────────────────────────────────────────────────────
async function startLocalAudio() {
  if (voiceState.localStream) return;
  voiceState.localStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: false,
  });
  voiceState.captureCtx = new AudioContext({ sampleRate: 48000 });
  _startCapture();
  console.log('[voice] local audio started');
}

function stopLocalAudio() {
  _stopCapture();
  if (voiceState.localStream) {
    voiceState.localStream.getTracks().forEach(t => t.stop());
    voiceState.localStream = null;
  }
  if (voiceState.captureCtx) {
    voiceState.captureCtx.close().catch(() => {});
    voiceState.captureCtx = null;
  }
  console.log('[voice] local audio stopped');
}

function stopAllPeerAudio() {
  for (const k of Object.keys(_peerPlayhead)) delete _peerPlayhead[k];
  for (const [pid, dec] of Object.entries(_opusDecoders)) {
    try { dec.close(); } catch {}
    delete _opusDecoders[pid];
  }
  if (voiceState.playCtx) {
    voiceState.playCtx.close().catch(() => {});
    voiceState.playCtx = null;
    voiceState.gainNode = null;
  }
}

// ─── CAPTURE — WebCodecs Opus (primary) + ScriptProcessor PCM (fallback) ─────
//
// Primary path (Chrome 94+, Firefox 130+, Safari 18+):
//   AudioWorkletNode feeds 20ms PCM frames to AudioEncoder (Opus).
//   Each EncodedAudioChunk is an independent Opus frame — no container,
//   no init segment, every frame decodable on its own.
//
// Fallback path (older browsers):
//   ScriptProcessorNode + FIR low-pass filter + Int16 PCM at 24 kHz.

const OPUS_SAMPLE_RATE = 48000;
const OPUS_BITRATE     = 32000;  // 32 kbps — excellent voice quality

let _audioEncoder   = null;
let _captureWorklet = null;
let _scriptProcessor = null;
let _analyserNode   = null;
let _vadBuffer      = null;
let _useOpus        = false;

// Inline AudioWorklet processor — registered at runtime via a Blob URL.
// Buffers mic samples into 20ms (960-sample) frames, computes RMS on each
// frame, and posts frames above the silence floor to the main thread.
// Doing VAD here (in the worklet) means we measure the actual frame energy,
// not a lagged analyser snapshot which can drop consonants and word endings.
const VAD_FLOOR = 0.002; // very low floor — only suppress near-silence/noise
                          // Opus DTX handles true silence compression on its own

const _WORKLET_CODE = `
class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf = [];
    this._frameSize = 960; // 20ms at 48kHz
    this._vadFloor  = ${VAD_FLOOR};
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) this._buf.push(ch[i]);
    while (this._buf.length >= this._frameSize) {
      const frame = new Float32Array(this._buf.splice(0, this._frameSize));
      // Compute RMS on the frame itself — accurate and zero-lag
      let sumSq = 0;
      for (let i = 0; i < frame.length; i++) sumSq += frame[i] * frame[i];
      const rms = Math.sqrt(sumSq / frame.length);
      if (rms >= this._vadFloor) {
        this.port.postMessage(frame, [frame.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('mic-capture', MicCaptureProcessor);
`;

async function _startCapture() {
  if (!voiceState.localStream || !voiceState.captureCtx) return;

  // Try WebCodecs Opus path first
  if (typeof AudioEncoder !== 'undefined' && typeof AudioDecoder !== 'undefined') {
    try {
      const support = await AudioEncoder.isConfigSupported({
        codec: 'opus', sampleRate: OPUS_SAMPLE_RATE, numberOfChannels: 1,
        bitrate: OPUS_BITRATE,
      });
      if (support.supported) {
        await _startOpusCapture();
        _useOpus = true;
        console.log('[voice] capture: WebCodecs Opus active (32kbps)');
        return;
      }
    } catch (e) {
      console.warn('[voice] WebCodecs Opus unavailable, using PCM fallback:', e.message);
    }
  }

  _startPcmCapture();
  _useOpus = false;
  console.log('[voice] capture: ScriptProcessor PCM fallback active');
}

async function _startOpusCapture() {
  const ctx    = voiceState.captureCtx;
  const source = ctx.createMediaStreamSource(voiceState.localStream);

  const blob    = new Blob([_WORKLET_CODE], { type: 'application/javascript' });
  const blobUrl = URL.createObjectURL(blob);
  await ctx.audioWorklet.addModule(blobUrl);
  URL.revokeObjectURL(blobUrl);

  _captureWorklet = new AudioWorkletNode(ctx, 'mic-capture');
  source.connect(_captureWorklet);
  const silentGain = ctx.createGain(); silentGain.gain.value = 0;
  _captureWorklet.connect(silentGain); silentGain.connect(ctx.destination);

  _audioEncoder = new AudioEncoder({
    output: (chunk) => {
      const buf = new ArrayBuffer(chunk.byteLength);
      chunk.copyTo(buf);
      _routeVoiceChunk(buf, 'opus');
    },
    error: (e) => console.warn('[voice] AudioEncoder error:', e),
  });

  _audioEncoder.configure({
    codec: 'opus', sampleRate: OPUS_SAMPLE_RATE, numberOfChannels: 1,
    bitrate: OPUS_BITRATE,
  });

  // Frames arrive pre-filtered by the worklet's VAD floor — just encode them.
  _captureWorklet.port.onmessage = (e) => {
    if (voiceState.muted) return;
    const pcmFrame  = e.data; // Float32Array, 960 samples, VAD already applied
    const audioData = new AudioData({
      format: 'f32', sampleRate: OPUS_SAMPLE_RATE,
      numberOfFrames: pcmFrame.length, numberOfChannels: 1,
      timestamp: performance.now() * 1000,
      data: pcmFrame,
    });
    _audioEncoder.encode(audioData);
    audioData.close();
  };
}

// ─── FALLBACK: ScriptProcessorNode + FIR low-pass + Int16 PCM ────────────────
const TARGET_SAMPLE_RATE = 24000;
const SCRIPT_BUFFER_SIZE = 2048;

function _buildLowPassKernel(nativeSR, targetSR) {
  const ratio  = targetSR / nativeSR;
  const cutoff = ratio * 0.9;
  const taps   = 31;
  const half   = Math.floor(taps / 2);
  const kernel = new Float32Array(taps);
  for (let i = 0; i < taps; i++) {
    const n    = i - half;
    const sinc = n === 0 ? 1 : Math.sin(Math.PI * cutoff * n) / (Math.PI * cutoff * n);
    const w    = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (taps - 1));
    kernel[i]  = sinc * w;
  }
  const sum = kernel.reduce((a, b) => a + b, 0);
  for (let i = 0; i < taps; i++) kernel[i] /= sum;
  return kernel;
}

function _startPcmCapture() {
  if (!voiceState.localStream || !voiceState.captureCtx) return;
  const ctx        = voiceState.captureCtx;
  const source     = ctx.createMediaStreamSource(voiceState.localStream);
  const nativeSR   = ctx.sampleRate;
  const downsample = Math.max(1, Math.round(nativeSR / TARGET_SAMPLE_RATE));
  const lpKernel   = _buildLowPassKernel(nativeSR, TARGET_SAMPLE_RATE);
  const kernelLen  = lpKernel.length;
  const ringBuf    = new Float32Array(kernelLen);
  let   ringPos    = 0;

  _analyserNode         = ctx.createAnalyser();
  _analyserNode.fftSize = 256;
  _vadBuffer            = new Float32Array(_analyserNode.frequencyBinCount);
  source.connect(_analyserNode);

  _scriptProcessor = ctx.createScriptProcessor(SCRIPT_BUFFER_SIZE, 1, 1);
  source.connect(_scriptProcessor);
  const muteGain = ctx.createGain(); muteGain.gain.value = 0;
  _scriptProcessor.connect(muteGain); muteGain.connect(ctx.destination);

  _scriptProcessor.onaudioprocess = (e) => {
    if (voiceState.muted) return;
    const input = e.inputBuffer.getChannelData(0);
    _analyserNode.getFloatTimeDomainData(_vadBuffer);
    let sumSq = 0;
    for (let i = 0; i < _vadBuffer.length; i++) sumSq += _vadBuffer[i] * _vadBuffer[i];
    if (Math.sqrt(sumSq / _vadBuffer.length) < VAD_FLOOR) return;

    const outLen = Math.floor(input.length / downsample);
    const pcm16  = new Int16Array(outLen);
    for (let outIdx = 0; outIdx < outLen; outIdx++) {
      for (let d = 0; d < downsample; d++) {
        ringBuf[ringPos] = input[outIdx * downsample + d];
        ringPos = (ringPos + 1) % kernelLen;
      }
      let acc = 0;
      for (let k = 0; k < kernelLen; k++) {
        acc += lpKernel[k] * ringBuf[(ringPos - 1 - k + kernelLen * 2) % kernelLen];
      }
      const s = Math.max(-1, Math.min(1, acc));
      pcm16[outIdx] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    _routeVoiceChunk(pcm16.buffer, 'pcm16');
  };
}

function _stopCapture() {
  if (_audioEncoder) {
    try { _audioEncoder.close(); } catch {}
    _audioEncoder = null;
  }
  if (_captureWorklet) {
    try { _captureWorklet.disconnect(); } catch {}
    _captureWorklet = null;
  }
  if (_scriptProcessor) {
    try { _scriptProcessor.disconnect(); } catch {}
    _scriptProcessor = null;
  }
  _analyserNode = null;
  _vadBuffer    = null;
  _useOpus      = false;
}

// ─── ROUTE VOICE CHUNK ────────────────────────────────────────────────────────
function _routeVoiceChunk(audioData, codec) {
  // DM call: route directly to the connected peer, skip room tree entirely
  if (_dmCallPeerId.current) {
    const pid = _dmCallPeerId.current;
    const packet = {
      type:       'dm_voice',
      authorId:   state.myId,
      authorName: state.myName,
      codec,
      sampleRate: codec === 'opus' ? OPUS_SAMPLE_RATE : TARGET_SAMPLE_RATE,
      audio:      _bufToB64(audioData),
    };
    const conn = state.peerConns[pid]?.conn;
    if (conn?.open) _sendVoicePacket(conn, packet);
    return; // don't also route to rooms during a DM call
  }

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
      codec,
      sampleRate: codec === 'opus' ? OPUS_SAMPLE_RATE : TARGET_SAMPLE_RATE,
      audio:      _bufToB64(audioData),
    };

    if (r.parentConn?.open) _sendVoicePacket(r.parentConn, packet);
    for (const cid of r.childIds) {
      const conn = r.childConns[cid] || state.peerConns[cid]?.conn;
      if (conn?.open) _sendVoicePacket(conn, packet);
    }
  }
}

function _bufToB64(buf) {
  const bytes  = new Uint8Array(buf);
  const CHUNK  = 8192;
  let   binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function _sendVoicePacket(conn, packet) {
  try { conn.send(packet); } catch {}
}

// ─── RECEIVE VOICE DATA ───────────────────────────────────────────────────────
export function handleVoiceData(data, conn) {
  const { roomId: rid, vcId, authorId, audio, sampleRate, codec } = data;
  const r = state.rooms[rid]; if (!r || !audio) return;

  if (authorId !== state.myId) {
    if (r.parentConn?.open && conn.peer !== r.parentId) {
      _sendVoicePacket(r.parentConn, data);
    }
    for (const cid of r.childIds) {
      if (cid === conn.peer) continue;
      const c = r.childConns[cid] || state.peerConns[cid]?.conn;
      if (c?.open) _sendVoicePacket(c, data);
    }
  }

  if (r.myVoiceChannelId === vcId && authorId !== state.myId && !voiceState.deafened) {
    _markSpeaking(authorId, rid);
    if (codec === 'opus') {
      _playOpusChunk(authorId, audio);
    } else {
      _playPcmChunk(authorId, audio, sampleRate);
    }
  }
}

export function handleVoiceBinary(buf, conn) {}

// ─── PLAYBACK ─────────────────────────────────────────────────────────────────
//
// Per-peer jitter buffer using AudioContext scheduled playback.
//
// JITTER_AHEAD_S: how far ahead of "now" we schedule the first frame for a peer.
//   Larger = more latency but fewer cut-offs on late packets.
//   150ms covers multi-hop relay latency (each PeerJS hop adds ~20–50ms).
//
// MAX_LAG_S: if the playhead falls this far behind current time, we've had a
//   real gap (peer paused speaking, tab backgrounded, etc.) — resync forward.
//   Kept generous to avoid false resyncs during short bursts.
//
// MIN_SCHEDULE_AHEAD_S: minimum time ahead of now to schedule a frame, to
//   account for async AudioDecoder callback latency. Without this headroom,
//   frames decoded asynchronously arrive after their scheduled start time and
//   play immediately out of sequence, causing clicks and cut-offs.

const JITTER_AHEAD_S      = 0.15;  // 150ms initial lookahead (was 60ms)
const MAX_LAG_S           = 0.6;   // 600ms before resync (was 250ms)
const MIN_SCHEDULE_AHEAD_S = 0.02; // 20ms minimum headroom (was 5ms)

const _peerPlayhead  = {};
const _opusDecoders  = {};

function _ensureOpusDecoder(peerId) {
  if (_opusDecoders[peerId] && _opusDecoders[peerId].state !== 'closed') {
    return _opusDecoders[peerId];
  }
  const dec = new AudioDecoder({
    output: (audioData) => {
      const f32 = new Float32Array(audioData.numberOfFrames);
      audioData.copyTo(f32, { planeIndex: 0 });
      audioData.close();
      _schedulePcmFrame(peerId, f32, OPUS_SAMPLE_RATE);
    },
    error: (e) => console.warn(`[voice] AudioDecoder(${peerId}):`, e),
  });
  dec.configure({ codec: 'opus', sampleRate: OPUS_SAMPLE_RATE, numberOfChannels: 1 });
  _opusDecoders[peerId] = dec;
  return dec;
}

function _playOpusChunk(peerId, b64) {
  if (typeof AudioDecoder === 'undefined') return;
  _ensurePlayCtx();
  const dec = _ensureOpusDecoder(peerId);
  if (!dec || dec.state === 'closed') return;

  let buf;
  try {
    const binary = atob(b64);
    buf = new ArrayBuffer(binary.length);
    const bytes = new Uint8Array(buf);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  } catch (e) { return; }

  try {
    dec.decode(new EncodedAudioChunk({
      type:      'key',  // every Opus frame is independently decodable
      timestamp: performance.now() * 1000,
      data:      buf,
    }));
  } catch (e) { console.warn('[voice] Opus decode error:', e.message); }
}

function _playPcmChunk(peerId, b64, sampleRate) {
  _ensurePlayCtx();
  const ctx = voiceState.playCtx;
  if (!ctx || ctx.state === 'closed') return;

  let pcm16;
  try {
    const binary = atob(b64);
    const bytes  = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    pcm16 = new Int16Array(bytes.buffer);
  } catch (e) { return; }

  const f32 = new Float32Array(pcm16.length);
  for (let i = 0; i < pcm16.length; i++) {
    f32[i] = pcm16[i] / (pcm16[i] < 0 ? 0x8000 : 0x7FFF);
  }
  _schedulePcmFrame(peerId, f32, sampleRate || TARGET_SAMPLE_RATE);
}

function _schedulePcmFrame(peerId, f32, sampleRate) {
  const ctx = voiceState.playCtx;
  if (!ctx || ctx.state === 'closed') return;

  let audioBuf;
  try { audioBuf = ctx.createBuffer(1, f32.length, sampleRate); } catch { return; }
  audioBuf.getChannelData(0).set(f32);

  const chunkDuration = f32.length / sampleRate;
  const now           = ctx.currentTime;

  if (!_peerPlayhead[peerId] || _peerPlayhead[peerId] < now - MAX_LAG_S) {
    // First frame for this peer, or we've been silent long enough to warrant a
    // resync. Set the playhead far enough ahead to absorb decode async latency
    // plus at least one full chunk duration of jitter buffer.
    _peerPlayhead[peerId] = now + JITTER_AHEAD_S;
  }

  // Ensure we never schedule in the past or within MIN_SCHEDULE_AHEAD_S of now.
  // This is the critical guard against async AudioDecoder callbacks arriving
  // after their target start time (which causes clips and sequence errors).
  const startTime = Math.max(_peerPlayhead[peerId], now + MIN_SCHEDULE_AHEAD_S);
  _peerPlayhead[peerId] = startTime + chunkDuration;

  const src = ctx.createBufferSource();
  src.buffer = audioBuf;
  src.connect(voiceState.gainNode);
  src.start(startTime);
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
// A non-voice node detected that ALL peers are in voice and sent become_my_child.
// We (the root voice node) should adopt_request back to the sender so they
// become our parent — making them the new non-voice root of the cluster.
export function handleBecomeMyChild(data, conn) {
  const rid = data.roomId;
  const r   = state.rooms[rid]; if (!r) return;

  // Only the current root should handle this
  if (r.parentId) {
    console.log(`[voice] handleBecomeMyChild(${rid}) — we are not root, rejecting`);
    try { conn.send({ type: 'become_my_child_reject', roomId: rid, reason: 'not_root' }); } catch {}
    return;
  }

  console.log(`[voice] handleBecomeMyChild(${rid}) — ${data.requesterId} (${data.name||'?'}) will become our new parent`);

  // Connect to the requester and send them an adopt_request so they accept us
  // as their child.  We include fromBecomeMyChild:true so the receiver's
  // checkVoiceAdoptAffinity can pre-authorize us even if it hasn't yet
  // processed our voice_relay_promote message (race-condition guard).
  state.cb.connectTo?.(data.requesterId, c => {
    c.send({
      type:              'adopt_request',
      roomId:            rid,
      id:                state.myId,
      name:              state.myName,
      voiceChannelId:    r.myVoiceChannelId || null,
      fromBecomeMyChild: true,   // tells receiver to bypass voice-affinity redirect
    });
  }, () => {
    console.warn(`[voice] handleBecomeMyChild(${rid}) — could not connect back to ${data.requesterId}`);
  });
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

// ─── VIDEO / SCREEN SHARE (WebRTC RTCPeerConnection per peer) ────────────────
// Each video stream is negotiated as a direct RTCPeerConnection between the
// local node and every other participant in the same voice channel.
// Signalling (offer/answer/ICE) piggybacks on the existing DataConnection.

const _videoPCs   = {};  // peerId → RTCPeerConnection
const _localVideoStream = { cam: null, screen: null }; // currently active local streams

const VIDEO_ICE = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'turn:openrelay.metered.ca:80',                username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443',               username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

function _getOrCreatePC(peerId, rid) {
  if (_videoPCs[peerId]?.connectionState === 'closed') delete _videoPCs[peerId];
  if (_videoPCs[peerId]) return _videoPCs[peerId];

  const pc = new RTCPeerConnection({ iceServers: VIDEO_ICE });
  _videoPCs[peerId] = pc;

  pc.onicecandidate = ({ candidate }) => {
    if (!candidate) return;
    _sendVideoSignal(peerId, rid, { type: 'video_ice', candidate: candidate.toJSON() });
  };

  pc.ontrack = (e) => {
    console.log(`[voice] video track received from ${peerId}`);
    import('./ui.js').then(ui => ui.setRemoteVideoTrack(peerId, e.streams[0]));
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      delete _videoPCs[peerId];
      import('./ui.js').then(ui => ui.clearRemoteVideo(peerId));
    }
  };

  // Add any already-active local tracks
  const tracks = [
    ...(_localVideoStream.cam?.getTracks()    || []),
    ...(_localVideoStream.screen?.getTracks() || []),
  ];
  for (const t of tracks) pc.addTrack(t, _localVideoStream.cam || _localVideoStream.screen);

  return pc;
}

function _sendVideoSignal(peerId, rid, msg) {
  const conn = state.peerConns[peerId]?.conn;
  if (conn?.open) try { conn.send({ ...msg, roomId: rid }); } catch {}
}

// Called by handleVideoSignal in main.js when a video_offer/answer/ice arrives
export async function handleVideoSignal(data, conn) {
  const rid    = data.roomId;
  const peerId = conn.peer;
  // Allow '__dm__' sentinel for direct DM calls; skip room-lookup guard
  const r = state.rooms[rid];
  if (!r && rid !== '__dm__') return;

  if (data.type === 'video_offer') {
    const pc = _getOrCreatePC(peerId, rid);
    await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    _sendVideoSignal(peerId, rid, { type: 'video_answer', sdp: pc.localDescription });
  } else if (data.type === 'video_answer') {
    await _videoPCs[peerId]?.setRemoteDescription(new RTCSessionDescription(data.sdp));
  } else if (data.type === 'video_ice') {
    try { await _videoPCs[peerId]?.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch {}
  } else if (data.type === 'video_stop') {
    // Remote peer stopped sharing
    import('./ui.js').then(ui => ui.clearRemoteVideo(peerId));
    if (_videoPCs[peerId]) {
      _videoPCs[peerId].close();
      delete _videoPCs[peerId];
    }
  }
}

async function _startVideoShare(rid, stream, label) {
  _localVideoStream[label] = stream;
  import('./ui.js').then(ui => ui.setLocalVideoStream(stream, label));

  // Offer to all current voice-channel peers
  const r = state.rooms[rid]; if (!r) return;
  const peers = Object.entries(r.clusterMap)
    .filter(([pid, e]) => e.voiceChannelId === r.myVoiceChannelId && pid !== state.myId)
    .map(([pid]) => pid);

  for (const peerId of peers) {
    const pc = _getOrCreatePC(peerId, rid);
    for (const t of stream.getTracks()) {
      const senders = pc.getSenders();
      if (!senders.find(s => s.track === t)) pc.addTrack(t, stream);
    }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    _sendVideoSignal(peerId, rid, { type: 'video_offer', sdp: pc.localDescription });
  }
}

export async function startCamShare(rid) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    await _startVideoShare(rid, stream, 'cam');
    toast('Camera on', 'success');
  } catch (e) { toast('Camera access denied', 'error'); }
}

export async function startScreenShare(rid) {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    stream.getVideoTracks()[0].onended = () => stopVideoShare(rid, 'screen');
    await _startVideoShare(rid, stream, 'screen');
    toast('Screen sharing', 'success');
  } catch (e) { toast('Screen share cancelled', 'info'); }
}

export function stopVideoShare(rid, label = 'cam') {
  const stream = _localVideoStream[label];
  if (!stream) return;
  stream.getTracks().forEach(t => t.stop());
  _localVideoStream[label] = null;
  import('./ui.js').then(ui => ui.clearLocalVideo(label));

  // Notify peers
  const r = state.rooms[rid]; if (!r) return;
  const peers = Object.entries(r.clusterMap)
    .filter(([pid, e]) => e.voiceChannelId === r.myVoiceChannelId && pid !== state.myId)
    .map(([pid]) => pid);
  for (const peerId of peers) _sendVideoSignal(peerId, rid, { type: 'video_stop' });

  // If no more video, tear down all PCs
  if (!_localVideoStream.cam && !_localVideoStream.screen) {
    for (const [pid, pc] of Object.entries(_videoPCs)) { pc.close(); delete _videoPCs[pid]; }
  }
}

export function stopAllVideo(rid) {
  stopVideoShare(rid, 'cam');
  stopVideoShare(rid, 'screen');
}

// Called by ui.js after rebuilding the call view DOM to reattach active streams.
export function reattachActiveStreams() {
  // Reattach local streams
  const localStream = _localVideoStream.screen || _localVideoStream.cam;
  if (localStream) {
    import('./ui.js').then(ui => ui.setLocalVideoStream(localStream, _localVideoStream.screen ? 'screen' : 'cam'));
  }
  // Reattach remote streams from open PeerConnections
  for (const [peerId, pc] of Object.entries(_videoPCs)) {
    const receivers = pc.getReceivers?.() || [];
    const videoReceiver = receivers.find(r => r.track?.kind === 'video' && r.track.readyState === 'live');
    if (videoReceiver) {
      const stream = new MediaStream([videoReceiver.track]);
      import('./ui.js').then(ui => ui.setRemoteVideoTrack(peerId, stream));
    }
  }
}

// ─── DIRECT DM CALL AUDIO ────────────────────────────────────────────────────
// Reuses the existing capture/playback pipeline but routes audio directly to
// the peer via the existing DataConnection (Opus chunks) rather than through
// a room tree.  Video uses the same RTCPeerConnection path as room calls.

const _dmCallPeerId = { current: null };

export async function startDMCallAudio(peerId) {
  _dmCallPeerId.current = peerId;
  try { await startLocalAudio(); } catch {
    import('./ui.js').then(ui => ui.toast?.('Microphone access denied', 'error'));
    return;
  }
  console.log('[voice] DM call audio started with', peerId);
}

export function stopDMCallAudio() {
  _dmCallPeerId.current = null;
  stopLocalAudio();
  stopAllPeerAudio();
  console.log('[voice] DM call audio stopped');
}


export function handleDMVoiceData(data, conn) {
  if (!_dmCallPeerId.current) return;
  const { authorId, audio, sampleRate, codec } = data;
  if (!audio || authorId === state.myId) return;
  _markSpeaking(authorId, null);
  if (!voiceState.deafened) {
    if (codec === 'opus') _playOpusChunk(authorId, audio);
    else _playPcmChunk(authorId, audio, sampleRate);
  }
}

// Raw mute/deafen toggles (no room context needed)
export function toggleMuteRaw() {
  voiceState.muted = !voiceState.muted;
  if (voiceState.localStream) voiceState.localStream.getAudioTracks().forEach(t => { t.enabled = !voiceState.muted; });
}
export function toggleDeafenRaw() {
  voiceState.deafened = !voiceState.deafened;
  if (voiceState.gainNode) voiceState.gainNode.gain.value = voiceState.deafened ? 0 : 1;
}

// Camera / screen share for DM calls — reuse existing RTCPeerConnection path
// with peerId instead of a room; video signalling goes directly over peerConns.
export async function startDMCallCam(peerId) {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
    _localVideoStream.cam = stream;
    import('./ui.js').then(ui => ui.setLocalVideoStream?.(stream, 'cam'));
    const pc = _getOrCreatePC(peerId, '__dm__');
    for (const t of stream.getTracks()) pc.addTrack(t, stream);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const conn = state.peerConns[peerId]?.conn;
    if (conn?.open) conn.send({ type: 'video_offer', sdp: pc.localDescription, roomId: '__dm__' });
    import('./ui.js').then(ui => ui.toast?.('Camera on', 'success'));
  } catch { import('./ui.js').then(ui => ui.toast?.('Camera access denied', 'error')); }
}

export async function startDMCallScreen(peerId) {
  try {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    stream.getVideoTracks()[0].onended = () => stopVideoShare('__dm__', 'screen');
    _localVideoStream.screen = stream;
    import('./ui.js').then(ui => ui.setLocalVideoStream?.(stream, 'screen'));
    const pc = _getOrCreatePC(peerId, '__dm__');
    for (const t of stream.getTracks()) pc.addTrack(t, stream);
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    const conn = state.peerConns[peerId]?.conn;
    if (conn?.open) conn.send({ type: 'video_offer', sdp: pc.localDescription, roomId: '__dm__' });
    import('./ui.js').then(ui => ui.toast?.('Screen sharing', 'success'));
  } catch { import('./ui.js').then(ui => ui.toast?.('Screen share cancelled', 'info')); }
}
