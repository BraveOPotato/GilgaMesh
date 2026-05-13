// src/core/state/rooms.ts
import { createStore, type Store } from './utils.js';
import type { RoomId, ChannelId, PeerId, Message } from '../types.js';
import type { Channel, VoiceChannel, PeerInfo } from '../types.js';

// ─── ROOM TOPOLOGY ────────────────────────────────────────────────────────────

export interface ClusterMapEntry {
  readonly name:            string;
  readonly distance:        number;
  readonly childCount:      number;
  readonly connCount:       number;
  readonly descendantCount: number;
  readonly voiceChannelId?: string | null;
}

export interface Room {
  readonly id:         RoomId;
  readonly name:       string;
  readonly createdBy:  PeerId | null;

  // ── Topology ────────────────────────────────────────────────────────────────
  readonly parentId:          PeerId | null;
  readonly grandparentId:     PeerId | null;
  readonly childIds:          readonly PeerId[];
  readonly backupId:          PeerId | null;
  readonly distanceFromRoot:  number;
  readonly siblings:          readonly PeerId[];
  readonly bestSibling:       PeerId | null;
  readonly myVoiceChannelId:  string | null;
  readonly clusterMap:        Readonly<Record<string, ClusterMapEntry>>;
  readonly recoveryLock:      number; // epoch ms until which recovery suppressed

  // ── Channels & messages ──────────────────────────────────────────────────────
  readonly channels:      readonly Channel[];
  readonly voiceChannels: readonly VoiceChannel[];
  readonly messages:      Readonly<Record<ChannelId, readonly Message[]>>;
  readonly unread:        Readonly<Record<ChannelId, number>>;
  readonly pendingMsgIds: readonly string[]; // message IDs awaiting ack

  // ── Peer registry ────────────────────────────────────────────────────────────
  readonly peers:      Readonly<Record<string, PeerInfo>>;
  readonly savedPeers: readonly string[];

  // ── Dedup caches ─────────────────────────────────────────────────────────────
  readonly seenMsgIds:    readonly string[];
  readonly seenTypingIds: readonly string[];

  // ── Typing ───────────────────────────────────────────────────────────────────
  /** peerId → name, populated transiently; cleared after 4 s */
  readonly typingPeers: Readonly<Record<string, string>>;

  // ── Election ─────────────────────────────────────────────────────────────────
  readonly electionEpoch: number;
  readonly electionVotes: Readonly<Record<string, number>>;
}

// ─── ROOMS STATE ──────────────────────────────────────────────────────────────

export interface RoomsState {
  readonly rooms:         Readonly<Record<RoomId, Room>>;
  readonly activeRoomId:  RoomId | null;
  readonly activeChannel: ChannelId;
}

export const DEFAULT_CHANNELS: readonly Channel[] = [
  { id: 'general' as ChannelId, name: 'general', desc: 'General chat' },
  { id: 'random'  as ChannelId, name: 'random',  desc: 'Anything goes' },
];

export const DEFAULT_VOICE_CHANNELS: readonly VoiceChannel[] = [
  { id: 'vc-general', name: 'general' },
];

export const roomsStore: Store<RoomsState> = createStore<RoomsState>({
  rooms:         {},
  activeRoomId:  null,
  activeChannel: 'general' as ChannelId,
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────

/** Create a blank room shell matching original makeRoomShell() logic. */
export function makeRoomShell(
  id: RoomId,
  name: string,
  createdBy: PeerId | null,
): Room {
  const messages: Record<string, readonly Message[]> = {};
  const unread:   Record<string, number> = {};
  for (const ch of DEFAULT_CHANNELS) {
    messages[ch.id] = [];
    unread[ch.id]   = 0;
  }

  return {
    id, name, createdBy,

    parentId:         null,
    grandparentId:    null,
    childIds:         [],
    backupId:         null,
    distanceFromRoot: 0,
    siblings:         [],
    bestSibling:      null,
    myVoiceChannelId: null,
    clusterMap:       {},
    recoveryLock:     0,

    channels:      DEFAULT_CHANNELS,
    voiceChannels: DEFAULT_VOICE_CHANNELS,
    messages:      messages as Readonly<Record<ChannelId, readonly Message[]>>,
    unread:        unread   as Readonly<Record<ChannelId, number>>,
    pendingMsgIds: [],

    peers:      {},
    savedPeers: [],

    seenMsgIds:    [],
    seenTypingIds: [],
    typingPeers:   {},

    electionEpoch: 0,
    electionVotes: {},
  };
}

/** True if rid exists and has no parent (is root). */
export function roomIsRoot(rid: RoomId): boolean {
  const room = roomsStore.get().rooms[rid];
  return room?.parentId === null || room?.parentId === undefined;
}

/** Total connection count for a room (parent + children + backup). */
export function totalConnCount(rid: RoomId): number {
  const room = roomsStore.get().rooms[rid];
  if (!room) return 0;
  let n = room.childIds.length;
  if (room.parentId) n++;
  if (room.backupId)  n++;
  return n;
}
