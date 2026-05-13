/**
 * src/voice/playback/index.ts — Per-peer audio playback with Opus and PCM backends.
 *
 * Lazily creates the AudioContext on first audio frame received — avoids the
 * "user gesture required" policy on cold load.
 */

import { OPUS_SAMPLE_RATE, TARGET_SAMPLE_RATE } from '../capture/index.js';
import type { AudioCodec } from '../capture/index.js';
import type { PeerId } from '../../core/types.js';

// ─── PLAYBACK ENGINE ──────────────────────────────────────────────────────────

export interface PlaybackEngine {
  enqueue(peerId: PeerId, data: ArrayBuffer, codec: AudioCodec, sampleRate: number): void;
  flush(): void;
}

// ─── OPUS PLAYBACK (WebCodecs) ────────────────────────────────────────────────

export class OpusPlaybackEngine implements PlaybackEngine {
  private ctx:      AudioContext | null = null;
  private gain:     GainNode    | null = null;
  private decoders  = new Map<PeerId, AudioDecoder>();
  private playheads = new Map<PeerId, number>(); // next scheduled time per peer

  private ensureCtx(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx  = new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 1;
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(e => console.warn('[OpusPlayback] resume failed:', e));
    }
    return this.ctx;
  }

  private ensureDecoder(peerId: PeerId): AudioDecoder {
    if (this.decoders.has(peerId)) return this.decoders.get(peerId)!;

    const ctx = this.ensureCtx();

    const decoder = new AudioDecoder({
      output: (audioData: AudioData) => {
        const ctx    = this.ensureCtx();
        const frames = audioData.numberOfFrames;
        const buf    = ctx.createBuffer(1, frames, audioData.sampleRate);
        const dest   = buf.getChannelData(0);
        audioData.copyTo(dest, { planeIndex: 0 });
        audioData.close();

        const src  = ctx.createBufferSource();
        src.buffer = buf;
        src.connect(this.gain!);

        const now  = ctx.currentTime;
        const head = this.playheads.get(peerId) ?? now;
        const when = Math.max(now + 0.05, head); // 50ms buffer
        src.start(when);
        this.playheads.set(peerId, when + buf.duration);
      },
      error: (e: Error) => console.warn(`[OpusPlayback:${peerId}] decoder error:`, e),
    });

    decoder.configure({ codec: 'opus', sampleRate: OPUS_SAMPLE_RATE, numberOfChannels: 1 });
    this.decoders.set(peerId, decoder);
    return decoder;
  }

  enqueue(peerId: PeerId, data: ArrayBuffer, _codec: AudioCodec, _sampleRate: number): void {
    const decoder = this.ensureDecoder(peerId);
    const chunk   = new EncodedAudioChunk({
      type:       'key',
      timestamp:  performance.now() * 1000,
      data,
    });
    decoder.decode(chunk);
  }

  flush(): void {
    for (const [, dec] of this.decoders) {
      try { dec.close(); } catch {}
    }
    this.decoders.clear();
    this.playheads.clear();
    try { this.ctx?.close(); } catch {}
    this.ctx  = null;
    this.gain = null;
  }

  setDeafened(deafened: boolean): void {
    if (this.gain) this.gain.gain.value = deafened ? 0 : 1;
  }
}

// ─── PCM PLAYBACK (AudioBufferSourceNode) ────────────────────────────────────

export class PcmPlaybackEngine implements PlaybackEngine {
  private ctx:      AudioContext | null = null;
  private gain:     GainNode    | null = null;
  private playheads = new Map<PeerId, number>();

  private ensureCtx(): AudioContext {
    if (!this.ctx || this.ctx.state === 'closed') {
      this.ctx  = new AudioContext();
      this.gain = this.ctx.createGain();
      this.gain.gain.value = 1;
      this.gain.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') {
      this.ctx.resume().catch(e => console.warn('[PcmPlayback] resume failed:', e));
    }
    return this.ctx;
  }

  enqueue(peerId: PeerId, data: ArrayBuffer, _codec: AudioCodec, sampleRate: number): void {
    const ctx    = this.ensureCtx();
    const pcm16  = new Int16Array(data);
    const frames = pcm16.length;
    const buf    = ctx.createBuffer(1, frames, sampleRate);
    const dest   = buf.getChannelData(0);

    for (let i = 0; i < frames; i++) {
      dest[i] = (pcm16[i] ?? 0) / 32768;
    }

    const src  = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.gain!);

    const now  = ctx.currentTime;
    const head = this.playheads.get(peerId) ?? now;
    const when = Math.max(now + 0.05, head);
    src.start(when);
    this.playheads.set(peerId, when + buf.duration);
  }

  flush(): void {
    this.playheads.clear();
    try { this.ctx?.close(); } catch {}
    this.ctx  = null;
    this.gain = null;
  }

  setDeafened(deafened: boolean): void {
    if (this.gain) this.gain.gain.value = deafened ? 0 : 1;
  }
}
