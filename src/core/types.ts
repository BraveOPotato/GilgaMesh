// src/core/types.ts
// ─── BRANDED TYPES ────────────────────────────────────────────────────────────
// Prevents mixing PeerId with RoomId at compile time.

declare const __brand: unique symbol;
type Brand<B> = { readonly [__brand]: B };

export type PeerId    = string & Brand<'PeerId'>;
export type RoomId    = string & Brand<'RoomId'>;
export type ChannelId = string & Brand<'ChannelId'>;
export type MessageId = string & Brand<'MessageId'>;
export type PluginId  = string & Brand<'PluginId'>;

// ─── RESULT TYPE ──────────────────────────────────────────────────────────────

export type Result<T, E> =
  | { readonly ok: true;  readonly value: T }
  | { readonly ok: false; readonly error: E };

export function ok<T>(value: T): Result<T, never> {
  return { ok: true, value };
}

export function err<E>(error: E): Result<never, E> {
  return { ok: false, error };
}

// ─── DOMAIN TYPES ─────────────────────────────────────────────────────────────

export interface Message {
  readonly id:       MessageId;
  readonly type:     'chat' | 'system' | 'file';
  readonly authorId: PeerId | 'system';
  readonly author:   string;
  readonly content:  string | null;
  readonly channel:  ChannelId;
  readonly ts:       number;
  readonly roomId?:  RoomId;
  readonly replyTo?: {
    readonly id:      MessageId;
    readonly author:  string;
    readonly content: string;
  };
  readonly pending?: boolean;
  readonly msgType?: 'file';
  readonly fileShare?: FileShare;
  readonly originId?: PeerId;
}

export interface DMMessage extends Message {
  readonly channel: ChannelId & 'dm';
}

export interface FileShare {
  readonly token:    string;
  readonly fromId:   PeerId;
  readonly fromName: string;
  readonly filename: string;
  readonly size:     number;
  readonly expires:  number;
}

export interface CommandContext {
  readonly roomId?:     RoomId;
  readonly channel?:    ChannelId;
  readonly dmPeerId?:   PeerId;
  readonly authorId:    PeerId;
  readonly authorName:  string;
}

export interface PluginManifest {
  readonly id:           PluginId;
  readonly name:         string;
  readonly version:      string;
  readonly description:  string;
  readonly permissions:  readonly string[];
  readonly botCommands?: readonly BotCommandDef[];
  readonly removable?:   boolean;
  readonly uiArea?:      string;
}

export interface BotCommandDef {
  readonly command:     string;
  readonly description: string;
  readonly scope:       'room' | 'dm' | 'both';
  readonly icon?:       string;
}

export interface Channel {
  readonly id:   ChannelId;
  readonly name: string;
  readonly desc: string;
}

export interface VoiceChannel {
  readonly id:   string;
  readonly name: string;
}

export interface PeerInfo {
  readonly id:               string;
  readonly name:             string;
  readonly distanceFromRoot: number;
  readonly childCount:       number;
  readonly descendantCount:  number;
  readonly voiceChannelId:   string | null;
}

export interface Friend {
  readonly id:           PeerId;
  readonly name:         string;
  readonly addedAt:      number;
  readonly nickname:     string;
  readonly sharedSecret: string | null;
  readonly impostor:     boolean;
}

export interface BlockedPeer {
  readonly id:        PeerId;
  readonly name:      string;
  readonly blockedAt: number;
}
