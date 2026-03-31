import { SCORE_WINDOW } from './constants.js';
import { state } from './state.js';
import { escapeHtml, stringToColor, formatBytes, copyToClipboard } from './utils.js';
import { genId } from './ids.js';
import { roomIsRoot, totalConnCount } from './state.js';
import { saveStorage } from './storage.js';

// ─── THEME ────────────────────────────────────────────────────────────────────
export function initTheme() {
  applyTheme(localStorage.getItem('gilgamesh_theme') || 'dark', false);
}
export function applyTheme(theme, save = true) {
  state.currentTheme = theme;
  document.documentElement.classList.toggle('dark',  theme === 'dark');
  document.documentElement.classList.toggle('light', theme === 'light');
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = theme === 'dark' ? '☀️' : '🌙';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme === 'dark' ? '#0d0f14' : '#f7f8fc';
  if (save) localStorage.setItem('gilgamesh_theme', theme);
}
export function toggleTheme() { applyTheme(state.currentTheme === 'dark' ? 'light' : 'dark'); }

// ─── STATUS DOT ───────────────────────────────────────────────────────────────
export function setStatus(state_, label) {
  const dot = document.getElementById('status-dot');
  if (dot) dot.className = 'dot ' + state_;
}

// ─── MY INFO ──────────────────────────────────────────────────────────────────
export function updateMyInfo() {
  const avatar = document.getElementById('my-avatar');
  const nameEl = document.getElementById('my-name-display');
  const idEl   = document.getElementById('my-id-display');
  if (avatar) avatar.textContent = (state.myName || '?').charAt(0).toUpperCase();
  if (nameEl) nameEl.textContent = state.myName;
  if (idEl)   idEl.textContent   = state.myId || '—';
}

// ─── TOAST ────────────────────────────────────────────────────────────────────
export function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  const col  = type === 'success' ? 'var(--green)' : type === 'error' ? 'var(--red)' : 'var(--accent)';
  const icon = { success: '✓', error: '✕', info: 'ℹ' }[type] || '•';
  el.innerHTML = `<span style="color:${col}">${icon}</span> ${escapeHtml(msg)}`;
  document.getElementById('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ─── ROOM LISTS ───────────────────────────────────────────────────────────────
export function renderRoomList() {
  const list = document.getElementById('rooms-list');
  const rids = Object.keys(state.rooms);
  if (!rids.length) {
    list.innerHTML = '<div style="padding:8px 14px;font-size:11px;color:var(--text-muted)">No rooms</div>';
    return;
  }
  list.innerHTML = rids.map(rid => {
    const r = state.rooms[rid], unr = totalRoomUnread(rid), isActive = rid === state.activeRoomId;
    const color = stringToColor(rid);
    return `<div class="room-item ${isActive ? 'active' : ''}" onclick="window._gmSwitchRoom('${rid}')" title="${escapeHtml(r.name)}">
      <div class="room-icon" style="background:${color}22;border-color:${color}44;color:${color}">${(r.name||'R').charAt(0).toUpperCase()}</div>
      ${unr && !isActive ? `<div class="room-badge">${unr > 99 ? '99+' : unr}</div>` : ''}
    </div>`;
  }).join('');
}

export function renderRoomGrid() {
  const msgs = document.getElementById('messages'); msgs.innerHTML = '';
  const rids = Object.keys(state.rooms);
  if (!rids.length) {
    msgs.innerHTML = `<div style="flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:14px;color:var(--text-muted);padding:40px;text-align:center">
      <img src="img/logo.svg" width="72" height="72" style="opacity:0.6" alt="GilgaMesh">
      <div style="font-size:15px;font-weight:600;color:var(--text-secondary)">No rooms yet</div>
      <div style="font-size:13px;line-height:1.7">Create a room with <strong>+</strong> in the sidebar,<br>or join one via an invite link.</div>
    </div>`;
    return;
  }
  const grid = document.createElement('div');
  grid.style.cssText = 'display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:12px;padding:16px;align-content:start;';
  for (const rid of rids) {
    const r = state.rooms[rid], unr = totalRoomUnread(rid), color = stringToColor(rid);
    const memberCount = Object.keys(r.peers).length + 1;
    const isRoot = roomIsRoot(rid);
    const card = document.createElement('div');
    card.style.cssText = 'background:var(--bg-raised);border:1px solid var(--border);border-radius:var(--radius);padding:14px;cursor:pointer;position:relative;transition:border-color .15s;';
    card.onmouseenter = () => card.style.borderColor = 'var(--border-accent)';
    card.onmouseleave = () => card.style.borderColor = '';
    card.onclick = () => window._gmSwitchRoom(rid);
    card.innerHTML = `
      <div style="width:40px;height:40px;border-radius:10px;background:${color}22;border:1px solid ${color}44;color:${color};display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:700;margin-bottom:10px">${(r.name||'R').charAt(0).toUpperCase()}</div>
      <div style="font-size:13px;font-weight:600;margin-bottom:3px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escapeHtml(r.name)}</div>
      <div style="font-size:11px;color:var(--text-muted);font-family:var(--mono)">ID: ${rid} · ${memberCount} member${memberCount !== 1 ? 's' : ''} ${isRoot ? '· root' : ''}</div>
      ${unr ? `<div style="position:absolute;top:10px;right:10px;background:var(--red);color:#fff;font-size:10px;font-weight:700;padding:2px 6px;border-radius:10px;min-width:18px;text-align:center">${unr > 99 ? '99+' : unr}</div>` : ''}`;
    grid.appendChild(card);
  }
  msgs.appendChild(grid);
}

function totalRoomUnread(rid) {
  const r = state.rooms[rid]; if (!r) return 0;
  return Object.values(r.unread).reduce((a, b) => a + b, 0);
}

// ─── ROOM SIDEBAR ─────────────────────────────────────────────────────────────
export function renderRoomSidebar() {
  renderRoomList();
  if (!state.activeRoomId) return;
  const r = state.rooms[state.activeRoomId]; if (!r) return;

  document.getElementById('channels-list').innerHTML = r.channels.map(ch => {
    const u = r.unread[ch.id] || 0;
    return `<div class="channel-item ${ch.id === state.activeChannel ? 'active' : ''}" onclick="window._gmSwitchChannel('${ch.id}')">
      <span class="ch-icon">#</span>
      <span class="ch-name">${escapeHtml(ch.name)}</span>
      ${u ? `<span class="unread">${u}</span>` : ''}
    </div>`;
  }).join('');

  const myColor = stringToColor(state.myId || '');
  const isRoot  = roomIsRoot(state.activeRoomId);
  const myEntry = `<div class="peer-item">
    <div class="peer-avatar" style="background:${myColor}20;border-color:${myColor}40;color:${myColor}">
      ${(state.myName || 'M').charAt(0).toUpperCase()}
      <div class="peer-status-dot ${isRoot ? 'server' : 'online'}"></div>
    </div>
    <span class="peer-name">${escapeHtml(state.myName)} (you)</span>
    ${isRoot ? '<span class="peer-role">root</span>' : ''}
  </div>`;

  document.getElementById('peers-list').innerHTML = myEntry + Object.values(r.peers).map(p => {
    const pc    = state.peerConns[p.id];
    const alive = pc?.conn?.open;
    const isParent = p.id === r.parentId;
    const isChild  = r.childIds.includes(p.id);
    const color    = stringToColor(p.id);
    const role     = isParent ? 'parent' : isChild ? 'child' : 'peer';
    return `<div class="peer-item">
      <div class="peer-avatar" style="background:${color}20;border-color:${color}40;color:${color}">
        ${(p.name || 'P').charAt(0).toUpperCase()}
        <div class="peer-status-dot ${isParent ? 'server' : alive ? 'online' : ''}"></div>
      </div>
      <span class="peer-name">${escapeHtml(p.name || p.id)}</span>
      <span class="peer-role">${role}</span>
    </div>`;
  }).join('');
}

export function updateSidebar() {
  if (state.activeRoomId) renderRoomSidebar(); else { renderRoomList(); renderRoomGrid(); }
}

export function updatePeerCount() {
  if (!state.activeRoomId) { document.getElementById('peer-count-text').textContent = ''; return; }
  const r = state.rooms[state.activeRoomId]; if (!r) return;
  const n = Object.keys(r.peers).filter(pid => state.peerConns[pid]?.conn?.open).length;
  document.getElementById('peer-count-text').textContent = (n + 1) + ' members';
}

// ─── MESSAGES ─────────────────────────────────────────────────────────────────
export function renderAllMessages() {
  document.getElementById('messages').innerHTML = '';
  if (!state.activeRoomId) { renderRoomGrid(); return; }
  const r = state.rooms[state.activeRoomId]; if (!r) return;
  (r.messages[state.activeChannel] || []).forEach(m => renderMessage(m, false));
}

export function renderMessage(msg, doScroll = true) {
  if (!msg) return;
  const C = document.getElementById('messages');
  if (msg.type === 'system') {
    const d = document.createElement('div');
    d.className = 'system-msg'; d.textContent = msg.content;
    C.appendChild(d); if (doScroll) scrollToBottom(); return;
  }
  const r         = state.activeRoomId ? state.rooms[state.activeRoomId] : null;
  const isMe      = msg.authorId === state.myId;
  const color     = stringToColor(msg.authorId || '');
  const timeStr   = new Date(msg.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const isRoot_   = r && !r.parentId && msg.authorId === state.myId;
  const isPending = !!msg.pending;

  const last  = C.lastElementChild;
  const sameA = last && last.dataset.authorId === msg.authorId && (msg.ts - parseInt(last.dataset.ts || '0')) < 120000;
  const group = sameA ? last : document.createElement('div');

  if (!sameA) {
    group.className = 'msg-group' + (isPending ? ' msg-pending' : '');
    group.dataset.authorId = msg.authorId;
    group.dataset.ts       = msg.ts;
    const hdr = document.createElement('div'); hdr.className = 'msg-header';
    hdr.innerHTML = `<span class="msg-author" style="color:${color}">${escapeHtml(msg.author || '?')}</span>${isRoot_ ? '<span class="msg-role-badge">root</span>' : ''}<span class="msg-time">${timeStr}</span>${isPending ? '<span class="msg-pending-badge">⏳</span>' : ''}`;
    group.appendChild(hdr);
  }

  const body = document.createElement('div');
  body.className = 'msg-body' + (sameA ? ' continued' : '');
  body.id = 'msg-' + msg.id;
  if (isPending) body.classList.add('msg-pending');

  if (msg.msgType === 'file' && msg.fileShare) {
    const fs   = msg.fileShare;
    const exp  = Date.now() > fs.expires;
    const secs = Math.max(0, Math.ceil((fs.expires - Date.now()) / 1000));
    body.innerHTML = `<div class="file-card">
      <div class="file-icon">📎</div>
      <div class="file-info">
        <div class="file-name">${escapeHtml(fs.filename)}</div>
        <div class="file-meta">${formatBytes(fs.size)}</div>
        <div class="file-timer${exp ? ' expired' : ''}" id="ftimer-${fs.token}">${exp ? 'Expired' : `Expires in ${secs}s`}</div>
      </div>
      <button class="download-btn" id="fdl-${fs.token}" ${exp || isMe ? 'disabled' : ''}
        onclick="window._gmDownloadFile('${fs.token}','${escapeHtml(fs.fromId)}','${escapeHtml(fs.filename)}')"
      >${isMe ? 'Shared' : 'Download'}</button>
    </div>`;
    if (!exp && !isMe) {
      let t = secs;
      const iv = setInterval(() => {
        t--;
        const tel = document.getElementById('ftimer-' + fs.token);
        const btn = document.getElementById('fdl-'    + fs.token);
        if (!tel) { clearInterval(iv); return; }
        if (t <= 0) { clearInterval(iv); tel.textContent = 'Expired'; tel.classList.add('expired'); if (btn) btn.disabled = true; }
        else tel.textContent = `Expires in ${t}s`;
      }, 1000);
    }
  } else {
    const span = document.createElement('span'); span.className = 'msg-text';
    span.innerHTML = renderMentionText(msg.content || '');
    const acts = document.createElement('div'); acts.className = 'msg-actions';
    acts.innerHTML = `<button onclick="window._gmCopyText(this)" data-text="${escapeHtml(msg.content)}">⎘</button>`;
    body.appendChild(span); body.appendChild(acts);
  }

  group.appendChild(body);
  if (!sameA) C.appendChild(group);
  if (doScroll) scrollToBottom();
}

export function scrollToBottom() {
  const c = document.getElementById('messages');
  requestAnimationFrame(() => { c.scrollTop = c.scrollHeight; });
}

// ─── TOPOLOGY SVG ─────────────────────────────────────────────────────────────
export function renderTopology() {
  const svg = document.getElementById('topo-svg'); if (!svg) return;
  const W = 256, H = 180, cx = W / 2, cy = H / 2;
  const rid = state.activeRoomId;
  const r   = rid ? state.rooms[rid] : null;
  const isRoot_ = r ? roomIsRoot(rid) : false;
  const nodeColor = isRoot_ ? '#f5a623' : '#5b6cf9';

  // Collect visible peers: children + parent (backup intentionally excluded per spec)
  const visiblePeers = [];
  if (r) {
    if (r.parentId) visiblePeers.push({ id: r.parentId, role: 'parent', name: r.peers[r.parentId]?.name || r.parentId });
    for (const cid of r.childIds) visiblePeers.push({ id: cid, role: 'child', name: r.peers[cid]?.name || cid });
  }
  const n = visiblePeers.length;

  let html = `<defs>
    <radialGradient id="g0" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="${nodeColor}" stop-opacity="0.22"/>
      <stop offset="100%" stop-color="${nodeColor}" stop-opacity="0"/>
    </radialGradient>
  </defs>`;

  const pos = visiblePeers.map((p, i) => {
    const a  = (i / Math.max(n, 1)) * 2 * Math.PI - Math.PI / 2;
    const rv = Math.min(72, 28 + n * 9);
    return { x: cx + rv * Math.cos(a), y: cy + rv * Math.sin(a), p };
  });

  // Lines
  pos.forEach(({ x, y, p }) => {
    const isParentLine = p.role === 'parent';
    html += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="${isParentLine ? '#f5a623' : '#5b6cf9'}" stroke-width="1" opacity="${isParentLine ? 0.65 : 0.3}"/>`;
  });

  // Center glow
  html += `<circle cx="${cx}" cy="${cy}" r="22" fill="url(#g0)"/>`;

  // Pulse ring if root
  if (isRoot_) {
    html += `<circle cx="${cx}" cy="${cy}" r="14" fill="none" stroke="#f5a623" stroke-width="1.5">
      <animate attributeName="r" values="14;26;14" dur="2.4s" repeatCount="indefinite"/>
      <animate attributeName="opacity" values="0.7;0;0.7" dur="2.4s" repeatCount="indefinite"/>
    </circle>`;
  }

  // Center node
  html += `<circle cx="${cx}" cy="${cy}" r="11" fill="${isRoot_ ? '#f5a62322' : '#5b6cf920'}" stroke="${nodeColor}" stroke-width="1.5"/>`;
  html += `<text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central" fill="${isRoot_ ? '#f5a623' : '#7b8cff'}" font-size="8" font-family="sans-serif" font-weight="700">ME</text>`;

  // Peer nodes
  pos.forEach(({ x, y, p }) => {
    const color = stringToColor(p.id);
    const init  = (p.name || 'P').charAt(0).toUpperCase();
    const isP   = p.role === 'parent';
    if (isP) {
      html += `<circle cx="${x}" cy="${y}" r="12" fill="none" stroke="#f5a623" stroke-width="1">
        <animate attributeName="r" values="12;20;12" dur="2.4s" repeatCount="indefinite"/>
        <animate attributeName="opacity" values="0.6;0;0.6" dur="2.4s" repeatCount="indefinite"/>
      </circle>`;
    }
    html += `<circle cx="${x}" cy="${y}" r="9" fill="${color}20" stroke="${isP ? '#f5a623' : color}" stroke-width="${isP ? 1.5 : 1}"/>`;
    html += `<text x="${x}" y="${y}" text-anchor="middle" dominant-baseline="central" fill="${color}" font-size="7" font-family="sans-serif" font-weight="700">${init}</text>`;
  });

  svg.innerHTML = html;
}

// ─── NETWORK PANEL ────────────────────────────────────────────────────────────
export function updateNetworkPanel() {
  const rid = state.activeRoomId;
  const r   = rid ? state.rooms[rid] : null;
  const badge = document.getElementById('my-role-badge');
  const rt    = document.getElementById('role-text');

  if (!r) {
    badge.className = 'role-badge alone'; rt.textContent = 'No room selected';
    document.getElementById('net-role').textContent = '—';
  } else if (roomIsRoot(rid)) {
    badge.className = 'role-badge server'; rt.textContent = 'Root Node';
    document.getElementById('net-role').textContent = 'Root';
  } else if (r.parentId) {
    badge.className = 'role-badge client'; rt.textContent = 'Connected';
    document.getElementById('net-role').textContent = 'Node';
  } else {
    badge.className = 'role-badge alone'; rt.textContent = 'Searching…';
    document.getElementById('net-role').textContent = 'Searching';
  }

  document.getElementById('net-peers').textContent = r ? Object.keys(r.peers).length : 0;
  document.getElementById('net-my-id').textContent = state.myId || '—';

  // ── FIX: show "Backup Peer: <full-peer-id>" per spec ─────────────────────
  const knownEl = document.getElementById('net-known');
  if (r?.backupId) {
    knownEl.textContent = `Backup Peer: ${r.backupId}`;
    knownEl.title = r.backupId;
  } else {
    knownEl.textContent = r ? Object.keys(r.clusterMap || {}).length : 0;
    knownEl.title = '';
  }

  // Children panel
  updateChildrenPanel(rid, r);
}

function updateChildrenPanel(rid, r) {
  const list = document.getElementById('candidates-list'); if (!list) return;
  if (!r || !r.childIds.length) {
    list.innerHTML = '<div style="font-size:11px;color:var(--text-muted);text-align:center;padding:8px">No children</div>';
    return;
  }
  list.innerHTML = r.childIds.map((pid, i) => {
    const pc    = state.peerConns[pid];
    const alive = pc?.conn?.open;
    const name  = state.peerAliases[pid] || r.peers[pid]?.name || pid;
    const rtt   = pc?.scores?.length ? Math.round(pc.scores.slice(-SCORE_WINDOW).reduce((a,b)=>a+b,0) / pc.scores.length) + 'ms' : '—';
    return `<div class="candidate-item">
      <span class="cand-rank">${i+1}</span>
      <span style="width:8px;height:8px;border-radius:50%;background:${alive ? 'var(--green)' : 'var(--text-muted)'};flex-shrink:0;display:inline-block"></span>
      <span class="cand-name">${escapeHtml(name)}</span>
      <span class="cand-score">${rtt}</span>
    </div>`;
  }).join('');
}

export function updateLatencyDisplay() {
  const all = Object.values(state.peerConns).flatMap(pc => pc.scores.slice(-3));
  if (!all.length) return;
  const el = document.getElementById('net-latency');
  if (el) el.textContent = Math.round(all.reduce((a,b)=>a+b,0) / all.length) + ' ms';
}

// ─── TYPING INDICATOR ─────────────────────────────────────────────────────────
export function updateTypingIndicator() {
  const r   = state.activeRoomId ? state.rooms[state.activeRoomId] : null;
  const tp  = r ? r.typingPeers : {};
  const names = Object.entries(tp)
    .filter(([k, v]) => !k.startsWith('_t_') && typeof v === 'string')
    .map(([, v]) => v);
  const el = document.getElementById('typing-indicator');
  const tx = document.getElementById('typing-text');
  if (!names.length) { el?.classList.add('hidden'); return; }
  el?.classList.remove('hidden');
  if (tx) tx.textContent = names.length === 1
    ? `${names[0]} is typing…`
    : `${names.slice(0, -1).join(', ')} and ${names.at(-1)} are typing…`;
}

// ─── DRAWER CONTROLS ──────────────────────────────────────────────────────────
export function toggleSidebar() {
  state.sidebarOpen = !state.sidebarOpen;
  document.getElementById('sidebar').classList.toggle('open', state.sidebarOpen);
  document.getElementById('sidebar-overlay').classList.toggle('visible', state.sidebarOpen);
}
export function closeSidebar() {
  state.sidebarOpen = false;
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('visible');
}
export function openNetPanel() {
  state.netPanelOpen = true;
  document.getElementById('network-panel-drawer').classList.add('open');
  document.getElementById('netpanel-overlay').classList.add('visible');
  renderTopology();
}
export function closeNetPanel() {
  state.netPanelOpen = false;
  document.getElementById('network-panel-drawer').classList.remove('open');
  document.getElementById('netpanel-overlay').classList.remove('visible');
}

// ─── MODAL HELPERS ────────────────────────────────────────────────────────────
export function closeModal(id) { document.getElementById(id)?.classList.add('hidden'); }

// ─── @MENTION AUTOCOMPLETE ────────────────────────────────────────────────────
export function handleMentionInput(input) {
  const val = input.value, cur = input.selectionStart;
  let atPos = -1;
  for (let i = cur - 1; i >= 0; i--) {
    if (val[i] === '@') { atPos = i; break; }
    if (/\s/.test(val[i])) break;
  }
  if (atPos === -1) { closeMentionPopup(); return; }
  const query   = val.slice(atPos + 1, cur).toLowerCase();
  const members = getRoomMembers();
  const matches = members.filter(m => m.name.toLowerCase().startsWith(query));
  if (!matches.length) { closeMentionPopup(); return; }
  state.mentionState = { active: true, start: atPos, query, selected: 0, matches };
  showMentionPopup(matches);
}

function getRoomMembers() {
  if (!state.activeRoomId || !state.rooms[state.activeRoomId]) return [];
  const r = state.rooms[state.activeRoomId];
  const members = [{ id: state.myId, name: state.myName }];
  for (const p of Object.values(r.peers)) members.push({ id: p.id, name: p.name });
  return members;
}

function showMentionPopup(matches) {
  let popup = document.getElementById('mention-popup');
  if (!popup) {
    popup = document.createElement('div');
    popup.id = 'mention-popup';
    document.getElementById('input-area').appendChild(popup);
  }
  const ms = state.mentionState;
  ms.matches  = matches;
  ms.selected = Math.min(ms.selected, matches.length - 1);
  popup.innerHTML = matches.map((m, i) => {
    const color = stringToColor(m.id);
    const init  = (m.name || '?').charAt(0).toUpperCase();
    return `<div class="mention-item${i === ms.selected ? ' selected' : ''}" data-idx="${i}"
      onmousedown="window._gmSelectMention(${i})">
      <div class="mention-avatar" style="background:${color}22;color:${color};border-color:${color}44">${init}</div>
      <span class="mention-name">${escapeHtml(m.name)}</span>
    </div>`;
  }).join('');
  popup.style.display = 'block';
}

export function moveMentionSelection(dir) {
  const ms = state.mentionState;
  if (!ms.active || !ms.matches?.length) return;
  ms.selected = (ms.selected + dir + ms.matches.length) % ms.matches.length;
  showMentionPopup(ms.matches);
}

export function confirmMention() {
  const ms = state.mentionState;
  if (!ms.active || !ms.matches?.length) return;
  const m = ms.matches[ms.selected]; if (!m) return;
  const input  = document.getElementById('msg-input');
  const before = input.value.slice(0, ms.start);
  const after  = input.value.slice(ms.start + 1 + ms.query.length);
  input.value  = before + '@' + m.name + '\u00a0' + after;
  const newPos = before.length + m.name.length + 2;
  input.setSelectionRange(newPos, newPos);
  input.focus();
  closeMentionPopup();
  document.getElementById('send-btn').disabled = !input.value.trim() || !state.activeRoomId;
}

export function closeMentionPopup() {
  state.mentionState.active = false;
  const popup = document.getElementById('mention-popup');
  if (popup) popup.style.display = 'none';
}

export function renderMentionText(text) {
  if (!text || !text.includes('@')) return escapeHtml(text);
  const members = getRoomMembers();
  const names   = members.map(m => m.name).filter(Boolean).sort((a, b) => b.length - a.length);
  if (!names.length) return escapeHtml(text);
  const escaped = escapeHtml(text);
  const pattern = new RegExp(
    '@(' + names.map(n => escapeHtml(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')(?=[\\s,!?.\u00a0]|$)',
    'g'
  );
  return escaped.replace(pattern, (match, name) =>
    `<span class="mention${name.toLowerCase() === state.myName.toLowerCase() ? ' mention-me' : ''}">${match}</span>`
  );
}
