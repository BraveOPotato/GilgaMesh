// src/__tests__/voice-pipeline.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { VoicePipeline } from '../voice/pipeline.js';
import { EventBus } from '../core/events.js';
import type { PeerId, RoomId } from '../core/types.js';

function pid(s: string): PeerId { return s as PeerId; }
function rid(s: string): RoomId { return s as RoomId; }

// ── Stub identity store ───────────────────────────────────────────────────────
vi.mock('../core/state/identity.js', () => ({
  identityStore: {
    get: vi.fn(() => ({
      myId: 'me' as PeerId, myName: 'Alice',
      peer: null, peerAliases: {}, currentTheme: 'dark',
    })),
    set: vi.fn(),
    subscribe: vi.fn(() => () => {}),
    snapshot: vi.fn(),
  },
}));

// ── Stub capture + playback engines ──────────────────────────────────────────
vi.mock('../voice/capture/index.js', () => ({
  OpusCaptureEngine: vi.fn().mockImplementation(() => ({
    start:     vi.fn(async () => {}),
    stop:      vi.fn(),
    isRunning: vi.fn(() => false),
    isSupported: vi.fn(async () => false),
  })),
  PcmCaptureEngine: vi.fn().mockImplementation(() => ({
    start:     vi.fn(async (_stream: unknown, _cb: unknown) => {}),
    stop:      vi.fn(),
    isRunning: vi.fn(() => false),
  })),
  OPUS_SAMPLE_RATE:   48000,
  OPUS_BITRATE:       32000,
  TARGET_SAMPLE_RATE: 24000,
  VAD_FLOOR:          0.002,
}));

vi.mock('../voice/playback/index.js', () => ({
  OpusPlaybackEngine: vi.fn().mockImplementation(() => ({
    enqueue:     vi.fn(),
    flush:       vi.fn(),
    setDeafened: vi.fn(),
  })),
  PcmPlaybackEngine: vi.fn().mockImplementation(() => ({
    enqueue:     vi.fn(),
    flush:       vi.fn(),
    setDeafened: vi.fn(),
  })),
}));

// ── Navigator stub ────────────────────────────────────────────────────────────
vi.stubGlobal('navigator', {
  mediaDevices: {
    getUserMedia: vi.fn(async () => ({
      getTracks: () => [{ stop: vi.fn() }],
    })),
  },
});

function makeMeshNode(overrides: {
  parentId?:   PeerId | null;
  clusterMap?: Record<string, { voiceChannelId?: string }>;
} = {}) {
  return {
    roomId:            rid('room-1'),
    getParentId:       vi.fn(() => overrides.parentId ?? null),
    getClusterMap:     vi.fn(() => overrides.clusterMap ?? {}),
    sendToParent:      vi.fn(() => true),
    sendToAllChildren: vi.fn(),
    getBackupConn:     vi.fn(() => null),
    getBackupPeerId:   vi.fn(() => null),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('VoicePipeline', () => {
  let bus: EventBus;

  beforeEach(() => { bus = new EventBus(); });
  afterEach(() => { vi.clearAllMocks(); });

  it('emits voice:joined on start', async () => {
    const events: string[] = [];
    bus.on('voice:joined', () => events.push('joined'));

    const node     = makeMeshNode();
    const pipeline = new VoicePipeline(rid('room-1'), 'vc-general', node as never, bus, false);
    await pipeline.start();

    expect(events).toContain('joined');
    expect(pipeline.isActive()).toBe(true);
    pipeline.stop();
  });

  it('emits voice:left on stop', async () => {
    const events: string[] = [];
    bus.on('voice:left', () => events.push('left'));

    const node     = makeMeshNode();
    const pipeline = new VoicePipeline(rid('room-1'), 'vc-general', node as never, bus, false);
    await pipeline.start();
    pipeline.stop();

    expect(events).toContain('left');
    expect(pipeline.isActive()).toBe(false);
  });

  it('start() is idempotent', async () => {
    const events: string[] = [];
    bus.on('voice:joined', () => events.push('joined'));

    const node     = makeMeshNode();
    const pipeline = new VoicePipeline(rid('room-1'), 'vc-general', node as never, bus, false);
    await pipeline.start();
    await pipeline.start();

    expect(events).toHaveLength(1);
    expect(pipeline.isActive()).toBe(true);
    pipeline.stop();
  });

  it('stop() is idempotent', async () => {
    const events: string[] = [];
    bus.on('voice:left', () => events.push('left'));

    const node     = makeMeshNode();
    const pipeline = new VoicePipeline(rid('room-1'), 'vc-general', node as never, bus, false);
    await pipeline.start();
    pipeline.stop();
    pipeline.stop();

    expect(events).toHaveLength(1);
  });

  it('does not route to parent when in different voice channel', async () => {
    const node = makeMeshNode({
      parentId:   pid('parent'),
      clusterMap: { parent: { voiceChannelId: 'vc-other' } },
    });

    const pipeline = new VoicePipeline(rid('room-1'), 'vc-mine', node as never, bus, false);
    await pipeline.start();
    // No frame produced (mocked capture never calls onFrame)
    expect(node.sendToParent).not.toHaveBeenCalled();
    pipeline.stop();
  });

  it('onIncomingVoiceData does not throw for valid PCM16 data', () => {
    // Produce a properly-aligned even-byte base64 payload (Int16Array requires 2-byte alignment)
    const pcm  = new Int16Array(8).fill(1000);
    const b64  = btoa(String.fromCharCode(...new Uint8Array(pcm.buffer)));

    const node     = makeMeshNode();
    const pipeline = new VoicePipeline(rid('room-1'), 'vc-general', node as never, bus, false);

    expect(() => pipeline.onIncomingVoiceData({
      authorId:   pid('peer-a'),
      audio:      b64,
      codec:      'pcm16',
      sampleRate: 24000,
    })).not.toThrow();
  });

  it('onIncomingVoiceData ignores own audio (no speaking event)', () => {
    const speakingEvents: unknown[] = [];
    bus.on('voice:speaking', (e) => speakingEvents.push(e));

    const pcm = new Int16Array(8).fill(500);
    const b64 = btoa(String.fromCharCode(...new Uint8Array(pcm.buffer)));

    const node     = makeMeshNode();
    const pipeline = new VoicePipeline(rid('room-1'), 'vc-general', node as never, bus, false);
    pipeline.onIncomingVoiceData({
      authorId:   pid('me'),    // own ID — should be silently dropped
      audio:      b64,
      codec:      'pcm16',
      sampleRate: 24000,
    });

    expect(speakingEvents).toHaveLength(0);
  });

  it('setMuted and setDeafened do not throw', () => {
    const node     = makeMeshNode();
    const pipeline = new VoicePipeline(rid('room-1'), 'vc-general', node as never, bus, false);
    expect(() => { pipeline.setMuted(true); pipeline.setDeafened(true); }).not.toThrow();
  });
});
