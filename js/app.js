/**
 * GilgaMesh — P2P Mesh Communication Network
 * v4: Rooms, per-room elections (20s), invite links, per-room unread badges,
 *     multi-room membership, robust connection deduplication
 */

// ─── CONSTANTS ────────────────────────────────────────────────────────────────
const MAX_CANDIDATES     = 10;
const ELECTION_INTERVAL  = 20000;    // 20 seconds
const HEARTBEAT_INTERVAL = 4000;
const RECONNECT_DELAY    = 2000;
const FILE_LINK_TTL      = 60000;
const STORAGE_KEY        = 'gilgamesh_v3';
const SCORE_WINDOW       = 10;
const CONN_TIMEOUT       = 8000;

// ─── GLOBAL PEER STATE ────────────────────────────────────────────────────────
let peer      = null;
let myId      = null;
let myName    = '';

// Physical connections — shared/reused across all rooms
// peerConns[peerId] = { conn, rooms: Set<roomId>, lastSeen, scores[] }
let peerConns = {};

// Candidate overrides (global)
let peerAliases        = {};
let globalRemovedCands = {};  // roomId → Set<peerId>

// ─── ROOM STATE ───────────────────────────────────────────────────────────────
let rooms         = {};   // roomId → Room object
let activeRoomId  = null;
let activeChannel = 'general';

let fileShares    = {};   // token → { file, expires, ... }

let heartbeatTimer  = null;
let electionTimers  = {};   // roomId → intervalId
let topoTimer       = null;
let sidebarOpen     = false;
let netPanelOpen    = false;
let currentTheme    = 'dark';

// ─── THEME ────────────────────────────────────────────────────────────────────
function initTheme() {
  applyTheme(localStorage.getItem('gilgamesh_theme') || 'dark', false);
}
function applyTheme(theme, save = true) {
  currentTheme = theme;
  document.documentElement.classList.toggle('dark',  theme === 'dark');
  document.documentElement.classList.toggle('light', theme === 'light');
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'dark' ? '#0d0f14' : '#f7f8fc';
  if (save) localStorage.setItem('gilgamesh_theme', theme);
}
function toggleTheme() { applyTheme(currentTheme === 'dark' ? 'light' : 'dark'); }

// ─── HUMAN-READABLE IDS ───────────────────────────────────────────────────────
const ADJECTIVES = [
  'amber','ancient','arctic','azure','blazing','bold','brave','bright','calm','celestial',
  'cerulean','chaotic','chosen','clever','cobalt','cosmic','crimson','crystal','cunning','dark',
  'daring','dawn','deep','distant','divine','dusk','eager','electric','emerald','endless',
  'epic','eternal','fierce','fiery','fleet','frosty','gilded','glacial','golden','grand',
  'grave','grim','hollow','humble','icy','idle','indigo','infinite','inner','iron',
  'jade','keen','kindled','lantern','lavender','lean','lofty','lone','lost','lucid',
  'lunar','mellow','mighty','mystic','narrow','neon','nimble','noble','obscure','ochre',
  'odd','old','omen','onyx','pale','phantom','primal','proud','quick','quiet',
  'radiant','rapid','raven','red','regal','restless','risen','roaming','rough','royal',
  'runed','sacred','sage','scarlet','serene','shining','silent','silver','sleek','solar',
  'somber','stark','steel','stern','still','storm','strong','subtle','sunken','swift',
  'teal','terse','timeless','tired','torn','twilight','twisted','ultra','vast','velvet',
  'veiled','vivid','wandering','wild','winter','wise','woven','zeal','zenith','zeroed'
];
const NOUNS = [
  'anvil','apex','arch','arrow','atlas','axe','beacon','blade','bloom','bolt',
  'bond','breach','bridge','cairn','candle','canyon','cape','cave','chain','cipher',
  'citadel','cliff','cloud','comet','compass','conduit','core','crest','crown','current',
  'cycle','dawn','delta','depth','door','dune','dust','echo','edge','ember',
  'epoch','falls','fang','field','flame','flare','flint','flood','flux','forge',
  'fork','frost','gate','glyph','gorge','grove','guide','gulf','harbor','haven',
  'hearth','helm','horizon','horn','island','keep','key','knot','lantern','ledge',
  'light','link','loop','mantle','mark','marsh','mesa','mesh','mirror','mist',
  'moon','mount','nexus','node','notch','oak','oracle','orbit','order','path',
  'peak','pillar','pine','plain','portal','prism','pulse','range','reef','relay',
  'ridge','rift','ring','root','rune','scale','shard','shore','signal','span',
  'spire','star','stone','storm','stream','summit','sun','surge','tide','timber',
  'torch','tower','trail','vault','veil','vessel','void','vortex','wake','wall',
  'ward','wave','well','wind','wire','world','wraith','yard','zenith','zone'
];
function generatePeerId() {
  const adj  = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const noun = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  return `${adj}-${noun}-${String(Math.floor(Math.random() * 9000) + 1000)}`;
}
function generateRoomId() {
  return String(Math.floor(Math.random() * 9000) + 1000);
}

// ─── STORAGE ──────────────────────────────────────────────────────────────────
function loadStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const d = JSON.parse(raw);
    myName      = d.name    || '';
    myId        = d.id      || null;
    peerAliases = d.aliases || {};
    const rem   = d.removed || {};
    globalRemovedCands = {};
    for (const [rid, arr] of Object.entries(rem)) globalRemovedCands[rid] = new Set(arr);
    const stored = d.rooms || {};
    for (const [rid, r] of Object.entries(stored)) {
      rooms[rid] = makeRoomShell(r.id, r.name, r.createdBy);
      rooms[rid].savedPeers = r.savedPeers || [];
      if (r.channels && r.channels.length) rooms[rid].channels = r.channels;
      const msgs = r.messages || {};
      for (const ch of rooms[rid].channels) {
        rooms[rid].messages[ch.id] = (msgs[ch.id] || []).slice(-200);
        rooms[rid].unread[ch.id]   = 0;
      }
    }
  } catch(e) { console.warn('loadStorage', e); }
}

function saveStorage() {
  const rem = {};
  for (const [rid, s] of Object.entries(globalRemovedCands)) rem[rid] = [...s];
  const storedRooms = {};
  for (const [rid, r] of Object.entries(rooms)) {
    const msgs = {};
    for (const ch of r.channels) msgs[ch.id] = (r.messages[ch.id] || []).slice(-200);
    storedRooms[rid] = { id:r.id, name:r.name, createdBy:r.createdBy, savedPeers:r.savedPeers, channels:r.channels, messages:msgs };
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ name:myName, id:myId, aliases:peerAliases, removed:rem, rooms:storedRooms }));
}

// ─── ROOM HELPERS ─────────────────────────────────────────────────────────────
function makeRoomShell(id, name, createdBy) {
  const r = {
    id, name, createdBy,
    serverId:null, isServer:false, serverConn:null,
    clientIds:new Set(), candidates:[], savedPeers:[],
    electionVotes:{},
    channels:[{ id:'general', name:'general', desc:'General chat' }, { id:'random', name:'random', desc:'Anything goes' }],
    messages:{}, unread:{}, peers:{}, knownPeers:{}, typingPeers:{},
  };
  for (const ch of r.channels) { r.messages[ch.id]=[]; r.unread[ch.id]=0; }
  return r;
}

function removedCands(rid) {
  if (!globalRemovedCands[rid]) globalRemovedCands[rid] = new Set();
  return globalRemovedCands[rid];
}

function totalRoomUnread(rid) {
  const r = rooms[rid]; if (!r) return 0;
  return Object.values(r.unread).reduce((a,b) => a+b, 0);
}

// ─── INIT ─────────────────────────────────────────────────────────────────────
function init() {
  initTheme();
  loadStorage();
  if (!myName) {
    document.getElementById('setup-modal').classList.remove('hidden');
    const ni = document.getElementById('setup-name');
    ni.focus();
    ni.addEventListener('keydown', e => { if (e.key === 'Enter') completeSetup(); });
  } else {
    startPeer();
  }
  setupUI();
}

// ─── PEER SETUP ───────────────────────────────────────────────────────────────
function startPeer() {
  setStatus('searching', 'connecting…');
  const iceServers = [
    { urls:'stun:stun.l.google.com:19302' },
    { urls:'stun:stun1.l.google.com:19302' },
    { urls:'stun:stun2.l.google.com:19302' },
    { urls:'stun:stun.services.mozilla.com' },
    { urls:'turn:openrelay.metered.ca:80',               username:'openrelayproject', credential:'openrelayproject' },
    { urls:'turn:openrelay.metered.ca:443',              username:'openrelayproject', credential:'openrelayproject' },
    { urls:'turn:openrelay.metered.ca:443?transport=tcp',username:'openrelayproject', credential:'openrelayproject' },
  ];
  const opts = { debug:0, config:{ iceServers, iceCandidatePoolSize:10, iceTransportPolicy:'all' } };
  try { peer = myId ? new Peer(myId, opts) : new Peer(generatePeerId(), opts); }
  catch(e) { peer = new Peer(generatePeerId(), opts); }

  peer.on('open', id => {
    myId = id; saveStorage(); updateMyInfo();
    setStatus('alone', 'online');
    toast('Your ID: ' + id, 'info');
    for (const rid of Object.keys(rooms)) { startRoomElectionTimer(rid); attemptRoomReconnect(rid); }
    heartbeatTimer = setInterval(doHeartbeat, HEARTBEAT_INTERVAL);
    topoTimer      = setInterval(renderTopology, 2500);
    renderTopology();
    backToRooms();
  });

  peer.on('connection', conn => {
    if (conn.label && conn.label.startsWith('file:')) handleIncomingFileConn(conn);
    else handleIncomingChatConn(conn);
  });

  peer.on('error', err => {
    if (err.type === 'peer-unavailable') return;
    if (err.type === 'unavailable-id') { myId=null; saveStorage(); peer.destroy(); startPeer(); }
    else console.warn('PeerJS:', err.type, err);
  });

  peer.on('disconnected', () => {
    setStatus('searching', 'reconnecting…');
    setTimeout(() => { try { if (!peer.destroyed) peer.reconnect(); } catch(e){} }, 2000);
  });
}

// ─── CONNECTIONS ──────────────────────────────────────────────────────────────
function handleIncomingChatConn(conn) {
  conn.on('open', () => {
    setupChatConn(conn);
    // Populate rooms tracking and send handshakes for all rooms we belong to
    const pc = peerConns[conn.peer];
    for (const rid of Object.keys(rooms)) {
      const r = rooms[rid];
      if (pc) pc.rooms.add(rid);
      conn.send({ type:'handshake', roomId:rid, id:myId, name:myName,
        isServer:r.isServer, serverId:r.serverId, candidates:r.candidates });
    }
  });
  conn.on('error', () => {});
}

function setupChatConn(conn) {
  const pid = conn.peer;
  const existing = peerConns[pid];
  // If we already have a healthy open connection to this peer, discard the duplicate.
  // This happens when both sides call connectTo simultaneously.
  if (existing && existing.conn && existing.conn.open && existing.conn !== conn) {
    try { conn.close(); } catch(e) {}
    return;
  }
  if (!peerConns[pid]) {
    peerConns[pid] = { conn, rooms:new Set(), lastSeen:Date.now(), scores:[] };
  } else {
    peerConns[pid].conn = conn;
    peerConns[pid].lastSeen = Date.now();
  }
  conn.on('data', data => handleChatData(data, conn));
  // Only treat close/error as a real disconnect if this conn is still the active one
  conn.on('close', () => { if (peerConns[pid] && peerConns[pid].conn === conn) handlePeerDisconnect(pid); });
  conn.on('error', () => { if (peerConns[pid] && peerConns[pid].conn === conn) handlePeerDisconnect(pid); });
}

function connectTo(targetId, onSuccess, onFail) {
  if (!targetId || targetId === myId) return;
  const ex = peerConns[targetId];
  if (ex && ex.conn && ex.conn.open) {
    // Already connected — still send handshakes for any rooms they may not know about
    for (const rid of Object.keys(rooms)) {
      const r = rooms[rid];
      try { ex.conn.send({ type:'handshake', roomId:rid, id:myId, name:myName,
        isServer:r.isServer, serverId:r.serverId, candidates:r.candidates }); } catch(e) {}
    }
    onSuccess && onSuccess(ex.conn);
    return;
  }
  let settled = false;
  const conn = peer.connect(targetId, { reliable:true, serialization:'json' });
  const timer = setTimeout(() => {
    if (!settled) { settled=true; try{conn.close();}catch(e){} onFail&&onFail(); }
  }, CONN_TIMEOUT);
  conn.on('open', () => {
    if (settled) return; settled=true; clearTimeout(timer);
    setupChatConn(conn);
    const pc = peerConns[conn.peer];
    for (const rid of Object.keys(rooms)) {
      const r = rooms[rid];
      if (pc) pc.rooms.add(rid);
      conn.send({ type:'handshake', roomId:rid, id:myId, name:myName,
        isServer:r.isServer, serverId:r.serverId, candidates:r.candidates });
    }
    onSuccess&&onSuccess(conn);
  });
  conn.on('error', () => { clearTimeout(timer); if (!settled){settled=true; onFail&&onFail();} });
}

function handlePeerDisconnect(pid) {
  const pc = peerConns[pid]; if (!pc) return;
  for (const rid of [...(pc.rooms||[])]) roomPeerLeft(rid, pid);
  delete peerConns[pid];
  renderTopology(); updateNetworkPanel();
}

function roomPeerLeft(rid, pid) {
  const r = rooms[rid]; if (!r) return;
  const name = r.peers[pid] ? r.peers[pid].name : pid;
  delete r.peers[pid]; r.clientIds.delete(pid);
  if (rid===activeRoomId) { renderRoomSidebar(); updatePeerCount(); }
  addSystemMsg(rid, 'general', `${name} left`);
  if (pid===r.serverId) {
    if (rid===activeRoomId) toast('Server disconnected — failing over…', 'error');
    r.serverId=null; r.serverConn=null; r.isServer=false;
    updateNetworkPanel(); failoverToNextCandidate(rid, 0);
  }
}

// ─── DATA HANDLING ────────────────────────────────────────────────────────────
function handleChatData(data, conn) {
  if (!data||!data.type) return;
  const pid=conn.peer, rid=data.roomId;
  switch(data.type) {
    case 'handshake':      handleHandshake(data, conn); break;
    case 'ping':           conn.send({ type:'pong', ts:data.ts, id:myId, roomId:rid }); break;
    case 'pong':           handlePong(data, pid); break;
    case 'message': {
      const r=rooms[rid]; if(!r) break;
      if(r.isServer){ displayMessage(rid,data); broadcastToRoomClients(rid,data,pid); }
      else displayMessage(rid,data);
      break;
    }
    case 'broadcast':      displayMessage(rid, data.payload); break;
    case 'election_vote':  handleElectionVote(rid, data); break;
    case 'elected':        handleElected(rid, data); break;
    case 'network_state':  handleNetworkState(rid, data); break;
    case 'peer_list':      handlePeerList(rid, data); break;
    case 'route_response':
      if(data.serverId&&data.serverId!==myId) connectToRoomServer(rid, data.serverId);
      if(data.candidates&&rooms[rid]) mergeCandidates(rid, data.candidates);
      break;
    case 'typing':         handleTyping(rid, data, pid); break;
    case 'channel_created':handleChannelCreated(rid, data); break;
    case 'join_room':      handleJoinRoom(data, conn); break;
    case 'peer_leaving':   handlePeerLeaving(data); break;
  }
}

function handleHandshake(data, conn) {
  const pid=conn.peer, rid=data.roomId;
  if (!rid||!rooms[rid]) return;
  const r=rooms[rid];
  const isNew = !r.peers[pid];
  if (isNew) r.peers[pid]={ id:pid, name:peerAliases[pid]||data.name||pid, role:'client' };
  else { r.peers[pid].name=peerAliases[pid]||data.name||r.peers[pid].name; }
  r.knownPeers[pid]=r.peers[pid].name;
  // Track which rooms this physical connection serves
  if (peerConns[pid]) peerConns[pid].rooms.add(rid);
  savePeerToRoom(rid, pid);
  if (data.serverId&&data.serverId!==myId) connectToRoomServer(rid, data.serverId);
  if (!r.isServer&&r.serverId&&r.serverId!==pid) conn.send({ type:'route_response', roomId:rid, serverId:r.serverId, candidates:r.candidates });
  if (r.isServer) { r.clientIds.add(pid); r.peers[pid].role='client'; broadcastRoomNetworkState(rid); broadcastRoomPeerList(rid); }
  if (data.candidates) mergeCandidates(rid, data.candidates);
  if (rid===activeRoomId) { renderRoomSidebar(); updatePeerCount(); updateNetworkPanel(); }
  // Only show join message and trigger election on first handshake from this peer
  if (isNew) {
    addSystemMsg(rid, 'general', `${r.peers[pid].name} joined`);
    // Trigger election only if no server is established yet
    if (!r.serverId) doRoomElection(rid);
  }
}

// ─── ROOM CREATION & JOINING ──────────────────────────────────────────────────
function createRoom() {
  const name=document.getElementById('new-room-name').value.trim();
  if (!name) { toast('Enter a room name','error'); return; }
  const rid=generateRoomId();
  rooms[rid]=makeRoomShell(rid, name, myId);
  rooms[rid].isServer=true; rooms[rid].serverId=myId;
  startRoomElectionTimer(rid);
  saveStorage(); closeModal('create-room-modal');
  switchRoom(rid); renderRoomList();
  // switchRoom reads r.serverId which is already set — but status needs server variant
  setStatus('server','elected server');
  updateNetworkPanel();
  toast(`Room "${name}" created!`, 'success');
}

function startRoomElectionTimer(rid) {
  if (electionTimers[rid]) clearInterval(electionTimers[rid]);
  electionTimers[rid] = setInterval(() => doRoomElection(rid), ELECTION_INTERVAL);
}

function joinRoomViaInvite(rid, roomName, viaPeerId) {
  if (rooms[rid]) { switchRoom(rid); toast(`Already in "${rooms[rid].name}"`, 'info'); return; }
  rooms[rid]=makeRoomShell(rid, roomName||`Room ${rid}`, null);
  startRoomElectionTimer(rid);
  saveStorage(); renderRoomList();
  connectTo(viaPeerId, conn => {
    conn.send({ type:'join_room', roomId:rid, id:myId, name:myName });
    switchRoom(rid); toast(`Joining room "${rooms[rid].name}"…`, 'info');
  }, () => {
    toast('Could not connect to invite peer', 'error');
    delete rooms[rid]; renderRoomList();
  });
}

function handleJoinRoom(data, conn) {
  const rid=data.roomId; if (!rooms[rid]) return;
  const r=rooms[rid], pid=conn.peer;
  // Register peer first so it's included in broadcast
  if (!r.peers[pid]) r.peers[pid]={ id:pid, name:data.name||pid, role:'client' };
  r.knownPeers[pid]=r.peers[pid].name;
  if (peerConns[pid]) {
    peerConns[pid].rooms.add(rid);
    // Also ensure we're tracking all known rooms for this peer
    for (const knownRid of Object.keys(rooms)) if (peerConns[pid]) peerConns[pid].rooms.add(knownRid);
  }
  savePeerToRoom(rid, pid);
  if (r.isServer) { r.clientIds.add(pid); r.peers[pid].role='client'; }
  // Send handshake back so joiner learns server identity + candidates
  conn.send({ type:'handshake', roomId:rid, id:myId, name:myName, isServer:r.isServer, serverId:r.serverId, candidates:r.candidates });
  // Broadcast updated member list to ALL room members (so existing peers see the newcomer)
  if (r.isServer) { broadcastRoomNetworkState(rid); broadcastRoomPeerList(rid); }
  addSystemMsg(rid, 'general', `${r.peers[pid].name} joined the room`);
  if (rid===activeRoomId) { renderRoomSidebar(); updatePeerCount(); updateNetworkPanel(); }
}

function handlePeerLeaving(data) {
  const rid = data.roomId, pid = data.id;
  if (!rooms[rid]) return;
  // Treat as a normal disconnect for this room
  roomPeerLeft(rid, pid);
}

// ─── ELECTION ─────────────────────────────────────────────────────────────────
function doRoomElection(rid) {
  const r=rooms[rid]; if(!r) return;
  const score=calcRoomScore(rid);
  // Always cast own vote; broadcast to connected peers
  r.electionVotes[myId]=score;
  broadcastToRoom(rid, { type:'election_vote', roomId:rid, id:myId, score, name:myName });
  // If no peers heard us (solo), resolve immediately so creator becomes server right away
  const hasPeers=Object.keys(r.peers).some(pid=>{const pc=peerConns[pid];return pc&&pc.conn&&pc.conn.open;});
  if (!hasPeers) {
    clearTimeout(handleElectionVote['_t_'+rid]);
    handleElectionVote['_t_'+rid]=setTimeout(()=>resolveRoomElection(rid), 200);
  }
}

function handleElectionVote(rid, data) {
  const r=rooms[rid]; if(!r) return;
  r.electionVotes[data.id]=data.score;
  // Make sure our own vote is included when we resolve
  if (r.electionVotes[myId]===undefined) r.electionVotes[myId]=calcRoomScore(rid);
  clearTimeout(handleElectionVote['_t_'+rid]);
  handleElectionVote['_t_'+rid]=setTimeout(()=>resolveRoomElection(rid), 1500);
}

function resolveRoomElection(rid) {
  const r=rooms[rid]; if(!r) return;
  r.electionVotes[myId]=calcRoomScore(rid);
  let winner=null, best=-Infinity;
  for (const [id,s] of Object.entries(r.electionVotes)) { if(s>best){best=s;winner=id;} }
  r.electionVotes={};
  if (!winner) return;
  if (winner===myId) {
    becomeRoomServer(rid);
  } else if (winner!==r.serverId) {
    // Only cede if we are not currently serving — don't disrupt a working server
    // unless we explicitly lost (i.e. we are current server and someone beat our score)
    if (r.isServer && r.serverId===myId) {
      // We're the current server — only hand off if winner truly beat us
      // (becomeRoomServer would have won if we had the higher score, so this is correct)
      r.isServer=false;
    }
    r.serverId=winner;
    connectToRoomServer(rid, winner);
  }
  updateRoomCandidateList(rid);
}

function calcRoomScore(rid) {
  const r=rooms[rid]; if(!r) return 0;
  const n=Object.keys(r.peers).filter(pid=>{const pc=peerConns[pid];return pc&&pc.conn&&pc.conn.open;}).length;
  let lat=0,lc=0;
  for (const pid of Object.keys(r.peers)) {
    const pc=peerConns[pid];
    if (pc&&pc.scores&&pc.scores.length) { const s=pc.scores.slice(-SCORE_WINDOW); lat+=s.reduce((a,b)=>a+b,0)/s.length; lc++; }
  }
  // Stability bonus: current server keeps role unless clearly outscored
  const stability = (r.isServer && r.serverId===myId) ? 500 : 0;
  return n*200 - (lc?lat/lc:50) + stability;
}

function becomeRoomServer(rid) {
  const r=rooms[rid]; if(!r||(r.isServer&&r.serverId===myId)) return;
  r.isServer=true; r.serverId=myId; r.serverConn=null;
  for (const pid of Object.keys(r.peers)) {
    const pc=peerConns[pid];
    if (pc&&pc.conn&&pc.conn.open) { r.clientIds.add(pid); r.peers[pid].role='client'; }
  }
  broadcastToRoom(rid, { type:'elected', roomId:rid, serverId:myId, serverName:myName });
  addSystemMsg(rid, 'general', 'You are now the elected server for this room');
  if (rid===activeRoomId) { toast("You are this room's server!", 'success'); setStatus('server','elected server'); updateNetworkPanel(); }
  broadcastRoomNetworkState(rid);
}

function handleElected(rid, data) {
  const r=rooms[rid]; if(!r||data.serverId===myId) return;
  r.serverId=data.serverId; r.isServer=false;
  connectToRoomServer(rid, data.serverId);
  addSystemMsg(rid, 'general', `${data.serverName} is now the room server`);
  if (rid===activeRoomId) updateNetworkPanel();
}

function connectToRoomServer(rid, sid) {
  const r=rooms[rid]; if(!r) return;
  if (!sid||sid===myId) { becomeRoomServer(rid); return; }
  // Already connected to this server — just make sure state is up to date
  if (r.serverId===sid&&r.serverConn&&r.serverConn.open) {
    if (rid===activeRoomId) { setStatus('connected','connected'); updateNetworkPanel(); }
    return;
  }
  connectTo(sid, _conn => {
    r.serverId=sid; r.isServer=false;
    // Always use the live conn from peerConns (may differ from _conn after deduplication)
    r.serverConn=peerConns[sid]?peerConns[sid].conn:_conn;
    if (r.peers[sid]) r.peers[sid].role='server';
    if (peerConns[sid]) peerConns[sid].rooms.add(rid);
    if (rid===activeRoomId) { setStatus('connected','connected'); updateNetworkPanel(); }
  }, () => {
    const idx=r.candidates.indexOf(sid);
    failoverToNextCandidate(rid, idx>=0?idx+1:0);
  });
}

// ─── FAILOVER ─────────────────────────────────────────────────────────────────
function failoverToNextCandidate(rid, idx) {
  const r=rooms[rid]; if(!r) return;
  const rc=removedCands(rid);
  const vis=r.candidates.filter(id=>!rc.has(id));
  if (idx>=vis.length) { attemptRoomReconnect(rid); return; }
  const cid=vis[idx];
  if (cid===myId) { failoverToNextCandidate(rid,idx+1); return; }
  connectTo(cid,()=>{},()=>setTimeout(()=>failoverToNextCandidate(rid,idx+1),RECONNECT_DELAY));
}

function attemptRoomReconnect(rid) {
  const r=rooms[rid]; if(!r) return;
  const toTry=r.savedPeers.filter(id=>id!==myId&&!(peerConns[id]&&peerConns[id].conn&&peerConns[id].conn.open));
  if (!toTry.length) return;
  let idx=0;
  const tryNext=()=>{ if(idx>=toTry.length) return; connectTo(toTry[idx++],()=>{},()=>setTimeout(tryNext,400)); };
  tryNext();
}

function savePeerToRoom(rid, pid) {
  const r=rooms[rid]; if(!r||!pid) return;
  if (!r.savedPeers.includes(pid)) { r.savedPeers.unshift(pid); if(r.savedPeers.length>100)r.savedPeers.pop(); saveStorage(); }
}

// ─── CANDIDATES ───────────────────────────────────────────────────────────────
function updateRoomCandidateList(rid) {
  const r=rooms[rid]; if(!r) return;
  const allIds=[...new Set([...Object.keys(r.peers),...r.savedPeers])].filter(id=>id!==myId);
  const scored=allIds.map(id=>{
    const pc=peerConns[id]; let s=0;
    if(pc&&pc.conn&&pc.conn.open) s+=1000;
    if(pc&&pc.scores&&pc.scores.length) s-=pc.scores.slice(-SCORE_WINDOW).reduce((a,b)=>a+b,0)/pc.scores.length;
    return {id,s};
  });
  scored.sort((a,b)=>b.s-a.s);
  r.candidates=scored.slice(0,MAX_CANDIDATES).map(x=>x.id);
  if (rid===activeRoomId) updateCandidatesPanel();
}

function mergeCandidates(rid, remote) {
  const r=rooms[rid]; if(!r||!remote||!remote.length) return;
  for (const id of remote) { if(id&&id!==myId&&!r.savedPeers.includes(id)) r.savedPeers.push(id); }
  updateRoomCandidateList(rid);
}

// ─── HEARTBEAT ────────────────────────────────────────────────────────────────
function doHeartbeat() {
  const now=Date.now();
  for (const [pid,pc] of Object.entries(peerConns)) {
    if (!pc.conn||!pc.conn.open) { handlePeerDisconnect(pid); continue; }
    try { pc.conn.send({ type:'ping', ts:now, id:myId }); } catch(e){}
    if (now-pc.lastSeen>HEARTBEAT_INTERVAL*4) handlePeerDisconnect(pid);
  }
  renderTopology(); updateNetworkPanel();
}

function handlePong(data, pid) {
  const rtt=Date.now()-data.ts, pc=peerConns[pid]; if(!pc) return;
  pc.lastSeen=Date.now(); pc.scores.push(rtt);
  if (pc.scores.length>SCORE_WINDOW*2) pc.scores.shift();
  updateLatencyDisplay();
}

// ─── MESSAGING ────────────────────────────────────────────────────────────────
function sendMessage() {
  const input=document.getElementById('msg-input'), text=input.value.trim();
  if (!text||!activeRoomId) return;
  const r=rooms[activeRoomId]; if(!r) return;
  const msg={ type:'message', roomId:activeRoomId, id:genId(), author:myName, authorId:myId,
    content:text, channel:activeChannel, ts:Date.now() };
  input.value=''; input.style.height='';
  document.getElementById('send-btn').disabled=true;
  displayMessage(activeRoomId, msg);
  if (r.isServer) {
    broadcastToRoomClients(activeRoomId, msg, myId);
  } else {
    // Always use the freshest conn to the server
    const sconn = r.serverId && peerConns[r.serverId] ? peerConns[r.serverId].conn : r.serverConn;
    if (sconn && sconn.open) {
      try { sconn.send(msg); } catch(e) { broadcastToRoom(activeRoomId, msg); }
    } else {
      broadcastToRoom(activeRoomId, msg);
    }
  }
}

function broadcastToRoomClients(rid, msg, fromId) {
  const r=rooms[rid]; if(!r) return;
  const packet={ type:'broadcast', roomId:rid, payload:msg };
  for (const pid of r.clientIds) {
    if (pid===fromId) continue;
    const pc=peerConns[pid];
    if (pc&&pc.conn&&pc.conn.open) try{pc.conn.send(packet);}catch(e){}
  }
}

function broadcastToRoom(rid, data, excludeId) {
  const r=rooms[rid]; if(!r) return;
  for (const pid of Object.keys(r.peers)) {
    if (pid===excludeId) continue;
    const pc=peerConns[pid];
    if (pc&&pc.conn&&pc.conn.open) try{pc.conn.send(data);}catch(e){}
  }
}

function displayMessage(rid, msg) {
  const r=rooms[rid]; if(!r||!msg||!msg.channel) return;
  if (!r.messages[msg.channel]) r.messages[msg.channel]=[];
  if (msg.id&&r.messages[msg.channel].some(m=>m.id===msg.id)) return;
  r.messages[msg.channel].push(msg);
  if (rid===activeRoomId&&msg.channel===activeChannel) {
    renderMessage(msg); scrollToBottom();
  } else {
    r.unread[msg.channel]=(r.unread[msg.channel]||0)+1;
    if (rid===activeRoomId) renderRoomSidebar();
    else renderRoomList();
  }
}

function handleNetworkState(rid, data) {
  const r=rooms[rid]; if(!r) return;
  if (data.peers) {
    for (const [id,info] of Object.entries(data.peers)) {
      if (id!==myId) {
        r.knownPeers[id]=peerAliases[id]||info.name;
        if (!r.peers[id]) r.peers[id]={id,name:r.knownPeers[id],role:info.role};
        else { r.peers[id].name=r.knownPeers[id]; r.peers[id].role=info.role; }
        // If we're the server, make sure this peer is in our client set
        if (r.isServer && info.role==='client' && peerConns[id] && peerConns[id].conn && peerConns[id].conn.open) {
          r.clientIds.add(id);
        }
      }
    }
  }
  if (data.candidates) mergeCandidates(rid, data.candidates);
  if (rid===activeRoomId) renderRoomSidebar();
}

function broadcastRoomNetworkState(rid) {
  const r=rooms[rid]; if(!r||!r.isServer) return;
  const m={}; for(const[id,p] of Object.entries(r.peers)) m[id]={name:p.name,role:p.role};
  m[myId]={name:myName,role:'server'};
  broadcastToRoom(rid, {type:'network_state',roomId:rid,peers:m,candidates:r.candidates});
}

function handlePeerList(rid, data) {
  const r=rooms[rid]; if(!r||!data.peers) return;
  for(const[id,name] of Object.entries(data.peers)){
    r.knownPeers[id]=peerAliases[id]||name;
    if (!r.peers[id]&&id!==myId) r.peers[id]={id,name:r.knownPeers[id],role:'client'};
    // Sync clientIds if we're server
    if (r.isServer && id!==myId && peerConns[id] && peerConns[id].conn && peerConns[id].conn.open) {
      r.clientIds.add(id);
    }
  }
  if (rid===activeRoomId) renderRoomSidebar();
}

function broadcastRoomPeerList(rid) {
  const r=rooms[rid]; if(!r||!r.isServer) return;
  const m={}; for(const[id,p] of Object.entries(r.peers)) m[id]=p.name;
  m[myId]=myName;
  broadcastToRoom(rid, {type:'peer_list',roomId:rid,peers:m});
}

// ─── TYPING ───────────────────────────────────────────────────────────────────
let typingDebounce=null;
function onTyping() {
  clearTimeout(typingDebounce);
  typingDebounce=setTimeout(()=>{
    if (!activeRoomId) return; const r=rooms[activeRoomId]; if(!r) return;
    const pkt={type:'typing',roomId:activeRoomId,id:myId,name:myName,channel:activeChannel};
    if (r.isServer) {
      broadcastToRoom(activeRoomId,pkt,myId);
    } else {
      const sconn=r.serverId&&peerConns[r.serverId]?peerConns[r.serverId].conn:r.serverConn;
      if (sconn&&sconn.open) try{sconn.send(pkt);}catch(e){}
    }
  },300);
}

function handleTyping(rid, data, senderId) {
  const r=rooms[rid]; if(!r) return;
  // Always relay first (server must forward to other clients regardless of own view)
  if (r.isServer) {
    for(const id of r.clientIds){
      if(id===senderId) continue;
      const pc=peerConns[id];
      if(pc&&pc.conn&&pc.conn.open)try{pc.conn.send(data);}catch(e){}
    }
  }
  // Only show indicator locally if viewing this room+channel
  if (rid!==activeRoomId||data.channel!==activeChannel) return;
  r.typingPeers[senderId]=data.name; updateTypingIndicator();
  clearTimeout(r.typingPeers['_t_'+senderId]);
  r.typingPeers['_t_'+senderId]=setTimeout(()=>{
    delete r.typingPeers[senderId]; delete r.typingPeers['_t_'+senderId];
    if(rid===activeRoomId) updateTypingIndicator();
  },4000);
}

// ─── CHANNELS ─────────────────────────────────────────────────────────────────
function createChannel() {
  if (!activeRoomId) return;
  const r=rooms[activeRoomId]; if(!r) return;
  const name=document.getElementById('new-channel-name').value.trim().toLowerCase().replace(/[^a-z0-9-]/g,'-');
  const desc=document.getElementById('new-channel-desc').value.trim();
  if (!name){toast('Enter a channel name','error');return;}
  if (r.channels.find(c=>c.id===name)){toast('Already exists','error');return;}
  const ch={id:name,name,desc:desc||'No description'};
  r.channels.push(ch); r.messages[ch.id]=[]; r.unread[ch.id]=0;
  saveStorage(); renderRoomSidebar(); closeModal('add-channel-modal');
  const evt={type:'channel_created',roomId:activeRoomId,channel:ch};
  if (r.isServer) broadcastToRoom(activeRoomId,evt); else if(r.serverConn&&r.serverConn.open) r.serverConn.send(evt);
}

function handleChannelCreated(rid, data) {
  const r=rooms[rid]; if(!r) return;
  if (r.channels.find(c=>c.id===data.channel.id)) return;
  r.channels.push(data.channel); r.messages[data.channel.id]=[]; r.unread[data.channel.id]=0;
  saveStorage(); if(rid===activeRoomId) renderRoomSidebar();
  if (r.isServer) broadcastToRoom(rid, data);
}

function switchChannel(id) {
  if (!activeRoomId) return;
  const r=rooms[activeRoomId]; if(!r) return;
  activeChannel=id; r.unread[id]=0;
  const ch=r.channels.find(c=>c.id===id);
  document.getElementById('active-channel-title').textContent=ch?ch.name:id;
  document.getElementById('active-channel-desc').textContent=ch?ch.desc:'';
  document.getElementById('msg-input').placeholder=`Message #${ch?ch.name:id}`;
  renderRoomSidebar(); renderAllMessages(); scrollToBottom();
  if (window.innerWidth<=700) closeSidebar();
}

// ─── ROOM SWITCHING ───────────────────────────────────────────────────────────
function switchRoom(rid) {
  activeRoomId=rid; activeChannel='general';
  const r=rooms[rid]; if(!r) return;
  for (const ch of r.channels) r.unread[ch.id]=0;
  const ch=r.channels.find(c=>c.id==='general')||r.channels[0];
  if (ch) activeChannel=ch.id;
  document.getElementById('active-room-name').textContent=r.name;
  document.getElementById('active-room-id').textContent='#'+r.id;
  document.getElementById('active-channel-title').textContent=activeChannel;
  document.getElementById('active-channel-desc').textContent=ch?ch.desc:'';
  document.getElementById('msg-input').placeholder=`Message #${activeChannel}`;
  document.getElementById('msg-input').disabled=false;
  document.getElementById('file-btn').disabled=false;
  document.getElementById('back-to-rooms').style.display='flex';
  document.getElementById('invite-btn').style.display='flex';
  document.getElementById('leave-strip').style.display='block';
  renderRoomSidebar(); renderAllMessages(); scrollToBottom();
  updateNetworkPanel(); renderRoomList();
  setStatus(r.serverId?'connected':'alone', r.serverId?'connected':'online');
  if (window.innerWidth<=700) closeSidebar();
}

function backToRooms() {
  activeRoomId=null;
  document.getElementById('active-room-name').textContent='GilgaMesh';
  document.getElementById('active-room-id').textContent='';
  document.getElementById('active-channel-title').textContent='Rooms';
  document.getElementById('active-channel-desc').textContent='Your peer-to-peer rooms';
  document.getElementById('back-to-rooms').style.display='none';
  document.getElementById('invite-btn').style.display='none';
  document.getElementById('leave-strip').style.display='none';
  document.getElementById('msg-input').disabled=true;
  document.getElementById('msg-input').placeholder='Select a room to chat';
  document.getElementById('send-btn').disabled=true;
  document.getElementById('file-btn').disabled=true;
  renderRoomList(); renderRoomGrid(); updateNetworkPanel();
}

// ─── INVITE ───────────────────────────────────────────────────────────────────
function showInvite() {
  if (!activeRoomId) return;
  const r=rooms[activeRoomId]; if(!r) return;
  const base=location.href.split('?')[0];
  const link=`${base}?join=${r.id}&rname=${encodeURIComponent(r.name)}&via=${encodeURIComponent(myId)}`;
  document.getElementById('invite-room-name').textContent=r.name;
  document.getElementById('invite-room-id').textContent=r.id;
  document.getElementById('invite-peer-id').textContent=myId;
  document.getElementById('invite-link').textContent=link;
  document.getElementById('invite-modal').classList.remove('hidden');
}

function confirmLeaveRoom() {
  if (!activeRoomId) return;
  const r = rooms[activeRoomId]; if (!r) return;
  document.getElementById('leave-room-name').textContent = r.name;
  document.getElementById('leave-room-modal').classList.remove('hidden');
}

function leaveRoom() {
  const rid = activeRoomId; if (!rid) return;
  const r = rooms[rid]; if (!r) return;
  closeModal('leave-room-modal');

  // Notify peers we're leaving
  const leaveMsg = { type: 'peer_leaving', roomId: rid, id: myId, name: myName };
  broadcastToRoom(rid, leaveMsg);

  // If we're the server, elect a replacement before leaving
  if (r.isServer) {
    // Pick the best connected candidate to hand off to
    const candidates = [...r.clientIds].filter(pid => {
      const pc = peerConns[pid]; return pc && pc.conn && pc.conn.open;
    });
    if (candidates.length) {
      const successor = candidates[0];
      broadcastToRoom(rid, { type: 'elected', roomId: rid, serverId: successor, serverName: r.peers[successor] ? r.peers[successor].name : successor });
    }
  }

  // Stop election timer for this room
  if (electionTimers[rid]) { clearInterval(electionTimers[rid]); delete electionTimers[rid]; }

  // Remove from peerConns room tracking
  for (const pc of Object.values(peerConns)) { if (pc.rooms) pc.rooms.delete(rid); }

  // Delete room state entirely
  delete rooms[rid];
  delete globalRemovedCands[rid];
  saveStorage();

  toast(`Left "${r.name}"`, 'info');
  backToRooms();
}

function copyInviteLink() { copyToClipboard(document.getElementById('invite-link').textContent); }

function checkJoinUrl() {
  const p=new URLSearchParams(location.search);
  const rid=p.get('join'), rname=p.get('rname')||'Room', via=p.get('via');
  if (rid&&via) {
    history.replaceState({},'',location.pathname);
    const attempt=()=>{ if(!peer||!myId){setTimeout(attempt,500);return;} joinRoomViaInvite(rid,rname,via); };
    setTimeout(attempt,800);
  } else {
    checkShareUrl();
  }
}

// ─── FILE SHARING ─────────────────────────────────────────────────────────────
function triggerFileShare() {
  if (!activeRoomId) return;
  document.getElementById('file-share-link-area').classList.add('hidden');
  document.getElementById('file-share-content').classList.remove('hidden');
  document.getElementById('file-share-modal').classList.remove('hidden');
  const input=document.getElementById('file-modal-input'), dropzone=document.getElementById('file-dropzone');
  input.value='';
  input.onchange=e=>{const f=e.target.files[0];if(f)prepareFileShare(f);};
  dropzone.onclick=()=>input.click();
  dropzone.ondragover=e=>{e.preventDefault();dropzone.style.borderColor='var(--accent)';};
  dropzone.ondragleave=()=>{dropzone.style.borderColor='';};
  dropzone.ondrop=e=>{e.preventDefault();dropzone.style.borderColor='';if(e.dataTransfer.files[0])prepareFileShare(e.dataTransfer.files[0]);};
}

function prepareFileShare(file) {
  const token=genId(), expires=Date.now()+FILE_LINK_TTL;
  fileShares[token]={file,expires,filename:file.name,size:file.size,mime:file.type||'application/octet-stream'};
  const base=location.href.split('?')[0];
  const shareUrl=`${base}?share=${token}&from=${encodeURIComponent(myId)}&name=${encodeURIComponent(file.name)}&size=${file.size}`;
  document.getElementById('file-share-content').classList.add('hidden');
  document.getElementById('file-share-link-area').classList.remove('hidden');
  document.getElementById('share-filename').textContent=`📎 ${file.name} (${formatBytes(file.size)})`;
  document.getElementById('share-link-text').textContent=shareUrl;
  let rem=60; const countEl=document.getElementById('share-countdown');
  const iv=setInterval(()=>{rem--;if(rem<=0){clearInterval(iv);delete fileShares[token];countEl.textContent='expired';countEl.style.color='var(--red)';}else countEl.textContent=rem+'s';},1000);
  if (!activeRoomId) return;
  const r=rooms[activeRoomId];
  const chatMsg={type:'message',roomId:activeRoomId,id:genId(),author:myName,authorId:myId,content:null,channel:activeChannel,ts:Date.now(),msgType:'file',fileShare:{token,fromId:myId,fromName:myName,filename:file.name,size:file.size,expires}};
  displayMessage(activeRoomId,chatMsg);
  if(r.isServer)broadcastToRoomClients(activeRoomId,chatMsg,myId);
  else if(r.serverConn&&r.serverConn.open)r.serverConn.send(chatMsg);
}

function downloadFile(token,fromId,filename) {
  if(!fromId||!token){toast('Invalid share link','error');return;}
  toast('Connecting for file transfer…','info');
  const conn=peer.connect(fromId,{reliable:true,serialization:'json',label:'file:'+token});
  let b64chunks=[],fileMime='application/octet-stream',fileFilename=filename;
  const failTimer=setTimeout(()=>{toast('File transfer timed out','error');try{conn.close();}catch(e){}},30000);
  conn.on('open',()=>conn.send({type:'file_request',token,requesterId:myId}));
  conn.on('data',msg=>{
    if(!msg||!msg.type)return;
    if(msg.type==='file_expired'){clearTimeout(failTimer);toast('Link expired','error');conn.close();return;}
    if(msg.type==='file_error'){clearTimeout(failTimer);toast('Transfer error: '+(msg.reason||'?'),'error');conn.close();return;}
    if(msg.type==='file_meta'){fileFilename=msg.filename||filename;fileMime=msg.mime||'application/octet-stream';toast(`Receiving ${fileFilename} (${formatBytes(msg.size)})…`,'info');return;}
    if(msg.type==='file_chunk'){b64chunks.push(msg.data);return;}
    if(msg.type==='file_done'){
      clearTimeout(failTimer);
      try{const bin=atob(b64chunks.join(''));const buf=new Uint8Array(bin.length);for(let i=0;i<bin.length;i++)buf[i]=bin.charCodeAt(i);const blob=new Blob([buf],{type:fileMime});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=fileFilename;document.body.appendChild(a);a.click();setTimeout(()=>{URL.revokeObjectURL(url);a.remove();},1500);toast(`Downloaded ${fileFilename}!`,'success');}catch(e){toast('Decode error: '+e.message,'error');}
      conn.close();
    }
  });
  conn.on('error',()=>{clearTimeout(failTimer);toast('File connection failed','error');});
}

function handleIncomingFileConn(conn) {
  const token=conn.label.replace('file:','');
  conn.on('open',()=>{
    conn.on('data',msg=>{if(msg&&msg.type==='file_request'&&msg.token===token)sendFileOverConn(conn,token);});
    conn.on('error',err=>console.warn('file conn error',err));
  });
}

function sendFileOverConn(conn,token) {
  const share=fileShares[token];
  if(!share||Date.now()>share.expires){conn.send({type:'file_expired'});conn.close();return;}
  conn.send({type:'file_meta',filename:share.filename,size:share.size,mime:share.mime});
  const CHUNK=48*1024;let offset=0;
  const next=()=>{
    if(!conn.open)return;
    if(offset>=share.file.size){conn.send({type:'file_done'});return;}
    const fr=new FileReader();
    fr.onload=e=>{if(!conn.open)return;const bytes=new Uint8Array(e.target.result);let bin='';for(let i=0;i<bytes.length;i++)bin+=String.fromCharCode(bytes[i]);try{conn.send({type:'file_chunk',data:btoa(bin)});offset+=CHUNK;setTimeout(next,0);}catch(err){conn.send({type:'file_error',reason:err.message});}};
    fr.readAsArrayBuffer(share.file.slice(offset,offset+CHUNK));
  };
  next();
}

function checkShareUrl() {
  const p=new URLSearchParams(location.search);
  const token=p.get('share'),fromId=p.get('from'),name=p.get('name')||'file',size=parseInt(p.get('size')||'0');
  if(token&&fromId){
    history.replaceState({},'',location.pathname);
    const attempt=()=>{if(!peer||!myId){setTimeout(attempt,500);return;}if(confirm(`Download "${name}" (${formatBytes(size)}) from a peer?\nDirect P2P transfer.`))downloadFile(token,fromId,name);};
    setTimeout(attempt,1000);
  }
}

// ─── UI RENDERING ─────────────────────────────────────────────────────────────
function renderRoomList() {
  const list=document.getElementById('rooms-list');
  const rids=Object.keys(rooms);
  if (!rids.length) {
    list.innerHTML='<div style="padding:8px 14px;font-size:11px;color:var(--text-muted)">No rooms</div>';
    return;
  }
  list.innerHTML=rids.map(rid=>{
    const r=rooms[rid], unr=totalRoomUnread(rid), isActive=rid===activeRoomId, color=stringToColor(rid);
    const init=(r.name||'R').charAt(0).toUpperCase();
    return `<div class="room-item ${isActive?'active':''}" onclick="switchRoom('${rid}')" title="${escapeHtml(r.name)}">
      <div class="room-icon" style="background:${color}22;border-color:${color}44;color:${color}">${init}</div>
      ${unr&&!isActive?`<div class="room-badge">${unr>99?'99+':unr}</div>`:''}
    </div>`;
  }).join('');
}

function renderRoomGrid() {
  const msgs=document.getElementById('messages'); msgs.innerHTML='';
  const rids=Object.keys(rooms);
  if (!rids.length) {
    msgs.innerHTML=`<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:var(--text-muted);padding:40px;text-align:center">
      <div style="font-size:40px;opacity:0.4">⬡</div>
      <div style="font-size:15px;font-weight:600;color:var(--text-secondary)">No rooms yet</div>
      <div style="font-size:13px;line-height:1.6">Create a room with the <strong>+</strong> button in the sidebar,<br>or join one via an invite link.</div>
    </div>`;
    return;
  }
  const grid=document.createElement('div');
  grid.style.cssText='display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;padding:16px;align-content:start;';
  for (const rid of rids) {
    const r=rooms[rid], unr=totalRoomUnread(rid), color=stringToColor(rid);
    const mc=Object.keys(r.peers).length+1;
    const card=document.createElement('div');
    card.style.cssText=`background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius);padding:14px;cursor:pointer;position:relative;transition:border-color 0.15s;`;
    card.onmouseenter=()=>card.style.borderColor='var(--border-accent)';
    card.onmouseleave=()=>card.style.borderColor='';
    card.onclick=()=>switchRoom(rid);
    card.innerHTML=`
      <div style="width:40px;height:40px;border-radius:10px;background:${color}22;border:1px solid ${color}44;color:${color};display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;margin-bottom:10px">${(r.name||'R').charAt(0).toUpperCase()}</div>
      <div style="font-size:13px;font-weight:600;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(r.name)}</div>
      <div style="font-size:11px;color:var(--text-muted);font-family:var(--mono)">ID: ${rid} · ${mc} member${mc!==1?'s':''}</div>
      ${unr?`<div style="position:absolute;top:10px;right:10px;background:var(--red);color:#fff;font-size:10px;font-weight:700;padding:2px 6px;border-radius:10px;min-width:18px;text-align:center">${unr>99?'99+':unr}</div>`:''}`;
    grid.appendChild(card);
  }
  msgs.appendChild(grid);
}

function renderRoomSidebar() {
  renderRoomList();
  if (!activeRoomId) return;
  const r=rooms[activeRoomId]; if(!r) return;

  document.getElementById('channels-list').innerHTML=r.channels.map(ch=>{
    const u=r.unread[ch.id]||0;
    return `<div class="channel-item ${ch.id===activeChannel?'active':''}" onclick="switchChannel('${ch.id}')">
      <span class="ch-icon">#</span><span class="ch-name">${escapeHtml(ch.name)}</span>
      ${u?`<span class="unread">${u}</span>`:''}
    </div>`;
  }).join('');

  const myEntry=`<div class="peer-item">
    <div class="peer-avatar" style="background:${stringToColor(myId||'')}20;border-color:${stringToColor(myId||'')}40;color:${stringToColor(myId||'')}">
      ${(myName||'M').charAt(0).toUpperCase()}
      <div class="peer-status-dot online"></div>
    </div>
    <span class="peer-name">${escapeHtml(myName)} (you)</span>
    ${r.isServer?'<span class="peer-role">server</span>':''}
  </div>`;

  document.getElementById('peers-list').innerHTML=myEntry+Object.values(r.peers).map(p=>{
    const pc=peerConns[p.id], alive=pc&&pc.conn&&pc.conn.open, isSrv=p.id===r.serverId, color=stringToColor(p.id);
    return `<div class="peer-item">
      <div class="peer-avatar" style="background:${color}20;border-color:${color}40;color:${color}">
        ${(p.name||'P').charAt(0).toUpperCase()}
        <div class="peer-status-dot ${isSrv?'server':alive?'online':''}"></div>
      </div>
      <span class="peer-name">${escapeHtml(p.name||p.id)}</span>
      ${isSrv?'<span class="peer-role">server</span>':''}
    </div>`;
  }).join('');
}

function updateSidebar() { if (activeRoomId) renderRoomSidebar(); else { renderRoomList(); renderRoomGrid(); } }

function updatePeerCount() {
  if (!activeRoomId) { document.getElementById('peer-count-text').textContent=''; return; }
  const r=rooms[activeRoomId]; if(!r) return;
  const n=Object.keys(r.peers).filter(pid=>{const pc=peerConns[pid];return pc&&pc.conn&&pc.conn.open;}).length;
  document.getElementById('peer-count-text').textContent=(n+1)+' members';
}

function renderAllMessages() {
  document.getElementById('messages').innerHTML='';
  if (!activeRoomId) { renderRoomGrid(); return; }
  const r=rooms[activeRoomId]; if(!r) return;
  (r.messages[activeChannel]||[]).forEach(m=>renderMessage(m,false));
}

function renderMessage(msg, doScroll=true) {
  if (!msg) return;
  const C=document.getElementById('messages');
  if (msg.type==='system') {
    const d=document.createElement('div'); d.className='system-msg'; d.textContent=msg.content;
    C.appendChild(d); if(doScroll)scrollToBottom(); return;
  }
  const r=activeRoomId?rooms[activeRoomId]:null;
  const isMe=msg.authorId===myId, color=stringToColor(msg.authorId||'');
  const timeStr=new Date(msg.ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'});
  const isSrv=r&&msg.authorId===r.serverId;
  const last=C.lastElementChild, sameA=last&&last.dataset.authorId===msg.authorId&&(msg.ts-parseInt(last.dataset.ts||'0'))<120000;
  const group=sameA?last:document.createElement('div');
  if (!sameA) {
    group.className='msg-group'; group.dataset.authorId=msg.authorId; group.dataset.ts=msg.ts;
    const hdr=document.createElement('div'); hdr.className='msg-header';
    hdr.innerHTML=`<span class="msg-author" style="color:${color}">${escapeHtml(msg.author||'?')}</span>${isSrv?'<span class="msg-role-badge">server</span>':''}<span class="msg-time">${timeStr}</span>`;
    group.appendChild(hdr);
  }
  const body=document.createElement('div'); body.className='msg-body'+(sameA?' continued':'');
  if (msg.msgType==='file'&&msg.fileShare) {
    const fs=msg.fileShare,exp=Date.now()>fs.expires,secs=Math.max(0,Math.ceil((fs.expires-Date.now())/1000));
    body.innerHTML=`<div class="file-card"><div class="file-icon">📎</div><div class="file-info"><div class="file-name">${escapeHtml(fs.filename)}</div><div class="file-meta">${formatBytes(fs.size)}</div><div class="file-timer${exp?' expired':''}" id="ftimer-${fs.token}">${exp?'Expired':`Expires in ${secs}s`}</div></div><button class="download-btn" id="fdl-${fs.token}" ${exp||isMe?'disabled':''}onclick="downloadFile('${fs.token}','${escapeHtml(fs.fromId)}','${escapeHtml(fs.filename)}')">${isMe?'Shared':'Download'}</button></div>`;
    if(!exp&&!isMe){let t=secs;const iv=setInterval(()=>{t--;const tel=document.getElementById('ftimer-'+fs.token),btn=document.getElementById('fdl-'+fs.token);if(!tel){clearInterval(iv);return;}if(t<=0){clearInterval(iv);tel.textContent='Expired';tel.classList.add('expired');if(btn)btn.disabled=true;}else tel.textContent=`Expires in ${t}s`;},1000);}
  } else {
    const span=document.createElement('span'); span.className='msg-text'; span.textContent=msg.content;
    const acts=document.createElement('div'); acts.className='msg-actions';
    acts.innerHTML=`<button onclick="copyText(this)" data-text="${escapeHtml(msg.content)}">⎘</button>`;
    body.appendChild(span); body.appendChild(acts);
  }
  group.appendChild(body); if(!sameA)C.appendChild(group); if(doScroll)scrollToBottom();
}

function addSystemMsg(rid, channel, text) {
  displayMessage(rid,{type:'system',content:text,roomId:rid,channel,ts:Date.now(),id:genId(),author:'System',authorId:'system'});
}

function scrollToBottom() { const c=document.getElementById('messages'); requestAnimationFrame(()=>{c.scrollTop=c.scrollHeight;}); }

// ─── CANDIDATE MANAGEMENT ─────────────────────────────────────────────────────
function openManageCandidates() {
  if (!activeRoomId) return; renderManageList();
  document.getElementById('manage-candidates-modal').classList.remove('hidden');
}

function renderManageList() {
  if (!activeRoomId) return;
  const r=rooms[activeRoomId], rc=removedCands(activeRoomId);
  const list=document.getElementById('manage-list');
  const allIds=r?[...new Set([...r.candidates,...r.savedPeers])].filter(id=>id!==myId):[];
  if (!allIds.length){list.innerHTML='<div style="font-size:12px;color:var(--text-muted);padding:10px 0">No candidates yet</div>';return;}
  list.innerHTML=allIds.slice(0,40).map(id=>{
    const pc=peerConns[id],alive=pc&&pc.conn&&pc.conn.open,elected=r&&id===r.serverId;
    const alias=peerAliases[id]||'',base=r&&r.peers[id]?r.peers[id].name:(r&&r.knownPeers[id])||id;
    const disp=alias||base,removed=rc.has(id),dotCol=elected?'var(--amber)':alive?'var(--green)':'var(--text-muted)';
    return `<div class="mgmt-item ${elected?'elected':''}" id="mgmt-${id}" style="${removed?'opacity:0.45':''}">
      <div class="mgmt-dot" style="background:${dotCol}"></div>
      <div class="mgmt-info"><div class="mgmt-alias">${escapeHtml(disp)}${elected?' ★':''}</div><div class="mgmt-id">${id}</div></div>
      <div class="mgmt-btns" id="mgmt-btns-${id}">
        <button class="mgmt-btn" onclick="startRename('${id}')" title="Rename">✏️</button>
        ${!elected?`<button class="mgmt-btn danger" onclick="${removed?`restoreCandidate('${id}')`:` removeCandidate('${id}')`}" title="${removed?'Restore':'Remove'}">${removed?'↩':'✕'}</button>`:''}
      </div>
    </div>`;
  }).join('');
}

function startRename(id) {
  const btnsEl=document.getElementById('mgmt-btns-'+id),info=document.querySelector(`#mgmt-${id} .mgmt-info`);
  if(!btnsEl||!info)return;
  const r=activeRoomId?rooms[activeRoomId]:null;
  const current=peerAliases[id]||(r&&r.peers[id]?r.peers[id].name:'')||id;
  const dispEl=info.querySelector('.mgmt-alias'),input=document.createElement('input');
  input.className='mgmt-inline-edit';input.value=current;input.placeholder='Display name…';input.maxLength=32;
  dispEl.replaceWith(input);input.focus();input.select();
  btnsEl.innerHTML=`<button class="mgmt-btn" onclick="confirmRename('${id}')" title="Save">✓</button><button class="mgmt-btn danger" onclick="cancelRename('${id}')" title="Cancel">✕</button>`;
  input.addEventListener('keydown',e=>{if(e.key==='Enter')confirmRename(id);if(e.key==='Escape')cancelRename(id);});
}

function confirmRename(id) {
  const row=document.getElementById('mgmt-'+id),input=row&&row.querySelector('.mgmt-inline-edit');
  if(!input)return;
  const val=input.value.trim();
  if(val){peerAliases[id]=val;for(const r of Object.values(rooms)){if(r.peers[id])r.peers[id].name=val;r.knownPeers[id]=val;}}
  else delete peerAliases[id];
  saveStorage();updateSidebar();updateNetworkPanel();renderManageList();
  toast(val?`Renamed to "${val}"`:'Alias removed','success');
}
function cancelRename(id) { renderManageList(); }

function removeCandidate(id) {
  if(!activeRoomId)return;
  const r=rooms[activeRoomId];
  if(r&&id===r.serverId){toast('Cannot remove the active server','error');return;}
  removedCands(activeRoomId).add(id);
  if(r)r.savedPeers=r.savedPeers.filter(p=>p!==id);
  saveStorage();updateRoomCandidateList(activeRoomId);renderManageList();toast('Candidate removed','info');
}
function restoreCandidate(id) {
  if(!activeRoomId)return;
  removedCands(activeRoomId).delete(id);
  saveStorage();updateRoomCandidateList(activeRoomId);renderManageList();toast('Candidate restored','success');
}

// ─── TOPOLOGY ─────────────────────────────────────────────────────────────────
function renderTopology() {
  const svg=document.getElementById('topo-svg');if(!svg)return;
  const W=256,H=180,cx=W/2,cy=H/2;
  const r=activeRoomId?rooms[activeRoomId]:null;
  const isSrv=r?r.isServer:false, srvId=r?r.serverId:null;
  const activePeers=r?Object.keys(r.peers).filter(pid=>{const pc=peerConns[pid];return pc&&pc.conn&&pc.conn.open;}).map(pid=>({id:pid,name:r.peers[pid].name})):[];
  const n=activePeers.length;
  const nodeColor=isSrv?'#f5a623':'#5b6cf9';

  let html=`<defs>
    <radialGradient id="g0" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${nodeColor}" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="${nodeColor}" stop-opacity="0"/>
    </radialGradient>
  </defs>`;

  // Lines from center to peers
  const pos=activePeers.map((p,i)=>{
    const a=(i/Math.max(n,1))*2*Math.PI-Math.PI/2, rv=Math.min(72,28+n*9);
    return{x:cx+rv*Math.cos(a),y:cy+rv*Math.sin(a),p};
  });
  pos.forEach(({x,y,p})=>{
    const isSrvPeer=p.id===srvId;
    html+=`<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="${isSrvPeer?'#f5a623':'#5b6cf9'}" stroke-width="1" opacity="${isSrvPeer?0.65:0.3}"/>`;
  });

  // Center glow
  html+=`<circle cx="${cx}" cy="${cy}" r="22" fill="url(#g0)"/>`;

  // Animated pulse ring — only when we are the elected server
  if (isSrv) {
    html+=`<circle cx="${cx}" cy="${cy}" r="14" fill="none" stroke="#f5a623" stroke-width="1.5">
      <animate attributeName="r" values="14;26;14" dur="2.4s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="0.7;0;0.7" dur="2.4s" repeatCount="indefinite"/>
    </circle>`;
  }

  // Center node
  html+=`<circle cx="${cx}" cy="${cy}" r="11" fill="${isSrv?'#f5a62322':'#5b6cf920'}" stroke="${isSrv?'#f5a623':'#5b6cf9'}" stroke-width="1.5"/>`;
  html+=`<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" fill="${isSrv?'#f5a623':'#7b8cff'}" font-size="8" font-family="sans-serif" font-weight="700">ME</text>`;

  // Peer nodes
  pos.forEach(({x,y,p})=>{
    const isSrvPeer=p.id===srvId, color=stringToColor(p.id), init=(p.name||'P').charAt(0).toUpperCase();
    // Pulse ring on the elected server peer node
    if (isSrvPeer) {
      html+=`<circle cx="${x}" cy="${y}" r="12" fill="none" stroke="#f5a623" stroke-width="1">
        <animate attributeName="r" values="12;20;12" dur="2.4s" repeatCount="indefinite"/>
        <animate attributeName="opacity" values="0.6;0;0.6" dur="2.4s" repeatCount="indefinite"/>
      </circle>`;
    }
    html+=`<circle cx="${x}" cy="${y}" r="9" fill="${color}20" stroke="${isSrvPeer?'#f5a623':color}" stroke-width="${isSrvPeer?1.5:1}"/>`;
    html+=`<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" fill="${color}" font-size="7" font-family="sans-serif" font-weight="700">${init}</text>`;
  });

  svg.innerHTML=html;
}

// ─── NETWORK PANEL ────────────────────────────────────────────────────────────
function updateNetworkPanel() {
  const r=activeRoomId?rooms[activeRoomId]:null;
  const badge=document.getElementById('my-role-badge'),rt=document.getElementById('role-text');
  if(!r){badge.className='role-badge alone';rt.textContent='No room selected';document.getElementById('net-role').textContent='—';}
  else if(r.isServer){badge.className='role-badge server';rt.textContent='Elected Server';document.getElementById('net-role').textContent='Server';}
  else if(r.serverId){badge.className='role-badge client';rt.textContent='Client';document.getElementById('net-role').textContent='Client';}
  else{badge.className='role-badge alone';rt.textContent='Searching…';document.getElementById('net-role').textContent='Searching';}
  document.getElementById('net-peers').textContent=r?Object.keys(r.peers).length:0;
  document.getElementById('net-known').textContent=r?Object.keys(r.knownPeers).length:0;
  document.getElementById('net-my-id').textContent=myId||'—';
  updateCandidatesPanel();
}

function updateCandidatesPanel() {
  const list=document.getElementById('candidates-list');
  if(!activeRoomId||!rooms[activeRoomId]){list.innerHTML='<div style="font-size:11px;color:var(--text-muted);text-align:center;padding:8px">Select a room</div>';return;}
  const r=rooms[activeRoomId],rc=removedCands(activeRoomId);
  const visible=r.candidates.filter(id=>!rc.has(id));
  if(!visible.length){list.innerHTML='<div style="font-size:11px;color:var(--text-muted);text-align:center;padding:8px">No candidates</div>';return;}
  list.innerHTML=visible.map((id,i)=>{
    const pc=peerConns[id],alive=pc&&pc.conn&&pc.conn.open,elected=id===r.serverId;
    const name=peerAliases[id]||(r.peers[id]?r.peers[id].name:r.knownPeers[id])||id,isAliased=!!peerAliases[id];
    const score=pc&&pc.scores&&pc.scores.length?Math.round(pc.scores.slice(-SCORE_WINDOW).reduce((a,b)=>a+b,0)/pc.scores.length)+'ms':'—';
    return `<div class="candidate-item ${elected?'elected':''}"><span class="cand-rank">${i+1}</span><span style="width:8px;height:8px;border-radius:50%;background:${elected?'var(--amber)':alive?'var(--green)':'var(--text-muted)'};flex-shrink:0;display:inline-block"></span><span class="cand-name ${isAliased?'aliased':''}">${escapeHtml(name)}</span><span class="cand-score">${score}</span></div>`;
  }).join('');
}

function updateLatencyDisplay() {
  const all=Object.values(peerConns).flatMap(pc=>pc.scores.slice(-3));
  if(!all.length)return;
  document.getElementById('net-latency').textContent=Math.round(all.reduce((a,b)=>a+b,0)/all.length)+' ms';
}

function updateTypingIndicator() {
  const r=activeRoomId?rooms[activeRoomId]:null;
  const tp=r?r.typingPeers:{};
  const names=Object.entries(tp).filter(([k,v])=>!k.startsWith('_t_')&&typeof v==='string').map(([,v])=>v);
  const el=document.getElementById('typing-indicator'),tx=document.getElementById('typing-text');
  if(!names.length){el.classList.add('hidden');return;}
  el.classList.remove('hidden');
  tx.textContent=names.length===1?`${names[0]} is typing…`:`${names.slice(0,-1).join(', ')} and ${names.at(-1)} are typing…`;
}

function setStatus(state,label){document.getElementById('status-dot').className='dot '+state;}

function updateMyInfo(){
  document.getElementById('my-avatar').textContent=(myName||'?').charAt(0).toUpperCase();
  document.getElementById('my-name-display').textContent=myName;
  document.getElementById('my-id-display').textContent=myId||'—';
}

// ─── DRAWERS ──────────────────────────────────────────────────────────────────
function toggleSidebar(){sidebarOpen=!sidebarOpen;document.getElementById('sidebar').classList.toggle('open',sidebarOpen);document.getElementById('sidebar-overlay').classList.toggle('visible',sidebarOpen);}
function closeSidebar(){sidebarOpen=false;document.getElementById('sidebar').classList.remove('open');document.getElementById('sidebar-overlay').classList.remove('visible');}
function openNetPanel(){netPanelOpen=true;document.getElementById('network-panel-drawer').classList.add('open');document.getElementById('netpanel-overlay').classList.add('visible');renderTopology();}
function closeNetPanel(){netPanelOpen=false;document.getElementById('network-panel-drawer').classList.remove('open');document.getElementById('netpanel-overlay').classList.remove('visible');}

// ─── UI SETUP ─────────────────────────────────────────────────────────────────
function setupUI() {
  const input=document.getElementById('msg-input'),send=document.getElementById('send-btn');
  input.addEventListener('input',()=>{input.style.height='';input.style.height=Math.min(input.scrollHeight,120)+'px';send.disabled=!input.value.trim()||!activeRoomId;onTyping();});
  input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMessage();}});
  send.addEventListener('click',sendMessage);
  document.getElementById('sidebar-overlay').addEventListener('click',closeSidebar);
  document.getElementById('netpanel-overlay').addEventListener('click',closeNetPanel);
  input.disabled=true; send.disabled=true; document.getElementById('file-btn').disabled=true;
  renderRoomList(); renderRoomGrid();
  checkJoinUrl();
}

// ─── MODALS ───────────────────────────────────────────────────────────────────
function completeSetup(){const name=document.getElementById('setup-name').value.trim();if(!name){toast('Enter a display name','error');return;}myName=name;saveStorage();closeModal('setup-modal');updateMyInfo();startPeer();}
function showSettings(){document.getElementById('settings-name').value=myName;document.getElementById('settings-peer-id').value=myId||'';document.getElementById('settings-modal').classList.remove('hidden');}
function saveSettings(){const name=document.getElementById('settings-name').value.trim();if(name){myName=name;updateMyInfo();saveStorage();}closeModal('settings-modal');}
function showCreateRoom(){document.getElementById('new-room-name').value='';document.getElementById('create-room-modal').classList.remove('hidden');setTimeout(()=>document.getElementById('new-room-name').focus(),50);}
function showAddChannel(){if(!activeRoomId)return;document.getElementById('new-channel-name').value='';document.getElementById('new-channel-desc').value='';document.getElementById('add-channel-modal').classList.remove('hidden');setTimeout(()=>document.getElementById('new-channel-name').focus(),50);}
function closeModal(id){document.getElementById(id).classList.add('hidden');}
function manualConnect(){
  const peerInput=document.getElementById('connect-peer-id');
  const roomInput=document.getElementById('connect-room-id');
  const pid=peerInput.value.trim();
  const rid=roomInput?roomInput.value.trim():'';
  if (!pid){toast('Enter a Peer ID','error');return;}
  peerInput.value=''; if(roomInput)roomInput.value='';
  if (rid) {
    // Join or switch to specified room via this peer
    if (!rooms[rid]) {
      rooms[rid]=makeRoomShell(rid,'Room '+rid,null);
      startRoomElectionTimer(rid);
      saveStorage(); renderRoomList();
    }
    toast('Connecting to '+pid+' for room '+rid+'…','info');
    connectTo(pid, conn => {
      conn.send({type:'join_room',roomId:rid,id:myId,name:myName});
      switchRoom(rid);
      toast('Joined room '+rid+'!','success');
    }, ()=>toast('Could not connect.','error'));
  } else {
    toast('Connecting to '+pid+'…','info');
    connectTo(pid,()=>toast('Connected!','success'),()=>toast('Could not connect.','error'));
  }
}
function copyShareLink(){ copyToClipboard(document.getElementById('share-link-text').textContent); }
function copyText(btn){ copyToClipboard(btn.dataset.text); }

// ─── TOAST ────────────────────────────────────────────────────────────────────
function toast(msg,type='info'){const el=document.createElement('div');el.className=`toast ${type}`;const col=type==='success'?'var(--green)':type==='error'?'var(--red)':'var(--accent)';const icon={success:'✓',error:'✕',info:'ℹ'}[type]||'•';el.innerHTML=`<span style="color:${col}">${icon}</span> ${escapeHtml(msg)}`;document.getElementById('toast-container').appendChild(el);setTimeout(()=>el.remove(),4000);}

// ─── UTILITIES ────────────────────────────────────────────────────────────────
function copyToClipboard(text) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).then(()=>toast('Copied!','success')).catch(()=>fallbackCopy(text));
  } else {
    fallbackCopy(text);
  }
}
function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text; ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0;pointer-events:none';
  document.body.appendChild(ta); ta.focus(); ta.select();
  try { document.execCommand('copy'); toast('Copied!','success'); }
  catch(e) { toast('Copy failed — please copy manually','error'); }
  document.body.removeChild(ta);
}

function genId(){return Math.random().toString(36).slice(2,10)+Date.now().toString(36);}
function escapeHtml(s){if(!s)return'';return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');}
function formatBytes(b){if(!b)return'0 B';const u=['B','KB','MB','GB'];let i=0,v=b;while(v>=1024&&i<u.length-1){v/=1024;i++;}return v.toFixed(1)+' '+u[i];}
function stringToColor(s){let h=0;for(let i=0;i<(s||'').length;i++)h=s.charCodeAt(i)+((h<<5)-h);return['#5b6cf9','#3ddc84','#f5a623','#e06c75','#c678dd','#56b6c2','#61afef','#d19a66'][Math.abs(h)%8];}

// ─── BOOT ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', init);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(()=>{});
