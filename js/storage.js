import { STORAGE_KEY } from './constants.js';
import { state } from './state.js';

export function loadStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    state.myName      = d.name    || '';
    state.myId        = d.id      || null;
    state.peerAliases = d.aliases || {};
    const stored = d.rooms || {};
    for (const [rid, r] of Object.entries(stored)) {
      state.rooms[rid] = makeRoomShell(r.id, r.name, r.createdBy);
      state.rooms[rid].savedPeers = r.savedPeers || [];
      if (r.channels && r.channels.length) state.rooms[rid].channels = r.channels;
      if (r.voiceChannels?.length) state.rooms[rid].voiceChannels = r.voiceChannels;
      else state.rooms[rid].voiceChannels = [{ id: 'vc-general', name: 'general' }];
      // Restore known peers so offline members remain visible in the sidebar
      if (r.peers) {
        for (const [pid, p] of Object.entries(r.peers)) {
          state.rooms[rid].peers[pid] = { id: pid, name: p.name || pid };
        }
      }
      const msgs = r.messages || {};
      for (const ch of state.rooms[rid].channels) {
        state.rooms[rid].messages[ch.id] = (msgs[ch.id] || []).slice(-200);
        state.rooms[rid].unread[ch.id]   = 0;
      }
    }
    const theme = localStorage.getItem('gilgamesh_theme') || 'dark';
    state.currentTheme = theme;
  } catch(e) { console.warn('loadStorage', e); }
}

export function saveStorage() {
  const storedRooms = {};
  for (const [rid, r] of Object.entries(state.rooms)) {
    const msgs = {};
    for (const ch of r.channels) msgs[ch.id] = (r.messages[ch.id] || []).slice(-200);
    // Persist peer registry (id + name) so offline members stay visible after reload
    const peerRegistry = {};
    for (const [pid, p] of Object.entries(r.peers || {})) {
      peerRegistry[pid] = { id: pid, name: p.name || pid };
    }
    storedRooms[rid] = {
      id: r.id, name: r.name, createdBy: r.createdBy,
      savedPeers: r.savedPeers, channels: r.channels, messages: msgs,
      voiceChannels: r.voiceChannels || [],
      peers: peerRegistry,
    };
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify({
    name: state.myName, id: state.myId,
    aliases: state.peerAliases,
    rooms: storedRooms,
  }));
}

// ─── ROOM SHELL ───────────────────────────────────────────────────────────────
export function makeRoomShell(id, name, createdBy) {
  const r = {
    id, name, createdBy,

    // ── Tree topology ────────────────────────────────────────────────────────
    parentId:      null,   // upstream peer ID (null = we are root)
    parentConn:    null,   // DataConnection to parent
    grandparentId: null,   // parent's parent — stored for fast upstream reconnect
    childIds:      [],     // up to SOFT_CHILD_LIMIT official children (ranked by RTT)
    childConns:    {},     // peerId → DataConnection
    backupId:      null,   // random backup peer ID
    backupConn:    null,   // DataConnection to backup
    distanceFromRoot: 0,   // hops from the root node

    // Siblings (children of our parent, excluding us) — populated by child_list
    siblings:    [],
    bestSibling: null,     // best-RTT sibling, used as a hint during recovery

    // ── Recovery & rebalancing ───────────────────────────────────────────────
    recoveryLock:   0,     // Date.now() value until which new recovery is suppressed
    rebalanceTimer: null,  // setInterval handle
    _joiningParent: false, // true while findAndJoinParent is in progress
    _recoverCollect: null, // callback set during RECOVER_PROCEDURE for response collection

    // ── Cluster topology snapshot ─────────────────────────────────────────────
    clusterMap: {},   // peerId → { distance, connCount, name, descendantCount }

    // ── Election state (local: parent + children only) ───────────────────────
    electionTimer:  null,
    electionVotes:  {},
    electionEpoch:  0,

    // ── Voice channels ───────────────────────────────────────────────────────
    voiceChannels:    [{ id: 'vc-general', name: 'general' }],   // [{ id, name }]
    myVoiceChannelId: null, // voice channel this node is currently in

    // ── Chat ─────────────────────────────────────────────────────────────────
    channels:    [
      { id: 'general', name: 'general', desc: 'General chat' },
      { id: 'random',  name: 'random',  desc: 'Anything goes' },
    ],
    messages:    {},
    unread:      {},
    pendingMsgs: [],

    // ── Dedup cache ───────────────────────────────────────────────────────────
    seenMsgIds:    [],  // last MSG_CACHE_SIZE message IDs
    seenTypingIds: [],  // last 60 typing-event IDs

    // ── Per-room peer registry ────────────────────────────────────────────────
    peers:      {},   // peerId → { name, id }
    knownPeers: {},
    typingPeers:{},
    savedPeers: [],
  };
  for (const ch of r.channels) { r.messages[ch.id] = []; r.unread[ch.id] = 0; }
  return r;
}
