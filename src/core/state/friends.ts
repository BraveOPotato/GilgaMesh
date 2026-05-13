// src/core/state/friends.ts
import { createStore, type Store } from './utils.js';
import type { PeerId, Message, Friend, BlockedPeer } from '../types.js';

export interface DMThread {
  readonly messages: readonly Message[];
  readonly unread:   number;
}

export interface DMCall {
  readonly peerId:    PeerId;
  readonly peerName:  string;
  readonly active:    boolean;
  readonly initiator: boolean;
}

export interface FriendsState {
  readonly friends:       Readonly<Record<string, Friend>>;
  readonly blocked:       Readonly<Record<string, BlockedPeer>>;
  readonly dms:           Readonly<Record<string, DMThread>>;
  readonly dmUnread:      Readonly<Record<string, number>>;
  readonly activeDMPeer:  PeerId | null;
  readonly dmCall:        DMCall | null;
  /** peerId → name, transiently populated when peer is typing in DM */
  readonly dmTypingPeers: Readonly<Record<string, string>>;
  /** peerId → true when speaking in DM call */
  readonly dmCallSpeakers: Readonly<Record<string, boolean>>;
  readonly activeFriendsView: boolean;
}

export const friendsStore: Store<FriendsState> = createStore<FriendsState>({
  friends:            {},
  blocked:            {},
  dms:                {},
  dmUnread:           {},
  activeDMPeer:       null,
  dmCall:             null,
  dmTypingPeers:      {},
  dmCallSpeakers:     {},
  activeFriendsView:  false,
});
