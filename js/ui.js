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
    list.innerHTML = '<div style="padding:8px 14px;font-size:11px;color:var(--text-muted);text-align:center">No rooms</div>';
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

  // ── Voice channels ──────────────────────────────────────────────────────
  const vcSection = document.getElementById('voice-channels-list');
  if (vcSection) {
    const myVcId = r.myVoiceChannelId || null;
    vcSection.innerHTML = (r.voiceChannels || []).map(vc => {
      const activeSpeakers = r.activeSpeakers || {};
      const allParticipants = [
        ...(myVcId === vc.id ? [{ id: state.myId, name: state.myName, isSelf: true }] : []),
        ...Object.entries(r.clusterMap)
          .filter(([pid, e]) => e.voiceChannelId === vc.id && pid !== state.myId)
          .map(([pid, e]) => ({ id: pid, name: e.name || pid, isSelf: false })),
      ];
      const inChannel = myVcId === vc.id;
      const participantRows = allParticipants.map(p => {
        const speaking = !!activeSpeakers[p.id];
        const color    = stringToColor(p.id);
        return `<div class="vc-participant${speaking ? ' vc-speaking' : ''}" id="vc-peer-${vc.id}-${p.id}">
          <div class="vc-peer-avatar${speaking ? ' vc-speaking-glow' : ''}" style="background:${color}22;border-color:${color}${speaking ? '' : '44'};color:${color}">
            ${(p.name||'?').charAt(0).toUpperCase()}
          </div>
          <span class="vc-peer-name">${escapeHtml(p.name)}${p.isSelf ? ' (you)' : ''}</span>
          ${speaking ? '<span class="vc-speaking-dot"></span>' : ''}
        </div>`;
      }).join('');

      // Click behaviour:
      //  - Not in channel → join on click
      //  - In channel → toggle full call view on click; controls shown inline
      const clickHandler = inChannel
        ? `window._gmToggleCallView('${state.activeRoomId}','${vc.id}')`
        : `window._gmJoinVoice('${state.activeRoomId}','${vc.id}')`;

      return `<div class="channel-item voice-channel-item ${inChannel ? 'active' : ''}" id="vc-item-${vc.id}" onclick="${clickHandler}" title="${inChannel ? 'Click to open call view' : 'Click to join voice'}">
        <span class="ch-icon">🔊</span>
        <span class="ch-name" style="flex:1">${escapeHtml(vc.name)}</span>
        ${inChannel
          ? `<span style="display:flex;gap:3px;align-items:center" onclick="event.stopPropagation()">
               <button class="vc-mute-btn icon-btn-xs" id="vc-mute-${vc.id}" onclick="window._gmToggleMute('${state.activeRoomId}')" title="Mute/Unmute">🎤</button>
               <button class="vc-deafen-btn icon-btn-xs" id="vc-deafen-${vc.id}" onclick="window._gmToggleDeafen('${state.activeRoomId}')" title="Deafen/Undeafen">🔊</button>
               <button class="icon-btn-xs" style="color:var(--red)" onclick="window._gmLeaveVoice('${state.activeRoomId}')" title="Leave voice">✕</button>
             </span>`
          : `<span class="vc-join-hint" style="font-size:10px;color:var(--text-muted);opacity:0">${allParticipants.length ? allParticipants.length + ' in call' : 'empty'}</span>`
        }
      </div>
      ${allParticipants.length ? `<div class="vc-participants-list">${participantRows}</div>` : ''}`;
    }).join('');

    // Update mute/deafen button states after render
    if (myVcId) {
      import('./voice.js').then(v => {
        const muted    = v.isMuted();
        const deafened = v.isDeafened();
        const muteBtn   = document.getElementById('vc-mute-'   + myVcId);
        const deafenBtn = document.getElementById('vc-deafen-' + myVcId);
        if (muteBtn)   muteBtn.textContent   = muted    ? '🔇' : '🎤';
        if (deafenBtn) deafenBtn.textContent = deafened ? '🔕' : '🔊';
      });
    }
  }

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

  document.getElementById('peers-list').innerHTML = myEntry + Object.values(r.peers).sort((a, b) => {
    const aOnline = !!(state.peerConns[a.id]?.conn?.open);
    const bOnline = !!(state.peerConns[b.id]?.conn?.open);
    if (aOnline !== bOnline) return bOnline ? 1 : -1; // online first
    return (a.name || a.id).localeCompare(b.name || b.id);
  }).map(p => {
    const pc        = state.peerConns[p.id];
    const alive     = !!(pc?.conn?.open);
    const checking  = state.peerChecking.has(p.id);
    const isParent  = p.id === r.parentId;
    const isChild   = r.childIds.includes(p.id);
    const color     = stringToColor(p.id);
    const role      = isParent ? 'parent' : isChild ? 'child' : '';
    const dotClass  = checking ? 'searching' : isParent ? 'server' : alive ? 'online' : 'offline';
    return `<div class="peer-item${alive || checking ? '' : ' peer-offline'}">
      <div class="peer-avatar" style="background:${color}20;border-color:${color}${alive || checking ? '40' : '20'};color:${color}${alive || checking ? '' : ';opacity:.5'}">
        ${(p.name || 'P').charAt(0).toUpperCase()}
        <div class="peer-status-dot ${dotClass}"></div>
      </div>
      <span class="peer-name" style="${alive || checking ? '' : 'opacity:.45'}">${escapeHtml(p.name || p.id)}</span>
      ${checking ? '<span class="peer-role" style="color:var(--accent);opacity:.7">checking…</span>' : role ? `<span class="peer-role">${role}</span>` : ''}
    </div>`;
  }).join('');
}

export function updateSidebar() {
  if (state.activeRoomId) renderRoomSidebar(); else { renderRoomList(); renderRoomGrid(); }
}

export function updatePeerCount() {
  if (!state.activeRoomId) { document.getElementById('peer-count-text').textContent = ''; return; }
  const r = state.rooms[state.activeRoomId]; if (!r) return;
  const total  = Object.keys(r.peers).length + 1; // +1 for self
  const online = Object.keys(r.peers).filter(pid => state.peerConns[pid]?.conn?.open).length + 1;
  document.getElementById('peer-count-text').textContent =
    online === total ? `${total} members` : `${online}/${total} online`;
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

  // Known = total nodes in cluster map
  const knownEl = document.getElementById('net-known');
  knownEl.textContent = r ? Object.keys(r.clusterMap || {}).length : 0;
  knownEl.title = '';

  // Backup = separate field for the backup peer ID
  const backupEl = document.getElementById('net-backup');
  if (backupEl) {
    if (r?.backupId) {
      const backupName = r.peers[r.backupId]?.name || r.backupId;
      backupEl.textContent = backupName;
      backupEl.title = r.backupId;
    } else {
      backupEl.textContent = '—';
      backupEl.title = '';
    }
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

export function renderVoicePanel(rid) {
  // Re-render sidebar voice section to reflect mute/deafen state changes
  renderRoomSidebar();
  // If call view is open, refresh it too
  if (document.getElementById('call-view')?.dataset.vcId) {
    const vcId = document.getElementById('call-view').dataset.vcId;
    _refreshCallView(rid, vcId);
  }
}

// ─── CALL VIEW (full-screen call overlay replacing message area) ──────────────
let _callViewRid  = null;
let _callViewVcId = null;

export function openCallView(rid, vcId) {
  _callViewRid  = rid;
  _callViewVcId = vcId;
  const main = document.getElementById('main');

  // Hide chat UI
  document.getElementById('messages').style.display   = 'none';
  document.getElementById('input-area').style.display = 'none';
  const typingRow = document.querySelector('#main > div:has(#typing-indicator)');
  if (typingRow) typingRow.style.display = 'none';

  // Create or reuse call view container
  let cv = document.getElementById('call-view');
  if (!cv) {
    cv = document.createElement('div');
    cv.id = 'call-view';
    main.appendChild(cv);
  }
  cv.dataset.vcId = vcId;
  cv.dataset.rid  = rid;
  _refreshCallView(rid, vcId);
}

export function closeCallView() {
  _callViewRid  = null;
  _callViewVcId = null;
  const cv = document.getElementById('call-view');
  if (cv) cv.remove();
  document.getElementById('messages').style.display   = '';
  document.getElementById('input-area').style.display = '';
  const typingRow = document.querySelector('#main > div:has(#typing-indicator)');
  if (typingRow) typingRow.style.display = '';
}

function _refreshCallView(rid, vcId) {
  const cv = document.getElementById('call-view'); if (!cv) return;
  const r  = state.rooms[rid]; if (!r) return;
  const vc = r.voiceChannels?.find(v => v.id === vcId);
  const activeSpeakers = r.activeSpeakers || {};

  const allParticipants = [
    ...(r.myVoiceChannelId === vcId ? [{ id: state.myId, name: state.myName, isSelf: true }] : []),
    ...Object.entries(r.clusterMap)
      .filter(([pid, e]) => e.voiceChannelId === vcId && pid !== state.myId)
      .map(([pid, e]) => ({ id: pid, name: e.name || pid, isSelf: false })),
  ];

  import('./voice.js').then(v => {
    const muted    = v.isMuted();
    const deafened = v.isDeafened();

    const tileHtml = allParticipants.map(p => {
      const speaking = !!activeSpeakers[p.id];
      const color    = stringToColor(p.id);
      return `<div class="call-tile${speaking ? ' call-tile-speaking' : ''}" id="calltile-${p.id}"
                   onclick="window._gmExpandTile('${p.id}')" title="Click to expand">
        <div class="call-tile-video-wrap" id="calltile-video-${p.id}">
          <video class="call-tile-video hidden" id="calltile-vid-${p.id}" autoplay playsinline ${p.isSelf ? 'muted' : ''}></video>
          <button class="call-tile-fullscreen hidden" id="calltile-fs-${p.id}"
            onclick="event.stopPropagation();window._gmFullscreenTile('${p.id}')" title="Fullscreen">⛶</button>
          <div class="call-tile-avatar${speaking ? ' vc-speaking-glow' : ''}" id="calltile-avatar-${p.id}"
               style="background:${color}22;border:2px solid ${color}${speaking ? '' : '44'};color:${color}">
            ${(p.name||'?').charAt(0).toUpperCase()}
          </div>
        </div>
        <div class="call-tile-name">${escapeHtml(p.name)}${p.isSelf ? ' (you)' : ''}</div>
      </div>`;
    }).join('');

    cv.innerHTML = `
      <div class="call-view-header">
        <span class="call-view-icon">🔊</span>
        <span class="call-view-title">${escapeHtml(vc?.name || vcId)}</span>
        <span class="call-view-count">${allParticipants.length} participant${allParticipants.length !== 1 ? 's' : ''}</span>
        <button class="call-view-close icon-btn" onclick="window._gmCloseCallView()" title="Back to chat">✕ Close</button>
      </div>
      <div class="call-tiles-grid" id="call-tiles-grid">${tileHtml || '<div class="call-empty">No one else in this channel yet</div>'}</div>
      <div class="call-controls">
        <button class="call-ctrl-btn${muted ? ' active-red' : ''}" id="call-mute-btn"
          onclick="window._gmToggleMute('${rid}');window._gmRefreshCallControls('${rid}','${vcId}')" title="${muted ? 'Unmute' : 'Mute'}">
          ${muted ? '🔇' : '🎤'} ${muted ? 'Unmute' : 'Mute'}
        </button>
        <button class="call-ctrl-btn${deafened ? ' active-red' : ''}" id="call-deafen-btn"
          onclick="window._gmToggleDeafen('${rid}');window._gmRefreshCallControls('${rid}','${vcId}')" title="${deafened ? 'Undeafen' : 'Deafen'}">
          ${deafened ? '🔕' : '🔊'} ${deafened ? 'Undeafen' : 'Deafen'}
        </button>
        <button class="call-ctrl-btn" id="call-cam-btn"
          onclick="window._gmToggleCam('${rid}')" title="Toggle camera">
          📷 Camera
        </button>
        <button class="call-ctrl-btn" id="call-screen-btn"
          onclick="window._gmToggleScreen('${rid}')" title="Share screen">
          🖥️ Share
        </button>
        <button class="call-ctrl-btn danger" onclick="window._gmLeaveVoice('${rid}');window._gmCloseCallView()" title="Leave call">
          📵 Leave
        </button>
      </div>`;

    // Reattach any active video streams to freshly-created DOM elements.
    // Handles the case where a peer was already sharing before local user opened call view.
    import('./voice.js').then(vv => {
      vv.reattachActiveStreams();
      _updateCamButton();
      _updateScreenButton();
      // Restore expanded state if one was active before the refresh
      if (_expandedTileId) {
        const grid2 = document.getElementById('call-tiles-grid');
        if (grid2) {
          grid2.classList.add('has-expanded');
          grid2.querySelectorAll('.call-tile').forEach(t => {
            const isTarget = t.id === `calltile-${_expandedTileId}`;
            t.classList.toggle('call-tile-expanded', isTarget);
            t.classList.toggle('call-tile-dimmed', !isTarget);
          });
        }
      }
    });
  });
}

export function renderVoiceSpeakers(rid) {
  const r = state.rooms[rid]; if (!r) return;
  const activeSpeakers = r.activeSpeakers || {};

  // Update sidebar participant rows
  for (const vc of (r.voiceChannels || [])) {
    const allPids = [
      ...(r.myVoiceChannelId === vc.id ? [state.myId] : []),
      ...Object.keys(r.clusterMap).filter(pid => r.clusterMap[pid]?.voiceChannelId === vc.id && pid !== state.myId),
    ];
    for (const pid of allPids) {
      const row    = document.getElementById(`vc-peer-${vc.id}-${pid}`);
      const avatar = row?.querySelector('.vc-peer-avatar');
      const dot    = row?.querySelector('.vc-speaking-dot');
      const speaking = !!activeSpeakers[pid];
      if (row)    row.classList.toggle('vc-speaking', speaking);
      if (avatar) avatar.classList.toggle('vc-speaking-glow', speaking);
      if (speaking && !dot) {
        const d = document.createElement('span');
        d.className = 'vc-speaking-dot';
        row?.appendChild(d);
      } else if (!speaking && dot) {
        dot.remove();
      }
    }
  }

  // Update call view tiles if open for this room
  const cv = document.getElementById('call-view');
  if (cv && cv.dataset.rid === rid) {
    const vcId = cv.dataset.vcId;
    const allPids = [
      ...(r.myVoiceChannelId === vcId ? [state.myId] : []),
      ...Object.keys(r.clusterMap).filter(pid => r.clusterMap[pid]?.voiceChannelId === vcId && pid !== state.myId),
    ];
    for (const pid of allPids) {
      const tile   = document.getElementById('calltile-' + pid);
      const avatar = tile?.querySelector('.call-tile-avatar');
      const speaking = !!activeSpeakers[pid];
      if (tile)   tile.classList.toggle('call-tile-speaking', speaking);
      if (avatar) avatar.classList.toggle('vc-speaking-glow', speaking);
    }
  }
}

// ─── VIDEO STREAM UI HELPERS ──────────────────────────────────────────────────
let _expandedTileId  = null;
let _localCamActive  = false;
let _localScreenActive = false;

export function setLocalVideoStream(stream, label) {
  const vid = document.getElementById(`calltile-vid-${state.myId}`);
  const av  = document.getElementById(`calltile-avatar-${state.myId}`);
  const fsBtn = document.getElementById(`calltile-fs-${state.myId}`);
  if (vid) { vid.srcObject = stream; vid.classList.remove('hidden'); }
  av?.classList.add('hidden');
  fsBtn?.classList.remove('hidden');
  if (label === 'cam')    _localCamActive    = true;
  if (label === 'screen') _localScreenActive = true;
  _updateCamButton();
  _updateScreenButton();
}

export function clearLocalVideo(label) {
  if (label === 'cam')    _localCamActive    = false;
  if (label === 'screen') _localScreenActive = false;
  if (!_localCamActive && !_localScreenActive) {
    const vid = document.getElementById(`calltile-vid-${state.myId}`);
    const av  = document.getElementById(`calltile-avatar-${state.myId}`);
    const fsBtn = document.getElementById(`calltile-fs-${state.myId}`);
    if (vid) { vid.srcObject = null; vid.classList.add('hidden'); }
    av?.classList.remove('hidden');
    fsBtn?.classList.add('hidden');
  }
  _updateCamButton();
  _updateScreenButton();
}

export function setRemoteVideoTrack(peerId, stream) {
  const vid = document.getElementById(`calltile-vid-${peerId}`);
  const av  = document.getElementById(`calltile-avatar-${peerId}`);
  const fsBtn = document.getElementById(`calltile-fs-${peerId}`);
  if (vid) { vid.srcObject = stream; vid.classList.remove('hidden'); }
  av?.classList.add('hidden');
  fsBtn?.classList.remove('hidden');
}

export function clearRemoteVideo(peerId) {
  const vid = document.getElementById(`calltile-vid-${peerId}`);
  const av  = document.getElementById(`calltile-avatar-${peerId}`);
  const fsBtn = document.getElementById(`calltile-fs-${peerId}`);
  if (vid) { vid.srcObject = null; vid.classList.add('hidden'); }
  av?.classList.remove('hidden');
  fsBtn?.classList.add('hidden');
}

function _updateCamButton() {
  const btn = document.getElementById('call-cam-btn');
  if (!btn) return;
  btn.classList.toggle('active-red', _localCamActive);
  btn.textContent = _localCamActive ? '📷 Cam off' : '📷 Camera';
}

function _updateScreenButton() {
  const btn = document.getElementById('call-screen-btn');
  if (!btn) return;
  btn.classList.toggle('active-red', _localScreenActive);
  btn.textContent = _localScreenActive ? '🖥️ Stop share' : '🖥️ Share';
}

export function fullscreenTile(peerId) {
  const vid = document.getElementById(`calltile-vid-${peerId}`);
  if (!vid || vid.classList.contains('hidden')) return;
  if (vid.requestFullscreen) vid.requestFullscreen();
  else if (vid.webkitRequestFullscreen) vid.webkitRequestFullscreen();
}

export function expandCallTile(peerId) {
  const grid = document.getElementById('call-tiles-grid'); if (!grid) return;
  if (_expandedTileId === peerId) {
    // Collapse
    _expandedTileId = null;
    grid.classList.remove('has-expanded');
    grid.querySelectorAll('.call-tile').forEach(t => {
      t.classList.remove('call-tile-expanded', 'call-tile-dimmed');
    });
  } else {
    _expandedTileId = peerId;
    grid.classList.add('has-expanded');
    grid.querySelectorAll('.call-tile').forEach(t => {
      const isTarget = t.id === `calltile-${peerId}`;
      t.classList.toggle('call-tile-expanded', isTarget);
      t.classList.toggle('call-tile-dimmed', !isTarget);
    });
  }
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
  // On mobile the room-rail is hidden behind the sidebar — slide both together
  if (window.innerWidth <= 700) {
    document.getElementById('room-rail').classList.toggle('open', state.sidebarOpen);
  }
}
export function closeSidebar() {
  state.sidebarOpen = false;
  document.getElementById('sidebar').classList.remove('open');
  document.getElementById('sidebar-overlay').classList.remove('visible');
  document.getElementById('room-rail').classList.remove('open');
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
