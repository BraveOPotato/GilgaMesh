// src/core/state/ui.ts
import { createStore, type Store } from './utils.js';
import type { PeerId, MessageId, Message } from '../types.js';

export interface MentionAutocomplete {
  readonly active:    boolean;
  readonly start:     number;
  readonly query:     string;
  readonly selected:  number;
  readonly matches:   readonly string[];
}

export interface SlashAutocomplete {
  readonly active:   boolean;
  readonly start:    number;
  readonly query:    string;
  readonly selected: number;
  readonly matches:  readonly string[];
}

export interface UIState {
  readonly sidebarOpen:  boolean;
  readonly netPanelOpen: boolean;
  readonly replyingTo:   Readonly<Pick<Message, 'id' | 'author' | 'content'>> | null;
  readonly mentionState: MentionAutocomplete;
  readonly slashState:   SlashAutocomplete;
  /** peerIds currently being contacted (shown as "checking…" in members list) */
  readonly peerChecking: readonly PeerId[];
  /** token → countdown remaining seconds */
  readonly fileShareCountdowns: Readonly<Record<string, number>>;
}

export const uiStore: Store<UIState> = createStore<UIState>({
  sidebarOpen:  false,
  netPanelOpen: false,
  replyingTo:   null,
  mentionState: { active: false, start: -1, query: '', selected: 0, matches: [] },
  slashState:   { active: false, start: -1, query: '', selected: 0, matches: [] },
  peerChecking: [],
  fileShareCountdowns: {},
});
