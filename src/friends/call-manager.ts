/**
 * src/friends/call-manager.ts — DM voice/video calls over WebRTC.
 *
 * Uses PeerJS media connections (peer.call()).
 * State in friendsStore.dmCall.
 * Signalling via bus events; no UI imports.
 */

import type { EventBus, PeerId } from '../core/events.js';
import { friendsStore } from '../core/state/friends.js';
import { identityStore } from '../core/state/identity.js';
import type { PeerRegistry } from '../network/peer-registry.js';

export class CallManager {
  constructor(
    private readonly bus:      EventBus,
    private readonly registry: PeerRegistry,
    private readonly getPeer:  () => unknown,
  ) {}

  // ── Initiate call ─────────────────────────────────────────────────────────

  async startCall(peerId: PeerId, peerName: string, video = false): Promise<void> {
    const { myId, myName } = identityStore.get();
    if (!myId) return;

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true, video });
    } catch (e) {
      this.bus.emit('ui:toast', { message: `Mic/camera error: ${(e as Error).message}`, kind: 'error' });
      return;
    }

    friendsStore.set(s => ({ ...s, dmCall: { peerId, peerName, active: true, initiator: true } }));
    this.bus.emit('dm:call-state-changed', { peerId, state: 'outgoing' });

    // Notify peer.
    const conn = this.registry.get(peerId);
    if (conn) {
      conn.send({ type: 'dm_call', action: 'offer', from: myId, fromName: myName, video });
    } else {
      void this.registry.connect(peerId).then(r => {
        if (r.ok) r.value.send({ type: 'dm_call', action: 'offer', from: myId, fromName: myName, video });
        else {
          this.bus.emit('ui:toast', { message: 'Could not reach peer for call', kind: 'error' });
          this.endCall(peerId);
        }
      });
    }

    // Use PeerJS media connection if available.
    const peer = this.getPeer() as { call?: (id: string, stream: MediaStream) => unknown } | null;
    if (peer?.call) {
      const mc = peer.call(peerId, stream);
      if (mc) {
        (mc as { on: (e: string, cb: (s: unknown) => void) => void }).on('stream', (remoteStream: unknown) => {
          this.bus.emit('dm:call-state-changed', { peerId, state: 'active' });
          // Attach remoteStream to UI via event.
          this.bus.emit('ui:toast' as never, { _callStream: remoteStream, peerId } as never);
        });
      }
    }
  }

  // ── Answer call ───────────────────────────────────────────────────────────

  async acceptCall(peerId: PeerId): Promise<void> {
    this.bus.emit('dm:call-state-changed', { peerId, state: 'active' });
    friendsStore.set(s => s.dmCall?.peerId === peerId
      ? { ...s, dmCall: { ...s.dmCall!, active: true, initiator: false } }
      : s);

    const { myId, myName } = identityStore.get();
    const conn = this.registry.get(peerId);
    conn?.send({ type: 'dm_call', action: 'answer', from: myId, fromName: myName });
  }

  declineCall(peerId: PeerId): void {
    const { myId, myName } = identityStore.get();
    const conn = this.registry.get(peerId);
    conn?.send({ type: 'dm_call', action: 'decline', from: myId, fromName: myName });
    this.clearCall();
    this.bus.emit('dm:call-state-changed', { peerId, state: 'ended' });
  }

  endCall(peerId: PeerId): void {
    const { myId, myName } = identityStore.get();
    const conn = this.registry.get(peerId);
    conn?.send({ type: 'dm_call', action: 'end', from: myId, fromName: myName });
    this.clearCall();
    this.bus.emit('dm:call-state-changed', { peerId, state: 'ended' });
  }

  // ── Incoming call signals ─────────────────────────────────────────────────

  handleCallSignal(data: Record<string, unknown>, fromPeerId: PeerId): void {
    const action   = String(data['action'] ?? '');
    const from     = (data['from'] as PeerId | undefined) ?? fromPeerId;
    const fromName = String(data['fromName'] ?? from);

    switch (action) {
      case 'offer':
        friendsStore.set(s => ({ ...s, dmCall: { peerId: from, peerName: fromName, active: false, initiator: false } }));
        this.bus.emit('dm:call-state-changed', { peerId: from, state: 'incoming' });
        break;

      case 'answer':
        if (friendsStore.get().dmCall?.peerId === from) {
          friendsStore.set(s => s.dmCall ? { ...s, dmCall: { ...s.dmCall!, active: true } } : s);
          this.bus.emit('dm:call-state-changed', { peerId: from, state: 'active' });
        }
        break;

      case 'decline':
        this.clearCall();
        this.bus.emit('dm:call-state-changed', { peerId: from, state: 'ended' });
        this.bus.emit('ui:toast', { message: `${fromName} declined the call`, kind: 'info' });
        break;

      case 'end':
        this.clearCall();
        this.bus.emit('dm:call-state-changed', { peerId: from, state: 'ended' });
        break;
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private clearCall(): void {
    friendsStore.set(s => ({ ...s, dmCall: null }));
  }

  isInCall(): boolean {
    return Boolean(friendsStore.get().dmCall?.active);
  }
}
