/**
 * src/ui/stores/view-store.ts — UI-local view state.
 *
 * Separate from domain stores: sidebar open/closed, active modal,
 * reply target, autocomplete state. All purely presentational.
 */

import { createStore, type Store } from '../../core/state/utils.js';
import type { Message } from '../../core/types.js';

export type ModalName =
  | 'settings'
  | 'room-settings'
  | 'invite'
  | 'create-room'
  | 'add-channel'
  | 'leave-confirm'
  | 'file-share'
  | 'peer-profile'
  | 'plugin-settings'
  | 'plugin-marketplace'
  | 'room-plugins';

export interface MentionAutocomplete {
  readonly active:   boolean;
  readonly start:    number;
  readonly query:    string;
  readonly selected: number;
  readonly matches:  readonly string[];
}

export interface SlashAutocomplete {
  readonly active:   boolean;
  readonly start:    number;
  readonly query:    string;
  readonly selected: number;
  readonly matches:  readonly string[];
}

export interface ViewState {
  readonly sidebarOpen:        boolean;
  readonly netPanelOpen:       boolean;
  readonly openModal:          ModalName | null;
  readonly replyingTo:         Readonly<Pick<Message, 'id' | 'author' | 'content'>> | null;
  readonly mentionState:       MentionAutocomplete;
  readonly slashState:         SlashAutocomplete;
  readonly peerCheckingIds:    readonly string[];
  readonly fileShareCountdowns: Readonly<Record<string, number>>;
}

export const viewStore: Store<ViewState> = createStore<ViewState>({
  sidebarOpen:         false,
  netPanelOpen:        false,
  openModal:           null,
  replyingTo:          null,
  mentionState:        { active: false, start: -1, query: '', selected: 0, matches: [] },
  slashState:          { active: false, start: -1, query: '', selected: 0, matches: [] },
  peerCheckingIds:     [],
  fileShareCountdowns: {},
});

// ─── HELPERS ─────────────────────────────────────────────────────────────────

export function openModal(name: ModalName): void {
  viewStore.set(s => ({ ...s, openModal: name }));
}

export function closeModal(): void {
  viewStore.set(s => ({ ...s, openModal: null }));
}

export function setReplyingTo(msg: Pick<Message, 'id' | 'author' | 'content'> | null): void {
  viewStore.set(s => ({ ...s, replyingTo: msg }));
}
