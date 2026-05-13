/**
 * src/main.ts — Application bootstrap.
 *
 * Wires all modules together. The only file that instantiates cross-module
 * objects. Domain modules never import each other directly.
 */

import { bus } from './core/events.js';
import { identityStore } from './core/state/identity.js';
import { roomsStore, makeRoomShell } from './core/state/rooms.js';
import { STORAGE_KEY } from './core/constants.js';
import { generatePeerId, genId } from './utils/id-generator.js';
import { PeerRegistry } from './network/peer-registry.js';
import { MeshNode } from './network/mesh-node.js';
import { RecoveryEngine } from './network/mesh-recovery.js';
import { Rebalancer } from './network/mesh-rebalance.js';
import { TopologyScout } from './network/topology-scout.js';
import { MessageRouter } from './network/message-router.js';
import { VoicePipeline } from './voice/pipeline.js';
import { PluginHost } from './plugins/host.js';
import { initUI } from './ui/index.js';
import type { PeerId, RoomId, ChannelId, MessageId, Message } from './core/types.js';
import type { PeerInstance } from './network/peerjs-types.js';
import { PEER_OPTIONS } from './network/peerjs-types.js';
import type { Room, Channel, VoiceChannel } from './core/state/rooms.js';

// ─── SINGLETONS ───────────────────────────────────────────────────────────────

let peer: PeerInstance | null = null;
let registry: PeerRegistry;
let router: MessageRouter;
let scout: TopologyScout;
let pluginHost: PluginHost;

const meshNodes = new Map<RoomId, MeshNode>();
const recoveries = new Map<RoomId, RecoveryEngine>();
const rebalancers = new Map<RoomId, Rebalancer>();
const voicePipes = new Map<RoomId, VoicePipeline>();

// ─── BOOTSTRAP ───────────────────────────────────────────────────────────────

async function bootstrap(): Promise<void> {
  loadStorage();

  registry = new PeerRegistry(bus, () => peer, () => identityStore.get().myId);
  router   = new MessageRouter(bus, registry);
  scout    = new TopologyScout(registry);

  wireBus();
  wireIntents();
  startPeer();

  pluginHost = new PluginHost(bus);
  checkUrlParams();
  initUI();
}

// ─── PEER ─────────────────────────────────────────────────────────────────────

function startPeer(): void {
  const { myId } = identityStore.get();
  const Peer = (window as unknown as { Peer: new (id: string | undefined, opts: unknown) => PeerInstance }).Peer;
  try {
    peer = myId ? new Peer(myId, PEER_OPTIONS) : new Peer(generatePeerId(), PEER_OPTIONS);
  } catch {
    peer = new Peer(generatePeerId(), PEER_OPTIONS);
  }
  peer.on('open', (id) => {
    identityStore.set(s => ({ ...s, myId: id as PeerId }));
    saveStorage();
    registry.startHeartbeat();
    bus.emit('ui:toast', { message: `Your ID: ${id}`, kind: 'info' });
    const { rooms } = roomsStore.get();
    for (const rid of Object.keys(rooms) as RoomId[]) {
      ensureNode(rid);
      attemptReconnect(rid);
    }
    void pluginHost.init({ name: 'GilgaMesh', plugins: [] });
  });
  peer.on('connection', (conn) => {
    if (conn.label?.startsWith('file:')) registry.handleIncomingFile(conn);
    else registry.handleIncoming(conn);
  });
  peer.on('error', (err) => {
    if (err.type === 'unavailable-id') {
      identityStore.set(s => ({ ...s, myId: null }));
      saveStorage(); peer!.destroy(); startPeer();
    }
  });
  peer.on('disconnected', () => {
    setTimeout(() => { try { if (!peer!.destroyed) peer!.reconnect(); } catch {} }, 2000);
  });
}

// ─── MESH NODE ────────────────────────────────────────────────────────────────

function ensureNode(roomId: RoomId): MeshNode {
  if (meshNodes.has(roomId)) return meshNodes.get(roomId)!;
  const node = new MeshNode(roomId, registry, bus,
    () => identityStore.get().myId ?? '' as PeerId,
    () => identityStore.get().myName);
  meshNodes.set(roomId, node);
  const rec = new RecoveryEngine(node, bus, registry);
  const reb = new Rebalancer(node, roomId, registry);
  recoveries.set(roomId, rec);
  rebalancers.set(roomId, reb);
  reb.start();
  return node;
}

function disposeRoom(roomId: RoomId): void {
  meshNodes.get(roomId)?.dispose();    meshNodes.delete(roomId);
  recoveries.get(roomId)?.cancel();    recoveries.delete(roomId);
  rebalancers.get(roomId)?.stop();     rebalancers.delete(roomId);
  voicePipes.get(roomId)?.stop();      voicePipes.delete(roomId);
}

function attemptReconnect(roomId: RoomId): void {
  const { rooms } = roomsStore.get();
  const room = rooms[roomId];
  if (!room) return;
  const node = ensureNode(roomId);
  if (!node.isOrphan()) return;
  const candidates = [...room.savedPeers, ...Object.keys(room.clusterMap)]
    .filter(p => p !== identityStore.get().myId) as PeerId[];
  if (!candidates.length) { node.becomeRoot(); return; }
  void tryJoin(roomId, candidates);
}

async function tryJoin(roomId: RoomId, candidates: PeerId[]): Promise<void> {
  const node = meshNodes.get(roomId);
  if (!node) return;
  for (const c of candidates) {
    if (!node.isOrphan()) break;
    await node.joinParent(c);
    await delay(500);
  }
  if (node.isOrphan()) node.becomeRoot();
}

// ─── BUS WIRING ───────────────────────────────────────────────────────────────

function wireBus(): void {
  bus.on('peer:data-received' as never, (({ peerId, data }: { peerId: PeerId; data: unknown }) => {
    dispatch(data, peerId);
  }) as never);

  bus.on('peer:offline', ({ peerId }) => {
    for (const [, node] of meshNodes) {
      if (node.getParentId() === peerId) node.onParentLost(peerId);
      if (node.getChildren().has(peerId)) { node.removeChild(peerId); node.broadcastChildList(); }
    }
  });

  bus.on('room:parent-lost', ({ roomId }) => recoveries.get(roomId)?.start());

  bus.on('ui:voice-join-requested', ({ roomId, channelId }) => void joinVoice(roomId, channelId));
  bus.on('ui:voice-leave-requested', ({ roomId }) => {
    voicePipes.get(roomId)?.stop(); voicePipes.delete(roomId);
    roomsStore.set(s => {
      const r = s.rooms[roomId]; if (!r) return s;
      return { ...s, rooms: { ...s.rooms, [roomId]: { ...r, myVoiceChannelId: null } } };
    });
  });

  bus.on('ui:message-send-requested', ({ roomId, channel, content, replyTo }) =>
    sendMsg(roomId, channel, content, replyTo as Message | undefined));

  bus.on('ui:room-create-requested', ({ name }) => createRoom(name));
  bus.on('ui:room-join-requested', ({ roomId, roomName, viaPeerId }) =>
    void joinRoom(roomId, roomName, viaPeerId));
  bus.on('ui:room-leave-requested', ({ roomId }) => leaveRoom(roomId));

  bus.on('ui:plugin-install-requested', (e) => {
    if ('baseUrl' in e) void pluginHost.installFromUrl(e.baseUrl);
    else void pluginHost.install(e.manifest as never, e.source as string, true, null);
  });
  bus.on('ui:plugin-remove-requested', ({ pluginId }) => pluginHost.remove(pluginId));
  bus.on('ui:plugin-toggle-requested', ({ pluginId, enabled }) =>
    enabled ? pluginHost.enable(pluginId) : pluginHost.disable(pluginId));
}

function wireIntents(): void {
  bus.on('ui:name-changed', ({ name }) => {
    identityStore.set(s => ({ ...s, myName: name })); saveStorage();
  });
  bus.on('ui:theme-changed', ({ theme }) => {
    identityStore.set(s => ({ ...s, currentTheme: theme }));
    document.documentElement.dataset['theme'] = theme;
    localStorage.setItem('gilgamesh_theme', theme);
  });
}

// ─── DISPATCH ─────────────────────────────────────────────────────────────────

function dispatch(data: unknown, from: PeerId): void {
  if (!data || typeof data !== 'object') return;
  const d    = data as Record<string, unknown>;
  const type = d['type'] as string;
  const rid  = d['roomId'] as RoomId;

  switch (type) {
    case 'ping':
      registry.get(from)?.send({ type: 'pong', ts: d['ts'], id: identityStore.get().myId }); break;
    case 'pong':
      registry.handlePong({ ts: Number(d['ts']) }, from); break;
    case 'handshake':
      handleHandshake(d, from); break;
    case 'adopt_request':
      handleAdoptRequest(d, from); break;
    case 'adopt_ack':
      handleAdoptAck(d); break;
    case 'adopt_reject':
      meshNodes.get(rid)?.onAdoptReject(String(d['reason'] ?? '')); break;
    case 'relay_message': {
      const node = meshNodes.get(rid);
      if (node) router.route(node, d['payload'] as Message, from); break;
    }
    case 'msg_ack': {
      const node = meshNodes.get(rid);
      if (node) router.routeAck(node, d as never); break;
    }
    case 'typing': {
      const node = meshNodes.get(rid);
      if (node) router.routeTyping(node, d as never, from); break;
    }
    case 'child_list':
      meshNodes.get(rid)?.onChildList(d['children'] as PeerId[], d['bestChild'] as PeerId | null); break;
    case 'cluster_map':
      meshNodes.get(rid)?.mergeClusterMap(d['map'] as never);
      meshNodes.get(rid)?.broadcastClusterMap(); break;
    case 'cluster_map_request':
      registry.get(from)?.send({ type: 'cluster_map', roomId: rid, map: meshNodes.get(rid)?.getClusterMap() ?? {} }); break;
    case 'parent_lost':
      meshNodes.get(rid)?.onSiblingParentLost(d['lostParentId'] as PeerId, d['newCandidate'] as PeerId); break;
    case 'descendant_count_request':
      registry.get(from)?.send({ type: 'descendant_count_response', roomId: rid, requesterId: d['requesterId'], count: meshNodes.get(rid)?.getDescendantCount() ?? 1 }); break;
    case 'descendant_count_response':
      recoveries.get(rid)?.handleDescendantCountResponse(from, Number(d['count'])); break;
    case 'connect_to_me':
      void meshNodes.get(rid) && meshNodes.get(rid)!.joinParent(from); break;
    case 'voice_data':
      voicePipes.get(rid)?.onIncomingVoiceData(d as never); break;
    case 'peer_leaving':
      if (meshNodes.get(rid)?.getChildren().has(from)) {
        meshNodes.get(rid)!.removeChild(from);
        meshNodes.get(rid)!.broadcastChildList();
      } break;
    case 'become_parent': {
      const node = meshNodes.get(rid); if (!node) break;
      node.becomeRoot();
      for (const sib of (d['siblings'] as PeerId[] ?? [])) {
        void registry.connect(sib).then(r => r.ok && r.value.send({ type: 'adopt_request', roomId: rid, id: identityStore.get().myId, name: identityStore.get().myName }));
      } break;
    }
    default: break;
  }
}

// ─── HANDSHAKE / ADOPT ───────────────────────────────────────────────────────

function handleHandshake(d: Record<string, unknown>, from: PeerId): void {
  const rid = d['roomId'] as RoomId;
  const node = meshNodes.get(rid); if (!node) return;
  roomsStore.set(s => {
    const r = s.rooms[rid]; if (!r) return s;
    return { ...s, rooms: { ...s.rooms, [rid]: { ...r, peers: { ...r.peers,
      [from]: { id: from, name: String(d['name'] ?? from),
        distanceFromRoot: Number(d['distanceFromRoot'] ?? 0),
        childCount: Number(d['childCount'] ?? 0), descendantCount: 1,
        voiceChannelId: (d['voiceChannelId'] as string | null) ?? null } } } } };
  });
  node.mergeClusterMap((d['clusterMap'] ?? {}) as never);
}

function handleAdoptRequest(d: Record<string, unknown>, from: PeerId): void {
  const rid  = d['roomId'] as RoomId;
  const node = ensureNode(rid);
  const conn = registry.get(from); if (!conn) return;
  const vc   = node.canAcceptVoiceChild(d['voiceChannelId'] as string | null);
  if (!vc.allow) { conn.send({ type: 'adopt_reject', roomId: rid, reason: vc.reason, redirectTo: vc.redirectTo }); return; }
  const result = node.addChild(conn);
  if (!result.ok) { conn.send({ type: 'adopt_reject', roomId: rid, reason: result.error }); return; }
  node.broadcastChildList(); node.updateClusterMapSelf();
  conn.send({ type: 'adopt_ack', roomId: rid, distance: node.getDistanceFromRoot() + 1,
    grandparentId: node.getParentId(), clusterMap: node.getClusterMap(),
    siblings: Array.from(node.getChildren().keys()).filter(k => k !== from),
    electionEpoch: node.getElectionEpoch() });
  node.broadcastClusterMap();
  bus.emit('room:system', { roomId: rid, channel: 'general' as ChannelId, text: `${String(d['name'] ?? from)} joined` });
}

function handleAdoptAck(d: Record<string, unknown>): void {
  const rid  = d['roomId'] as RoomId;
  const node = meshNodes.get(rid); if (!node) return;
  node.onAdoptAck(d['parentId'] as PeerId ?? '' as PeerId,
    Number(d['distance'] ?? 1), (d['grandparentId'] as PeerId | null) ?? null,
    (d['clusterMap'] ?? {}) as never, (d['siblings'] as PeerId[] ?? []),
    Number(d['electionEpoch'] ?? 0));
  roomsStore.set(s => {
    const r = s.rooms[rid]; if (!r) return s;
    return { ...s, rooms: { ...s.rooms, [rid]: { ...r, parentId: d['parentId'] as PeerId, distanceFromRoot: Number(d['distance'] ?? 1) } } };
  });
  saveStorage();
}

// ─── ROOM OPS ─────────────────────────────────────────────────────────────────

function createRoom(name: string): void {
  const { myId } = identityStore.get(); if (!myId) return;
  const rid = String(Math.floor(Math.random() * 9000) + 1000) as RoomId;
  roomsStore.set(s => ({ ...s, rooms: { ...s.rooms, [rid]: makeRoomShell(rid, name, myId) }, activeRoomId: rid }));
  saveStorage(); ensureNode(rid).becomeRoot();
  bus.emit('ui:toast', { message: `Room "${name}" created!`, kind: 'success' });
  bus.emit('ui:room-selected', { roomId: rid });
}

async function joinRoom(rid: RoomId, roomName: string, via: PeerId): Promise<void> {
  const { rooms } = roomsStore.get();
  if (rooms[rid]) { bus.emit('ui:room-selected', { roomId: rid }); return; }
  bus.emit('ui:toast', { message: `Joining "${roomName}"…`, kind: 'info' });
  const sr = await scout.scoutWithRetry(via, rid);
  if (!sr.ok) { bus.emit('ui:toast', { message: `Could not join "${roomName}"`, kind: 'error' }); return; }
  const room = makeRoomShell(rid, roomName, null);
  const map  = sr.value;
  roomsStore.set(s => ({ ...s, rooms: { ...s.rooms, [rid]: map ? { ...room, clusterMap: { ...room.clusterMap, ...map } } : room }, activeRoomId: rid }));
  saveStorage();
  const node = ensureNode(rid);
  if (map) await tryJoin(rid, Object.keys(map) as PeerId[]);
  else     await node.joinParent(via);
  bus.emit('ui:room-selected', { roomId: rid });
}

function leaveRoom(rid: RoomId): void {
  const { rooms } = roomsStore.get();
  const room = rooms[rid]; if (!room) return;
  const node = meshNodes.get(rid);
  if (node?.isRoot() && node.getChildCount() > 0) {
    const best = Array.from(node.getChildren().keys())[0];
    if (best) registry.get(best)?.send({ type: 'become_parent', roomId: rid,
      siblings: Array.from(node.getChildren().keys()).filter(k => k !== best), distanceFromRoot: 0 });
  }
  disposeRoom(rid);
  roomsStore.set(s => { const rs = { ...s.rooms }; delete (rs as Record<string,unknown>)[rid]; return { ...s, rooms: rs, activeRoomId: null }; });
  saveStorage();
  bus.emit('ui:toast', { message: `Left "${room.name}"`, kind: 'info' });
}

// ─── VOICE ────────────────────────────────────────────────────────────────────

async function joinVoice(rid: RoomId, channelId: string): Promise<void> {
  voicePipes.get(rid)?.stop();
  const node = meshNodes.get(rid); if (!node) return;
  try {
    const p = await VoicePipeline.create(rid, channelId, node, bus);
    voicePipes.set(rid, p); await p.start();
    roomsStore.set(s => { const r = s.rooms[rid]; if (!r) return s; return { ...s, rooms: { ...s.rooms, [rid]: { ...r, myVoiceChannelId: channelId } } }; });
    node.updateClusterMapSelf(); node.broadcastClusterMap();
  } catch (e) { bus.emit('ui:toast', { message: `Voice error: ${(e as Error).message}`, kind: 'error' }); }
}

// ─── MESSAGING ───────────────────────────────────────────────────────────────

function sendMsg(rid: RoomId, channel: ChannelId, content: string, replyTo?: Message): void {
  const { myId, myName } = identityStore.get();
  if (!myId || !content.trim()) return;
  const node = meshNodes.get(rid); if (!node) return;
  const msg: Message = {
    type: 'chat', id: genId() as MessageId, roomId: rid,
    author: myName, authorId: myId, content, channel, ts: Date.now(),
    originId: myId, pending: !node.isRoot(),
    replyTo: replyTo ? { id: replyTo.id, author: replyTo.author, content: replyTo.content ?? '' } : undefined,
  };
  roomsStore.set(s => {
    const r = s.rooms[rid]; if (!r) return s;
    return { ...s, rooms: { ...s.rooms, [rid]: { ...r, messages: { ...r.messages, [channel]: [...(r.messages[channel] ?? []), msg] } } } };
  });
  bus.emit('room:message', { roomId: rid, msg, fromPeerId: myId });
  const pkt = { type: 'relay_message', roomId: rid, payload: msg };
  if (node.isRoot()) node.sendToAllChildren(pkt);
  else { node.sendToParent(pkt); node.sendToAllChildren(pkt); }
}

// ─── STORAGE ─────────────────────────────────────────────────────────────────

function loadStorage(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY); if (!raw) return;
    const d = JSON.parse(raw) as Record<string, unknown>;
    identityStore.set(s => ({ ...s, myName: String(d['name'] ?? ''), myId: (d['id'] as PeerId | null) ?? null, peerAliases: (d['aliases'] as Record<string,string>) ?? {}, currentTheme: (d['theme'] as 'dark' | 'light') ?? 'dark' }));
    const sr = (d['rooms'] as Record<string, unknown>) ?? {};
    const rooms: Record<string, Room> = {};
    for (const [rid, r] of Object.entries(sr)) {
      const rr = r as Record<string, unknown>;
      const sh = makeRoomShell(rid as RoomId, String(rr['name'] ?? rid), (rr['createdBy'] as PeerId | null) ?? null);
      rooms[rid] = { ...sh, savedPeers: (rr['savedPeers'] as string[]) ?? [], channels: (rr['channels'] as Channel[]) ?? sh.channels, voiceChannels: (rr['voiceChannels'] as VoiceChannel[]) ?? sh.voiceChannels };
    }
    roomsStore.set(s => ({ ...s, rooms: rooms as never }));
    document.documentElement.dataset['theme'] = identityStore.get().currentTheme;
  } catch (e) { console.warn('[main] loadStorage:', e); }
}

function saveStorage(): void {
  const { myId, myName, peerAliases, currentTheme } = identityStore.get();
  const { rooms } = roomsStore.get();
  const sr: Record<string, unknown> = {};
  for (const [rid, r] of Object.entries(rooms)) {
    sr[rid] = { id: r.id, name: r.name, createdBy: r.createdBy, savedPeers: r.savedPeers, channels: r.channels, voiceChannels: r.voiceChannels };
  }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ name: myName, id: myId, aliases: peerAliases, theme: currentTheme, rooms: sr })); } catch {}
}

function checkUrlParams(): void {
  const p = new URLSearchParams(location.search);
  const jid = p.get('join'), rn = p.get('rname'), via = p.get('via');
  if (jid && via) {
    history.replaceState({}, '', location.pathname);
    const go = () => peer?.open ? bus.emit('ui:room-join-requested', { roomId: jid as RoomId, roomName: rn ?? jid, viaPeerId: via as PeerId }) : setTimeout(go, 500);
    setTimeout(go, 800);
  }
}

const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', () => void bootstrap());
else void bootstrap();
