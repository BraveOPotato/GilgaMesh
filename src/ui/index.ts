/**
 * src/ui/index.ts — UI bootstrap.
 *
 * Called once from main.ts after all domain modules are initialised.
 * Subscribes to domain stores + bus events, renders initial state.
 *
 * This is the ONLY file allowed to import both domain stores and DOM APIs.
 * Components receive plain data; they never import stores directly.
 */

import { bus } from '../core/events.js';
import { identityStore } from '../core/state/identity.js';
import { roomsStore } from '../core/state/rooms.js';
import { friendsStore } from '../core/state/friends.js';
import { pluginsStore } from '../core/state/plugins.js';
import { setupEventDelegation, teardownEventDelegation } from './events.js';
import { initToasts, showToast } from './components/toast-container.js';
import { MessageList } from './components/message-list.js';
import { viewStore, openModal, closeModal, setReplyingTo } from './stores/view-store.js';
import type { RoomId, ChannelId, Message } from '../core/types.js';

// Active MessageList instance for current channel.
let currentMessageList: MessageList | null = null;
let teardownToasts: (() => void) | null    = null;
const unsubscribers: Array<() => void>     = [];

// ─── BOOTSTRAP ───────────────────────────────────────────────────────────────

export function initUI(): void {
  setupEventDelegation();
  teardownToasts = initToasts();

  subscribeToStores();
  subscribeToEvents();

  renderIdentity();
  renderRoomList();
}

export function destroyUI(): void {
  teardownEventDelegation();
  teardownToasts?.();
  for (const unsub of unsubscribers) unsub();
  unsubscribers.length = 0;
  currentMessageList   = null;
}

// ─── STORE SUBSCRIPTIONS ─────────────────────────────────────────────────────

function subscribeToStores(): void {
  unsubscribers.push(
    identityStore.subscribe(() => renderIdentity()),
    roomsStore.subscribe((state) => {
      renderRoomList();
      if (state.activeRoomId) {
        renderRoomSidebar(state.activeRoomId);
      }
    }),
    friendsStore.subscribe(() => renderFriendsBadge()),
    viewStore.subscribe((state) => {
      syncModal(state.openModal);
      syncReplyBar(state.replyingTo);
    }),
  );
}

// ─── EVENT SUBSCRIPTIONS ──────────────────────────────────────────────────────

function subscribeToEvents(): void {
  unsubscribers.push(
    // ── Room selection ───────────────────────────────────────────────────────
    bus.on('ui:room-selected', ({ roomId }) => {
      if (!roomId) {
        switchToRoomsGrid();
      } else {
        switchToRoom(roomId);
      }
    }),

    // ── Channel selection ────────────────────────────────────────────────────
    bus.on('ui:channel-selected', ({ roomId, channelId }) => {
      switchChannel(roomId, channelId);
    }),

    // ── Incoming message → append or increment unread ────────────────────────
    bus.on('room:message', ({ roomId, msg }) => {
      const { activeRoomId, activeChannel } = roomsStore.get();
      if (roomId === activeRoomId && msg.channel === activeChannel) {
        const wasBottom = currentMessageList?.isScrolledToBottom() ?? true;
        currentMessageList?.append(msg as Message);
        if (wasBottom) currentMessageList?.scrollToBottom();
      }
    }),

    // ── Msg acked → un-gray ───────────────────────────────────────────────────
    bus.on('room:msg-acked', ({ msgId }) => {
      currentMessageList?.unPend(String(msgId));
    }),

    // ── Toast passthrough ─────────────────────────────────────────────────────
    // (already handled by initToasts — this is a no-op registration for symmetry)

    // ── Modal close ───────────────────────────────────────────────────────────
    bus.on('ui:modal-close-requested', () => closeModal()),

    // ── Reply initiated ────────────────────────────────────────────────────────
    bus.on('ui:reply-initiated', ({ msgId }) => {
      // Find message in current channel to build preview.
      const { rooms, activeRoomId, activeChannel } = roomsStore.get();
      if (!activeRoomId) return;
      const msgs = rooms[activeRoomId]?.messages[activeChannel] ?? [];
      const msg  = msgs.find(m => m.id === msgId);
      if (msg) setReplyingTo({ id: msg.id, author: msg.author, content: msg.content ?? '' });
    }),

    // ── Topology changed → update network panel ───────────────────────────────
    bus.on('room:topology-changed', ({ roomId }) => {
      if (roomId === roomsStore.get().activeRoomId) {
        renderNetworkPanel(roomId);
      }
    }),

    // ── Voice speaking → update speaker indicators ────────────────────────────
    bus.on('voice:speaking', ({ roomId, peerId, active }) => {
      updateSpeakerIndicator(String(peerId), active);
      if (roomId === roomsStore.get().activeRoomId) {
        renderVoiceSpeakers(roomId);
      }
    }),

    // ── Status bar events ─────────────────────────────────────────────────────
    bus.on('room:became-root', ({ roomId }) => {
      if (roomId === roomsStore.get().activeRoomId) setStatus('server', 'root');
    }),
    bus.on('room:parent-lost', ({ roomId }) => {
      if (roomId === roomsStore.get().activeRoomId) setStatus('searching', 'reconnecting…');
    }),
    bus.on('room:joined', ({ roomId }) => {
      if (roomId === roomsStore.get().activeRoomId) setStatus('connected', 'connected');
    }),
    bus.on('peer:online', () => renderNetworkPanel(roomsStore.get().activeRoomId)),
    bus.on('peer:offline', () => renderNetworkPanel(roomsStore.get().activeRoomId)),
  );
}

// ─── ROOM SWITCHING ───────────────────────────────────────────────────────────

function switchToRoom(roomId: RoomId): void {
  const { rooms } = roomsStore.get();
  const room      = rooms[roomId];
  if (!room) return;

  setActiveRoomInDOM(roomId, room.name, room.id);

  const channel = room.channels.find(c => c.id === 'general') ?? room.channels[0];
  if (channel) switchChannel(roomId, channel.id as ChannelId);

  renderRoomSidebar(roomId);
  renderRoomList();

  const isRoot = !room.parentId;
  setStatus(
    isRoot ? 'server' : room.parentId ? 'connected' : 'alone',
    isRoot ? 'root'   : room.parentId ? 'connected' : 'searching',
  );

  if (window.innerWidth <= 700) closeSidebar();
}

function switchChannel(roomId: RoomId, channelId: ChannelId): void {
  const { rooms } = roomsStore.get();
  const room      = rooms[roomId];
  if (!room) return;

  const ch = room.channels.find(c => c.id === channelId);
  setActiveChannelInDOM(channelId, ch?.name ?? channelId, ch?.desc ?? '');

  const msgs = room.messages[channelId] ?? [];
  mountMessageList(msgs as Message[]);
}

function switchToRoomsGrid(): void {
  setStatus('alone', 'online');
  renderRoomsGrid();
}

// ─── DOM HELPERS ──────────────────────────────────────────────────────────────

function renderIdentity(): void {
  const { myId, myName } = identityStore.get();
  const idEl   = document.getElementById('my-peer-id');
  const nameEl = document.getElementById('my-name');
  if (idEl)   idEl.textContent   = myId   ?? '…';
  if (nameEl) nameEl.textContent = myName ?? '…';
}

function renderRoomList(): void {
  const { rooms, activeRoomId } = roomsStore.get();
  const container = document.getElementById('room-list');
  if (!container) return;

  container.innerHTML = Object.values(rooms)
    .map(r => {
      const active = r.id === activeRoomId ? ' room-active' : '';
      const totalUnread = Object.values(r.unread).reduce((a, b) => a + b, 0);
      const badge = totalUnread > 0 ? `<span class="unread-badge">${totalUnread}</span>` : '';
      return `<div class="room-item${active}" data-room-id="${r.id}">
        <span class="room-icon">#</span>
        <span class="room-name">${escHtml(r.name)}</span>
        ${badge}
      </div>`;
    })
    .join('');
}

function renderRoomSidebar(roomId: RoomId | null): void {
  if (!roomId) return;
  const { rooms } = roomsStore.get();
  const room      = rooms[roomId];
  if (!room) return;

  // Channels
  const channelList = document.getElementById('channel-list');
  if (channelList) {
    channelList.innerHTML = room.channels
      .map(ch => {
        const unread = room.unread[ch.id] ?? 0;
        return `<div class="channel-item" data-channel-id="${ch.id}" data-room-id="${roomId}">
          <span class="channel-hash">#</span>
          <span class="channel-name">${escHtml(ch.name)}</span>
          ${unread > 0 ? `<span class="unread-badge">${unread}</span>` : ''}
        </div>`;
      })
      .join('');
  }

  // Voice channels
  const voiceList = document.getElementById('voice-channel-list');
  if (voiceList) {
    voiceList.innerHTML = (room.voiceChannels ?? [])
      .map(vc => `<div class="voice-channel-item" data-voice-channel-id="${vc.id}" data-room-id="${roomId}">
        <span class="vc-icon">🔊</span>
        <span class="vc-name">${escHtml(vc.name)}</span>
      </div>`)
      .join('');
  }

  // Peer list
  const peerList = document.getElementById('peer-list');
  if (peerList) {
    peerList.innerHTML = Object.values(room.peers)
      .map(p => `<div class="peer-item" data-peer-id="${p.id}">
        <span class="peer-status online"></span>
        <span class="peer-name">${escHtml(p.name)}</span>
      </div>`)
      .join('');
  }
}

function renderRoomsGrid(): void {
  const { rooms } = roomsStore.get();
  const container = document.getElementById('rooms-grid');
  if (!container) return;

  if (!Object.keys(rooms).length) {
    container.innerHTML = '<p class="empty-state">No rooms yet — create or join one!</p>';
    return;
  }

  container.innerHTML = Object.values(rooms)
    .map(r => `<div class="room-card" data-room-id="${r.id}">
      <div class="room-card-name">${escHtml(r.name)}</div>
      <div class="room-card-id">#${r.id}</div>
      <div class="room-card-peers">${Object.keys(r.peers).length} members</div>
    </div>`)
    .join('');
}

function renderFriendsBadge(): void {
  const { dms } = friendsStore.get();
  const total = Object.values(dms).reduce((a, t) => a + t.unread, 0);
  const badge = document.getElementById('friends-badge');
  if (!badge) return;
  badge.textContent = total > 0 ? String(total) : '';
  badge.hidden      = total === 0;
}

function renderNetworkPanel(roomId: RoomId | null): void {
  if (!roomId) return;
  const { rooms } = roomsStore.get();
  const room = rooms[roomId];
  if (!room) return;

  const panel = document.getElementById('network-panel');
  if (!panel) return;

  panel.innerHTML = `
    <div class="net-row"><span>Status</span><span>${room.parentId ? 'child' : 'root'}</span></div>
    <div class="net-row"><span>Distance</span><span>${room.distanceFromRoot}</span></div>
    <div class="net-row"><span>Children</span><span>${room.childIds.length}</span></div>
    <div class="net-row"><span>Peers</span><span>${Object.keys(room.peers).length}</span></div>
  `;
}

function renderVoiceSpeakers(_roomId: RoomId): void {
  // Voice speaker indicators are updated incrementally via updateSpeakerIndicator.
}

function updateSpeakerIndicator(peerId: string, active: boolean): void {
  document
    .querySelectorAll<HTMLElement>(`[data-peer-id="${CSS.escape(peerId)}"]`)
    .forEach(el => el.classList.toggle('speaking', active));
}

function mountMessageList(messages: Message[]): void {
  const container = document.getElementById('msg-list');
  if (!container) return;
  currentMessageList = new MessageList(container, buildMsgOpts());
  currentMessageList.mount(messages);
  currentMessageList.scrollToBottom();
}

function buildMsgOpts() {
  const { myId, myName } = identityStore.get();
  const { rooms, activeRoomId, activeChannel } = roomsStore.get();
  const peers = activeRoomId ? Object.values(rooms[activeRoomId]?.peers ?? {}).map(p => p.name) : [];
  return { mentionNames: peers, myName: myName || undefined, myId: myId ?? undefined };
}

function setActiveRoomInDOM(roomId: RoomId, name: string, id: string): void {
  document.body.dataset['activeRoomId'] = roomId;
  const nameEl = document.getElementById('active-room-name');
  const idEl   = document.getElementById('active-room-id');
  if (nameEl) nameEl.textContent = name;
  if (idEl)   idEl.textContent   = `#${id}`;
  document.getElementById('back-to-rooms')?.style.setProperty('display', 'flex');
  document.getElementById('invite-btn')?.style.setProperty('display', 'flex');
  const msgInput = document.getElementById('msg-input') as HTMLInputElement | null;
  if (msgInput) msgInput.disabled = false;
}

function setActiveChannelInDOM(channelId: ChannelId, name: string, desc: string): void {
  const titleEl = document.getElementById('active-channel-title');
  const descEl  = document.getElementById('active-channel-desc');
  const input   = document.getElementById('msg-input') as HTMLInputElement | null;
  if (titleEl) titleEl.textContent = name;
  if (descEl)  descEl.textContent  = desc;
  if (input)   input.placeholder   = `Message #${name}`;
}

function setStatus(type: string, label: string): void {
  const el = document.getElementById('connection-status');
  if (!el) return;
  el.className   = `status status-${type}`;
  el.textContent = label;
}

function syncModal(name: string | null): void {
  document.querySelectorAll<HTMLElement>('.modal').forEach(m => {
    m.classList.toggle('hidden', m.id !== (name ? `${name}-modal` : ''));
  });
}

function syncReplyBar(replyingTo: { id: unknown; author: string; content: string | null } | null): void {
  const bar = document.getElementById('reply-bar');
  if (!bar) return;
  if (!replyingTo) {
    bar.classList.add('hidden');
    return;
  }
  bar.classList.remove('hidden');
  const authorEl  = bar.querySelector('.reply-author');
  const contentEl = bar.querySelector('.reply-content');
  if (authorEl)  authorEl.textContent  = replyingTo.author;
  if (contentEl) contentEl.textContent = replyingTo.content ?? '';
}

function closeSidebar(): void {
  document.getElementById('sidebar')?.classList.remove('open');
}

function escHtml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
