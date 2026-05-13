// src/__tests__/vad.test.ts
import { describe, it, expect } from 'vitest';
import { VAD } from '../voice/vad.js';

describe('VAD', () => {
  it('passes loud Float32 frame', () => {
    const vad   = new VAD({ floor: 0.002 });
    const frame = new Float32Array(960).fill(0.5); // loud
    expect(vad.isVoice(frame)).toBe(true);
  });

  it('rejects silent Float32 frame', () => {
    const vad   = new VAD({ floor: 0.002 });
    const frame = new Float32Array(960).fill(0); // silence
    expect(vad.isVoice(frame)).toBe(false);
  });

  it('passes loud PCM16 frame', () => {
    const vad  = new VAD({ floor: 0.002 });
    const pcm  = new Int16Array(480).fill(16384); // 50% amplitude
    expect(vad.isVoice(pcm.buffer)).toBe(true);
  });

  it('rejects silent PCM16 frame', () => {
    const vad  = new VAD({ floor: 0.002 });
    const pcm  = new Int16Array(480).fill(0);
    expect(vad.isVoice(pcm.buffer)).toBe(false);
  });

  it('respects custom floor', () => {
    const strictVad = new VAD({ floor: 0.9 });
    const frame     = new Float32Array(960).fill(0.5); // below strict floor
    expect(strictVad.isVoice(frame)).toBe(false);

    const looseVad = new VAD({ floor: 0.001 });
    const quietFrame = new Float32Array(960).fill(0.01);
    expect(looseVad.isVoice(quietFrame)).toBe(true);
  });

  it('defaults floor to 0.002 when not specified', () => {
    const vad  = new VAD();
    const loud = new Float32Array(960).fill(0.1);
    expect(vad.isVoice(loud)).toBe(true);
  });

  it('handles single-sample frame', () => {
    const vad = new VAD({ floor: 0.002 });
    expect(vad.isVoice(new Float32Array([1.0]))).toBe(true);
    expect(vad.isVoice(new Float32Array([0.0]))).toBe(false);
  });
});
