/**
 * main.js — Boots GilgaMesh and routes all incoming messages
 * Plugin system integrated — hot-swappable at runtime
 */

import { state } from './state.js';
import { loadStorage, saveStorage, makeRoomShell, clearAllData } from './storage.js';
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
  becomeRoot,
} from './mesh.js';
import { handleElectionStart, handleElectionVote, handleElectionWon, startLocalElection } from './election.js';
import { handleIncomingMessage, handleMsgAck, addSystemMsg, displayMessage, flushPendingMessages, onTyping, handleTyping } from './messaging.js';
import { handleVoiceChannelCreated, handleVoiceData, handleVoiceBinary, handleBecomeMyChild, handleVoiceEvictChildren, handleVoiceRelayPromote, handleVideoSignal, handleDMVoiceData, joinVoiceChannel, leaveVoiceChannel } from './voice.js';
import { handleChannelCreated, switchChannel, createRoom, createChannel, joinRoomViaInvite,
         confirmLeaveRoom, leaveRoom, showInvite, copyInviteLink, checkJoinUrl,
         backToRooms, switchRoom, handlePeerLeaving } from './rooms.js';
import { triggerFileShare, downloadFile, checkShareUrl } from './files.js';
import {
  loadFriendsData, saveFriendsData,
  addFriend, removeFriend, isFriend, setNickname,
  blockPeer, unblockPeer, isBlocked,
  sendDM, sendDMTyping, handleIncomingDM,
  handleIncomingFriendRequest, handleIncomingFriendResponse,
  respondToFriendRequest,
  handleVerifyToken,
  startDMCall, handleDMCallInvite, handleDMCallAccept, handleDMCallEnd, openDMCallView,
  openFriendsView, closeFriendsView,
  renderFriendsSidebar, renderFriendsGrid, renderFriendsBadge,
  openDMWith, showPeerProfile,
} from './friends.js';
import {
  initTheme, toggleTheme, applyTheme,
  toast, setStatus, updateMyInfo, closeModal,
  renderRoomList, renderRoomSidebar, renderRoomGrid, renderAllMessages, scrollToBottom,
  renderTopology, updateNetworkPanel, updatePeerCount, updateLatencyDisplay,
  toggleSidebar, closeSidebar, openNetPanel, closeNetPanel,
  handleMentionInput, moveMentionSelection, confirmMention, closeMentionPopup,
  renderMentionText,
  openCallView, closeCallView, openDMCallViewUI, closeDMCallView, expandCallTile, fullscreenTile,
  setReplyTarget, clearReplyTarget, scrollToMessage,
} from './ui.js';
import { copyToClipboard, escapeHtml } from './utils.js';
import { SCORE_WINDOW } from './constants.js';

// ─── PLUGIN SYSTEM ────────────────────────────────────────────────────────────
import { PluginHost }            from './plugin-host.js';
import { initPluginSettingsTab } from './plugin-ui.js';

// Active PluginHost instance — null until peer is open
export let pluginHost = null;

// ─── BOOT ─────────────────────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', init);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});

function init() {
  initTheme();
  loadStorage();
  loadFriendsData();

  import('./friends.js').then(fr => fr.renderFriendsBadge());

  state.cb.handleChatData       = handleChatData;
  state.cb.handlePeerDisconnect = _handlePeerDisconnectWithHook;
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

  // Plugin API callbacks — called by plugins via the host broker
  state.cb.sendDM = async (peerId, content) => {
    sendDM(peerId, content);
  };
  state.cb.sendRoomMessage = async (roomId, channel, content) => {
    const { genId } = await import('./ids.js');
    const r = state.rooms[roomId]; if (!r) return;
    const msg = {
      type: 'message', roomId, id: genId(),
      author: '[Plugin]', authorId: 'plugin',
      content, channel: channel || 'general',
      ts: Date.now(), originId: state.myId,
    };
    displayMessage(roomId, msg);
    if (r.parentConn?.open) try { r.parentConn.send({ type: 'relay_message', roomId, payload: msg }); } catch {}
    for (const cid of r.childIds) {
      const conn = r.childConns[cid] || state.peerConns[cid]?.conn;
      if (conn?.open) try { conn.send({ type: 'relay_message', roomId, payload: msg }); } catch {}
    }
  };

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

// ─── PLUGIN SYSTEM BOOT (called from onPeerOpen in peer.js via state.cb) ──────
// peer.js fires state.cb.onPeerOpen after the PeerJS peer.on('open') event.
// We register that callback here so the plugin host boots only once the peer ID
// is confirmed and stable — plugins that call isPeerOnline or sendDM need myId.
state.cb.onPeerOpen = async (id) => {
  // Load the distribution config.  The dist file is swapped at build time
  // (or at runtime via the plugin manager UI — see installPlugin / removePlugin below).
  let distConfig;
  try {
    // Attempt to load a user-customised runtime dist from localStorage first.
    // Format: { name, plugins: [{ id, removable }] }
    const saved = localStorage.getItem('gilgamesh_runtime_dist');
    distConfig = saved ? JSON.parse(saved) : null;
  } catch {}

  if (!distConfig) {
    // Fall back to the build-time distribution
    try {
      const mod = await import('./distributions/community.dist.js');
      distConfig = mod.default;
    } catch {
      distConfig = { name: 'GilgaMesh', plugins: [] };
    }
  }

  pluginHost = new PluginHost(distConfig, state);
  await pluginHost.init();

  // Patch the settings modal with the plugins tab (idempotent)
  initPluginSettingsTab(pluginHost);

  // Expose hot-swap controls on window for the UI (plugin-ui.js calls these)
  window._gmInstallPlugin = installPlugin;
  window._gmRemovePlugin  = removePlugin;
  window._gmTogglePlugin  = togglePlugin;
};

// ─── HOT-SWAP: INSTALL ────────────────────────────────────────────────────────
/**
 * Install a plugin at runtime from a URL or an already-fetched { manifest, source } object.
 *
 * Usage A — from URL (manifest must be at <base>/manifest.json, entry at <base>/<manifest.entry>):
 *   await window._gmInstallPlugin({ baseUrl: 'https://example.com/my-plugin' });
 *
 * Usage B — from inline objects (e.g. drag-and-drop upload or developer console):
 *   await window._gmInstallPlugin({ manifest: {...}, source: '...js source...' });
 *
 * @param {{ baseUrl?: string, manifest?: object, source?: string, removable?: boolean }} opts
 */
async function installPlugin({ baseUrl, manifest, source, removable = true } = {}) {
  if (!pluginHost) { toast('Plugin system not ready', 'error'); return false; }

  try {
    // Fetch manifest + source from URL if not provided inline
    if (baseUrl) {
      const mRes = await fetch(`${baseUrl.replace(/\/$/, '')}/manifest.json`);
      if (!mRes.ok) throw new Error('Could not fetch manifest from ' + baseUrl);
      manifest = await mRes.json();

      const entry  = manifest.entry || 'index.js';
      const sRes   = await fetch(`${baseUrl.replace(/\/$/, '')}/${entry}`);
      if (!sRes.ok) throw new Error('Could not fetch plugin source');
      source = await sRes.text();
    }

    if (!manifest?.id)  throw new Error('Invalid manifest — missing id');
    if (!source)        throw new Error('Plugin source is empty');

    // Check if already installed
    const existing = pluginHost.getPlugin(manifest.id);
    if (existing) {
      toast(`Plugin "${manifest.name || manifest.id}" is already installed`, 'info');
      return false;
    }

    // Hot-load: inject directly into the running PluginHost
    await pluginHost.hotLoad(manifest, source, removable);

    // Persist the new plugin entry to the runtime dist in localStorage
    _persistRuntimeDist();

    toast(`Plugin "${manifest.name || manifest.id}" installed`, 'success');
    return true;
  } catch (err) {
    console.error('[main] installPlugin error:', err);
    toast('Install failed: ' + err.message, 'error');
    return false;
  }
}

// ─── HOT-SWAP: REMOVE ─────────────────────────────────────────────────────────
/**
 * Remove a removable plugin at runtime.
 * @param {string} pluginId
 */
async function removePlugin(pluginId) {
  if (!pluginHost) return false;

  const info = pluginHost.getPlugin(pluginId);
  if (!info) { toast('Plugin not found', 'error'); return false; }
  if (!info.removable) { toast('This plugin is required and cannot be removed', 'error'); return false; }

  const ok = pluginHost.hotUnload(pluginId);
  if (ok) {
    _persistRuntimeDist();
    toast(`Plugin "${info.manifest.name || pluginId}" removed`, 'info');
  }
  return ok;
}

// ─── HOT-SWAP: TOGGLE (enable / disable without unloading) ────────────────────
/**
 * Enable or disable a plugin without unloading its iframe.
 * Disabled plugins receive no hook events but their iframe stays alive
 * so they can be re-enabled instantly without re-fetching source.
 * @param {string} pluginId
 * @param {boolean} [enabled]  — omit to toggle current state
 */
function togglePlugin(pluginId, enabled) {
  if (!pluginHost) return;
  const info = pluginHost.getPlugin(pluginId);
  if (!info) return;

  const target = enabled !== undefined ? enabled : !info.enabled;
  if (target) pluginHost.enablePlugin(pluginId);
  else        pluginHost.disablePlugin(pluginId);
  _persistRuntimeDist();
}

// ─── PERSIST RUNTIME DIST ─────────────────────────────────────────────────────
// Writes the current plugin list back to localStorage so it survives page reloads.
function _persistRuntimeDist() {
  if (!pluginHost) return;
  const dist = {
    name:    pluginHost.distConfig?.name || 'GilgaMesh',
    plugins: pluginHost.getPluginList().map(p => ({
      id:        p.id,
      removable: p.removable,
      enabled:   p.enabled,
      // Store baseUrl or inline source so we can reinstall on reload
      _baseUrl:  p._baseUrl  || null,
      _source:   p._source   || null,
      _manifest: p.manifest  || null,
    })),
  };
  try { localStorage.setItem('gilgamesh_runtime_dist', JSON.stringify(dist)); } catch {}
}

// ─── PEER DISCONNECT HOOK ─────────────────────────────────────────────────────
// Wraps the mesh handlePeerDisconnect to also fire the peer:offline plugin event.
function _handlePeerDisconnectWithHook(pid) {
  handlePeerDisconnect(pid);
  pluginHost?.emit('peer:offline', { peerId: pid });
}

// ─── SETUP UI ─────────────────────────────────────────────────────────────────
function setupUI() {
  const input = document.getElementById('msg-input');
  const send  = document.getElementById('send-btn');

  input.addEventListener('input', () => {
    input.style.height = '';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
    send.disabled = !input.value.trim() || (!state.activeRoomId && !state.activeDMPeer);
    if (state.activeDMPeer) sendDMTyping(state.activeDMPeer);
    else onTyping();
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
  checkShareUrl();
}

function sendMessageFromUI() {
  if (state.activeDMPeer) {
    const input = document.getElementById('msg-input');
    const text  = input.value.trim();
    if (!text) return;
    input.value = '';
    input.style.height = '';
    document.getElementById('send-btn').disabled = true;
    sendDM(state.activeDMPeer, text);
    return;
  }
  import('./messaging.js').then(m => m.sendMessage());
}

// ─── CENTRAL MESSAGE DISPATCHER ───────────────────────────────────────────────
export function handleChatData(data, conn) {
  if (!data || !data.type) return;
  const pid = conn.peer;
  const rid = data.roomId;

  if (state.peerConns[pid]) state.peerConns[pid].lastSeen = Date.now();

  switch (data.type) {

    // ── Identity verification ──────────────────────────────────────────────
    case 'verify_token':
      handleVerifyToken(data, conn);
      break;

    // ── Heartbeat ──────────────────────────────────────────────────────────
    case 'ping':
      conn.send({ type: 'pong', ts: data.ts, id: state.myId, roomId: rid });
      break;
    case 'pong':
      handlePong(data, pid);
      // Fire peer:online hook — pong confirms the peer is alive and reachable.
      // Guard with a seen-set so we only fire once per session, not every heartbeat.
      if (!state._pluginOnlineSeen) state._pluginOnlineSeen = new Set();
      if (!state._pluginOnlineSeen.has(pid)) {
        state._pluginOnlineSeen.add(pid);
        pluginHost?.emit('peer:online', { peerId: pid });
      }
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
      if (rid && data.payload) {
        handleIncomingMessage(rid, data.payload, pid);
        // Fire room:message hook for plugins
        pluginHost?.emit('room:message', { msg: data.payload, roomId: rid });
      }
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

    case 'dm':
    case 'dm_typing':
      handleIncomingDM(data, conn);
      // Fire dm:received hook for plugins (only for actual messages, not typing)
      if (data.type === 'dm' && data.content) {
        pluginHost?.emit('dm:received', {
          msg: { id: data.id, content: data.content, author: data.fromName, authorId: data.from, ts: data.ts },
          peerId: data.from,
        });
      }
      break;

    case 'friend_request':
      handleIncomingFriendRequest(data, conn);
      break;

    case 'friend_response':
      handleIncomingFriendResponse(data, conn);
      break;

    case 'dm_call_invite':
      handleDMCallInvite(data, conn);
      break;

    case 'dm_call_accept':
      handleDMCallAccept(data, conn);
      break;

    case 'dm_call_end':
      handleDMCallEnd(data, conn);
      break;

    case 'dm_voice':
      handleDMVoiceData(data, conn);
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
    case 'video_offer':
    case 'video_answer':
    case 'video_ice':
    case 'video_stop':
      if (rid) handleVideoSignal(data, conn);
      break;
  }
}

// ─── HANDSHAKE HANDLER ────────────────────────────────────────────────────────
function handleHandshakeMsg(data, conn) {
  const rid = data.roomId, pid = conn.peer;
  if (!rid || !state.rooms[rid]) return;
  const r = state.rooms[rid];

  const isNew = !r.peers[pid];
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
  saveStorage();

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

function showRoomSettings() {
  const r = state.activeRoomId ? state.rooms[state.activeRoomId] : null;
  const titleEl = document.getElementById('room-settings-modal-title');
  const subEl   = document.getElementById('room-settings-modal-sub');
  if (titleEl) titleEl.textContent = r ? r.name : 'Room Settings';
  if (subEl)   subEl.textContent   = r ? `Room ID: ${r.id}` : '';
  document.getElementById('room-settings-modal').classList.remove('hidden');
}

function clearData() {
  if (confirm('Erase ALL local data — rooms, messages, identity, friends, DMs? This cannot be undone.')) {
    clearAllData();
  }
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
  const nameInput = document.getElementById('connect-room-name');
  const pid   = peerInput.value.trim();
  const rid   = roomInput?.value.trim() || '';
  const rname = nameInput?.value.trim() || '';
  if (!pid) { toast('Enter a Peer ID', 'error'); return; }
  peerInput.value = ''; if (roomInput) roomInput.value = ''; if (nameInput) nameInput.value = '';

  if (rid) {
    if (!state.rooms[rid]) {
      state.rooms[rid] = makeRoomShell(rid, rname || ('Room ' + rid), null);
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
    openDMWith(pid, pid);
    openFriendsView();
  }
}

function copyText(btn) { copyToClipboard(btn.dataset.text); }
function copyShareLink() { copyToClipboard(document.getElementById('share-link-text').textContent); }

// ─── VOICE HOOKS FOR PLUGINS ──────────────────────────────────────────────────
// Wrap joinVoiceChannel / leaveVoiceChannel to emit plugin hooks.
// Internal callers already use the direct imports from voice.js;
// these wrappers are used by the global window._gmJoinVoice / _gmLeaveVoice below.
async function joinVoiceWithHook(rid, vcId) {
  await joinVoiceChannel(rid, vcId);
  pluginHost?.emit('voice:joined', { roomId: rid, channelId: vcId });
}
async function leaveVoiceWithHook(rid) {
  await leaveVoiceChannel(rid);
  pluginHost?.emit('voice:left', { roomId: rid });
}

// ─── DM SEND HOOK ─────────────────────────────────────────────────────────────
// Patch sendDM so plugins receive the dm:sent event.
// We shadow the imported sendDM with a wrapper that fires the hook after sending.
const _origSendDM = sendDM;
function sendDMWithHook(peerId, content) {
  _origSendDM(peerId, content);
  const msg = { content, author: state.myName, authorId: state.myId, ts: Date.now() };
  pluginHost?.emit('dm:sent', { msg, peerId });
}

// ─── ROOM ROOT HOOKS ──────────────────────────────────────────────────────────
// mesh.js calls becomeRoot() internally; we expose hooks via state.cb.
// These are called by mesh.js at the two key moments.
state.cb.onBecomeRoot = (rid) => {
  pluginHost?.emit('room:became-root', { roomId: rid });
};
state.cb.onLoseRoot = (rid) => {
  pluginHost?.emit('room:lost-root', { roomId: rid });
};
state.cb.onRoomJoined = (rid) => {
  pluginHost?.emit('room:joined', { roomId: rid, channel: state.rooms[rid]?.channels?.[0]?.id || 'general' });
};

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
  showRoomSettings,
  showCreateRoom, createRoom,
  showAddChannel, createChannel,
  showInvite, copyInviteLink,
  confirmLeaveRoom, leaveRoom,
  manualConnect,
  triggerFileShare,
  _gmDownloadFile: (token, fromId, name) => downloadFile(token, fromId, name),
  _gmJoinVoice:    (rid, vcId) => joinVoiceWithHook(rid, vcId),
  _gmLeaveVoice:   (rid) => { leaveVoiceWithHook(rid); closeCallView(); },
  _gmToggleMute:   (rid) => import('./voice.js').then(v => v.toggleMute(rid)),
  _gmToggleDeafen: (rid) => import('./voice.js').then(v => v.toggleDeafen(rid)),
  _gmToggleCam:    (rid) => import('./voice.js').then(v => {
    if (document.getElementById('call-cam-btn')?.classList.contains('active-red')) {
      v.stopVideoShare(rid, 'cam');
    } else {
      v.startCamShare(rid);
    }
  }),
  _gmToggleScreen: (rid) => import('./voice.js').then(v => {
    if (document.getElementById('call-screen-btn')?.classList.contains('active-red')) {
      v.stopVideoShare(rid, 'screen');
    } else {
      v.startScreenShare(rid);
    }
  }),
  _gmExpandTile:    (peerId) => expandCallTile(peerId),
  _gmFullscreenTile:(peerId) => fullscreenTile(peerId),
  _gmToggleCallView:(rid, vcId) => {
    const cv = document.getElementById('call-view');
    if (cv && cv.dataset.vcId === vcId) { closeCallView(); } else { openCallView(rid, vcId); }
  },
  _gmCloseCallView:        () => closeCallView(),
  _gmRefreshCallControls:  (rid, vcId) => import('./ui.js').then(ui => ui.openCallView(rid, vcId)),
  _gmCreateVoiceChannel:   (rid) => import('./voice.js').then(v => v.createVoiceChannel(rid)),
  _gmActiveRoomId:         () => state.activeRoomId,
  copyShareLink,
  _gmCopyText:    btn => copyText(btn),
  _gmReply:       (msgId, author, content) => setReplyTarget(msgId, author, content),
  _gmScrollToMsg: (msgId) => scrollToMessage(msgId),
  _gmClearReply:  () => clearReplyTarget(),

  // ── Friends / DM ──────────────────────────────────────────────────────────
  _gmOpenFriends:    () => openFriendsView(),
  _gmOpenDM:         (pid, name) => openDMWith(pid, name),
  _gmOpenDMById:     () => {
    const el = document.getElementById('dm-peer-id-input');
    const pid = el?.value.trim();
    if (!pid) { toast('Enter a Peer ID', 'error'); return; }
    if (el) el.value = '';
    openDMWith(pid);
  },
  _gmAddFriend:    (pid, name) => addFriend(pid, name),
  _gmRemoveFriend: (pid) => removeFriend(pid),
  _gmBlockPeer:    (pid, name) => blockPeer(pid, name),
  _gmUnblockPeer:  (pid) => unblockPeer(pid),
  _gmAddFriendDM:  (pid, name) => { addFriend(pid, name); openDMWith(pid, name); },
  _gmUnfriendConfirm:(pid) => {
    const name = state.friends?.[pid]?.name || pid;
    if (confirm('Unfriend ' + name + '?')) { removeFriend(pid); openDMWith(pid, name); }
  },
  _gmBlockFromDM:  (pid, name) => { blockPeer(pid, name); openDMWith(pid, name); },

  // ── Peer profile popup ──────────────────────────────────────────────────
  _gmShowPeerProfile:  (pid, name) => showPeerProfile(pid, name),
  _gmClosePeerProfile: () => {
    const el = document.getElementById('peer-profile-popup');
    if (el) el.classList.add('hidden');
  },
  _gmPPMessage:     (pid, name) => { window._gmClosePeerProfile(); openDMWith(pid, name); },
  _gmPPAddFriend:   (pid, name) => { addFriend(pid, name); showPeerProfile(pid, name); },
  _gmPPSetNickname: (pid) => {
    const current = state.friends?.[pid]?.nickname || '';
    const nick = prompt('Set nickname (leave blank to clear):', current);
    if (nick === null) return;
    setNickname(pid, nick);
    showPeerProfile(pid, nick.trim() || state.friends?.[pid]?.name || pid);
  },
  _gmPPUnfriend: (pid, name) => { removeFriend(pid); window._gmClosePeerProfile(); },
  _gmPPBlock:    (pid, name) => { blockPeer(pid, name); window._gmClosePeerProfile(); },
  _gmPPUnblock:  (pid) => { unblockPeer(pid); window._gmClosePeerProfile(); },

  // DM call
  _gmDMCall: (peerId) => {
    import('./friends.js').then(fr => fr.startDMCall(peerId));
  },

  // Friend requests
  _gmAcceptFriendReq:  (pid, reqId) => respondToFriendRequest(pid, reqId, true),
  _gmDeclineFriendReq: (pid, reqId) => respondToFriendRequest(pid, reqId, false),

  // DM call accept / decline
  _gmAcceptDMCall: (pid, name) => {
    const banner = document.getElementById('dm-call-banner');
    if (banner) banner.remove();
    const conn = state.peerConns[pid]?.conn;
    if (conn?.open) try { conn.send({ type: 'dm_call_accept', from: state.myId, fromName: state.myName }); } catch {}
    state.dmCall = { peerId: pid, peerName: name, active: true, initiator: false };
    openDMCallView(pid, name);
    import('./voice.js').then(v => v.startDMCallAudio?.(pid));
  },
  _gmDeclineDMCall: (pid) => {
    const banner = document.getElementById('dm-call-banner');
    if (banner) banner.remove();
    const conn = state.peerConns[pid]?.conn;
    if (conn?.open) try { conn.send({ type: 'dm_call_end', from: state.myId }); } catch {}
  },
  _gmEndDMCall: (pid) => {
    const conn = state.peerConns[pid]?.conn;
    if (conn?.open) try { conn.send({ type: 'dm_call_end', from: state.myId }); } catch {}
    import('./voice.js').then(v => v.stopDMCallAudio?.());
    state.dmCall = null;
    import('./ui.js').then(ui => ui.closeDMCallView());
    toast('Call ended', 'info');
  },
  _gmDMCallToggleMute:   (pid) => import('./voice.js').then(v => { v.toggleMuteRaw?.(); import('./ui.js').then(ui => ui.openDMCallViewUI(pid, state.dmCall?.peerName || pid)); }),
  _gmDMCallToggleDeafen: (pid) => import('./voice.js').then(v => { v.toggleDeafenRaw?.(); import('./ui.js').then(ui => ui.openDMCallViewUI(pid, state.dmCall?.peerName || pid)); }),
  _gmDMCallToggleCam: (pid) => {
    import('./ui.js').then(ui => {
      if (ui.isLocalCamActive?.()) {
        import('./voice.js').then(v => v.stopVideoShare?.('__dm__', 'cam'));
      } else {
        import('./voice.js').then(v => v.startDMCallCam?.(pid));
      }
    });
  },
  _gmDMCallToggleScreen: (pid) => {
    import('./ui.js').then(ui => {
      if (ui.isLocalScreenActive?.()) {
        import('./voice.js').then(v => v.stopVideoShare?.('__dm__', 'screen'));
      } else {
        import('./voice.js').then(v => v.startDMCallScreen?.(pid));
      }
    });
  },

  clearData,
  openManageCandidates: () => {
    if (!state.activeRoomId) return;
    renderManageList();
    document.getElementById('manage-candidates-modal').classList.remove('hidden');
  },
  _gmSelectMention: idx => {
    state.mentionState.selected = idx;
    confirmMention();
  },

  // ── Plugin hot-swap (set after pluginHost boots, but exposed here for discoverability)
  _gmOpenRoomPlugins: () => {
    import('./plugin-ui.js').then(ui => {
      closeModal('room-settings-modal');
      ui.openRoomPluginsModal?.();
    });
  },
  _gmInstallPlugin: (...args) => installPlugin(...args),
  _gmRemovePlugin:  (...args) => removePlugin(...args),
  _gmTogglePlugin:  (...args) => togglePlugin(...args),
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
