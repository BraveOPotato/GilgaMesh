import { CONN_TIMEOUT, HEARTBEAT_INTERVAL, PING_TIMEOUT, SCORE_WINDOW } from './constants.js';
import { state } from './state.js';
import { generatePeerId } from './ids.js';
import { saveStorage } from './storage.js';
import { updateMyInfo, setStatus, toast } from './ui.js';
import { recordConnStart } from './election.js';  // ← for uptime-based election scores

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
  // Record our own uptime start for election score calculations
  recordConnStart(id);
  saveStorage();
  updateMyInfo();
  setStatus('alone', 'online');
  toast('Your ID: ' + id, 'info');

  // Start heartbeat and topology refresh
  state.heartbeatTimer = setInterval(doHeartbeat, HEARTBEAT_INTERVAL);
  state.topoTimer      = setInterval(renderTopology, 2500);
  renderTopology();

  if (window.backToRooms) window.backToRooms();
  import('./mesh.js').then(m => { for (const rid of Object.keys(state.rooms)) m.attemptRoomReconnect(rid); });
}

// ─── INCOMING CHAT CONNECTION ─────────────────────────────────────────────────
function handleIncomingChatConn(conn) {
  conn.on('open', () => {
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
  const existing = state.peerConns[pid];
  if (existing && existing.conn && existing.conn.open && existing.conn !== conn) {
    try { conn.close(); } catch {}
    return;
  }
  if (!state.peerConns[pid]) {
    state.peerConns[pid] = { conn, rooms: new Set(), lastSeen: Date.now(), scores: [] };
  } else {
    state.peerConns[pid].conn     = conn;
    state.peerConns[pid].lastSeen = Date.now();
  }
  // Record connection start time for election uptime scoring
  recordConnStart(pid);

  conn.on('data',  data => state.cb.handleChatData?.(data, conn));
  conn.on('close', () => { if (state.peerConns[pid]?.conn === conn) state.cb.handlePeerDisconnect?.(pid); });
  conn.on('error', () => { if (state.peerConns[pid]?.conn === conn) state.cb.handlePeerDisconnect?.(pid); });
}

// ─── CONNECT TO A PEER ───────────────────────────────────────────────────────
export function connectTo(targetId, onSuccess, onFail) {
  if (!targetId || targetId === state.myId) { onFail?.(); return; }
  const ex = state.peerConns[targetId];
  if (ex && ex.conn && ex.conn.open) {
    for (const [rid, r] of Object.entries(state.rooms)) sendHandshake(ex.conn, rid, r);
    onSuccess?.(ex.conn);
    return;
  }
  let settled = false;
  const conn  = state.peer.connect(targetId, { reliable: true, serialization: 'json' });
  const timer = setTimeout(() => {
    if (!settled) { settled = true; try { conn.close(); } catch {} onFail?.(); }
  }, CONN_TIMEOUT);

  conn.on('open', () => {
    if (settled) return; settled = true; clearTimeout(timer);
    setupChatConn(conn);
    const pc = state.peerConns[conn.peer];
    for (const [rid, r] of Object.entries(state.rooms)) {
      if (pc) pc.rooms.add(rid);
      sendHandshake(conn, rid, r);
    }
    onSuccess?.(conn);
  });
  conn.on('error', () => { clearTimeout(timer); if (!settled) { settled = true; onFail?.(); } });
}

// ─── HANDSHAKE PACKET ────────────────────────────────────────────────────────
export function sendHandshake(conn, rid, r) {
  try {
    conn.send({
      type:           'handshake',
      roomId:         rid,
      id:             state.myId,
      name:           state.myName,
      parentId:       r.parentId,
      distanceFromRoot: r.distanceFromRoot,
      childCount:     r.childIds.length,
      electionEpoch:  r.electionEpoch,
      clusterMap:     r.clusterMap,
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

// renderTopology is called from the topo timer; lazy-import to avoid circular dep at load
function renderTopology() {
  import('./ui.js').then(ui => ui.renderTopology());
}
