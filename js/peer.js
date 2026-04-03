import { CONN_TIMEOUT, HEARTBEAT_INTERVAL, PING_TIMEOUT, SCORE_WINDOW } from './constants.js';
import { state } from './state.js';
import { generatePeerId } from './ids.js';
import { saveStorage } from './storage.js';
import { updateMyInfo, setStatus, toast } from './ui.js';
import { recordConnStart } from './election.js';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.services.mozilla.com' },
  { urls: 'turn:openrelay.metered.ca:80',                username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443',               username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

export function startPeer() {
  setStatus('searching', 'connecting…');
  const opts = { debug: 0, config: { iceServers: ICE_SERVERS, iceCandidatePoolSize: 10, iceTransportPolicy: 'all' } };
  try   { state.peer = state.myId ? new Peer(state.myId, opts) : new Peer(generatePeerId(), opts); }
  catch { state.peer = new Peer(generatePeerId(), opts); }

  state.peer.on('open', onPeerOpen);
  state.peer.on('connection', conn => {
    if (conn.label && conn.label.startsWith('file:')) handleIncomingFileConn(conn);
    else handleIncomingChatConn(conn);
  });
  state.peer.on('error', err => {
    if (err.type === 'peer-unavailable') return;
    if (err.type === 'unavailable-id') {
      state.myId = null; saveStorage(); state.peer.destroy(); startPeer();
    } else { console.warn('PeerJS:', err.type, err); }
  });
  state.peer.on('disconnected', () => {
    setStatus('searching', 'reconnecting…');
    setTimeout(() => { try { if (!state.peer.destroyed) state.peer.reconnect(); } catch {} }, 2000);
  });
}

function onPeerOpen(id) {
  state.myId = id;
  recordConnStart(id);
  saveStorage();
  updateMyInfo();
  setStatus('alone', 'online');
  toast('Your ID: ' + id, 'info');

  state.heartbeatTimer = setInterval(doHeartbeat, HEARTBEAT_INTERVAL);
  state.topoTimer      = setInterval(renderTopology, 2500);
  renderTopology();

  if (window.backToRooms) window.backToRooms();
  import('./mesh.js').then(m => { for (const rid of Object.keys(state.rooms)) m.attemptRoomReconnect(rid); });
}

// ─── INCOMING CHAT CONNECTION ─────────────────────────────────────────────────
function handleIncomingChatConn(conn) {
  conn.on('open', () => {
    // If we already have an open connection to this peer, keep the one whose
    // peer ID sorts higher (deterministic tie-break) to prevent both sides
    // closing the other's connection and ending up with nothing.
    const existing = state.peerConns[conn.peer];
    if (existing?.conn?.open && existing.conn !== conn) {
      if (state.myId > conn.peer) {
        // We win — close the incoming duplicate silently
        try { conn.close(); } catch {}
        return;
      }
      // They win — replace our outbound conn with this incoming one.
      // Don't fire disconnect; just swap.
      try { existing.conn.close(); } catch {}
    }
    setupChatConn(conn);
    const pc = state.peerConns[conn.peer];
    for (const [rid, r] of Object.entries(state.rooms)) {
      if (pc) pc.rooms.add(rid);
      sendHandshake(conn, rid, r);
    }
  });
  conn.on('error', () => {});
}

// ─── SETUP / DEDUPLICATION ───────────────────────────────────────────────────
export function setupChatConn(conn) {
  const pid = conn.peer;

  // Guard: never register handlers on a conn object more than once.
  if (conn._gmSetup) return;
  conn._gmSetup = true;

  if (!state.peerConns[pid]) {
    state.peerConns[pid] = { conn, rooms: new Set(), lastSeen: Date.now(), scores: [] };
  } else {
    state.peerConns[pid].conn     = conn;
    state.peerConns[pid].lastSeen = Date.now();
  }
  recordConnStart(pid);

  conn.on('data',  data => state.cb.handleChatData?.(data, conn));
  conn.on('close', () => {
    // Only trigger disconnect if this conn is still the active one.
    // A replaced/deduped conn closing must not tear down the new conn.
    if (state.peerConns[pid]?.conn === conn) state.cb.handlePeerDisconnect?.(pid);
  });
  conn.on('error', () => {
    if (state.peerConns[pid]?.conn === conn) state.cb.handlePeerDisconnect?.(pid);
  });
}

// ─── CONNECT TO A PEER ───────────────────────────────────────────────────────
// Keeps a connection attempt alive for CONN_TIMEOUT ms, polling every 200 ms
// for the open event as a fallback against PeerJS not firing it on cold start.
export function connectTo(targetId, onSuccess, onFail) {
  if (!targetId || targetId === state.myId) { onFail?.(); return; }

  // Reuse an existing open connection immediately.
  const ex = state.peerConns[targetId];
  if (ex?.conn?.open) {
    for (const [rid, r] of Object.entries(state.rooms)) sendHandshake(ex.conn, rid, r);
    onSuccess?.(ex.conn);
    return;
  }

  // If the PeerJS peer isn't open yet, wait for it then retry.
  if (!state.peer?.open) {
    console.warn(`[peer] connectTo(${targetId}) — peer not open yet, waiting…`);
    const onPeerOpen = () => connectTo(targetId, onSuccess, onFail);
    state.peer.once('open', onPeerOpen);
    setTimeout(() => {
      state.peer.off('open', onPeerOpen);
      onFail?.();
    }, CONN_TIMEOUT);
    return;
  }

  const conn = state.peer.connect(targetId, { reliable: true, serialization: 'json' });

  if (!conn) {
    console.warn(`[peer] connectTo(${targetId}) — peer.connect() returned undefined`);
    onFail?.();
    return;
  }

  console.log(`[peer] connectTo(${targetId}) — connection created, waiting for open…`);

  let settled = false;

  const succeed = () => {
    if (settled) return;
    settled = true;
    clearTimeout(hardTimer);
    clearInterval(pollTimer);

    // Prefer an incoming conn from this peer if one raced us and won.
    const ex2 = state.peerConns[targetId];
    if (ex2?.conn?.open && ex2.conn !== conn) {
      console.log(`[peer] connectTo(${targetId}) — using incoming conn that raced ours`);
      try { conn.close(); } catch {}
      onSuccess?.(ex2.conn);
      return;
    }

    setupChatConn(conn);
    const pc = state.peerConns[conn.peer];
    for (const [rid, r] of Object.entries(state.rooms)) {
      if (pc) pc.rooms.add(rid);
      sendHandshake(conn, rid, r);
    }
    console.log(`[peer] connectTo(${targetId}) — open, handshakes sent`);
    onSuccess?.(conn);
  };

  const fail = (reason) => {
    if (settled) return;
    settled = true;
    clearTimeout(hardTimer);
    clearInterval(pollTimer);
    console.warn(`[peer] connectTo(${targetId}) — failed: ${reason}`);
    try { conn.close(); } catch {}
    onFail?.();
  };

  // Poll every 200 ms — catches the case where PeerJS fires open before our
  // listener is registered (can happen on cold start / first-ever connection).
  const pollTimer = setInterval(() => {
    if (conn.open) succeed();
  }, 200);

  // Hard timeout — give up after CONN_TIMEOUT.
  const hardTimer = setTimeout(() => fail('timeout'), CONN_TIMEOUT);

  conn.on('open',  () => succeed());
  conn.on('error', (err) => fail(err?.type || 'error'));
}

// ─── HANDSHAKE PACKET ────────────────────────────────────────────────────────
export function sendHandshake(conn, rid, r) {
  try {
    conn.send({
      type:             'handshake',
      roomId:           rid,
      id:               state.myId,
      name:             state.myName,
      parentId:         r.parentId,
      distanceFromRoot: r.distanceFromRoot,
      childCount:       r.childIds.length,
      electionEpoch:    r.electionEpoch,
      clusterMap:       r.clusterMap,
    });
  } catch {}
}

// ─── HEARTBEAT ───────────────────────────────────────────────────────────────
function doHeartbeat() {
  const now = Date.now();
  for (const [pid, pc] of Object.entries(state.peerConns)) {
    if (!pc.conn || !pc.conn.open) { state.cb.handlePeerDisconnect?.(pid); continue; }
    try { pc.conn.send({ type: 'ping', ts: now, id: state.myId }); } catch {}
    if (now - pc.lastSeen > PING_TIMEOUT) state.cb.handlePeerDisconnect?.(pid);
  }
  state.cb.renderTopology?.();
  state.cb.updateNetworkPanel?.();
}

export function handlePong(data, pid) {
  const rtt = Date.now() - data.ts;
  const pc  = state.peerConns[pid]; if (!pc) return;
  pc.lastSeen = Date.now();
  pc.scores.push(rtt);
  if (pc.scores.length > SCORE_WINDOW * 2) pc.scores.shift();
  state.cb.updateLatencyDisplay?.();
}

// ─── FILE CONNECTIONS ─────────────────────────────────────────────────────────
function handleIncomingFileConn(conn) {
  const token = conn.label.replace('file:', '');
  conn.on('open', () => {
    conn.on('data', msg => {
      if (msg?.type === 'file_request' && msg.token === token) {
        import('./files.js').then(f => f.sendFileOverConn(conn, token));
      }
    });
    conn.on('error', err => console.warn('file conn error', err));
  });
}

function renderTopology() {
  import('./ui.js').then(ui => ui.renderTopology());
}

// ─── SCOUT CONNECTION (cluster map fetch only) ────────────────────────────────
// Opens a temporary connection to targetId, sends a cluster_map_request, waits
// for the cluster_map response, then closes the connection.  Does NOT call
// setupChatConn, does NOT send handshakes, does NOT register in peerConns as a
// permanent peer — the joiner is invisible to the cluster until it sends an
// adopt_request on the real join connection.
export function scoutClusterMap(targetId, rid, onMap, onFail) {
  if (!targetId || targetId === state.myId) { onFail?.('invalid target'); return; }
  const r = state.rooms[rid]; if (!r) { onFail?.('no room'); return; }

  console.log(`[peer] scoutClusterMap(${rid}) — connecting to ${targetId} for map`);

  // If we already have an open permanent connection to this peer we can reuse
  // it to ask for the map without tearing anything down.
  const ex = state.peerConns[targetId];
  if (ex?.conn?.open) {
    console.log(`[peer] scoutClusterMap(${rid}) — reusing existing conn to ${targetId}`);
    ex.conn.send({ type: 'cluster_map_request', roomId: rid, id: state.myId, name: state.myName });
    // onMap will be called by the normal handleClusterMap path in main.js
    onMap?.(null); // signal that map will arrive via normal dispatch
    return;
  }

  // Wait for peer to be open (same guard as connectTo).
  if (!state.peer?.open) {
    console.warn(`[peer] scoutClusterMap(${rid}) — peer not open yet, waiting…`);
    const onPeerOpen = () => scoutClusterMap(targetId, rid, onMap, onFail);
    state.peer.once('open', onPeerOpen);
    setTimeout(() => { state.peer.off('open', onPeerOpen); onFail?.('peer-not-ready'); }, CONN_TIMEOUT);
    return;
  }

  const conn = state.peer.connect(targetId, { reliable: true, serialization: 'json', label: 'scout' });

  if (!conn) {
    console.warn(`[peer] scoutClusterMap(${rid}) — peer.connect() returned undefined`);
    onFail?.('connect-returned-null');
    return;
  }

  let settled = false;
  let mapRequested = false;

  const sendMapRequest = () => {
    if (mapRequested) return;
    mapRequested = true;
    console.log(`[peer] scoutClusterMap(${rid}) — scout conn open to ${targetId}, requesting map`);
    try { conn.send({ type: 'cluster_map_request', roomId: rid, id: state.myId, name: state.myName }); } catch {}
  };

  const fail = (reason) => {
    if (settled) return;
    settled = true;
    clearInterval(pollTimer);
    clearTimeout(hardTimer);
    console.log(`[peer] scoutClusterMap(${rid}) — failed: ${reason}`);
    try { conn.close(); } catch {}
    onFail?.(reason);
  };

  // Poll every 200 ms for open — mirrors connectTo behaviour for cold-start reliability.
  const pollTimer = setInterval(() => { if (conn.open) sendMapRequest(); }, 200);
  const hardTimer = setTimeout(() => fail('timeout'), CONN_TIMEOUT);

  conn.on('open', () => sendMapRequest());

  conn.on('data', msg => {
    if (settled) return;
    if (msg?.type === 'cluster_map' && msg.roomId === rid) {
      settled = true;
      clearInterval(pollTimer);
      clearTimeout(hardTimer);
      console.log(`[peer] scoutClusterMap(${rid}) — received map with ${Object.keys(msg.map || {}).length} entries, closing scout conn`);
      try { conn.close(); } catch {}
      onMap?.(msg.map);
    }
  });

  conn.on('error', (err) => fail(err?.type || 'error'));
  conn.on('close', () => { if (!settled) fail('closed'); });
}
