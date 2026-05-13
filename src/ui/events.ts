/**
 * src/ui/events.ts — DOM event delegation.
 *
 * Single click/keydown listener on document.body.
 * Reads data-* attributes, emits typed bus events.
 * No module may assign window.* functions or use inline onclick=.
 *
 * HTML convention:
 *   <div data-room-id="1234">           → ui:room-selected
 *   <div data-channel-id="general">    → ui:channel-selected
 *   <div data-peer-id="amber-…">       → ui:peer-selected
 *   <div data-msg-id="…">              → (reply btn child) ui:reply-initiated
 *   <div data-voice-channel-id="vc-…"> → ui:voice-join-requested
 *   <button data-plugin-install="url"> → ui:plugin-install-requested
 */

import { bus } from '../core/events.js';
import type { PeerId, RoomId, ChannelId, MessageId, PluginId } from '../core/types.js';

export function setupEventDelegation(): void {
  document.body.addEventListener('click', onBodyClick);
  document.addEventListener('keydown', onKeyDown);
}

export function teardownEventDelegation(): void {
  document.body.removeEventListener('click', onBodyClick);
  document.removeEventListener('keydown', onKeyDown);
}

// ─── CLICK DELEGATION ─────────────────────────────────────────────────────────

function onBodyClick(e: MouseEvent): void {
  const target = e.target as HTMLElement | null;
  if (!target) return;

  // ── Room selection ─────────────────────────────────────────────────────────
  const roomEl = target.closest<HTMLElement>('[data-room-id]');
  if (roomEl && !target.closest('[data-channel-id]') && !target.closest('[data-voice-channel-id]')) {
    const roomId = roomEl.dataset['roomId'];
    if (roomId) {
      bus.emit('ui:room-selected', { roomId: roomId as RoomId });
      return;
    }
  }

  // ── Channel selection ──────────────────────────────────────────────────────
  const channelEl = target.closest<HTMLElement>('[data-channel-id]');
  if (channelEl) {
    const roomId    = channelEl.closest<HTMLElement>('[data-room-id]')?.dataset['roomId'];
    const channelId = channelEl.dataset['channelId'];
    if (roomId && channelId) {
      bus.emit('ui:channel-selected', {
        roomId:    roomId    as RoomId,
        channelId: channelId as ChannelId,
      });
      return;
    }
  }

  // ── Voice channel ──────────────────────────────────────────────────────────
  const voiceEl = target.closest<HTMLElement>('[data-voice-channel-id]');
  if (voiceEl) {
    const roomId    = voiceEl.closest<HTMLElement>('[data-room-id]')?.dataset['roomId'];
    const channelId = voiceEl.dataset['voiceChannelId'];
    if (roomId && channelId) {
      bus.emit('ui:voice-join-requested', { roomId: roomId as RoomId, channelId });
      return;
    }
  }

  // ── Peer profile ───────────────────────────────────────────────────────────
  const peerEl = target.closest<HTMLElement>('[data-peer-id]');
  if (peerEl && target.closest('.peer-item, .peer-avatar, [data-peer-trigger]')) {
    const peerId = peerEl.dataset['peerId'];
    if (peerId) {
      bus.emit('ui:peer-selected', { peerId: peerId as PeerId });
      return;
    }
  }

  // ── Message reply ──────────────────────────────────────────────────────────
  if (target.closest('.msg-reply-btn, [data-reply-btn]')) {
    const msgEl = target.closest<HTMLElement>('[data-msg-id]');
    const msgId = msgEl?.dataset['msgId'];
    if (msgId) {
      bus.emit('ui:reply-initiated', { msgId: msgId as MessageId });
      return;
    }
  }

  // ── Mention click ──────────────────────────────────────────────────────────
  if (target.closest('.mention[data-peer-id]')) {
    const mentionEl = target.closest<HTMLElement>('.mention[data-peer-id]');
    const peerId    = mentionEl?.dataset['peerId'];
    if (peerId) {
      bus.emit('ui:mention-clicked', { peerId: peerId as PeerId });
      return;
    }
  }

  // ── File share ─────────────────────────────────────────────────────────────
  if (target.closest('#file-btn, [data-file-btn]')) {
    const activeRoom = document.body.dataset['activeRoomId'];
    const activeDM   = document.body.dataset['activeDmPeer'];
    bus.emit('ui:file-share-triggered', {
      roomId:    activeRoom ? activeRoom as RoomId : null,
      dmPeerId:  activeDM  ? activeDM  as PeerId  : null,
    });
    return;
  }

  // ── Voice leave ────────────────────────────────────────────────────────────
  if (target.closest('[data-voice-leave]')) {
    const roomId = target.closest<HTMLElement>('[data-room-id]')?.dataset['roomId']
      ?? document.body.dataset['activeRoomId'];
    if (roomId) {
      bus.emit('ui:voice-leave-requested', { roomId: roomId as RoomId });
      return;
    }
  }

  // ── Plugin install ─────────────────────────────────────────────────────────
  const pluginInstallEl = target.closest<HTMLElement>('[data-plugin-install]');
  if (pluginInstallEl) {
    const baseUrl = pluginInstallEl.dataset['pluginInstall'];
    if (baseUrl) {
      bus.emit('ui:plugin-install-requested', { baseUrl });
      return;
    }
  }

  // ── Plugin remove ──────────────────────────────────────────────────────────
  const pluginRemoveEl = target.closest<HTMLElement>('[data-plugin-remove]');
  if (pluginRemoveEl) {
    const pluginId = pluginRemoveEl.dataset['pluginRemove'];
    if (pluginId) {
      bus.emit('ui:plugin-remove-requested', { pluginId: pluginId as PluginId });
      return;
    }
  }

  // ── Plugin toggle ──────────────────────────────────────────────────────────
  const pluginToggleEl = target.closest<HTMLElement>('[data-plugin-toggle]');
  if (pluginToggleEl) {
    const pluginId = pluginToggleEl.dataset['pluginToggle'];
    const enabled  = pluginToggleEl.dataset['pluginEnabled'] !== 'true'; // toggle current
    if (pluginId) {
      bus.emit('ui:plugin-toggle-requested', { pluginId: pluginId as PluginId, enabled });
      return;
    }
  }

  // ── Friend request respond ─────────────────────────────────────────────────
  const friendRespEl = target.closest<HTMLElement>('[data-friend-respond]');
  if (friendRespEl) {
    const peerId = friendRespEl.dataset['peerId'];
    const reqId  = friendRespEl.dataset['reqId'];
    const accept = friendRespEl.dataset['friendRespond'] === 'accept';
    if (peerId && reqId) {
      bus.emit('ui:friend-request-responded', { peerId: peerId as PeerId, reqId, accept });
      return;
    }
  }

  // ── Call accept/decline/end ────────────────────────────────────────────────
  const callEl = target.closest<HTMLElement>('[data-call-action]');
  if (callEl) {
    const action  = callEl.dataset['callAction'];
    const peerId  = callEl.dataset['peerId'] ?? document.body.dataset['callPeerId'];
    if (peerId) {
      if (action === 'accept') bus.emit('ui:call-accepted', { peerId: peerId as PeerId });
      if (action === 'decline') bus.emit('ui:call-declined', { peerId: peerId as PeerId });
      if (action === 'end') bus.emit('ui:call-ended', { peerId: peerId as PeerId });
      return;
    }
  }

  // ── Modal close ────────────────────────────────────────────────────────────
  if (target.closest('[data-close-modal], .modal-overlay[data-dismiss]')) {
    bus.emit('ui:modal-close-requested', {});
    return;
  }

  // ── Back to rooms ──────────────────────────────────────────────────────────
  if (target.closest('#back-to-rooms, [data-back-to-rooms]')) {
    bus.emit('ui:room-selected', { roomId: '' as RoomId }); // empty = back to grid
    return;
  }
}

// ─── KEYBOARD SHORTCUTS ───────────────────────────────────────────────────────

function onKeyDown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    bus.emit('ui:modal-close-requested', {});
  }
}
