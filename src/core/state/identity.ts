// src/core/state/identity.ts
import { createStore, type Store } from './utils.js';
import type { PeerId } from '../types.js';

export interface IdentityState {
  /** PeerJS Peer instance. Typed as unknown — callers cast via type guard. */
  readonly peer:    unknown | null;
  readonly myId:    PeerId | null;
  readonly myName:  string;
  /** User-set display name aliases for peers. peerId → alias */
  readonly peerAliases: Readonly<Record<string, string>>;
  readonly currentTheme: 'dark' | 'light';
}

export const identityStore: Store<IdentityState> = createStore<IdentityState>({
  peer:         null,
  myId:         null,
  myName:       '',
  peerAliases:  {},
  currentTheme: 'dark',
});
