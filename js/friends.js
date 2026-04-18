/**
 * friends.js — Friends list, direct messaging, and block list.
 *
 * DMs use the exact same #messages / renderMessage pipeline as room chat.
 * The friends view mirrors the rooms view:
 *   - Clicking the logo → friends grid in #messages, friends list in sidebar
 *   - Clicking a friend → DM thread in #messages (same rendering as room chat)
 *   - Send/file buttons work identically
 *
 * state.activeFriendsView = true  → we're in the friends context
 * state.activeDMPeer = peerId     → we're viewing a specific DM thread
 */

import { state } from './state.js';
import { genId } from './ids.js';
import { escapeHtml, stringToColor } from './utils.js';
import { toast, renderMessage, scrollToBottom } from './ui.js';

// ─── NAME RESOLUTION ─────────────────────────────────────────────────────────
// Best display name for a peer: nickname > friends-stored name > room peer name > peerId
function _peerDisplayName(pid) {
  if (!pid) return '';
  // Nickname overrides everything
  if (state.friends?.[pid]?.nickname) return state.friends[pid].nickname;
  // Friends-stored name (set when added from room member list)
  if (state.friends?.[pid]?.name && state.friends[pid].name !== pid) return state.friends[pid].name;
  // Any active room's peer registry
  for (const r of Object.values(state.rooms || {})) {
    if (r.peers?.[pid]?.name && r.peers[pid].name !== pid) return r.peers[pid].name;
  }
  // Fallback to stored name or id
  return state.friends?.[pid]?.name || pid;
}

const FRIENDS_KEY = 'gilgamesh_friends';
const BLOCKED_KEY = 'gilgamesh_blocked';
const DMS_KEY     = 'gilgamesh_dms';

// ─── STORAGE ──────────────────────────────────────────────────────────────────
export function loadFriendsData() {
  try { state.friends = JSON.parse(localStorage.getItem(FRIENDS_KEY) || '{}'); } catch { state.friends = {}; }
  try { state.blocked = JSON.parse(localStorage.getItem(BLOCKED_KEY) || '{}'); } catch { state.blocked = {}; }
  try { state.dms     = JSON.parse(localStorage.getItem(DMS_KEY)     || '{}'); } catch { state.dms     = {}; }
  if (!state.dmUnread) state.dmUnread = {};
}

export function setNickname(peerId, nickname) {
  if (!state.friends?.[peerId]) return;
  state.friends[peerId].nickname = nickname.trim();
  saveFriendsData();
  if (state.activeFriendsView) renderFriendsSidebar();
  // Re-render grid or thread header if open
  if (state.activeDMPeer === peerId) openDMWith(peerId, _peerDisplayName(peerId));
  else if (state.activeFriendsView) renderFriendsGrid();
  toast(nickname.trim() ? `Nickname set to "${nickname.trim()}"` : 'Nickname cleared', 'success');
}

export function saveFriendsData() {
  localStorage.setItem(FRIENDS_KEY, JSON.stringify(state.friends || {}));
  localStorage.setItem(BLOCKED_KEY, JSON.stringify(state.blocked || {}));
  localStorage.setItem(DMS_KEY,     JSON.stringify(state.dms     || {}));
}

// ─── FRIENDS ──────────────────────────────────────────────────────────────────
export function addFriend(peerId, name) {
  if (!peerId || peerId === state.myId) return;
  if (state.friends?.[peerId]) { toast('Already friends', 'info'); return; }
  // Send a friend request packet — don't add to list until accepted
  const reqId = genId();
  const wire = (conn) => {
    try {
      conn.send({ type: 'friend_request', reqId, from: state.myId, fromName: state.myName });
      toast(`Friend request sent to ${name || peerId}`, 'success');
    } catch { toast('Could not reach peer', 'error'); }
  };
  const ex = state.peerConns[peerId];
  if (ex?.conn?.open) wire(ex.conn);
  else state.cb.connectTo?.(peerId, conn => wire(conn), () => toast('Peer unreachable', 'error'));
  // Also show as a system-style DM message locally so the user knows they sent a request
  _storeDMSystem(peerId, name || peerId, `You sent a friend request to ${name || peerId}`);
}

export function _addFriendConfirmed(peerId, name) {
  // Called after the other side accepts — actually adds to friends list
  if (!state.friends) state.friends = {};
  const existing = state.friends[peerId];
  state.friends[peerId] = { id: peerId, name: name || peerId, addedAt: Date.now(), nickname: existing?.nickname || '' };
  saveFriendsData();
  if (state.activeFriendsView) renderFriendsSidebar();
}

export function removeFriend(peerId) {
  if (!state.friends?.[peerId]) return;
  const name = state.friends[peerId].name;
  delete state.friends[peerId];
  saveFriendsData();
  if (state.activeFriendsView) renderFriendsSidebar();
  toast(`${name} removed from friends`, 'info');
}

export function isFriend(peerId)  { return !!(state.friends?.[peerId]); }

// ─── BLOCK ────────────────────────────────────────────────────────────────────
export function blockPeer(peerId, name) {
  if (!peerId || peerId === state.myId) return;
  if (!state.blocked) state.blocked = {};
  state.blocked[peerId] = { id: peerId, name: name || peerId, blockedAt: Date.now() };
  if (state.friends?.[peerId]) delete state.friends[peerId];
  saveFriendsData();
  if (state.activeFriendsView) renderFriendsSidebar();
  toast(`${name || peerId} blocked`, 'info');
}

export function unblockPeer(peerId) {
  if (!state.blocked?.[peerId]) return;
  const name = state.blocked[peerId].name;
  delete state.blocked[peerId];
  saveFriendsData();
  if (state.activeFriendsView) renderFriendsSidebar();
  toast(`${name} unblocked`, 'info');
}

export function isBlocked(peerId) { return !!(state.blocked?.[peerId]); }

// ─── SEND DM ──────────────────────────────────────────────────────────────────
export function sendDM(peerId, text) {
  if (!text?.trim() || !peerId || peerId === state.myId) return false;
  if (!state.dms) state.dms = {};
  if (!state.dms[peerId]) state.dms[peerId] = [];

  const msg = {
    id:       genId(),
    type:     'chat',          // same as room messages so renderMessage handles it fully
    author:   state.myName,
    authorId: state.myId,
    content:  text.trim(),
    ts:       Date.now(),
    channel:  'dm',
  };

  state.dms[peerId].push(msg);
  if (state.dms[peerId].length > 500) state.dms[peerId].shift();
  saveFriendsData();

  // Render immediately in active DM view
  if (state.activeDMPeer === peerId) {
    renderMessage(msg);
    scrollToBottom();
  }

  // Wire — point-to-point only
  const wire = (conn) => {
    try { conn.send({ type: 'dm', id: msg.id, from: state.myId, fromName: state.myName, content: text.trim(), ts: msg.ts }); }
    catch { toast('Send failed', 'error'); }
  };
  const ex = state.peerConns[peerId];
  if (ex?.conn?.open) wire(ex.conn);
  else state.cb.connectTo?.(peerId, conn => wire(conn), () => toast('Peer unreachable', 'error'));

  return true;
}

// ─── SYSTEM DM MESSAGE (local only) ─────────────────────────────────────────
function _storeDMSystem(peerId, peerName, text) {
  if (!state.dms) state.dms = {};
  if (!state.dms[peerId]) state.dms[peerId] = [];
  const msg = { id: genId(), type: 'system', content: text, ts: Date.now(), channel: 'dm', authorId: 'system', author: 'System' };
  state.dms[peerId].push(msg);
  saveFriendsData();
  if (state.activeDMPeer === peerId) { renderMessage(msg); import('./ui.js').then(ui => ui.scrollToBottom()); }
}

// ─── DM TYPING ────────────────────────────────────────────────────────────────
let _dmTypingTimer = null;
export function sendDMTyping(peerId) {
  const ex = state.peerConns[peerId];
  if (!ex?.conn?.open) return;
  try { ex.conn.send({ type: 'dm_typing', from: state.myId, fromName: state.myName, to: peerId }); } catch {}
}

// ─── FRIEND REQUEST ───────────────────────────────────────────────────────────
export function handleIncomingFriendRequest(data, conn) {
  const from = data.from || conn.peer;
  if (!from || from === state.myId) return;
  if (isBlocked(from)) return;
  if (!state.dms) state.dms = {};
  if (!state.dms[from]) state.dms[from] = [];
  const fromName = data.fromName || from;
  // Show an interactive friend request message
  const reqId = data.reqId || genId();
  const msg = {
    id: reqId,
    type: 'friend_request_msg',
    author: fromName,
    authorId: from,
    content: `${escapeHtml(fromName)} wants to be your friend`,
    reqId,
    fromPid: from,
    ts: Date.now(),
    channel: 'dm',
  };
  if (!state.dms[from].some(m => m.id === reqId)) {
    state.dms[from].push(msg);
    saveFriendsData();
  }
  if (!state.dmUnread) state.dmUnread = {};
  if (state.activeDMPeer !== from) {
    state.dmUnread[from] = (state.dmUnread[from] || 0) + 1;
    renderFriendsBadge();
  }
  if (state.activeFriendsView) renderFriendsSidebar();
  if (state.activeDMPeer === from) { renderMessage(msg); import('./ui.js').then(ui => ui.scrollToBottom()); }
  toast(`${fromName} wants to be your friend`, 'info');
}

export function respondToFriendRequest(fromPid, reqId, accept) {
  const fromName = state.friends?.[fromPid]?.name || fromPid;
  const myName = state.myName;
  const responseText = accept
    ? `${myName} accepted your friend request`
    : `${myName} declined your friend request`;
  // Send response back
  const wire = (conn) => {
    try { conn.send({ type: 'friend_response', reqId, from: state.myId, fromName: myName, accept }); } catch {}
  };
  const ex = state.peerConns[fromPid];
  if (ex?.conn?.open) wire(ex.conn);
  else state.cb.connectTo?.(fromPid, conn => wire(conn), () => {});
  if (accept) {
    _addFriendConfirmed(fromPid, fromName);
    _storeDMSystem(fromPid, fromName, `You are now friends with ${fromName}`);
  } else {
    _storeDMSystem(fromPid, fromName, `You declined ${fromName}'s friend request`);
  }
  // Replace the interactive request message with the response text
  if (state.dms?.[fromPid]) {
    const idx = state.dms[fromPid].findIndex(m => m.id === reqId);
    if (idx !== -1) state.dms[fromPid].splice(idx, 1);
  }
  saveFriendsData();
  if (state.activeDMPeer === fromPid) openDMWith(fromPid, _peerDisplayName(fromPid));
  else if (state.activeFriendsView) renderFriendsSidebar();
}

export function handleIncomingFriendResponse(data, conn) {
  const from = data.from || conn.peer;
  if (!from) return;
  const fromName = data.fromName || from;
  if (data.accept) {
    _addFriendConfirmed(from, fromName);
    _storeDMSystem(from, fromName, `${fromName} accepted your friend request — you are now friends!`);
    toast(`${fromName} accepted your friend request!`, 'success');
  } else {
    _storeDMSystem(from, fromName, `${fromName} declined your friend request`);
    toast(`${fromName} declined your friend request`, 'info');
  }
  if (state.activeDMPeer === from) openDMWith(from, _peerDisplayName(from));
  else if (state.activeFriendsView) renderFriendsSidebar();
}

// ─── RECEIVE DM ───────────────────────────────────────────────────────────────
export function handleIncomingDM(data, conn) {
  const from = data.from || conn.peer;
  if (!from) return;
  // Handle typing notification (no storage)
  if (data.type === 'dm_typing') {
    if (isBlocked(from)) return;
    if (!state.dmTypingPeers) state.dmTypingPeers = {};
    state.dmTypingPeers[from] = data.fromName || from;
    import('./ui.js').then(ui => ui.updateTypingIndicator());
    clearTimeout(state._dmTypingTimers?.[from]);
    if (!state._dmTypingTimers) state._dmTypingTimers = {};
    state._dmTypingTimers[from] = setTimeout(() => {
      delete state.dmTypingPeers?.[from];
      import('./ui.js').then(ui => ui.updateTypingIndicator());
    }, 4000);
    return;
  }
  if (!state.dms) state.dms = {};
  if (!state.dms[from]) state.dms[from] = [];
  if (state.dms[from].some(m => m.id === data.id)) return; // dedup

  const msg = {
    id:       data.id || genId(),
    type:     'chat',
    author:   data.fromName || from,
    authorId: from,
    content:  data.content,
    ts:       data.ts || Date.now(),
    channel:  'dm',
    // Preserve file-share fields when present
    ...(data.msgType   ? { msgType:   data.msgType   } : {}),
    ...(data.fileShare ? { fileShare: data.fileShare } : {}),
  };

  state.dms[from].push(msg);
  if (state.dms[from].length > 500) state.dms[from].shift();
  if (state.friends?.[from] && data.fromName) state.friends[from].name = data.fromName;
  saveFriendsData();

  if (isBlocked(from)) return; // stored but never shown

  if (state.activeDMPeer === from) {
    renderMessage(msg);
    scrollToBottom();
  } else {
    if (!state.dmUnread) state.dmUnread = {};
    state.dmUnread[from] = (state.dmUnread[from] || 0) + 1;
    renderFriendsBadge();
    if (state.activeFriendsView) renderFriendsSidebar();
    const senderName = state.friends?.[from]?.name || data.fromName || from;
    toast(`DM from ${senderName}: ${data.content.slice(0, 60)}`, 'info');
  }
}

// ─── FRIENDS VIEW ─────────────────────────────────────────────────────────────
export function openFriendsView() {
  state.activeRoomId      = null;
  state.activeDMPeer      = null;
  state.activeFriendsView = true;

  document.getElementById('active-room-name').textContent     = 'Friends';
  document.getElementById('active-room-id').textContent       = '';
  document.getElementById('active-channel-title').textContent = 'Direct Messages';
  document.getElementById('active-channel-desc').textContent  = 'Message your friends directly';
  document.getElementById('back-to-rooms').style.display      = 'none';
  document.getElementById('invite-btn').style.display         = 'none';
  document.getElementById('leave-strip').style.display        = 'none';
  document.getElementById('msg-input').disabled               = true;
  document.getElementById('msg-input').placeholder            = 'Select a friend to chat';
  document.getElementById('send-btn').disabled                = true;
  document.getElementById('file-btn').disabled                = true;

  showFriendsSidebarOverlay(true);
  renderFriendsSidebar();
  renderFriendsGrid();
  renderFriendsBadge();
  import('./ui.js').then(ui => { ui.updateNetworkPanel(); ui.renderRoomList(); });
  // Quick presence scan: ping each friend we don't already have a live connection to
  _scanFriendPresence();
}

export function closeFriendsView() {
  state.activeFriendsView = false;
  state.activeDMPeer      = null;
  showFriendsSidebarOverlay(false);
}

// ─── FRIENDS SIDEBAR ──────────────────────────────────────────────────────────
// Uses a dedicated overlay div so the real channels-section DOM is never touched.
// When friends view is active the overlay covers it; when returning to a room
// the overlay is hidden and renderRoomSidebar writes into the original elements.
export function showFriendsSidebarOverlay(visible) {
  const ov = document.getElementById('friends-sidebar-overlay');
  if (!ov) return;
  ov.classList.toggle('hidden', !visible);
}

export function renderFriendsSidebar() {
  if (!state.activeFriendsView) return;
  const section = document.getElementById('friends-sidebar-overlay');
  if (!section) return;

  const friends  = Object.values(state.friends || {});
  const blocked  = Object.values(state.blocked || {});
  const otherDMs = Object.keys(state.dms || {}).filter(pid =>
    !state.friends?.[pid] && !state.blocked?.[pid] && (state.dms[pid]?.length || 0) > 0
  );

  let html = '';

  // ── Quick DM by Peer ID ───────────────────────────────────────────────────
  html += `<div class="section-label">New Message</div>
  <div style="padding:2px 10px 8px">
    <div style="display:flex;gap:5px">
      <input id="dm-peer-id-input" placeholder="Peer ID…" style="flex:1;min-width:0;background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius-sm);padding:5px 8px;color:var(--text-primary);font-size:11px;font-family:var(--mono);outline:none" autocomplete="off" spellcheck="false">
      <button onclick="window._gmOpenDMById()" style="background:var(--accent);border:none;color:#fff;border-radius:var(--radius-sm);padding:5px 10px;cursor:pointer;font-size:13px;flex-shrink:0">→</button>
    </div>
  </div>`;

  // ── Recent DMs (non-friends) ───────────────────────────────────────────────
  if (otherDMs.length) {
    html += `<div class="section-label">Recent</div>`;
    for (const pid of otherDMs) html += _dmRow(pid, _peerDisplayName(pid), false);
    html += `<div class="divider"></div>`;
  }

  // ── Friends ───────────────────────────────────────────────────────────────
  html += `<div class="section-label">Friends</div>`;
  if (!friends.length) {
    html += `<div style="padding:6px 13px 10px;font-size:11px;color:var(--text-muted);line-height:1.5">No friends yet.<br>Click a member in any room to add them.</div>`;
  } else {
    for (const f of friends.sort((a, b) => _peerDisplayName(a.id).localeCompare(_peerDisplayName(b.id)))) {
      html += _dmRow(f.id, _peerDisplayName(f.id), true);
    }
  }

  // ── Blocked ───────────────────────────────────────────────────────────────
  if (blocked.length) {
    html += `<div class="divider"></div><div class="section-label">Blocked</div>`;
    for (const b of blocked) {
      const color = stringToColor(b.id);
      html += `<div class="peer-item" style="opacity:0.5">
        <div class="peer-avatar" style="background:${color}20;border-color:${color}30;color:${color};width:22px;height:22px;font-size:10px">${(b.name||'?').charAt(0).toUpperCase()}</div>
        <span class="peer-name">${escapeHtml(b.name||b.id)}</span>
        <button onclick="window._gmUnblockPeer('${b.id}')" style="background:none;border:1px solid var(--border);border-radius:4px;padding:2px 6px;font-size:10px;cursor:pointer;color:var(--text-muted);flex-shrink:0">Unblock</button>
      </div>`;
    }
  }

  section.innerHTML = html;

  section.classList.remove('hidden'); // ensure visible
  const inp = document.getElementById('dm-peer-id-input');
  if (inp) {
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') window._gmOpenDMById(); });
    // focus so typing is snappy on mobile too
    inp.addEventListener('focus', () => inp.style.borderColor = 'var(--border-accent)');
    inp.addEventListener('blur',  () => inp.style.borderColor = 'transparent');
  }
}

function _dmRow(pid, name, isFriend) {
  const color  = stringToColor(pid);
  const unread = state.dmUnread?.[pid] || 0;
  const active = state.activeDMPeer === pid;
  const online = !!(state.peerConns[pid]?.conn?.open);
  const safeN  = (name||pid).replace(/'/g, "\\'");
  return `<div class="channel-item${active ? ' active' : ''}" onclick="window._gmOpenDM('${pid}','${safeN}')">
    <div style="position:relative;width:22px;height:22px;flex-shrink:0">
      <div style="width:22px;height:22px;border-radius:50%;background:${color}${online?'20':'14'};border:1.5px solid ${color}${active?'':'44'};color:${color};display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;transition:all .3s;${online?'':'filter:grayscale(0.8);opacity:0.55;'}">${(name||'?').charAt(0).toUpperCase()}</div>
      <div style="position:absolute;bottom:-1px;right:-1px;width:8px;height:8px;border-radius:50%;background:${online?'var(--green)':'var(--text-muted)'};border:2px solid var(--bg-deep);transition:background .3s"></div>
    </div>
    <span class="ch-name">${escapeHtml(name||pid)}</span>
    ${unread ? `<span class="unread">${unread>99?'99+':unread}</span>` : ''}
  </div>`;
}

// ─── FRIENDS GRID (like rooms grid) ───────────────────────────────────────────
export function renderFriendsGrid() {
  const container = document.getElementById('messages');
  container.innerHTML = '';

  const friends  = Object.values(state.friends || {});
  const otherDMs = Object.keys(state.dms || {}).filter(pid =>
    !state.friends?.[pid] && !state.blocked?.[pid] && (state.dms[pid]?.length || 0) > 0
  );

  if (!friends.length && !otherDMs.length) {
    container.innerHTML = `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:var(--text-muted);padding:40px;text-align:center">
      <div style="font-size:48px;line-height:1">👥</div>
      <div style="font-size:15px;font-weight:600;color:var(--text-secondary)">No friends yet</div>
      <div style="font-size:13px;line-height:1.7;max-width:280px">Click any member in a room to add them as a friend, or type a Peer ID in the sidebar to start a direct message.</div>
    </div>`;
    return;
  }

  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;padding:16px;align-content:start;';

  const all = [
    ...friends.map(f => ({ pid: f.id, name: _peerDisplayName(f.id), friend: true })),
    ...otherDMs.map(pid => ({ pid, name: _peerDisplayName(pid), friend: false })),
  ];

  for (const { pid, name, friend } of all) {
    const color   = stringToColor(pid);
    const unread  = state.dmUnread?.[pid] || 0;
    const online  = !!(state.peerConns[pid]?.conn?.open);
    const thread  = state.dms?.[pid] || [];
    const last    = thread[thread.length - 1];
    const preview = last ? ((last.authorId === state.myId ? 'You: ' : '') + last.content.slice(0, 40)) : 'No messages yet';

    const card = document.createElement('div');
    card.style.cssText = 'background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius);padding:14px;cursor:pointer;position:relative;transition:border-color .15s;';
    card.onmouseenter = () => card.style.borderColor = 'var(--border-accent)';
    card.onmouseleave = () => card.style.borderColor = 'transparent';
    card.onclick = () => window._gmShowPeerProfile(pid, name);
    // Avatar is desaturated + dimmed until the peer has an open connection
    const avatarFilter = online ? '' : 'filter:grayscale(1);opacity:0.45;';
    card.innerHTML = `
      <div style="position:relative;width:44px;height:44px;margin-bottom:10px">
        <div style="width:44px;height:44px;border-radius:50%;background:${color}${online?'22':'18'};border:2px solid ${color}${online?'55':'25'};color:${color};display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;transition:all .3s;${avatarFilter}">${(name||'?').charAt(0).toUpperCase()}</div>
        <div style="position:absolute;bottom:0;right:0;width:12px;height:12px;border-radius:50%;background:${online?'var(--green)':'var(--text-muted)'};border:2px solid var(--bg-raised);transition:background .3s"></div>
      </div>
      <div style="font-size:13px;font-weight:600;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(name||pid)}</div>
      <div style="font-size:11px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(preview)}</div>
      ${friend ? `<div style="position:absolute;top:10px;right:${unread?'54':'10'}px;font-size:9px;font-family:var(--mono);padding:1px 5px;border-radius:3px;background:var(--accent-glow);color:var(--accent);border:1px solid var(--border-accent)">friend</div>` : ''}
      ${unread ? `<div style="position:absolute;top:8px;right:8px;background:var(--red);color:#fff;font-size:10px;font-weight:700;padding:2px 6px;border-radius:10px;min-width:18px;text-align:center">${unread>99?'99+':unread}</div>` : ''}`;
    grid.appendChild(card);
  }
  container.appendChild(grid);
}

// ─── OPEN DM THREAD ───────────────────────────────────────────────────────────
export function openDMWith(peerId, name) {
  if (!peerId || peerId === state.myId) return;
  const resolvedName = name || _peerDisplayName(peerId);
  // Lazily establish a connection when the user opens a DM thread
  if (!state.peerConns[peerId]?.conn?.open) {
    state.cb.connectTo?.(peerId,
      () => { if (state.activeDMPeer === peerId) { renderFriendsSidebar(); } },
      () => { /* peer offline — that's fine, they'll see messages when online */ }
    );
  }

  state.activeFriendsView = true;
  state.activeDMPeer      = peerId;
  state.activeRoomId      = null;
  if (!state.dmUnread) state.dmUnread = {};
  state.dmUnread[peerId]  = 0;

  renderFriendsBadge();

  document.getElementById('active-room-name').textContent     = 'Friends';
  document.getElementById('active-room-id').textContent       = '';
  document.getElementById('active-channel-title').textContent = resolvedName;
  document.getElementById('active-channel-desc').textContent  = `Direct message · ${peerId}`;
  document.getElementById('back-to-rooms').style.display      = 'none';
  document.getElementById('invite-btn').style.display         = 'none';
  document.getElementById('leave-strip').style.display        = 'none';

  const blocked = isBlocked(peerId);
  document.getElementById('msg-input').disabled               = blocked;
  document.getElementById('msg-input').placeholder            = blocked ? 'This user is blocked' : `Message ${resolvedName}…`;
  document.getElementById('send-btn').disabled                = blocked;
  document.getElementById('file-btn').disabled                = blocked;

  showFriendsSidebarOverlay(true);
  renderFriendsSidebar();
  renderDMThreadContent(peerId, resolvedName);
  import('./ui.js').then(ui => { ui.updateNetworkPanel(); ui.renderRoomList(); });
  if (window.innerWidth <= 700) import('./ui.js').then(ui => ui.closeSidebar());
}

export function renderDMThreadContent(peerId, name) {
  if (!name) name = state.friends?.[peerId]?.name || peerId;
  const container = document.getElementById('messages');
  container.innerHTML = '';

  const color   = stringToColor(peerId);
  const blocked = isBlocked(peerId);
  const fri     = isFriend(peerId);
  const safeN   = (name||peerId).replace(/'/g, "\\'");

  // Conversation header
  const hdr = document.createElement('div');
  hdr.style.cssText = 'display:flex;align-items:center;gap:10px;padding:12px 14px 10px;border-bottom:1px solid var(--border);flex-shrink:0';
  hdr.innerHTML = `
    <div style="width:36px;height:36px;border-radius:50%;background:${color}22;border:2px solid ${color}55;color:${color};display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;flex-shrink:0">${(name||'?').charAt(0).toUpperCase()}</div>
    <div style="min-width:0">
      <div style="font-size:14px;font-weight:700">${escapeHtml(name||peerId)}</div>
      <div style="font-size:10px;font-family:var(--mono);color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(peerId)}</div>
    </div>
    <div style="margin-left:auto;display:flex;gap:6px;flex-shrink:0">
      <button class="btn btn-secondary" style="font-size:11px;padding:4px 12px;display:flex;align-items:center;gap:5px" onclick="window._gmDMCall('${peerId}')">📞 Call</button>
      <button class="btn btn-secondary" style="font-size:11px;padding:4px 10px" onclick="window._gmShowPeerProfile('${peerId}','${safeN}')">👤 Profile</button>
    </div>`;
  container.appendChild(hdr);

  // Messages
  const thread = (state.dms?.[peerId] || []);
  if (!thread.length) {
    const empty = document.createElement('div');
    empty.style.cssText = 'flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;color:var(--text-muted);padding:40px;text-align:center';
    empty.innerHTML = `<div style="font-size:36px;border-radius:50%;width:64px;height:64px;display:flex;align-items:center;justify-content:center;background:${color}20;border:2px solid ${color}44;color:${color};font-weight:700">${(name||'?').charAt(0).toUpperCase()}</div>
      <div style="font-size:14px;font-weight:600;color:var(--text-secondary)">${escapeHtml(name||peerId)}</div>
      <div style="font-size:13px;max-width:260px;line-height:1.6">This is the beginning of your direct message history. Files, markdown, and replies all work here.</div>`;
    container.appendChild(empty);
  } else {
    for (const m of thread) renderMessage(m, false);
  }

  import('./ui.js').then(ui => ui.scrollToBottom());
}

// ─── PRESENCE SCAN ──────────────────────────────────────────────────────────
// Probes all friends that don't currently have an open peerConn.
// Uses connectTo so existing connections are reused and handshakes fire,
// updating the sidebar online dots shortly after the view opens.
function _scanFriendPresence() {
  const friends = Object.keys(state.friends || {});
  let anyPending = false;
  for (const pid of friends) {
    if (pid === state.myId) continue;
    if (state.peerConns[pid]?.conn?.open) continue; // already connected — dot already green
    anyPending = true;
    // Short-circuit: if we get no response in 3 s the peer is offline; don't
    // wait for the full CONN_TIMEOUT (20 s) before updating the dots.
    const probeTimer = setTimeout(() => {
      if (state.activeFriendsView) { renderFriendsSidebar(); renderFriendsGrid(); }
    }, 3000);
    state.cb.connectTo?.(pid,
      () => { clearTimeout(probeTimer); if (state.activeFriendsView) { renderFriendsSidebar(); renderFriendsGrid(); } },
      () => { clearTimeout(probeTimer); if (state.activeFriendsView) { renderFriendsSidebar(); renderFriendsGrid(); } }
    );
  }
  // If all friends already connected, re-render immediately so dots reflect live state
  if (!anyPending) { renderFriendsSidebar(); renderFriendsGrid(); }
}

// ─── DIRECT DM CALL ──────────────────────────────────────────────────────────
// A self-contained P2P call that doesn't need a shared room.
// Uses the existing video signalling infrastructure (video_offer/answer/ice)
// but runs over the direct peerConn instead of a room tree.
// State lives in state.dmCall = { peerId, peerName, active, localStream }

export function startDMCall(peerId) {
  if (!peerId || peerId === state.myId) return;
  const name = _peerDisplayName(peerId);

  // Ensure we have an open connection first
  const ex = state.peerConns[peerId];
  if (ex?.conn?.open) {
    _initiateDMCall(peerId, name, ex.conn);
  } else {
    toast('Connecting to ' + name + '…', 'info');
    state.cb.connectTo?.(peerId,
      conn => _initiateDMCall(peerId, name, conn),
      () => toast('Could not reach ' + name, 'error')
    );
  }
}

function _initiateDMCall(peerId, name, conn) {
  state.dmCall = { peerId, peerName: name, active: true, initiator: true };
  // Signal the peer via a dm_call_invite packet
  try {
    conn.send({ type: 'dm_call_invite', from: state.myId, fromName: state.myName });
  } catch { toast('Could not start call', 'error'); return; }
  openDMCallView(peerId, name);
  // Start local audio/video via voice.js helpers
  import('./voice.js').then(v => v.startDMCallAudio(peerId));
}

export function handleDMCallInvite(data, conn) {
  const from = data.from || conn.peer;
  if (!from || isBlocked(from)) return;
  const fromName = data.fromName || _peerDisplayName(from);
  // Show an incoming call notification in the DM thread
  _showIncomingCallBanner(from, fromName, conn);
}

export function handleDMCallAccept(data, conn) {
  const from = data.from || conn.peer;
  if (!state.dmCall || state.dmCall.peerId !== from) return;
  state.dmCall.active     = true;
  state.dmCall.peerJoined = true;   // un-grays the recipient avatar in the call view
  toast('Call connected', 'success');
  openDMCallView(from, _peerDisplayName(from));
  import('./voice.js').then(v => v.startDMCallAudio(from));
}

export function handleDMCallEnd(data, conn) {
  const from = data.from || conn.peer;
  if (state.dmCall?.peerId !== from && state.dmCall?.peerId !== state.myId) return;
  import('./voice.js').then(v => v.stopDMCallAudio());
  state.dmCall = null;
  // Close call view and restore DM thread
  import('./ui.js').then(ui => ui.closeDMCallView());
  toast('Call ended', 'info');
}

function _showIncomingCallBanner(fromPid, fromName, conn) {
  let banner = document.getElementById('dm-call-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'dm-call-banner';
    banner.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);z-index:300;background:var(--bg-raised);border:1px solid var(--border-accent);border-radius:var(--radius-lg);padding:14px 20px;box-shadow:var(--shadow);display:flex;align-items:center;gap:14px;min-width:280px;animation:slide-up .2s ease';
    document.body.appendChild(banner);
  }
  const color = stringToColor(fromPid);
  banner.innerHTML = `
    <div style="width:38px;height:38px;border-radius:50%;background:${color}22;border:2px solid ${color}55;color:${color};display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;flex-shrink:0;animation:vc-pulse 1.2s ease-in-out infinite">${(fromName||'?').charAt(0).toUpperCase()}</div>
    <div style="flex:1;min-width:0">
      <div style="font-size:13px;font-weight:700">${escapeHtml(fromName)}</div>
      <div style="font-size:11px;color:var(--text-muted)">Incoming call…</div>
    </div>
    <button class="btn btn-primary" style="padding:6px 14px;font-size:12px;background:var(--green);border:none" onclick="window._gmAcceptDMCall('${fromPid}','${(fromName).replace(/'/g,"\\'")}')">
      📞 Accept
    </button>
    <button class="btn btn-secondary" style="padding:6px 10px;font-size:12px" onclick="window._gmDeclineDMCall('${fromPid}')">
      ✕
    </button>`;
}

export function openDMCallView(peerId, peerName) {
  import('./ui.js').then(ui => ui.openDMCallViewUI(peerId, peerName || _peerDisplayName(peerId)));
}

// ─── RENDER FRIEND REQUEST MESSAGE ──────────────────────────────────────────
// Called by renderMessage when msg.type === 'friend_request_msg'
export function renderFriendRequestMsg(msg) {
  const C = document.getElementById('messages'); if (!C) return;
  const d = document.createElement('div');
  d.id = 'msg-' + msg.id;
  d.style.cssText = 'display:flex;flex-direction:column;align-items:center;gap:8px;padding:14px;margin:8px 14px;background:var(--bg-raised);border:1px solid var(--border-accent);border-radius:var(--radius);';
  const color = stringToColor(msg.authorId || '');
  d.innerHTML = `
    <div style="font-size:13px;font-weight:500">${msg.content}</div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-primary" style="font-size:12px;padding:5px 14px" onclick="window._gmAcceptFriendReq('${msg.fromPid}','${msg.reqId}')">✓ Accept</button>
      <button class="btn btn-secondary" style="font-size:12px;padding:5px 14px" onclick="window._gmDeclineFriendReq('${msg.fromPid}','${msg.reqId}')">✕ Decline</button>
    </div>`;
  C.appendChild(d);
  import('./ui.js').then(ui => ui.scrollToBottom());
}

// ─── BADGE ────────────────────────────────────────────────────────────────────
export function renderFriendsBadge() {
  const badge = document.getElementById('friends-rail-badge');
  if (!badge) return;
  const total = Object.values(state.dmUnread || {}).reduce((a, b) => a + b, 0);
  badge.textContent   = total > 0 ? (total > 99 ? '99+' : String(total)) : '';
  badge.style.display = total > 0 ? '' : 'none';
}

// ─── PEER PROFILE POPUP ───────────────────────────────────────────────────────
export function showPeerProfile(peerId, name) {
  if (!peerId || peerId === state.myId) return;
  const peerName = name || state.friends?.[peerId]?.name || peerId;
  const fri   = isFriend(peerId);
  const blk   = isBlocked(peerId);
  const color = stringToColor(peerId);
  const safeN = peerName.replace(/'/g, "\\'");

  let el = document.getElementById('peer-profile-popup');
  if (!el) {
    el = document.createElement('div');
    el.id = 'peer-profile-popup';
    el.className = 'modal-overlay hidden';
    document.body.appendChild(el);
  }

  el.innerHTML = `<div class="modal" style="max-width:300px;padding:20px;position:relative" onclick="event.stopPropagation()">
    <button onclick="window._gmClosePeerProfile()" style="position:absolute;top:12px;right:12px;background:none;border:none;cursor:pointer;color:var(--text-muted);font-size:16px;padding:3px 7px;border-radius:4px">✕</button>
    <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px">
      <div style="width:48px;height:48px;border-radius:50%;background:${color}22;border:2px solid ${color}55;color:${color};display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:700;flex-shrink:0">${(peerName||'?').charAt(0).toUpperCase()}</div>
      <div style="min-width:0">
        <div style="font-size:15px;font-weight:700">${escapeHtml(peerName)}</div>
        ${fri && state.friends[peerId]?.nickname ? `<div style="font-size:11px;color:var(--accent);font-family:var(--mono)">aka ${escapeHtml(state.friends[peerId].name)}</div>` : ''}
        <div style="font-size:10px;font-family:var(--mono);color:var(--text-muted);overflow:hidden;text-overflow:ellipsis">${escapeHtml(peerId)}</div>
      </div>
    </div>
    <div style="display:flex;flex-direction:column;gap:7px">
      <button class="pp-action-btn" onclick="window._gmPPMessage('${peerId}','${safeN}')">💬 Message</button>
      ${fri
        ? `<button class="pp-action-btn" onclick="window._gmPPUnfriend('${peerId}','${safeN}')">👤 Unfriend</button>`
        : `<button class="pp-action-btn" onclick="window._gmPPAddFriend('${peerId}','${safeN}')">👤 Add Friend</button>`
      }
      ${fri ? `<button class="pp-action-btn" onclick="window._gmPPSetNickname('${peerId}')">✏️ Set Nickname</button>` : ''}
      ${blk
        ? `<button class="pp-action-btn" onclick="window._gmPPUnblock('${peerId}')">🔓 Unblock</button>`
        : `<button class="pp-action-btn" style="color:var(--red)" onclick="window._gmPPBlock('${peerId}','${safeN}')">🚫 Block</button>`
      }
    </div>
  </div>`;

  el.classList.remove('hidden');
  el.onclick = () => window._gmClosePeerProfile();
}
