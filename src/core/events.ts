/**
 * src/core/events.ts — Central typed event bus.
 *
 * Rules:
 *  - Events are facts that happened, not commands.
 *  - Payloads are Readonly<T>.
 *  - Synchronous delivery preserves ordering.
 *  - No module imports a function from another module solely to call it.
 *    All cross-module communication goes through bus.emit() / bus.on().
 */

import type {
  PeerId, RoomId, ChannelId, MessageId, PluginId,
  Message, DMMessage, FileShare, CommandContext, PluginManifest,
  Channel, VoiceChannel,
} from './types.js';

// ─── EVENT MAP ────────────────────────────────────────────────────────────────
// Every event is documented: when emitted, who listens, payload shape.

export interface EventMap {
  // ── Peer lifecycle ──────────────────────────────────────────────────────────
  /** Emitted by PeerRegistry when connection confirmed open. Listened by UI, rooms. */
  'peer:online':          { readonly peerId: PeerId };
  /** Emitted by PeerConnection.dispose(). Listened by mesh, rooms, UI. */
  'peer:offline':         { readonly peerId: PeerId };
  /** Emitted by PeerConnection.recordPong(). Listened by UI latency display. */
  'peer:latency-update':  { readonly peerId: PeerId; readonly rtt: number };

  // ── Room topology ────────────────────────────────────────────────────────────
  /** Emitted by MeshNode.onAdoptAck(). Listened by rooms, UI. */
  'room:joined':            { readonly roomId: RoomId; readonly channel: ChannelId };
  /** Emitted by MeshNode.becomeRoot(). Listened by UI status bar. */
  'room:became-root':       { readonly roomId: RoomId };
  /** Emitted when root status lost (parent arrived). Listened by UI. */
  'room:lost-root':         { readonly roomId: RoomId };
  /** Emitted by MeshNode.onParentLost(). Listened by recovery engine. */
  'room:parent-lost':       { readonly roomId: RoomId; readonly lostParentId: PeerId };
  /** Emitted by RecoveryEngine.start(). Listened by UI. */
  'room:recovery-started':  { readonly roomId: RoomId };
  /** Emitted by RecoveryEngine when complete. Listened by UI. */
  'room:recovery-complete': { readonly roomId: RoomId; readonly newParentId: PeerId | null };
  /** Emitted by MeshNode on any state transition. Listened by UI topology panel. */
  'room:topology-changed':  { readonly roomId: RoomId };

  // ── Messaging ────────────────────────────────────────────────────────────────
  /** Emitted by MessageRouter on incoming message. Listened by rooms store, UI. */
  'room:message':          { readonly roomId: RoomId; readonly msg: Readonly<Message>; readonly fromPeerId: PeerId };
  /** Emitted by MessageRouter on typing packet. Listened by UI. */
  'room:typing':           { readonly roomId: RoomId; readonly channel: ChannelId; readonly peerId: PeerId; readonly name: string };
  /** Emitted by rooms module on system events. Listened by UI message list. */
  'room:system':           { readonly roomId: RoomId; readonly channel: ChannelId; readonly text: string };
  /** Emitted when new channel created. Listened by UI sidebar. */
  'room:channel-created':  { readonly roomId: RoomId; readonly channel: Readonly<Channel> };
  /** Emitted when msg_ack received for a pending message. Listened by UI. */
  'room:msg-acked':        { readonly roomId: RoomId; readonly msgId: MessageId };

  // ── Voice ────────────────────────────────────────────────────────────────────
  /** Emitted by VoicePipeline.start(). Listened by UI voice panel. */
  'voice:joined':          { readonly roomId: RoomId; readonly channelId: string };
  /** Emitted by VoicePipeline.stop(). Listened by UI voice panel. */
  'voice:left':            { readonly roomId: RoomId };
  /** Emitted by VoicePipeline on VAD activity change. Listened by UI speaking indicators. */
  'voice:speaking':        { readonly roomId: RoomId; readonly peerId: PeerId; readonly active: boolean };
  /** Emitted when voice channel created. Listened by UI sidebar. */
  'voice:channel-created': { readonly roomId: RoomId; readonly channel: Readonly<VoiceChannel> };

  // ── Friends / DM ─────────────────────────────────────────────────────────────
  /** Emitted by DMManager on incoming DM. Listened by UI DM thread. */
  'dm:received':                { readonly peerId: PeerId; readonly msg: Readonly<DMMessage> };
  /** Emitted by DMManager after sending DM. Listened by UI DM thread. */
  'dm:sent':                    { readonly peerId: PeerId; readonly msg: Readonly<DMMessage> };
  /** Emitted when friend request received. Listened by UI notification. */
  'friend:request-received':    { readonly fromPeerId: PeerId; readonly name: string; readonly reqId: string };
  /** Emitted when friend request accepted. Listened by UI. */
  'friend:request-accepted':    { readonly peerId: PeerId; readonly name: string };
  /** Emitted when friend request declined. Listened by UI. */
  'friend:request-declined':    { readonly peerId: PeerId; readonly name: string };
  /** Emitted when friend removed. Listened by UI friends list. */
  'friend:removed':             { readonly peerId: PeerId };
  /** Emitted when peer blocked. Listened by UI, message filter. */
  'peer:blocked':               { readonly peerId: PeerId };
  /** Emitted when peer unblocked. Listened by UI. */
  'peer:unblocked':             { readonly peerId: PeerId };
  /** Emitted when identity verification completes. Listened by UI friend card. */
  'peer:verified':              { readonly peerId: PeerId; readonly verified: boolean };
  /** Emitted when DM call state changes. Listened by UI call overlay. */
  'dm:call-state-changed':      { readonly peerId: PeerId; readonly state: 'incoming' | 'outgoing' | 'active' | 'ended' };
  /** Emitted on DM typing event. Listened by UI typing indicator. */
  'dm:typing':                  { readonly peerId: PeerId; readonly name: string };

  // ── File sharing ─────────────────────────────────────────────────────────────
  /** Emitted by ShareManager when link created. Listened by UI file modal. */
  'file:share-created':    { readonly token: string; readonly fileShare: Readonly<FileShare> };
  /** Emitted when download request received. Listened by UI. */
  'file:download-request': { readonly token: string; readonly fromId: PeerId; readonly filename: string };
  /** Emitted when share expires. Listened by UI countdown. */
  'file:share-expired':    { readonly token: string };

  // ── Plugins ──────────────────────────────────────────────────────────────────
  /** Emitted by PluginHost.install(). Listened by plugins store, UI. */
  'plugin:installed':  { readonly pluginId: PluginId; readonly manifest: Readonly<PluginManifest> };
  /** Emitted by PluginHost.remove(). Listened by plugins store, UI. */
  'plugin:removed':    { readonly pluginId: PluginId };
  /** Emitted by PluginHost.enable(). Listened by UI toggle. */
  'plugin:enabled':    { readonly pluginId: PluginId };
  /** Emitted by PluginHost.disable(). Listened by UI toggle. */
  'plugin:disabled':   { readonly pluginId: PluginId };
  /** Emitted when bot command dispatched. Listened by PluginHost, UI message area. */
  'plugin:command':    { readonly pluginId: PluginId; readonly command: string; readonly args: string; readonly context: Readonly<CommandContext> };

  // ── Internal network events (not for UI consumption) ────────────────────────
  /** Emitted by PeerConnection on each data frame. Consumed by main dispatcher. */
  'peer:data-received':     { readonly peerId: PeerId; readonly data: unknown; readonly conn: unknown };
  /** Emitted by PeerRegistry when a connection is confirmed open. */
  'peer:connection-opened': { readonly peerId: PeerId; readonly conn: unknown };

  // ── UI (view-layer intent events) ────────────────────────────────────────────
  // These are fired by DOM delegation and consumed by domain modules.
  // Domain modules NEVER query the DOM directly.
  'ui:room-selected':             { readonly roomId: RoomId };
  'ui:channel-selected':          { readonly roomId: RoomId; readonly channelId: ChannelId };
  'ui:peer-selected':             { readonly peerId: PeerId };
  'ui:reply-initiated':           { readonly msgId: MessageId };
  'ui:mention-clicked':           { readonly peerId: PeerId };
  'ui:file-share-triggered':      { readonly roomId: RoomId | null; readonly dmPeerId: PeerId | null };
  'ui:voice-join-requested':      { readonly roomId: RoomId; readonly channelId: string };
  'ui:voice-leave-requested':     { readonly roomId: RoomId };
  'ui:call-accepted':             { readonly peerId: PeerId };
  'ui:call-declined':             { readonly peerId: PeerId };
  'ui:call-ended':                { readonly peerId: PeerId };
  'ui:friend-request-responded':  { readonly peerId: PeerId; readonly reqId: string; readonly accept: boolean };
  'ui:plugin-install-requested':  { readonly baseUrl: string } | { readonly manifest: PluginManifest; readonly source: string };
  'ui:plugin-remove-requested':   { readonly pluginId: PluginId };
  'ui:plugin-toggle-requested':   { readonly pluginId: PluginId; readonly enabled: boolean };
  'ui:modal-close-requested':     Record<string, never>;
  'ui:message-send-requested':    { readonly roomId: RoomId; readonly channel: ChannelId; readonly content: string; readonly replyTo?: Message };
  'ui:dm-send-requested':         { readonly peerId: PeerId; readonly content: string };
  'ui:room-create-requested':     { readonly name: string };
  'ui:room-join-requested':       { readonly roomId: RoomId; readonly roomName: string; readonly viaPeerId: PeerId };
  'ui:room-leave-requested':      { readonly roomId: RoomId };
  'ui:channel-create-requested':  { readonly roomId: RoomId; readonly name: string; readonly desc: string };
  'ui:theme-changed':             { readonly theme: 'dark' | 'light' };
  'ui:name-changed':              { readonly name: string };
  'ui:toast':                     { readonly message: string; readonly kind: 'info' | 'success' | 'error' | 'warning' };
}

export type EventName = keyof EventMap;

// ─── EVENT BUS ────────────────────────────────────────────────────────────────

export class EventBus {
  private readonly listeners = new Map<EventName, Set<(payload: unknown) => void>>();
  private readonly logger?: (event: EventName, payload: unknown, count: number) => void;

  constructor(options?: {
    readonly logger?: (event: EventName, payload: unknown, count: number) => void;
  }) {
    this.logger = options?.logger;
  }

  /**
   * Subscribe to an event. Returns unsubscribe function.
   * Store the returned function and call it on cleanup to prevent leaks.
   */
  on<K extends EventName>(
    event: K,
    handler: (payload: EventMap[K]) => void,
  ): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    const wrapped = (p: unknown) => handler(p as EventMap[K]);
    set.add(wrapped);

    return () => {
      set!.delete(wrapped);
      if (set!.size === 0) this.listeners.delete(event);
    };
  }

  /**
   * Subscribe once — auto-unsubscribes after first delivery.
   */
  once<K extends EventName>(
    event: K,
    handler: (payload: EventMap[K]) => void,
  ): () => void {
    const unsub = this.on(event, (payload) => {
      unsub();
      handler(payload);
    });
    return unsub;
  }

  /**
   * Emit an event. All handlers called synchronously in subscription order.
   * Errors in individual handlers are caught and logged — never crash the bus.
   */
  emit<K extends EventName>(event: K, payload: EventMap[K]): void {
    const set = this.listeners.get(event);
    const count = set?.size ?? 0;
    this.logger?.(event, payload, count);

    if (!set) return;

    for (const handler of set) {
      try {
        handler(payload);
      } catch (err) {
        console.error(`[EventBus] Error in "${event}" handler:`, err);
      }
    }
  }

  listenerCount<K extends EventName>(event: K): number {
    return this.listeners.get(event)?.size ?? 0;
  }

  /** Remove all listeners — useful in tests. */
  clear(): void {
    this.listeners.clear();
  }
}

// ─── SINGLETON ────────────────────────────────────────────────────────────────

export const bus = new EventBus({
  logger:
    typeof process !== 'undefined' && process.env?.['NODE_ENV'] === 'development'
      ? (event, _payload, count) => {
          if (count === 0) console.warn(`[EventBus] "${event}" emitted with no listeners`);
        }
      : undefined,
});
