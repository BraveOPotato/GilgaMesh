import { state } from './state.js';
import { makeRoomShell, saveStorage } from './storage.js';
import { generateRoomId } from './ids.js';
import { becomeRoot, savePeerToRoom, updateClusterMapSelf, broadcastClusterMap, handleAdoptRequest, findAndJoinParent, onChildLost } from './mesh.js';
import { startLocalElection, stopLocalElection } from './election.js';
import { displayMessage, addSystemMsg } from './messaging.js';
import { toast, renderRoomList, renderRoomSidebar, renderRoomGrid, renderAllMessages,
         scrollToBottom, updateNetworkPanel, setStatus, closeModal } from './ui.js';
import { copyToClipboard } from './utils.js';

// ─── CREATE ───────────────────────────────────────────────────────────────────
export function createRoom() {
  const name = document.getElementById('new-room-name').value.trim();
  if (!name) { toast('Enter a room name', 'error'); return; }
  const rid = generateRoomId();
  state.rooms[rid] = makeRoomShell(rid, name, state.myId);
  state.rooms[rid].electionEpoch = Date.now();
  saveStorage();
  closeModal('create-room-modal');
  becomeRoot(rid);
  startLocalElection(rid);
  switchRoom(rid);
  renderRoomList();
  toast(`Room "${name}" created!`, 'success');
}

// ─── JOIN VIA INVITE ─────────────────────────────────────────────────────────
export function joinRoomViaInvite(rid, roomName, viaPeerId) {
  if (state.rooms[rid]) { switchRoom(rid); toast(`Already in "${state.rooms[rid].name}"`, 'info'); return; }

  // Show a non-blocking "joining…" toast but do NOT create the room shell or
  // switch the UI yet — we wait until the scout succeeds so a failed join
  // never leaves a phantom empty room in the sidebar.
  const resolvedName = roomName || `Room ${rid}`;
  toast(`Joining room "${resolvedName}"…`, 'info');

  console.log(`[rooms] joinRoomViaInvite(${rid}) — scouting cluster map via ${viaPeerId}`);

  // Helper: commit the room into state and switch the UI to it.
  // Called exactly once on the success path.
  const commitRoom = (map) => {
    // Guard: if another code path already added this room while we were
    // scouting (e.g. duplicate invite click), just switch to it.
    if (state.rooms[rid]) { switchRoom(rid); return; }

    state.rooms[rid] = makeRoomShell(rid, resolvedName, null);

    if (map !== null) {
      // Merge the received cluster map into our room shell
      const r = state.rooms[rid];
      for (const [pid, entry] of Object.entries(map)) {
        if (pid === state.myId) continue;
        r.clusterMap[pid] = entry;
        if (!r.peers[pid]) r.peers[pid] = { id: pid, name: entry.name || pid };
      }
      // Ensure the inviting peer is present in the map
      if (!r.clusterMap[viaPeerId]) {
        r.clusterMap[viaPeerId] = { name: viaPeerId, distance: 0, childCount: 0, connCount: 0, descendantCount: 1 };
      }
      updateClusterMapSelf(rid);
    }

    saveStorage();
    renderRoomList();
    switchRoom(rid);

    if (map !== null) {
      console.log(`[rooms] joinRoomViaInvite(${rid}) — clusterMap ready, finding optimal parent`);
      findAndJoinParent(rid);
    } else {
      // map === null: reusing an existing connection — map + findAndJoinParent
      // will be triggered automatically via the normal dispatch path.
      console.log(`[rooms] joinRoomViaInvite(${rid}) — map arriving via existing conn`);
    }
  };

  import('./peer.js').then(({ scoutClusterMap }) => {
    const MAX_ATTEMPTS = 6;        // 1 initial + 5 retries
    const RETRY_INTERVAL_MS = 200; // 200 ms between each retry
    let attempt = 0;

    const tryScout = () => {
      attempt++;
      console.log(`[rooms] joinRoomViaInvite(${rid}) — scout attempt ${attempt}/${MAX_ATTEMPTS} via ${viaPeerId}`);

      scoutClusterMap(viaPeerId, rid, (map) => {
        // ── Success ──────────────────────────────────────────────────────────
        console.log(`[rooms] joinRoomViaInvite(${rid}) — scout succeeded on attempt ${attempt}` +
          (map ? ` (${Object.keys(map).length} map entries)` : ' (existing conn)'));
        commitRoom(map);
      }, (reason) => {
        // ── Failure / retry ───────────────────────────────────────────────────
        console.log(`[rooms] joinRoomViaInvite(${rid}) — scout attempt ${attempt} failed: ${reason}`);

        if (attempt < MAX_ATTEMPTS) {
          console.log(`[rooms] joinRoomViaInvite(${rid}) — retrying in ${RETRY_INTERVAL_MS}ms`);
          setTimeout(tryScout, RETRY_INTERVAL_MS);
        } else {
          // All attempts exhausted — never created a room shell, so nothing to
          // clean up. Just inform the user and stay on the rooms grid.
          console.log(`[rooms] joinRoomViaInvite(${rid}) — all ${MAX_ATTEMPTS} attempts failed, giving up`);
          toast(`Could not join "${resolvedName}" — the inviter may be offline.`, 'error');
        }
      });
    };

    tryScout();
  });
}

// ─── LEAVE ────────────────────────────────────────────────────────────────────
export function confirmLeaveRoom() {
  if (!state.activeRoomId) return;
  const r = state.rooms[state.activeRoomId]; if (!r) return;
  document.getElementById('leave-room-name').textContent = r.name;
  document.getElementById('leave-room-modal').classList.remove('hidden');
}

export function leaveRoom() {
  const rid = state.activeRoomId; if (!rid) return;
  const r = state.rooms[rid]; if (!r) return;
  closeModal('leave-room-modal');

  // If we're the parent of our local group, hand off
  if (!r.parentId && r.childIds.length) {
    const bestChild = r.childIds[0];
    const conn = r.childConns[bestChild] || state.peerConns[bestChild]?.conn;
    if (conn?.open) {
      try {
        conn.send({ type: 'become_parent', roomId: rid, siblings: r.childIds.filter(id => id !== bestChild), distanceFromRoot: 0 });
      } catch {}
    }
  }

  // Notify parent
  if (r.parentConn?.open) {
    try { r.parentConn.send({ type: 'peer_leaving', roomId: rid, id: state.myId, name: state.myName }); } catch {}
  }

  stopLocalElection(rid);
  // Close all room connections
  r.childIds.forEach(pid => { try { r.childConns[pid]?.close(); } catch {} });
  if (r.parentConn) try { r.parentConn.close(); } catch {}
  if (r.backupConn) try { r.backupConn.close(); } catch {}

  // Remove room from peerConns tracking
  for (const pc of Object.values(state.peerConns)) { pc.rooms?.delete(rid); }

  delete state.rooms[rid];
  saveStorage();
  toast(`Left "${r.name}"`, 'info');
  backToRooms();
}

// ─── CHANNELS ─────────────────────────────────────────────────────────────────
export function createChannel() {
  if (!state.activeRoomId) return;
  const r = state.rooms[state.activeRoomId]; if (!r) return;
  const name = document.getElementById('new-channel-name').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-');
  const desc = document.getElementById('new-channel-desc').value.trim();
  if (!name) { toast('Enter a channel name', 'error'); return; }
  if (r.channels.find(c => c.id === name)) { toast('Already exists', 'error'); return; }
  const ch = { id: name, name, desc: desc || 'No description' };
  r.channels.push(ch); r.messages[ch.id] = []; r.unread[ch.id] = 0;
  saveStorage(); renderRoomSidebar(); closeModal('add-channel-modal');
  const evt = { type: 'channel_created', roomId: state.activeRoomId, channel: ch };
  broadcastToRoom(state.activeRoomId, evt);
}

export function handleChannelCreated(rid, data) {
  const r = state.rooms[rid]; if (!r) return;
  if (r.channels.find(c => c.id === data.channel.id)) return;
  r.channels.push(data.channel); r.messages[data.channel.id] = []; r.unread[data.channel.id] = 0;
  saveStorage();
  if (rid === state.activeRoomId) renderRoomSidebar();
  broadcastToRoom(rid, data);
}

export function switchChannel(id) {
  if (!state.activeRoomId) return;
  const r = state.rooms[state.activeRoomId]; if (!r) return;
  state.activeChannel = id; r.unread[id] = 0;
  const ch = r.channels.find(c => c.id === id);
  document.getElementById('active-channel-title').textContent = ch ? ch.name : id;
  document.getElementById('active-channel-desc').textContent  = ch ? ch.desc : '';
  document.getElementById('msg-input').placeholder = `Message #${ch ? ch.name : id}`;
  renderRoomSidebar(); renderAllMessages(); scrollToBottom();
  if (window.innerWidth <= 700) import('./ui.js').then(ui => ui.closeSidebar());
}

// ─── ROOM SWITCHING ───────────────────────────────────────────────────────────
export function switchRoom(rid) {
  state.activeRoomId = rid; state.activeChannel = 'general';
  const r = state.rooms[rid]; if (!r) return;
  for (const ch of r.channels) r.unread[ch.id] = 0;
  const ch = r.channels.find(c => c.id === 'general') || r.channels[0];
  if (ch) state.activeChannel = ch.id;

  document.getElementById('active-room-name').textContent  = r.name;
  document.getElementById('active-room-id').textContent    = '#' + r.id;
  document.getElementById('active-channel-title').textContent = state.activeChannel;
  document.getElementById('active-channel-desc').textContent  = ch ? ch.desc : '';
  document.getElementById('msg-input').placeholder = `Message #${state.activeChannel}`;
  document.getElementById('msg-input').disabled    = false;
  document.getElementById('file-btn').disabled     = false;
  document.getElementById('back-to-rooms').style.display = 'flex';
  document.getElementById('invite-btn').style.display    = 'flex';
  document.getElementById('leave-strip').style.display   = 'block';

  renderRoomSidebar(); renderAllMessages(); scrollToBottom();
  updateNetworkPanel(); renderRoomList();

  const isRoot = !r.parentId;
  setStatus(isRoot ? 'server' : r.parentId ? 'connected' : 'alone',
            isRoot ? 'root' : r.parentId ? 'connected' : 'searching');

  if (window.innerWidth <= 700) import('./ui.js').then(ui => ui.closeSidebar());
}

export function backToRooms() {
  state.activeRoomId = null;
  document.getElementById('active-room-name').textContent  = 'GilgaMesh';
  document.getElementById('active-room-id').textContent    = '';
  document.getElementById('active-channel-title').textContent = 'Rooms';
  document.getElementById('active-channel-desc').textContent  = 'Your peer-to-peer rooms';
  document.getElementById('back-to-rooms').style.display = 'none';
  document.getElementById('invite-btn').style.display    = 'none';
  document.getElementById('leave-strip').style.display   = 'none';
  document.getElementById('msg-input').disabled    = true;
  document.getElementById('msg-input').placeholder = 'Select a room to chat';
  document.getElementById('send-btn').disabled  = true;
  document.getElementById('file-btn').disabled  = true;
  renderRoomList(); renderRoomGrid(); updateNetworkPanel();
}

// ─── INVITE ───────────────────────────────────────────────────────────────────
export function showInvite() {
  if (!state.activeRoomId) return;
  const r = state.rooms[state.activeRoomId]; if (!r) return;
  const base = location.href.split('?')[0];
  const link = `${base}?join=${r.id}&rname=${encodeURIComponent(r.name)}&via=${encodeURIComponent(state.myId)}`;
  document.getElementById('invite-room-name').textContent = r.name;
  document.getElementById('invite-room-id').textContent   = r.id;
  document.getElementById('invite-peer-id').textContent   = state.myId;
  document.getElementById('invite-link').textContent      = link;
  document.getElementById('invite-modal').classList.remove('hidden');
}

export function copyInviteLink() {
  copyToClipboard(document.getElementById('invite-link').textContent);
}

export function checkJoinUrl() {
  const p    = new URLSearchParams(location.search);
  const rid  = p.get('join'), rname = p.get('rname') || 'Room', via = p.get('via');
  if (rid && via) {
    history.replaceState({}, '', location.pathname);
    const attempt = () => {
      // state.peer exists as soon as new Peer() is called, but .open is only
      // true after the peer.on('open') callback fires — which is when
      // peer.connect() actually works. Checking only state.myId was equivalent
      // since myId is set in that same callback, but be explicit here.
      if (!state.peer?.open || !state.myId) {
        console.log('[rooms] checkJoinUrl — peer not open yet, retrying in 500ms');
        setTimeout(attempt, 500);
        return;
      }
      joinRoomViaInvite(rid, rname, via);
    };
    setTimeout(attempt, 800);
  }
}

// ─── BROADCAST HELPERS ────────────────────────────────────────────────────────
function broadcastToRoom(rid, data) {
  const r = state.rooms[rid]; if (!r) return;
  if (r.parentConn?.open) try { r.parentConn.send(data); } catch {}
  for (const cid of r.childIds) {
    const conn = r.childConns[cid] || state.peerConns[cid]?.conn;
    if (conn?.open) try { conn.send(data); } catch {}
  }
}

export function handlePeerLeaving(data) {
  // Keep r.peers[data.id] intact — a graceful leave, like a disconnect,
  // keeps the member visible in the sidebar with an offline dot.
  const r = state.rooms[data.roomId]; if (!r) return;
  const name = r.peers[data.id]?.name || data.id;

  // If the leaving peer is one of our children, clean up the child slot now.
  // Without this, the peer stays in childIds even after it has gracefully
  // detached (e.g. a voice node leaving the channel sends peer_leaving before
  // reconnecting elsewhere, and the old parent must release it immediately).
  if (r.childIds.includes(data.id)) {
    onChildLost(data.roomId, data.id);
  }

  addSystemMsg(data.roomId, 'general', `${name} left`);
  saveStorage();
  if (data.roomId === state.activeRoomId) renderRoomSidebar();
}
