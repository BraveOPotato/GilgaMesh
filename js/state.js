// ─── SHARED MUTABLE STATE ────────────────────────────────────────────────────
// All modules import this and mutate it directly.
// No module should re-export a copy — always import { state } and use state.x.

export const state = {
  // Identity
  peer:         null,   // PeerJS Peer instance
  myId:         null,
  myName:       '',

  // Physical connections (shared across all rooms)
  // peerConns[peerId] = { conn, lastSeen, scores[], rooms: Set }
  peerConns:    {},

  // Rooms
  rooms:        {},     // roomId → Room object (from makeRoomShell)
  activeRoomId: null,
  activeChannel:'general',

  // UI
  peerAliases:  {},
  currentTheme: 'dark',
  sidebarOpen:  false,
  netPanelOpen: false,

  // Mention autocomplete
  mentionState: { active: false, start: -1, query: '', selected: 0, matches: [] },

  // Slash command autocomplete
  slashState:   { active: false, start: -1, query: '', selected: 0, matches: [] },
  _botCommands: [],  // populated by ui.updateBotCommandList()

  // Active reply target: { id, author, content } or null
  replyingTo:   null,

  // Friends & DMs
  friends:           {},   // peerId → { id, name, addedAt }
  blocked:           {},   // peerId → { id, name, blockedAt }
  dms:               {},   // peerId → [ ...messages ]
  dmUnread:          {},   // peerId → count
  activeDMPeer:      null, // peerId of open DM thread
  dmCall:            null, // { peerId, peerName, active, initiator } when in a DM call
  dmCallSpeakers:    {},   // peerId → true when speaking in DM call
  activeFriendsView: false,// true when in friends context

  // File shares (global, not per-room)
  fileShares:   {},   // token → { file, expires, filename, size, mime }

  // Peers currently being contacted (shown as "checking..." in Members list)
  peerChecking: new Set(),  // Set of peerIds currently being tried

  // Cross-module callbacks — populated by main.js at boot to break circular deps
  // Each is a function reference set after all modules load
  cb: {
    handleChatData:      null,  // (data, conn) — set by main.js
    handlePeerDisconnect:null,  // (pid) — set by main.js
    flushPendingMessages:null,  // (rid) — set by main.js
    addSystemMsg:        null,  // (rid, channel, text) — set by main.js
    renderTopology:      null,  // () — set by main.js
    updateNetworkPanel:  null,  // () — set by main.js
  },

  // Timers
  heartbeatTimer: null,
  topoTimer:      null,
};

// ─── PURE STATE HELPERS (no imports needed) ─────────────────────────────────
export function roomIsRoot(rid) {
  return state.rooms[rid]?.parentId === null || state.rooms[rid]?.parentId === undefined;
}

export function totalConnCount(rid) {
  const r = state.rooms[rid]; if (!r) return 0;
  let n = r.childIds?.length ?? 0;
  if (r.parentId) n++;
  if (r.backupId) n++;
  return n;
}
