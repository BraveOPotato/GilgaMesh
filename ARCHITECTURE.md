# GilgaMesh Architecture

## Overview

GilgaMesh is a serverless P2P chat application built on PeerJS (WebRTC). It uses
a tree-shaped mesh topology where each room has a root node that all messages
propagate through, providing ordering guarantees without a central server.

---

## Module Boundaries

```
src/
├── core/           # Zero-dependency foundation. Imported by everyone.
│   ├── types.ts        Branded types, Result<T,E>, domain interfaces
│   ├── events.ts       EventBus + EventMap — all cross-module communication
│   ├── constants.ts    Network tuning constants
│   └── state/          Immutable reactive stores (one per domain)
│       ├── utils.ts        createStore() factory
│       ├── identity.ts     myId, myName, theme
│       ├── rooms.ts        rooms map, topology, messages
│       ├── friends.ts      friends, blocked, DMs, call state
│       ├── plugins.ts      installed plugins, bot commands
│       └── ui.ts           view-layer state (sidebar, autocomplete)
│
├── network/        # P2P transport. No DOM. No UI imports.
│   ├── peerjs-types.ts     PeerJS type shim
│   ├── peer-connection.ts  Lifecycle wrapper around DataConnection
│   ├── peer-registry.ts    All connections, dedup, heartbeat, handshake
│   ├── mesh-node.ts        Per-room state machine (orphan/joining/child/root)
│   ├── mesh-recovery.ts    Parent-loss recovery engine
│   ├── mesh-rebalance.ts   Background rebalancer
│   ├── topology-scout.ts   Pre-join cluster map discovery
│   └── message-router.ts   Tree-based message relay + ack routing
│
├── voice/          # Audio pipeline. No DOM (except AudioContext). No UI imports.
│   ├── vad.ts              Voice activity detection (RMS energy)
│   ├── capture/index.ts    OpusCaptureEngine + PcmCaptureEngine (strategy)
│   ├── playback/index.ts   OpusPlaybackEngine + PcmPlaybackEngine (strategy)
│   └── pipeline.ts         Orchestrator — capture → VAD → route → playback
│
├── plugins/        # Plugin system. No domain logic. No direct state mutation.
│   ├── types.ts            PluginManifest, KNOWN_PERMISSIONS, PluginEntry
│   ├── host.ts             PluginHost — lifecycle, postMessage broker, API
│   ├── sandbox/            IframeSandbox (allow-scripts only, no same-origin)
│   ├── permissions/        PermissionEngine — validate + check
│   └── marketplace/        fetchMarketplace, fetchPluginPackage (TTL cached)
│
├── ui/             # View layer. Only module that touches DOM.
│   ├── events.ts           Single-listener click/keydown delegation
│   ├── renderers/          Pure HTML-string generators (markdown, avatar, time)
│   ├── components/         MessageList, MessageItem, ToastContainer
│   ├── stores/             view-store (modal, reply, autocomplete)
│   └── index.ts            Bootstrap — subscribes stores → renders DOM
│
├── utils/          # Pure helpers. No side effects.
│   ├── id-generator.ts     generatePeerId, generateRoomId, genId
│   ├── format.ts           escapeHtml, formatBytes, stringToColor
│   └── clipboard.ts        copyToClipboard → Promise<boolean>
│
└── main.ts         # Bootstrap only. Wires modules via EventBus.
```

### Hard Rules

| Rule | Rationale |
|------|-----------|
| No module imports a function from another module solely to call it | Use `bus.emit()` / `bus.on()` instead |
| `src/ui/` is the only layer that touches the DOM | Network/voice/plugins emit events; UI listens and renders |
| No `window.*` assignments | Use `data-*` attributes + event delegation |
| No direct state mutations | Use `store.set(updater)` with immutable updates |
| No `any` type | Use `unknown` with type guards |
| All async errors return `Result<T, E>` | No throwing for expected failure paths |
| No module > 400 lines | Split by responsibility |
| No circular imports | Extract shared interface to `core/` if two modules need each other |

---

## Data Flow

### Message Send (non-root node)

```
User types → ui:message-send-requested
  → main.ts sendMsg()
    → roomsStore.set() (store locally)
    → bus.emit('room:message')     ← UI appends pending message
    → meshNode.sendToParent()      ← relay_message upstream
    → meshNode.sendToAllChildren() ← relay_message downstream

Root receives relay_message:
  → MessageRouter.route()
    → bus.emit('room:message')     ← UI un-grays on other nodes
    → propagateDown to all children except sender
    → send msg_ack hop-by-hop back

Origin receives msg_ack:
  → MessageRouter.routeAck()
    → bus.emit('room:msg-acked')   ← UI removes pending badge
```

### Peer Joins a Room

```
User clicks invite link → url param ?join=RID&via=PEER_ID
  → checkUrlParams() → bus.emit('ui:room-join-requested')
    → main.ts joinRoom()
      → TopologyScout.scoutWithRetry()   ← temp conn, get cluster map
        → cluster_map_request / cluster_map
      → makeRoomShell() → roomsStore.set()
      → ensureNode(roomId)               ← creates MeshNode + RecoveryEngine
      → tryJoin(candidates)
        → MeshNode.joinParent(candidate)
          → PeerRegistry.connect()
          → send adopt_request
        → receives adopt_ack
          → MeshNode.onAdoptAck()
            → bus.emit('room:joined')    ← UI updates status bar
```

### Parent Loss Recovery

```
Heartbeat timeout / DataConnection close
  → PeerConnection.dispose()
    → bus.emit('peer:offline')
      → main.ts: if was parent → meshNode.onParentLost()
        → bus.emit('room:parent-lost')
          → RecoveryEngine.start()
            1. Try grandparent directly (fast path)
            2. Query up to 5 known peers for descendant counts
            3. After 5s: pick winner by (DC, nodeId lex)
               - winner > us → adopt_request
               - us > winner → become_root + pull winner down
```

### Voice Join

```
User clicks voice channel
  → ui:voice-join-requested
    → main.ts joinVoice()
      → VoicePipeline.create()      ← runtime WebCodecs check
      → pipeline.start()
        → getUserMedia()
        → CaptureEngine.start()     ← Opus or PCM strategy
      → roomsStore.set(myVoiceChannelId)
      → meshNode.updateClusterMapSelf()
      → meshNode.broadcastClusterMap()

Each captured frame:
  → VAD.isVoice() — drop silence
  → send to parent (if same vcId) + all children
  → other nodes call pipeline.onIncomingVoiceData()
    → PlaybackEngine.enqueue()      ← per-peer scheduled playhead
    → bus.emit('voice:speaking')    ← UI speaking indicator
```

---

## Event Catalog

### Peer Lifecycle

| Event | Emitted by | Consumed by |
|-------|-----------|-------------|
| `peer:online` | PeerRegistry | UI peer list |
| `peer:offline` | PeerConnection.dispose() | main.ts (mesh cleanup), UI |
| `peer:latency-update` | PeerConnection.recordPong() | UI latency display |

### Room Topology

| Event | Emitted by | Consumed by |
|-------|-----------|-------------|
| `room:joined` | MeshNode.onAdoptAck() | UI status bar |
| `room:became-root` | MeshNode.becomeRoot() | UI status bar |
| `room:parent-lost` | MeshNode.onParentLost() | RecoveryEngine |
| `room:recovery-started` | MeshNode.onParentLost() | UI |
| `room:recovery-complete` | RecoveryEngine.decide() | UI |
| `room:topology-changed` | MeshNode (any transition) | UI network panel |

### Messaging

| Event | Emitted by | Consumed by |
|-------|-----------|-------------|
| `room:message` | MessageRouter.route() | UI message list |
| `room:msg-acked` | MessageRouter.routeAck() | UI (un-gray pending) |
| `room:typing` | MessageRouter.routeTyping() | UI typing indicator |
| `room:system` | main.ts handleAdoptRequest() | UI message list |
| `room:channel-created` | rooms domain | UI sidebar |

### Voice

| Event | Emitted by | Consumed by |
|-------|-----------|-------------|
| `voice:joined` | VoicePipeline.start() | UI voice panel |
| `voice:left` | VoicePipeline.stop() | UI voice panel |
| `voice:speaking` | VoicePipeline (per frame) | UI speaking rings |

### Friends / DM

| Event | Emitted by | Consumed by |
|-------|-----------|-------------|
| `dm:received` | DMManager | UI DM thread |
| `dm:sent` | DMManager | UI DM thread |
| `friend:request-received` | FriendManager | UI notification |
| `friend:request-accepted` | FriendManager | UI friends list |
| `peer:verified` | VerificationEngine | UI friend card |

### Plugins

| Event | Emitted by | Consumed by |
|-------|-----------|-------------|
| `plugin:installed` | PluginHost.install() | pluginsStore, UI |
| `plugin:removed` | PluginHost.remove() | pluginsStore, UI |
| `plugin:enabled` | PluginHost.enable() | UI toggle |
| `plugin:disabled` | PluginHost.disable() | UI toggle |
| `plugin:command` | PluginHost.dispatchBotCommand() | UI message area |

### UI Intent Events (view → domain)

| Event | Emitted by | Consumed by |
|-------|-----------|-------------|
| `ui:room-selected` | DOM delegation | main.ts (switch room) |
| `ui:channel-selected` | DOM delegation | UI (switch channel) |
| `ui:message-send-requested` | DOM delegation / plugins | main.ts sendMsg() |
| `ui:voice-join-requested` | DOM delegation | main.ts joinVoice() |
| `ui:file-share-triggered` | DOM delegation | files domain |
| `ui:plugin-install-requested` | DOM delegation / UI | main.ts → PluginHost |
| `ui:toast` | any module | ToastContainer |
| `ui:modal-close-requested` | keydown Escape / click | viewStore |
| `ui:reply-initiated` | DOM delegation (reply btn) | viewStore |

---

## State Ownership

Each store owns a bounded slice of state. Cross-domain reads are allowed;
cross-domain writes are never allowed.

| Store | Owns | Written by |
|-------|------|-----------|
| `identityStore` | myId, myName, theme, aliases | main.ts (peer open, settings) |
| `roomsStore` | rooms, topology, messages, unread | main.ts, message router |
| `friendsStore` | friends, blocked, DMs, call state | friends domain |
| `pluginsStore` | installed plugins, bot commands | PluginHost |
| `viewStore` | modal, reply, autocomplete, sidebar | UI components only |

---

## Plugin Sandbox Security

```
IframeSandbox:
  sandbox="allow-scripts"   ← no allow-same-origin
                               → cannot read host localStorage/cookies
                               → cannot access host DOM

postMessage protocol:
  plugin → host: { dir: 'plugin→host', type: 'api'|'emit'|'ready', ... }
  host → plugin: { dir: 'host→plugin', type: 'api:response'|'hook', ... }

Source verification:
  event.source === iframe.contentWindow  (checked on every incoming message)

Permission check:
  Every API handler calls permEngine.check(permissions, 'required-perm')
  Missing permission → Error → returned as api:response error field
```

---

## Testing Strategy

Each domain module has a corresponding `src/__tests__/*.test.ts` file.
Tests use `vitest` with `jsdom` environment.

| Test file | Coverage |
|-----------|---------|
| `event-bus.test.ts` | EventBus on/once/emit/unsubscribe/error isolation/logger |
| `stores.test.ts` | createStore get/set/subscribe/snapshot/Maps |
| `mesh-node.test.ts` | All state transitions, child limits, dedup, dispose |
| `peer-connection.test.ts` | RTT, room tracking, dispose idempotency |
| `recovery-engine.test.ts` | Grandparent path, decide() winner selection |
| `voice-pipeline.test.ts` | start/stop idempotency, channel routing, own-audio filter |
| `vad.test.ts` | Float32/Int16 frames, custom floor, silence rejection |
| `markdown.test.ts` | All block/inline elements, XSS prevention, mentions |
| `plugin-host.test.ts` | Install/remove/enable/disable/getPluginList |
| `permissions.test.ts` | Validate manifest, check pass/fail |

Run: `npm test`
Coverage: `npm run test:coverage`
