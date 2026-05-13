/**
 * src/friends/friend-manager.ts — Friends list, verification, block list.
 *
 * Owns the friends and blocked maps in friendsStore.
 * All cross-module communication via EventBus — no direct UI imports.
 */

import type { EventBus, PeerId } from '../core/events.js';
import { friendsStore } from '../core/state/friends.js';
import { identityStore } from '../core/state/identity.js';
import { genId } from '../utils/id-generator.js';
import type { Friend, BlockedPeer } from '../core/types.js';

const FRIENDS_KEY = 'gilgamesh_friends';
const BLOCKED_KEY = 'gilgamesh_blocked';

// Stash tokens received before friendship is confirmed.
const pendingTokens = new Map<PeerId, string>();

export class FriendManager {
  constructor(private readonly bus: EventBus) {}

  // ── Persistence ───────────────────────────────────────────────────────────

  load(): void {
    try {
      const friends = JSON.parse(localStorage.getItem(FRIENDS_KEY) ?? '{}') as Record<string, Friend>;
      const blocked = JSON.parse(localStorage.getItem(BLOCKED_KEY) ?? '{}') as Record<string, BlockedPeer>;
      friendsStore.set(s => ({ ...s, friends: friends as never, blocked: blocked as never }));
    } catch (e) {
      console.warn('[FriendManager] load error:', e);
    }
  }

  save(): void {
    const { friends, blocked } = friendsStore.get();
    try {
      localStorage.setItem(FRIENDS_KEY, JSON.stringify(friends));
      localStorage.setItem(BLOCKED_KEY, JSON.stringify(blocked));
    } catch {}
  }

  // ── Verification ──────────────────────────────────────────────────────────

  /**
   * Handle verify_token sent by a peer when their connection opens.
   *
   * Cases:
   *  1a. Token matches stored friend, same peerId   → verified
   *  1b. Token matches but peerId changed (rotation) → update record silently
   *  1c. Known friend, wrong token                  → impostor warning
   *  1d. Unknown peer                               → stash for later
   */
  handleVerifyToken(remotePid: PeerId, remoteToken: string, remoteName: string): void {
    const { friends } = friendsStore.get();

    // Search all friends for matching shared secret.
    const matchEntry = Object.entries(friends).find(
      ([, f]) => f.sharedSecret && f.sharedSecret === remoteToken,
    );

    if (matchEntry) {
      const [storedPid, friend] = matchEntry;
      if (storedPid === remotePid) {
        // 1a — correct peer and secret.
        if (friend.impostor) {
          friendsStore.set(s => ({
            ...s,
            friends: { ...s.friends, [remotePid]: { ...s.friends[remotePid]!, impostor: false } },
          }));
          this.save();
        }
        this.bus.emit('peer:verified', { peerId: remotePid, verified: true });
      } else {
        // 1b — peer rotated ID; update record.
        friendsStore.set(s => {
          const fs = { ...s.friends };
          delete (fs as Record<string, unknown>)[storedPid];
          fs[remotePid] = { ...friend, id: remotePid, name: remoteName, impostor: false };
          return { ...s, friends: fs as never };
        });
        this.save();
        this.bus.emit('peer:verified', { peerId: remotePid, verified: true });
        this.bus.emit('ui:toast', {
          message: `${remoteName} reconnected with a new peer ID (identity verified ✓)`,
          kind: 'info',
        });
      }
      return;
    }

    const knownFriend = friends[remotePid];
    if (knownFriend) {
      if (!knownFriend.sharedSecret) {
        // Legacy record — trust first token.
        friendsStore.set(s => ({
          ...s,
          friends: { ...s.friends, [remotePid]: { ...s.friends[remotePid]!, sharedSecret: remoteToken, impostor: false } },
        }));
        this.save();
      } else {
        // 1c — wrong token.
        friendsStore.set(s => ({
          ...s,
          friends: { ...s.friends, [remotePid]: { ...s.friends[remotePid]!, impostor: true } },
        }));
        this.save();
        this.bus.emit('peer:verified', { peerId: remotePid, verified: false });
        this.bus.emit('ui:toast', {
          message: `⚠️ ${remoteName} connected with an unexpected identity token`,
          kind: 'error',
        });
      }
      return;
    }

    // 1d — stash.
    pendingTokens.set(remotePid, remoteToken);
  }

  // ── Friend management ─────────────────────────────────────────────────────

  addFriend(peerId: PeerId, name: string): Friend {
    const sharedSecret = genId() + genId();
    const friend: Friend = {
      id:           peerId,
      name:         name || peerId,
      addedAt:      Date.now(),
      nickname:     '',
      sharedSecret: sharedSecret,
      impostor:     false,
    };

    // If peer already sent us a token, attach it as the shared secret.
    const pending = pendingTokens.get(peerId);
    if (pending && !friend.sharedSecret) {
      (friend as { sharedSecret: string }).sharedSecret = pending;
      pendingTokens.delete(peerId);
    }

    friendsStore.set(s => ({
      ...s,
      friends: { ...s.friends, [peerId]: friend },
    }));
    this.save();
    return friend;
  }

  confirmFriend(peerId: PeerId, name: string): void {
    const existing = friendsStore.get().friends[peerId];
    const friend: Friend = {
      id:           peerId,
      name:         name || peerId,
      addedAt:      existing?.addedAt ?? Date.now(),
      nickname:     existing?.nickname ?? '',
      sharedSecret: existing?.sharedSecret ?? pendingTokens.get(peerId) ?? null,
      impostor:     false,
    };
    pendingTokens.delete(peerId);
    friendsStore.set(s => ({ ...s, friends: { ...s.friends, [peerId]: friend } }));
    this.save();
    this.bus.emit('friend:request-accepted', { peerId, name });
  }

  removeFriend(peerId: PeerId): void {
    const { friends } = friendsStore.get();
    const name = friends[peerId]?.name ?? peerId;
    friendsStore.set(s => {
      const fs = { ...s.friends };
      delete (fs as Record<string, unknown>)[peerId];
      return { ...s, friends: fs as never };
    });
    this.save();
    this.bus.emit('friend:removed', { peerId });
    this.bus.emit('ui:toast', { message: `${name} removed from friends`, kind: 'info' });
  }

  setNickname(peerId: PeerId, nickname: string): void {
    const { friends } = friendsStore.get();
    if (!friends[peerId]) return;
    friendsStore.set(s => ({
      ...s,
      friends: { ...s.friends, [peerId]: { ...s.friends[peerId]!, nickname: nickname.trim() } },
    }));
    this.save();
    this.bus.emit('ui:toast', {
      message: nickname.trim() ? `Nickname set to "${nickname.trim()}"` : 'Nickname cleared',
      kind: 'success',
    });
  }

  isFriend(peerId: PeerId): boolean {
    return Boolean(friendsStore.get().friends[peerId]);
  }

  getSharedSecret(peerId: PeerId): string | null {
    return friendsStore.get().friends[peerId]?.sharedSecret ?? null;
  }

  // ── Block list ────────────────────────────────────────────────────────────

  blockPeer(peerId: PeerId, name: string): void {
    const blocked: BlockedPeer = { id: peerId, name: name || peerId, blockedAt: Date.now() };
    friendsStore.set(s => {
      const fs = { ...s.friends };
      delete (fs as Record<string, unknown>)[peerId];
      return { ...s, friends: fs as never, blocked: { ...s.blocked, [peerId]: blocked } };
    });
    this.save();
    this.bus.emit('peer:blocked', { peerId });
    this.bus.emit('ui:toast', { message: `${name || peerId} blocked`, kind: 'info' });
  }

  unblockPeer(peerId: PeerId): void {
    const { blocked } = friendsStore.get();
    const name = blocked[peerId]?.name ?? peerId;
    friendsStore.set(s => {
      const bl = { ...s.blocked };
      delete (bl as Record<string, unknown>)[peerId];
      return { ...s, blocked: bl as never };
    });
    this.save();
    this.bus.emit('peer:unblocked', { peerId });
    this.bus.emit('ui:toast', { message: `${name} unblocked`, kind: 'info' });
  }

  isBlocked(peerId: PeerId): boolean {
    return Boolean(friendsStore.get().blocked[peerId]);
  }
}
