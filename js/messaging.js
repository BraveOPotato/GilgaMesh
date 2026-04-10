/**
 * messaging.js — Message flow in the tree topology
 *
 * Propagation:
 *   - A leaf node sends a message UP to its parent.
 *   - Each intermediate node that receives a message:
 *       1. Checks its seenMsgIds cache — drop if duplicate
 *       2. Delivers to its own UI
 *       3. Propagates UP to parent (if not already from parent)
 *       4. Propagates DOWN to all children except the sender
 *       5. Also sends to backup peer
 *   - Root receives, delivers, broadcasts down to all children + backup.
 *   - Root sends `msg_ack` back to the originating peer when it receives a message.
 *
 * Pending: messages from non-root nodes are shown grayed until `msg_ack` from
 * the root (or until we become root).
 */

import { MSG_CACHE_SIZE } from './constants.js';
import { state } from './state.js';
import { genId } from './ids.js';
import { renderMessage, scrollToBottom, renderRoomSidebar, renderRoomList, toast } from './ui.js';
import { escapeHtml } from './utils.js';

// ─── SEND ─────────────────────────────────────────────────────────────────────
export function sendMessage() {
  const input = document.getElementById('msg-input');
  const text  = input.value.trim();
  if (!text || !state.activeRoomId) return;
  const r = state.rooms[state.activeRoomId]; if (!r) return;

  const msg = {
    type:     'message',
    roomId:   state.activeRoomId,
    id:       genId(),
    author:   state.myName,
    authorId: state.myId,
    content:  text,
    channel:  state.activeChannel,
    ts:       Date.now(),
    originId: state.myId,
    replyTo:  state.replyingTo || undefined,
  };

  input.value = ''; input.style.height = '';
  document.getElementById('send-btn').disabled = true;
  // Clear reply state after capturing it into the message
  if (state.replyingTo) {
    state.replyingTo = null;
    import('./ui.js').then(ui => ui.clearReplyTarget());
  }

  const isRoot = !state.rooms[state.activeRoomId]?.parentId;

  if (isRoot) {
    // Root sends immediately — no pending state
    deliverLocal(state.activeRoomId, msg);
    propagateDown(state.activeRoomId, msg, null);
  } else {
    // Non-root: show as pending, send up
    msg.pending = true;
    r.pendingMsgs.push(msg);
    displayMessage(state.activeRoomId, msg);
    sendUpstream(state.activeRoomId, msg);
    propagateDown(state.activeRoomId, msg, state.myId);
  }
}

// ─── RECEIVE / RELAY ──────────────────────────────────────────────────────────
export function handleIncomingMessage(rid, msg, fromPid) {
  const r = state.rooms[rid]; if (!r || !msg) return;

  // Deduplicate
  if (msg.id && r.seenMsgIds.includes(msg.id)) return;
  if (msg.id) {
    r.seenMsgIds.push(msg.id);
    if (r.seenMsgIds.length > MSG_CACHE_SIZE) r.seenMsgIds.shift();
  }

  // Strip the pending flag for BOTH local display and the wire payload.
  // pending:true is only meaningful on the originating node; if it travels
  // in the relay packet every intermediate and root node renders it gray.
  const cleanMsg = msg.pending ? { ...msg, pending: false } : msg;

  // Deliver locally — always un-grayed on non-originating nodes
  deliverLocal(rid, cleanMsg);

  const isRoot = !state.rooms[rid]?.parentId;

  if (isRoot) {
    // Root: broadcast clean copy to all children (except sender)
    propagateDown(rid, cleanMsg, fromPid);
    // Send ack hop-by-hop back toward the origin.
    // We ack the direct sender (fromPid), NOT msg.originId directly — the origin
    // may not be directly connected to us. Each intermediate node receiving
    // a msg_ack forwards it upstream until it reaches the originator.
    if (fromPid && fromPid !== state.myId) {
      const senderConn = r.childConns?.[fromPid] || state.peerConns[fromPid]?.conn;
      if (senderConn?.open) {
        try { senderConn.send({ type: 'msg_ack', roomId: rid, msgId: msg.id, originId: msg.originId }); } catch {}
      }
    }
  } else {
    // Intermediate / leaf: forward clean copy up AND down (except sender)
    if (fromPid !== r.parentId) sendUpstream(rid, cleanMsg);
    propagateDown(rid, cleanMsg, fromPid);
    if (r.backupConn?.open && r.backupId !== fromPid) {
      try { r.backupConn.send({ type: 'relay_message', roomId: rid, payload: cleanMsg }); } catch {}
    }
    // Intermediate node: if this came from a child and we just relayed it up,
    // we'll receive the ack back from the root and must forward it down.
    // That is handled in handleMsgAck below.
  }
}

function sendUpstream(rid, msg) {
  const r = state.rooms[rid]; if (!r) return;
  const conn = r.parentConn;
  if (conn?.open) {
    try { conn.send({ type: 'relay_message', roomId: rid, payload: msg }); } catch {}
  }
}

function propagateDown(rid, msg, excludePid) {
  const r = state.rooms[rid]; if (!r) return;
  const pkt = { type: 'relay_message', roomId: rid, payload: msg };
  for (const cid of r.childIds) {
    if (cid === excludePid) continue;
    const conn = r.childConns[cid] || state.peerConns[cid]?.conn;
    if (conn?.open) try { conn.send(pkt); } catch {}
  }
}

// ─── ACK ──────────────────────────────────────────────────────────────────────
export function handleMsgAck(data) {
  const rid = data.roomId, r = state.rooms[rid]; if (!r) return;

  // If this ack is not for us, forward it downstream toward the origin.
  // The ack travels hop-by-hop: root → intermediate → leaf (origin).
  if (data.originId && data.originId !== state.myId) {
    // Try to find the origin among our children; if found, forward and stop.
    const originConn = r.childConns?.[data.originId] || state.peerConns[data.originId]?.conn;
    if (originConn?.open) {
      try { originConn.send(data); } catch {}
      return;
    }
    // Origin not a direct child — forward to all children and let the right
    // one absorb it (cheap; acks are tiny and infrequent).
    for (const cid of r.childIds) {
      const conn = r.childConns[cid] || state.peerConns[cid]?.conn;
      if (conn?.open) try { conn.send(data); } catch {}
    }
    return;
  }

  // This ack is for us — un-gray the message.
  const idx = r.pendingMsgs.findIndex(m => m.id === data.msgId);
  if (idx === -1) return;
  const [msg] = r.pendingMsgs.splice(idx, 1);
  delete msg.pending;
  const el = document.getElementById('msg-' + data.msgId);
  if (el) {
    el.classList.remove('msg-pending');
    const badge = el.closest('.msg-group')?.querySelector('.msg-pending-badge');
    if (badge) badge.remove();
    const grp = el.closest('.msg-group');
    if (grp) grp.classList.remove('msg-pending');
  }
}

// ─── FLUSH PENDING ────────────────────────────────────────────────────────────
export function flushPendingMessages(rid) {
  const r = state.rooms[rid]; if (!r || !r.pendingMsgs.length) return;
  const queue = r.pendingMsgs.splice(0);
  for (const msg of queue) {
    // Un-gray
    const el = document.getElementById('msg-' + msg.id);
    if (el) el.classList.remove('msg-pending');
    const grp = el?.closest?.('.msg-group');
    if (grp) grp.classList.remove('msg-pending');
    const badge = grp?.querySelector('.msg-pending-badge');
    if (badge) badge.remove();
    delete msg.pending;
    // Re-send
    sendUpstream(rid, msg);
  }
}

// ─── LOCAL DISPLAY ────────────────────────────────────────────────────────────
function deliverLocal(rid, msg) {
  displayMessage(rid, msg);
}

export function displayMessage(rid, msg) {
  const r = state.rooms[rid]; if (!r || !msg || !msg.channel) return;
  if (!r.messages[msg.channel]) r.messages[msg.channel] = [];
  if (msg.id && r.messages[msg.channel].some(m => m.id === msg.id)) return;
  r.messages[msg.channel].push(msg);

  if (rid === state.activeRoomId && msg.channel === state.activeChannel) {
    renderMessage(msg); scrollToBottom();
  } else {
    r.unread[msg.channel] = (r.unread[msg.channel] || 0) + 1;
    if (rid === state.activeRoomId) renderRoomSidebar();
    else renderRoomList();
  }
}

export function addSystemMsg(rid, channel, text) {
  displayMessage(rid, {
    type:'system', content:text, roomId:rid, channel,
    ts:Date.now(), id:genId(), author:'System', authorId:'system'
  });
}

// ─── TYPING ───────────────────────────────────────────────────────────────────
let typingDebounce = null;
export function onTyping() {
  clearTimeout(typingDebounce);
  typingDebounce = setTimeout(() => {
    if (!state.activeRoomId) return;
    const r = state.rooms[state.activeRoomId]; if (!r) return;
    // Each typing packet gets a unique ID so every node can dedup it and
    // never relay the same packet twice, regardless of cluster topology.
    const pkt = {
      type: 'typing', roomId: state.activeRoomId,
      id: state.myId, name: state.myName, channel: state.activeChannel,
      tid: state.myId + ':' + Date.now(), // unique typing-event ID
    };
    if (r.parentConn?.open) try { r.parentConn.send(pkt); } catch {}
    if (!r.parentId) state.cb.sendToAllChildren?.(state.activeRoomId, pkt);
  }, 300);
}

export function handleTyping(rid, data, senderId) {
  const r = state.rooms[rid]; if (!r) return;

  // Dedup by typing-event ID (tid). Without this, in a chain A→B→C:
  // A types → B relays up to C → C fans back down to B → B resets its 4 s
  // timer → B appears permanently typing. The tid lets every node drop a
  // packet it has already seen, cutting all loops regardless of topology.
  if (!r.seenTypingIds) r.seenTypingIds = [];
  if (data.tid) {
    if (r.seenTypingIds.includes(data.tid)) return; // already processed
    r.seenTypingIds.push(data.tid);
    if (r.seenTypingIds.length > 60) r.seenTypingIds.shift();
  }

  // Directional relay: from a child → up only; from parent → down only.
  // Never relay back toward the sender.
  const fromChild  = r.childIds.includes(senderId);
  const fromParent = senderId === r.parentId;

  if (fromChild) {
    // Relay upward toward root
    if (r.parentConn?.open) {
      try { r.parentConn.send(data); } catch {}
    }
    // Also fan down to our OTHER children (siblings of the sender) so every
    // node in the subtree sees the indicator — not just nodes above us.
    state.cb.sendToAllChildren?.(rid, data, senderId);
    // If we are root (no parent), sendToAllChildren above already covers everyone.
  } else if (fromParent) {
    state.cb.sendToAllChildren?.(rid, data);
  }
  // Backup peers don't participate in typing relay.

  // Display locally if viewing this room+channel
  if (rid !== state.activeRoomId || data.channel !== state.activeChannel) return;
  r.typingPeers[senderId] = data.name;
  import('./ui.js').then(ui => ui.updateTypingIndicator());
  clearTimeout(r.typingPeers['_t_' + senderId]);
  r.typingPeers['_t_' + senderId] = setTimeout(() => {
    delete r.typingPeers[senderId];
    delete r.typingPeers['_t_' + senderId];
    if (rid === state.activeRoomId) import('./ui.js').then(ui => ui.updateTypingIndicator());
  }, 4000);
}
