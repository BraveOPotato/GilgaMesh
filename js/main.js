/**
 * main.js — Boots GilgaMesh and routes all incoming messages
 */

import { state } from './state.js';
import { loadStorage, saveStorage, makeRoomShell } from './storage.js';
import { generateRoomId } from './ids.js';
import { startPeer, handlePong, sendHandshake, connectTo } from './peer.js';
import {
  handleAdoptRequest, handleAdoptAck, handleAdoptRedirect, handleAdoptReject,
  handleClusterMap, handleClusterMapRequest,
  handlePeerDisconnect, handleBecomeParent,
  findAndJoinParent, savePeerToRoom, updateClusterMapSelf, broadcastClusterMap,
  addChild, sendToAllChildrenPublic, handleChildList,
  handleParentLost,
  handleDescendantCountRequest, handleDescendantCountResponse,
  handleConnectToMe, handleTopologyRequest, handleReassignParent,
} from './mesh.js';
import { handleElectionStart, handleElectionVote, handleElectionWon, startLocalElection } from './election.js';
import { handleIncomingMessage, handleMsgAck, addSystemMsg, displayMessage, flushPendingMessages, onTyping, handleTyping } from './messaging.js';
import { handleVoiceChannelCreated, handleVoiceData, handleVoiceBinary, handleBecomeMyChild, handleVoiceEvictChildren, handleVoiceRelayPromote } from './voice.js';
import { handleChannelCreated, switchChannel, createRoom, createChannel, joinRoomViaInvite,
         confirmLeaveRoom, leaveRoom, showInvite, copyInviteLink, checkJoinUrl,
         backToRooms, switchRoom, handlePeerLeaving } from './rooms.js';
import { triggerFileShare, downloadFile, checkShareUrl } from './files.js';
import {
  initTheme, toggleTheme, applyTheme,
  toast, setStatus, updateMyInfo, closeModal,
  renderRoomList, renderRoomSidebar, renderRoomGrid, renderAllMessages, scrollToBottom,
  renderTopology, updateNetworkPanel, updatePeerCount, updateLatencyDisplay,
  toggleSidebar, closeSidebar, openNetPanel, closeNetPanel,
  handleMentionInput, moveMentionSelection, confirmMention, closeMentionPopup,
  renderMentionText,
  openCallView, closeCallView,
} from './ui.js';
import { copyToClipboard, escapeHtml } from './utils.js';
import { SCORE_WINDOW } from './constants.js';

// ─── BOOT ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', init);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

function init() {
  initTheme();
  loadStorage();

  state.cb.handleChatData       = handleChatData;
  state.cb.handlePeerDisconnect = handlePeerDisconnect;
  state.cb.connectTo            = connectTo;
  state.cb.sendHandshake        = sendHandshake;
  state.cb.addSystemMsg         = addSystemMsg;
  state.cb.flushPendingMessages = flushPendingMessages;
  state.cb.sendToAllChildren    = sendToAllChildrenPublic;
  state.cb.startLocalElection   = startLocalElection;
  state.cb.toast                = toast;
  state.cb.renderTopology       = renderTopology;
  state.cb.updateNetworkPanel   = updateNetworkPanel;
  state.cb.updateLatencyDisplay = updateLatencyDisplay;
  state.cb.addChild             = addChild;
  state.cb.updateClusterMapSelf = updateClusterMapSelf;
  state.cb.broadcastClusterMap  = broadcastClusterMap;

  setupUI();

  if (!state.myName) {
    document.getElementById('setup-modal').classList.remove('hidden');
    const ni = document.getElementById('setup-name');
    ni.focus();
    ni.addEventListener('keydown', e => { if (e.key === 'Enter') completeSetup(); });
  } else {
    startPeer();
  }
}

// ─── SETUP UI ─────────────────────────────────────────────────────────────────
function setupUI() {
  const input = document.getElementById('msg-input');
  const send  = document.getElementById('send-btn');

  input.addEventListener('input', () => {
    input.style.height = '';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    send.disabled = !input.value.trim() || !state.activeRoomId;
    onTyping();
    handleMentionInput(input);
  });

  input.addEventListener('keydown', e => {
    if (state.mentionState.active) {
      if (e.key === 'ArrowDown') { e.preventDefault(); moveMentionSelection(1);  return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); moveMentionSelection(-1); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); confirmMention(); return; }
      if (e.key === 'Escape')    { e.preventDefault(); closeMentionPopup(); return; }
    }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessageFromUI(); }
  });

  send.addEventListener('click', sendMessageFromUI);
  document.getElementById('sidebar-overlay').addEventListener('click', closeSidebar);
  document.getElementById('netpanel-overlay').addEventListener('click', closeNetPanel);

  input.disabled   = true;
  send.disabled    = true;
  document.getElementById('file-btn').disabled = true;

  renderRoomList();
  renderRoomGrid();
  checkJoinUrl();
}

function sendMessageFromUI() {
  import('./messaging.js').then(m => m.sendMessage());
}

// ─── CENTRAL MESSAGE DISPATCHER ───────────────────────────────────────────────
export function handleChatData(data, conn) {
  if (!data || !data.type) return;
  const pid = conn.peer;
  const rid = data.roomId;

  if (state.peerConns[pid]) state.peerConns[pid].lastSeen = Date.now();

  switch (data.type) {

    // ── Heartbeat ──────────────────────────────────────────────────────────
    case 'ping':
      conn.send({ type: 'pong', ts: data.ts, id: state.myId, roomId: rid });
      break;
    case 'pong':
      handlePong(data, pid);
      break;

    // ── Tree topology ──────────────────────────────────────────────────────
    case 'handshake':
      handleHandshakeMsg(data, conn);
      break;
    case 'cluster_map_request':
      handleClusterMapRequest(data, conn);
      break;
    case 'cluster_map':
      handleClusterMap(data);
      // Only trigger findAndJoinParent from a cluster_map if we are genuinely
      // unplaced AND no join is already in progress (_joiningParent).
      // The new scout-based join (joinRoomViaInvite) calls findAndJoinParent
      // directly after merging the map; this path handles attemptRoomReconnect
      // and any other flow that uses the permanent connectTo path.
      if (rid) {
        const _r = state.rooms[rid];
        if (_r && !_r.parentId && !_r.childIds.length && !_r._joiningParent) {
          console.log(`[main] cluster_map(${rid}) received — triggering findAndJoinParent`);
          findAndJoinParent(rid);
        } else if (_r) {
          console.log(`[main] cluster_map(${rid}) received — skipping findAndJoinParent (parent=${_r.parentId}, children=${_r.childIds.length}, joining=${_r._joiningParent})`);
        }
      }
      break;
    case 'adopt_request':
      handleAdoptRequest(data, conn);
      break;
    case 'adopt_ack':
      handleAdoptAck(data, conn);
      break;
    case 'adopt_redirect':
      handleAdoptRedirect(data);
      break;
    case 'adopt_reject':
      handleAdoptReject(data);
      break;
    case 'become_parent':
      handleBecomeParent(data);
      break;
    case 'child_list':
      handleChildList(data);
      break;
    case 'child_count_update':
      if (rid && state.rooms[rid]) {
        const r = state.rooms[rid];
        if (r.clusterMap[pid]) {
          r.clusterMap[pid].connCount       = data.count;
          r.clusterMap[pid].childCount      = data.childCount ?? data.count;
          r.clusterMap[pid].descendantCount = data.descendantCount;
        }
        // Bubble the update up toward the root so the entire tree has
        // accurate childCount data for every node — this is what lets
        // the root correctly redirect newcomers to the right layer.
        if (r.parentConn?.open) {
          try { r.parentConn.send(data); } catch {}
        }
      }
      break;

    // ── Failover / Recovery ────────────────────────────────────────────────
    case 'parent_lost':
      handleParentLost(data);
      break;
    case 'descendant_count_request':
      handleDescendantCountRequest(data, conn);
      break;
    case 'descendant_count_response':
      handleDescendantCountResponse(data);
      break;
    case 'connect_to_me':
      handleConnectToMe(data);
      break;
    case 'topology_request':
      handleTopologyRequest(data, conn);
      break;
    case 'reassign_parent':
      handleReassignParent(data);
      break;

    // ── Election ───────────────────────────────────────────────────────────
    case 'election_start':
      handleElectionStart(data, conn);
      break;
    case 'election_vote':
      handleElectionVote(data);
      break;
    case 'election_won':
      handleElectionWon(data, conn);
      break;

    // ── Messaging ──────────────────────────────────────────────────────────
    case 'relay_message':
      if (rid && data.payload) handleIncomingMessage(rid, data.payload, pid);
      break;
    case 'msg_ack':
      handleMsgAck(data);
      break;
    case 'typing':
      if (rid) handleTyping(rid, data, pid);
      break;

    // ── Room / channel ─────────────────────────────────────────────────────
    case 'channel_created':
      if (rid) handleChannelCreated(rid, data);
      break;
    case 'peer_leaving':
      handlePeerLeaving(data);
      break;

    // ── Voice ──────────────────────────────────────────────────────────────
    case 'voice_channel_created':
      if (rid) handleVoiceChannelCreated(rid, data);
      break;
    case 'voice_data':
      if (rid) handleVoiceData(data, conn);
      break;
    case 'become_my_child':
      if (rid) handleBecomeMyChild(data, conn);
      break;
    case 'voice_evict_children':
      if (rid) handleVoiceEvictChildren(data);
      break;
    case 'voice_relay_promote':
      if (rid) handleVoiceRelayPromote(data);
      break;
  }
}

// ─── HANDSHAKE HANDLER ────────────────────────────────────────────────────────
function handleHandshakeMsg(data, conn) {
  const rid = data.roomId, pid = conn.peer;
  if (!rid || !state.rooms[rid]) return;
  const r = state.rooms[rid];

  // A peer is "new" only if we had no prior record of them at all —
  // returning members loaded from storage already have an entry in r.peers.
  const isNew = !r.peers[pid];
  const nameChanged = r.peers[pid] && r.peers[pid].name !== (state.peerAliases[pid] || data.name || pid);
  r.peers[pid] = r.peers[pid] || {};
  r.peers[pid].id   = pid;
  r.peers[pid].name = state.peerAliases[pid] || data.name || pid;

  if (state.peerConns[pid]) state.peerConns[pid].rooms.add(rid);
  savePeerToRoom(rid, pid);

  if (data.distanceFromRoot !== undefined) {
    r.clusterMap[pid] = {
      name:            data.name || pid,
      distance:        data.distanceFromRoot,
      connCount:       data.childCount || 0,
      childCount:      data.childCount || 0,
      descendantCount: data.descendantCount || 0,
      voiceChannelId:  data.voiceChannelId || null,
    };
  }

  if (data.electionEpoch && data.electionEpoch > r.electionEpoch) {
    r.electionEpoch = data.electionEpoch;
  }

  updateClusterMapSelf(rid);
  saveStorage(); // persist updated name immediately

  if (rid === state.activeRoomId) {
    renderRoomSidebar();
    updatePeerCount();
    updateNetworkPanel();
  }

  if (isNew) addSystemMsg(rid, 'general', `${r.peers[pid].name} joined`);
}

// ─── MODALS / SETTINGS ────────────────────────────────────────────────────────
function completeSetup() {
  const name = document.getElementById('setup-name').value.trim();
  if (!name) { toast('Enter a display name', 'error'); return; }
  state.myName = name;
  saveStorage();
  closeModal('setup-modal');
  updateMyInfo();
  startPeer();
}

function showSettings() {
  document.getElementById('settings-name').value    = state.myName;
  document.getElementById('settings-peer-id').value = state.myId || '';
  document.getElementById('settings-modal').classList.remove('hidden');
}

function saveSettings() {
  const name = document.getElementById('settings-name').value.trim();
  if (name) { state.myName = name; updateMyInfo(); saveStorage(); }
  closeModal('settings-modal');
}

function showCreateRoom() {
  document.getElementById('new-room-name').value = '';
  document.getElementById('create-room-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('new-room-name').focus(), 50);
}

function showAddChannel() {
  if (!state.activeRoomId) return;
  document.getElementById('new-channel-name').value = '';
  document.getElementById('new-channel-desc').value = '';
  document.getElementById('add-channel-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('new-channel-name').focus(), 50);
}

function manualConnect() {
  const peerInput = document.getElementById('connect-peer-id');
  const roomInput = document.getElementById('connect-room-id');
  const pid = peerInput.value.trim();
  const rid = roomInput?.value.trim() || '';
  if (!pid) { toast('Enter a Peer ID', 'error'); return; }
  peerInput.value = ''; if (roomInput) roomInput.value = '';

  if (rid) {
    if (!state.rooms[rid]) {
      state.rooms[rid] = makeRoomShell(rid, 'Room ' + rid, null);
      saveStorage(); renderRoomList();
    }
    import('./peer.js').then(p => {
      p.connectTo(pid, conn => {
        conn.send({ type: 'cluster_map_request', roomId: rid, id: state.myId, name: state.myName });
        switchRoom(rid);
        toast('Joining room ' + rid + '…', 'info');
      }, () => toast('Could not connect.', 'error'));
    });
  } else {
    import('./peer.js').then(p => {
      p.connectTo(pid, () => toast('Connected!', 'success'), () => toast('Could not connect.', 'error'));
    });
  }
}

function copyText(btn) { copyToClipboard(btn.dataset.text); }
function copyShareLink() { copyToClipboard(document.getElementById('share-link-text').textContent); }

// ─── GLOBAL HANDLERS ─────────────────────────────────────────────────────────
Object.assign(window, {
  toggleTheme,
  toggleSidebar, closeSidebar, openNetPanel, closeNetPanel,
  backToRooms,
  _gmSwitchRoom:    id => switchRoom(id),
  _gmSwitchChannel: id => switchChannel(id),
  closeModal,
  completeSetup,
  showSettings, saveSettings,
  showCreateRoom, createRoom,
  showAddChannel, createChannel,
  showInvite, copyInviteLink,
  confirmLeaveRoom, leaveRoom,
  manualConnect,
  triggerFileShare,
  _gmDownloadFile: (token, fromId, name) => downloadFile(token, fromId, name),
  _gmJoinVoice: (rid, vcId) => import('./voice.js').then(v => v.joinVoiceChannel(rid, vcId)),
  _gmLeaveVoice: (rid) => import('./voice.js').then(v => { v.leaveVoiceChannel(rid); closeCallView(); }),
  _gmToggleMute: (rid) => import('./voice.js').then(v => v.toggleMute(rid)),
  _gmToggleDeafen: (rid) => import('./voice.js').then(v => v.toggleDeafen(rid)),
  _gmToggleCallView: (rid, vcId) => {
    const cv = document.getElementById('call-view');
    if (cv && cv.dataset.vcId === vcId) { closeCallView(); } else { openCallView(rid, vcId); }
  },
  _gmCloseCallView: () => closeCallView(),
  _gmRefreshCallControls: (rid, vcId) => import('./ui.js').then(ui => ui.openCallView(rid, vcId)),
  _gmCreateVoiceChannel: (rid) => import('./voice.js').then(v => v.createVoiceChannel(rid)),
  _gmActiveRoomId: () => state.activeRoomId,
  copyShareLink,
  _gmCopyText: btn => copyText(btn),
  openManageCandidates: () => {
    if (!state.activeRoomId) return;
    renderManageList();
    document.getElementById('manage-candidates-modal').classList.remove('hidden');
  },
  _gmSelectMention: idx => {
    state.mentionState.selected = idx;
    confirmMention();
  },
});

// ─── MANAGE CANDIDATES ────────────────────────────────────────────────────────
function renderManageList() {
  if (!state.activeRoomId) return;
  const r    = state.rooms[state.activeRoomId];
  const list = document.getElementById('manage-list');
  const allIds = r ? [...new Set([...r.childIds, ...(r.parentId ? [r.parentId] : []), ...r.savedPeers])].filter(id => id !== state.myId) : [];
  if (!allIds.length) {
    list.innerHTML = '<div style="font-size:12px;color:var(--text-muted);padding:10px 0">No peers yet</div>';
    return;
  }
  list.innerHTML = allIds.slice(0, 40).map(id => {
    const pc    = state.peerConns[id];
    const alive = pc?.conn?.open;
    const alias = state.peerAliases[id] || '';
    const base  = r?.peers[id]?.name || id;
    const disp  = alias || base;
    return `<div class="mgmt-item" id="mgmt-${id}">
      <div class="mgmt-dot" style="background:${alive ? 'var(--green)' : 'var(--text-muted)'}"></div>
      <div class="mgmt-info">
        <div class="mgmt-alias">${escapeHtml(disp)}</div>
        <div class="mgmt-id">${id}</div>
      </div>
      <div class="mgmt-btns" id="mgmt-btns-${id}">
        <button class="mgmt-btn" onclick="window._gmStartRename('${id}')">✏️</button>
      </div>
    </div>`;
  }).join('');
}

window._gmStartRename = id => {
  const btnsEl = document.getElementById('mgmt-btns-' + id);
  const info   = document.querySelector(`#mgmt-${id} .mgmt-info`);
  if (!btnsEl || !info) return;
  const r = state.activeRoomId ? state.rooms[state.activeRoomId] : null;
  const current = state.peerAliases[id] || (r?.peers[id]?.name) || id;
  const dispEl  = info.querySelector('.mgmt-alias');
  const input   = document.createElement('input');
  input.className = 'mgmt-inline-edit'; input.value = current; input.placeholder = 'Display name…'; input.maxLength = 32;
  dispEl.replaceWith(input); input.focus(); input.select();
  btnsEl.innerHTML = `<button class="mgmt-btn" onclick="window._gmConfirmRename('${id}')">✓</button>
    <button class="mgmt-btn danger" onclick="window._gmCancelRename()">✕</button>`;
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter')  window._gmConfirmRename(id);
    if (e.key === 'Escape') window._gmCancelRename();
  });
};

window._gmConfirmRename = id => {
  const row   = document.getElementById('mgmt-' + id);
  const input = row?.querySelector('.mgmt-inline-edit');
  if (!input) return;
  const val = input.value.trim();
  if (val) {
    state.peerAliases[id] = val;
    for (const r of Object.values(state.rooms)) { if (r.peers[id]) r.peers[id].name = val; }
  } else {
    delete state.peerAliases[id];
  }
  saveStorage(); renderRoomSidebar(); updateNetworkPanel(); renderManageList();
  toast(val ? `Renamed to "${val}"` : 'Alias removed', 'success');
};
window._gmCancelRename = () => renderManageList();
