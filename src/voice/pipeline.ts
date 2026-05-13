/**
 * src/voice/pipeline.ts — VoicePipeline: per-room voice orchestrator.
 *
 * One instance per active voice channel session.
 * Owns capture, playback, and per-peer active-speaker tracking.
 * Never touches DOM. All feedback goes through EventBus.
 *
 * Routing rules (mirrors voice.js):
 *  - Send UP to parent if parent is in same voice channel.
 *  - Send DOWN to all children (they are guaranteed same channel by topology).
 *  - Never send to backup peer (not in voice subtree).
 *  - DM calls bypass room routing entirely (handled separately).
 */

import type { EventBus, PeerId, RoomId } from '../core/events.js';
import type { MeshNode } from '../network/mesh-node.js';
import {
  OpusCaptureEngine,
  PcmCaptureEngine,
  type CaptureEngine,
  type AudioFrame,
} from './capture/index.js';
import { OpusPlaybackEngine, PcmPlaybackEngine, type PlaybackEngine } from './playback/index.js';
import { identityStore } from '../core/state/identity.js';
import { roomsStore } from '../core/state/rooms.js';

const SPEAKING_TIMEOUT_MS = 1500;
const b64cache = new WeakMap<ArrayBuffer, string>();

function bufToB64(buf: ArrayBuffer): string {
  if (b64cache.has(buf)) return b64cache.get(buf)!;
  const bytes   = new Uint8Array(buf);
  const CHUNK   = 8192;
  let   binary  = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  const b64 = btoa(binary);
  b64cache.set(buf, b64);
  return b64;
}

export class VoicePipeline {
  private capture:   CaptureEngine;
  private playback:  PlaybackEngine;
  private active     = false;
  private muted      = false;
  private deafened   = false;
  private seq        = 0;

  /** peerId → clearTimeout handle */
  private speakerTimers = new Map<PeerId, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly roomId:     RoomId,
    private readonly channelId:  string,
    private readonly meshNode:   MeshNode,
    private readonly bus:        EventBus,
    hasWebCodecs: boolean,
  ) {
    this.capture  = hasWebCodecs ? new OpusCaptureEngine()  : new PcmCaptureEngine();
    this.playback = hasWebCodecs ? new OpusPlaybackEngine() : new PcmPlaybackEngine();
  }

  /** Factory — performs runtime WebCodecs capability check. */
  static async create(
    roomId:    RoomId,
    channelId: string,
    meshNode:  MeshNode,
    bus:       EventBus,
  ): Promise<VoicePipeline> {
    const hasWebCodecs = await OpusCaptureEngine.isSupported();
    return new VoicePipeline(roomId, channelId, meshNode, bus, hasWebCodecs);
  }

  // ── Start / Stop ──────────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.active) return;

    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl:  true,
      },
      video: false,
    });

    await this.capture.start(stream, (frame) => this.onCapturedFrame(frame));
    this.active = true;
    this.bus.emit('voice:joined', { roomId: this.roomId, channelId: this.channelId });
  }

  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.capture.stop();
    this.playback.flush();
    for (const t of this.speakerTimers.values()) clearTimeout(t);
    this.speakerTimers.clear();
    this.bus.emit('voice:left', { roomId: this.roomId });
  }

  isActive(): boolean { return this.active; }

  setMuted(muted: boolean): void     { this.muted = muted; }
  setDeafened(deafened: boolean): void {
    this.deafened = deafened;
    if (this.playback instanceof OpusPlaybackEngine || this.playback instanceof PcmPlaybackEngine) {
      (this.playback as { setDeafened(d: boolean): void }).setDeafened(deafened);
    }
  }

  // ── Incoming audio from wire ───────────────────────────────────────────────

  onIncomingVoiceData(data: {
    authorId:   PeerId;
    audio:      string;  // base64
    codec:      'opus' | 'pcm16';
    sampleRate: number;
  }): void {
    if (this.deafened) return;
    if (data.authorId === (identityStore.get().myId as PeerId)) return;

    // Decode base64 → ArrayBuffer.
    const bin = atob(data.audio);
    const buf = new ArrayBuffer(bin.length);
    const u8  = new Uint8Array(buf);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);

    this.playback.enqueue(data.authorId, buf, data.codec, data.sampleRate);
    this.markSpeaking(data.authorId);
  }

  // ── Private ───────────────────────────────────────────────────────────────

  private onCapturedFrame(frame: AudioFrame): void {
    if (!this.active || this.muted) return;

    const { myId, myName } = identityStore.get();
    if (!myId) return;

    this.markSpeaking(myId as PeerId);

    const packet = {
      type:       'voice_data',
      roomId:     this.roomId,
      vcId:       this.channelId,
      authorId:   myId,
      authorName: myName,
      seq:        this.seq++,
      codec:      frame.codec,
      sampleRate: frame.sampleRate,
      audio:      bufToB64(frame.data),
    };

    // Send UP to parent (if parent is in same voice channel).
    const parentId   = this.meshNode.getParentId();
    const clusterMap = this.meshNode.getClusterMap();

    if (parentId) {
      const parentVcId = clusterMap[parentId]?.voiceChannelId;
      if (parentVcId === this.channelId) {
        this.meshNode.sendToParent(packet);
      }
    }

    // Send DOWN to all children (guaranteed same channel by topology).
    this.meshNode.sendToAllChildren(packet);
  }

  private markSpeaking(peerId: PeerId): void {
    const existing = this.speakerTimers.get(peerId);
    if (existing) clearTimeout(existing);

    this.bus.emit('voice:speaking', { roomId: this.roomId, peerId, active: true });

    const timer = setTimeout(() => {
      this.speakerTimers.delete(peerId);
      this.bus.emit('voice:speaking', { roomId: this.roomId, peerId, active: false });
    }, SPEAKING_TIMEOUT_MS);

    this.speakerTimers.set(peerId, timer);
  }
}
