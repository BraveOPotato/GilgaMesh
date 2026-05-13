/**
 * src/friends/dm-manager.ts — Direct messaging, typing indicators, friend requests.
 *
 * Wire protocol is point-to-point (no relay).
 * Messages are stored in friendsStore.dms[peerId].
 */

import type { EventBus, PeerId, MessageId } from '../core/events.js';
import type { Message } from '../core/types.js';
import { friendsStore } from '../core/state/friends.js';
import { identityStore } from '../core/state/identity.js';
import { genId } from '../utils/id-generator.js';
import type { FriendManager } from './friend-manager.js';
import type { PeerRegistry } from '../network/peer-registry.js';

const DMS_KEY = 'gilgamesh_dms';
const DM_MAX  = 500;

// Typing clear timers: peerId → setTimeout handle
const typingTimers = new Map<PeerId, ReturnType<typeof setTimeout>>();

export class DMManager {
  constructor(
    private readonly bus:           EventBus,
    private readonly registry:      PeerRegistry,
    private readonly friendManager: FriendManager,
  ) {}

  // ── Persistence ───────────────────────────────────────────────────────────

  load(): void {
    try {
      const dms = JSON.parse(localStorage.getItem(DMS_KEY) ?? '{}') as Record<string, Message[]>;
      friendsStore.set(s => ({ ...s, dms: dms as never }));
    } catch (e) {
      console.warn('[DMManager] load error:', e);
    }
  }

  save(): void {
    try {
      localStorage.setItem(DMS_KEY, JSON.stringify(friendsStore.get().dms));
    } catch {}
  }

  // ── Send DM ───────────────────────────────────────────────────────────────

  send(peerId: PeerId, text: string): boolean {
    const { myId, myName } = identityStore.get();
    if (!text?.trim() || !peerId || peerId === myId || !myId) return false;

    const msg: Message = {
      id:       genId() as MessageId,
      type:     'chat',
      author:   myName,
      authorId: myId,
      content:  text.trim(),
      ts:       Date.now(),
      channel:  'dm' as never,
    };

    this.storeMessage(peerId, msg);
    this.save();

    this.bus.emit('dm:sent', { peerId, msg: msg as never });

    // Wire — point-to-point.
    const wire = (conn: { send(d: unknown): boolean }) => {
      const ok = conn.send({
        type:     'dm',
        id:       msg.id,
        from:     myId,
        fromName: myName,
        content:  text.trim(),
        ts:       msg.ts,
      });
      if (!ok) this.bus.emit('ui:toast', { message: 'Send failed', kind: 'error' });
    };

    const existing = this.registry.get(peerId);
    if (existing) {
      wire(existing);
    } else {
      void this.registry.connect(peerId).then(result => {
        if (result.ok) wire(result.value);
        else this.bus.emit('ui:toast', { message: 'Peer unreachable', kind: 'error' });
      });
    }

    return true;
  }

  // ── Receive DM ────────────────────────────────────────────────────────────

  handleIncoming(data: Record<string, unknown>, fromPeerId: PeerId): void {
    const from = (data['from'] as PeerId | undefined) ?? fromPeerId;
    if (!from) return;

    if (this.friendManager.isBlocked(from)) return;

    const { dms } = friendsStore.get();
    const thread  = dms[from] as Message[] | undefined ?? [];
    if (thread.some(m => m.id === data['id'])) return; // dedup

    const msg: Message = {
      id:       (data['id'] as string ?? genId()) as MessageId,
      type:     'chat',
      author:   String(data['fromName'] ?? from),
      authorId: from,
      content:  String(data['content'] ?? ''),
      ts:       Number(data['ts'] ?? Date.now()),
      channel:  'dm' as never,
      ...(data['msgType']   ? { msgType:   data['msgType']   } : {}),
      ...(data['fileShare'] ? { fileShare: data['fileShare'] } : {}),
    };

    this.storeMessage(from, msg);
    this.save();

    // Update friend name if known.
    const { friends } = friendsStore.get();
    if (friends[from] && data['fromName']) {
      friendsStore.set(s => ({
        ...s,
        friends: { ...s.friends, [from]: { ...s.friends[from]!, name: String(data['fromName']) } },
      }));
    }

    // Increment unread if DM thread not active.
    const { activeDMPeer } = friendsStore.get();
    if (activeDMPeer !== from) {
      friendsStore.set(s => ({
        ...s,
        dmUnread: { ...s.dmUnread, [from]: ((s.dmUnread[from] ?? 0) as number) + 1 },
      }));
    }

    this.bus.emit('dm:received', { peerId: from, msg: msg as never });

    if (activeDMPeer !== from) {
      const senderName = friendsStore.get().friends[from]?.name ?? String(data['fromName'] ?? from);
      const preview    = msg.content?.slice(0, 60) ?? '';
      this.bus.emit('ui:toast', { message: `DM from ${senderName}: ${preview}`, kind: 'info' });
    }
  }

  // ── Friend requests ───────────────────────────────────────────────────────

  sendFriendRequest(peerId: PeerId, name: string): void {
    const { myId, myName } = identityStore.get();
    if (!myId) return;

    const friend = this.friendManager.addFriend(peerId, name);
    const reqId  = genId();

    const wire = (conn: { send(d: unknown): boolean }) => {
      conn.send({
        type:         'friend_request',
        reqId,
        from:         myId,
        fromName:     myName,
        sharedSecret: friend.sharedSecret,
      });
      this.bus.emit('ui:toast', { message: `Friend request sent to ${name || peerId}`, kind: 'success' });
    };

    const existing = this.registry.get(peerId);
    if (existing) wire(existing);
    else void this.registry.connect(peerId).then(r => r.ok ? wire(r.value) : this.bus.emit('ui:toast', { message: 'Peer unreachable', kind: 'error' }));

    this.storeSystem(peerId, name || peerId, `You sent a friend request to ${name || peerId}`);
  }

  handleIncomingFriendRequest(data: Record<string, unknown>, fromPeerId: PeerId): void {
    const from     = (data['from'] as PeerId | undefined) ?? fromPeerId;
    const fromName = String(data['fromName'] ?? from);
    const reqId    = String(data['reqId'] ?? genId());

    if (this.friendManager.isBlocked(from)) return;

    // Stash the shared secret from the initiator.
    if (data['sharedSecret']) {
      // FriendManager will pick this up on confirm.
      this.friendManager['pendingTokens' as never] = undefined; // handled inside confirm
    }

    const requestMsg: Message = {
      id:       reqId as MessageId,
      type:     'chat',
      author:   fromName,
      authorId: from,
      content:  `${fromName} wants to be your friend`,
      ts:       Date.now(),
      channel:  'dm' as never,
    };

    const { dms } = friendsStore.get();
    const thread  = (dms[from] as Message[] | undefined) ?? [];
    if (!thread.some(m => m.id === reqId)) {
      this.storeMessage(from, requestMsg);
      this.save();
    }

    const { activeDMPeer } = friendsStore.get();
    if (activeDMPeer !== from) {
      friendsStore.set(s => ({
        ...s,
        dmUnread: { ...s.dmUnread, [from]: ((s.dmUnread[from] ?? 0) as number) + 1 },
      }));
    }

    this.bus.emit('friend:request-received', { fromPeerId: from, name: fromName, reqId });
    this.bus.emit('ui:toast', { message: `${fromName} wants to be your friend`, kind: 'info' });
    this.bus.emit('dm:received', { peerId: from, msg: requestMsg as never });
  }

  respondToFriendRequest(fromPid: PeerId, reqId: string, accept: boolean): void {
    const { myId, myName } = identityStore.get();
    if (!myId) return;

    const fromName = friendsStore.get().friends[fromPid]?.name ?? fromPid;

    const wire = (conn: { send(d: unknown): boolean }) => {
      conn.send({ type: 'friend_response', reqId, from: myId, fromName: myName, accept });
    };

    const existing = this.registry.get(fromPid);
    if (existing) wire(existing);
    else void this.registry.connect(fromPid).then(r => r.ok && wire(r.value));

    if (accept) {
      this.friendManager.confirmFriend(fromPid, fromName);
      this.storeSystem(fromPid, fromName, `You are now friends with ${fromName}`);
      this.bus.emit('friend:request-accepted', { peerId: fromPid, name: fromName });
    } else {
      this.storeSystem(fromPid, fromName, `You declined ${fromName}'s friend request`);
      this.bus.emit('friend:request-declined', { peerId: fromPid, name: fromName });
    }

    // Remove the request message from thread.
    friendsStore.set(s => {
      const thread = [...((s.dms[fromPid] as Message[] | undefined) ?? [])].filter(m => m.id !== reqId);
      return { ...s, dms: { ...s.dms, [fromPid]: thread } };
    });
    this.save();
  }

  handleIncomingFriendResponse(data: Record<string, unknown>, fromPeerId: PeerId): void {
    const from     = (data['from'] as PeerId | undefined) ?? fromPeerId;
    const fromName = String(data['fromName'] ?? from);
    const accept   = Boolean(data['accept']);

    if (accept) {
      this.friendManager.confirmFriend(from, fromName);
      this.storeSystem(from, fromName, `${fromName} accepted your friend request — you are now friends!`);
      this.bus.emit('ui:toast', { message: `${fromName} accepted your friend request!`, kind: 'success' });
    } else {
      this.storeSystem(from, fromName, `${fromName} declined your friend request`);
      this.bus.emit('ui:toast', { message: `${fromName} declined your friend request`, kind: 'info' });
    }
  }

  // ── Typing ────────────────────────────────────────────────────────────────

  sendTyping(peerId: PeerId): void {
    const { myId, myName } = identityStore.get();
    if (!myId) return;
    const conn = this.registry.get(peerId);
    conn?.send({ type: 'dm_typing', from: myId, fromName: myName, to: peerId });
  }

  handleTyping(data: Record<string, unknown>, fromPeerId: PeerId): void {
    const from     = (data['from'] as PeerId | undefined) ?? fromPeerId;
    const fromName = String(data['fromName'] ?? from);
    if (this.friendManager.isBlocked(from)) return;

    friendsStore.set(s => ({
      ...s,
      dmTypingPeers: { ...s.dmTypingPeers, [from]: fromName },
    }));
    this.bus.emit('dm:typing', { peerId: from, name: fromName });

    // Clear after 4 s.
    const existing = typingTimers.get(from);
    if (existing) clearTimeout(existing);
    typingTimers.set(from, setTimeout(() => {
      friendsStore.set(s => {
        const t = { ...s.dmTypingPeers };
        delete (t as Record<string, unknown>)[from];
        return { ...s, dmTypingPeers: t as never };
      });
      typingTimers.delete(from);
    }, 4000));
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  private storeMessage(peerId: PeerId, msg: Message): void {
    friendsStore.set(s => {
      const thread = [...((s.dms[peerId] as Message[] | undefined) ?? []), msg];
      if (thread.length > DM_MAX) thread.shift();
      return { ...s, dms: { ...s.dms, [peerId]: thread } };
    });
  }

  storeSystem(peerId: PeerId, _peerName: string, text: string): void {
    const msg: Message = {
      id:       genId() as MessageId,
      type:     'system',
      content:  text,
      ts:       Date.now(),
      channel:  'dm' as never,
      authorId: 'system' as never,
      author:   'System',
    };
    this.storeMessage(peerId, msg);
    this.save();
    this.bus.emit('dm:received', { peerId, msg: msg as never });
  }

  clearUnread(peerId: PeerId): void {
    friendsStore.set(s => ({ ...s, dmUnread: { ...s.dmUnread, [peerId]: 0 } }));
  }
}
