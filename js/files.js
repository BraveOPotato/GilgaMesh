import { FILE_LINK_TTL } from './constants.js';
import { state } from './state.js';
import { genId } from './ids.js';
import { displayMessage } from './messaging.js';
import { toast } from './ui.js';
import { formatBytes } from './utils.js';

// ─── TRIGGER FILE SHARE UI ────────────────────────────────────────────────────
export function triggerFileShare() {
  if (!state.activeRoomId && !state.activeDMPeer) return;
  document.getElementById('file-share-link-area').classList.add('hidden');
  document.getElementById('file-share-content').classList.remove('hidden');
  document.getElementById('file-share-modal').classList.remove('hidden');

  const input    = document.getElementById('file-modal-input');
  const dropzone = document.getElementById('file-dropzone');
  input.value = '';
  input.onchange = e => { const f = e.target.files[0]; if (f) prepareFileShare(f); };
  dropzone.onclick     = () => input.click();
  dropzone.ondragover  = e => { e.preventDefault(); dropzone.style.borderColor = 'var(--accent)'; };
  dropzone.ondragleave = () => { dropzone.style.borderColor = ''; };
  dropzone.ondrop      = e => {
    e.preventDefault(); dropzone.style.borderColor = '';
    if (e.dataTransfer.files[0]) prepareFileShare(e.dataTransfer.files[0]);
  };
}

function prepareFileShare(file) {
  const token   = genId();
  const expires = Date.now() + FILE_LINK_TTL;
  state.fileShares[token] = { file, expires, filename: file.name, size: file.size, mime: file.type || 'application/octet-stream' };

  const base     = location.href.split('?')[0];
  const shareUrl = `${base}?share=${token}&from=${encodeURIComponent(state.myId)}&name=${encodeURIComponent(file.name)}&size=${file.size}`;

  document.getElementById('file-share-content').classList.add('hidden');
  document.getElementById('file-share-link-area').classList.remove('hidden');
  document.getElementById('share-filename').textContent  = `📎 ${file.name} (${formatBytes(file.size)})`;
  document.getElementById('share-link-text').textContent = shareUrl;

  let rem = 60;
  const countEl = document.getElementById('share-countdown');
  const iv = setInterval(() => {
    rem--;
    if (rem <= 0) {
      clearInterval(iv);
      delete state.fileShares[token];
      countEl.textContent = 'expired';
      countEl.style.color = 'var(--red)';
    } else {
      countEl.textContent = rem + 's';
    }
  }, 1000);

  // ── DM context ───────────────────────────────────────────────────────────
  if (state.activeDMPeer && !state.activeRoomId) {
    const peerId = state.activeDMPeer;
    const msgId  = genId();
    // Local stored format matches what renderMessage expects
    const localMsg = {
      id: msgId, type: 'chat',
      author: state.myName, authorId: state.myId,
      content: null, ts: Date.now(), channel: 'dm',
      msgType: 'file',
      fileShare: { token, fromId: state.myId, fromName: state.myName, filename: file.name, size: file.size, expires },
    };
    if (!state.dms) state.dms = {};
    if (!state.dms[peerId]) state.dms[peerId] = [];
    state.dms[peerId].push(localMsg);
    import('./friends.js').then(f => {
      f.saveFriendsData?.();
      if (state.activeDMPeer === peerId) { import('./ui.js').then(ui => { ui.renderMessage(localMsg); ui.scrollToBottom(); }); }
    });
    // Wire packet — uses type:'dm' so the receiver's handleIncomingDM fires.
    // Include msgType + fileShare so the receiver reconstructs the file card.
    const wireMsg = {
      type: 'dm', id: msgId,
      from: state.myId, fromName: state.myName,
      content: null, ts: localMsg.ts,
      msgType: 'file',
      fileShare: localMsg.fileShare,
    };
    const ex = state.peerConns[peerId];
    const send = conn => { try { conn.send(wireMsg); } catch { toast('Send failed', 'error'); } };
    if (ex?.conn?.open) send(ex.conn);
    else state.cb.connectTo?.(peerId, send, () => toast('Peer unreachable', 'error'));
    return;
  }

  // ── Room context ─────────────────────────────────────────────────────────
  if (!state.activeRoomId) return;
  const r = state.rooms[state.activeRoomId]; if (!r) return;
  const chatMsg = {
    type: 'message', roomId: state.activeRoomId, id: genId(),
    author: state.myName, authorId: state.myId, content: null,
    channel: state.activeChannel, ts: Date.now(), msgType: 'file',
    fileShare: { token, fromId: state.myId, fromName: state.myName, filename: file.name, size: file.size, expires },
    originId: state.myId,
  };
  displayMessage(state.activeRoomId, chatMsg);
  // Propagate the file-share message up/down the tree
  if (r.parentConn?.open) {
    try { r.parentConn.send({ type: 'relay_message', roomId: state.activeRoomId, payload: chatMsg }); } catch {}
  }
  for (const cid of r.childIds) {
    const conn = r.childConns[cid] || state.peerConns[cid]?.conn;
    if (conn?.open) try { conn.send({ type: 'relay_message', roomId: state.activeRoomId, payload: chatMsg }); } catch {}
  }
}

// ─── DOWNLOAD ─────────────────────────────────────────────────────────────────
export function downloadFile(token, fromId, filename) {
  if (!fromId || !token) { toast('Invalid share link', 'error'); return; }
  toast('Connecting for file transfer…', 'info');

  const conn = state.peer.connect(fromId, { reliable: true, serialization: 'json', label: 'file:' + token });
  let b64chunks = [], fileMime = 'application/octet-stream', fileFilename = filename;

  const failTimer = setTimeout(() => {
    toast('File transfer timed out', 'error');
    try { conn.close(); } catch {}
  }, 30000);

  conn.on('open', () => conn.send({ type: 'file_request', token, requesterId: state.myId }));
  conn.on('data', msg => {
    if (!msg?.type) return;
    switch (msg.type) {
      case 'file_expired': clearTimeout(failTimer); toast('Link expired', 'error'); conn.close(); break;
      case 'file_error':   clearTimeout(failTimer); toast('Transfer error: ' + (msg.reason || '?'), 'error'); conn.close(); break;
      case 'file_meta':    fileFilename = msg.filename || filename; fileMime = msg.mime || 'application/octet-stream'; toast(`Receiving ${fileFilename} (${formatBytes(msg.size)})…`, 'info'); break;
      case 'file_chunk':   b64chunks.push(msg.data); break;
      case 'file_done':
        clearTimeout(failTimer);
        try {
          const bin = atob(b64chunks.join(''));
          const buf = new Uint8Array(bin.length);
          for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
          const blob = new Blob([buf], { type: fileMime });
          const url  = URL.createObjectURL(blob);
          const a    = document.createElement('a'); a.href = url; a.download = fileFilename;
          document.body.appendChild(a); a.click();
          setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
          toast(`Downloaded ${fileFilename}!`, 'success');
        } catch(e) { toast('Decode error: ' + e.message, 'error'); }
        conn.close();
        break;
    }
  });
  conn.on('error', () => { clearTimeout(failTimer); toast('File connection failed', 'error'); });
}

export function sendFileOverConn(conn, token) {
  const share = state.fileShares[token];
  if (!share || Date.now() > share.expires) { conn.send({ type: 'file_expired' }); conn.close(); return; }
  conn.send({ type: 'file_meta', filename: share.filename, size: share.size, mime: share.mime });
  const CHUNK = 48 * 1024; let offset = 0;
  const next = () => {
    if (!conn.open) return;
    if (offset >= share.file.size) { conn.send({ type: 'file_done' }); return; }
    const fr = new FileReader();
    fr.onload = e => {
      if (!conn.open) return;
      const bytes = new Uint8Array(e.target.result); let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      try { conn.send({ type: 'file_chunk', data: btoa(bin) }); offset += CHUNK; setTimeout(next, 0); }
      catch(err) { conn.send({ type: 'file_error', reason: err.message }); }
    };
    fr.readAsArrayBuffer(share.file.slice(offset, offset + CHUNK));
  };
  next();
}

export function checkShareUrl() {
  const p = new URLSearchParams(location.search);
  const token = p.get('share'), fromId = p.get('from'), name = p.get('name') || 'file', size = parseInt(p.get('size') || '0');
  if (token && fromId) {
    history.replaceState({}, '', location.pathname);
    const attempt = () => {
      if (!state.peer?.open || !state.myId) { setTimeout(attempt, 500); return; }
      if (confirm(`Download "${name}" (${formatBytes(size)}) from a peer?\nDirect P2P transfer.`)) {
        downloadFile(token, fromId, name);
      }
    };
    setTimeout(attempt, 1000);
  }
}
