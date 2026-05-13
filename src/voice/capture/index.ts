/**
 * src/voice/capture/index.ts — Audio capture strategy interface + implementations.
 *
 * Strategy pattern: runtime capability detection selects Opus (WebCodecs)
 * or PCM (ScriptProcessor) backend. Both expose the same CaptureEngine API.
 */

// ─── INTERFACE ────────────────────────────────────────────────────────────────

export type AudioCodec = 'opus' | 'pcm16';

export interface AudioFrame {
  readonly data:       ArrayBuffer;
  readonly codec:      AudioCodec;
  readonly sampleRate: number;
  readonly timestamp:  number;
}

export interface CaptureEngine {
  start(stream: MediaStream, onFrame: (frame: AudioFrame) => void): Promise<void>;
  stop(): void;
  isRunning(): boolean;
}

// ─── CONSTANTS ────────────────────────────────────────────────────────────────

export const OPUS_SAMPLE_RATE   = 48_000;
export const OPUS_BITRATE       = 32_000; // 32 kbps — excellent voice quality
export const TARGET_SAMPLE_RATE = 24_000; // PCM fallback sample rate
export const VAD_FLOOR          = 0.002;  // suppress near-silence only

// ─── OPUS CAPTURE (WebCodecs primary path) ────────────────────────────────────

// Inline AudioWorklet processor — registered at runtime via a Blob URL.
// Buffers mic samples into 20ms (960-sample @ 48kHz) frames, computes RMS,
// posts frames above VAD_FLOOR to the main thread.
const WORKLET_CODE = `
class MicCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buf       = [];
    this._frameSize = 960;
    this._vadFloor  = ${VAD_FLOOR};
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) this._buf.push(ch[i]);
    while (this._buf.length >= this._frameSize) {
      const frame = new Float32Array(this._buf.splice(0, this._frameSize));
      let sumSq = 0;
      for (let i = 0; i < frame.length; i++) sumSq += frame[i] * frame[i];
      const rms = Math.sqrt(sumSq / frame.length);
      if (rms >= this._vadFloor) {
        this.port.postMessage(frame, [frame.buffer]);
      }
    }
    return true;
  }
}
registerProcessor('mic-capture', MicCaptureProcessor);
`;

export class OpusCaptureEngine implements CaptureEngine {
  private encoder:  AudioEncoder | null = null;
  private worklet:  AudioWorkletNode | null = null;
  private ctx:      AudioContext | null = null;
  private running   = false;

  async start(stream: MediaStream, onFrame: (frame: AudioFrame) => void): Promise<void> {
    this.ctx = new AudioContext({ sampleRate: OPUS_SAMPLE_RATE });
    const source = this.ctx.createMediaStreamSource(stream);

    // Load worklet from blob URL.
    const blob    = new Blob([WORKLET_CODE], { type: 'application/javascript' });
    const blobUrl = URL.createObjectURL(blob);
    await this.ctx.audioWorklet.addModule(blobUrl);
    URL.revokeObjectURL(blobUrl);

    this.worklet = new AudioWorkletNode(this.ctx, 'mic-capture');
    source.connect(this.worklet);

    // Silent output — we don't want to hear our own mic.
    const silence = this.ctx.createGain();
    silence.gain.value = 0;
    this.worklet.connect(silence);
    silence.connect(this.ctx.destination);

    this.encoder = new AudioEncoder({
      output: (chunk: EncodedAudioChunk) => {
        const buf = new ArrayBuffer(chunk.byteLength);
        chunk.copyTo(buf);
        onFrame({
          data:       buf,
          codec:      'opus',
          sampleRate: OPUS_SAMPLE_RATE,
          timestamp:  chunk.timestamp,
        });
      },
      error: (e: Error) => console.warn('[OpusCapture] encoder error:', e),
    });

    await this.encoder.configure({
      codec:            'opus',
      sampleRate:       OPUS_SAMPLE_RATE,
      numberOfChannels: 1,
      bitrate:          OPUS_BITRATE,
    });

    this.worklet.port.onmessage = (e: MessageEvent<Float32Array>) => {
      if (!this.running || !this.encoder) return;
      const pcmFrame  = e.data;
      const audioData = new AudioData({
        format:           'f32',
        sampleRate:       OPUS_SAMPLE_RATE,
        numberOfFrames:   pcmFrame.length,
        numberOfChannels: 1,
        timestamp:        performance.now() * 1000,
        data:             pcmFrame,
      });
      this.encoder.encode(audioData);
      audioData.close();
    };

    this.running = true;
  }

  stop(): void {
    this.running = false;
    try { this.encoder?.close(); } catch {}
    try { this.worklet?.disconnect(); } catch {}
    try { this.ctx?.close(); } catch {}
    this.encoder = null;
    this.worklet = null;
    this.ctx     = null;
  }

  isRunning(): boolean { return this.running; }

  static async isSupported(): Promise<boolean> {
    if (typeof AudioEncoder === 'undefined' || typeof AudioDecoder === 'undefined') return false;
    try {
      const support = await AudioEncoder.isConfigSupported({
        codec: 'opus', sampleRate: OPUS_SAMPLE_RATE, numberOfChannels: 1, bitrate: OPUS_BITRATE,
      });
      return support.supported;
    } catch { return false; }
  }
}

// ─── PCM FALLBACK (ScriptProcessorNode) ──────────────────────────────────────

const SCRIPT_BUFFER_SIZE = 2048;

function buildLowPassKernel(nativeSR: number, targetSR: number): Float32Array {
  const ratio  = targetSR / nativeSR;
  const cutoff = ratio * 0.9;
  const taps   = 31;
  const half   = Math.floor(taps / 2);
  const kernel = new Float32Array(taps);
  for (let i = 0; i < taps; i++) {
    const n    = i - half;
    const sinc = n === 0 ? 1 : Math.sin(Math.PI * cutoff * n) / (Math.PI * cutoff * n);
    const w    = 0.54 - 0.46 * Math.cos(2 * Math.PI * i / (taps - 1));
    kernel[i]  = (sinc ?? 0) * w;
  }
  const sum = kernel.reduce((a, b) => a + b, 0);
  for (let i = 0; i < taps; i++) kernel[i] = (kernel[i] ?? 0) / sum;
  return kernel;
}

export class PcmCaptureEngine implements CaptureEngine {
  private processor: ScriptProcessorNode | null = null;
  private ctx:       AudioContext | null = null;
  private running    = false;

  async start(stream: MediaStream, onFrame: (frame: AudioFrame) => void): Promise<void> {
    this.ctx = new AudioContext();
    const source     = this.ctx.createMediaStreamSource(stream);
    const nativeSR   = this.ctx.sampleRate;
    const downsample = Math.max(1, Math.round(nativeSR / TARGET_SAMPLE_RATE));
    const lpKernel   = buildLowPassKernel(nativeSR, TARGET_SAMPLE_RATE);
    const kernelLen  = lpKernel.length;
    const ringBuf    = new Float32Array(kernelLen);
    let   ringPos    = 0;

    // VAD analyser
    const analyser    = this.ctx.createAnalyser();
    analyser.fftSize  = 256;
    const vadBuf      = new Float32Array(analyser.frequencyBinCount);
    source.connect(analyser);

    this.processor = this.ctx.createScriptProcessor(SCRIPT_BUFFER_SIZE, 1, 1);
    source.connect(this.processor);

    const muteGain        = this.ctx.createGain();
    muteGain.gain.value   = 0;
    this.processor.connect(muteGain);
    muteGain.connect(this.ctx.destination);

    this.processor.onaudioprocess = (e: AudioProcessingEvent) => {
      if (!this.running) return;
      const input = e.inputBuffer.getChannelData(0);
      analyser.getFloatTimeDomainData(vadBuf);
      let sumSq = 0;
      for (let i = 0; i < vadBuf.length; i++) sumSq += (vadBuf[i] ?? 0) ** 2;
      if (Math.sqrt(sumSq / vadBuf.length) < VAD_FLOOR) return;

      const outLen = Math.floor(input.length / downsample);
      const pcm16  = new Int16Array(outLen);
      for (let outIdx = 0; outIdx < outLen; outIdx++) {
        for (let d = 0; d < downsample; d++) {
          ringBuf[ringPos] = input[outIdx * downsample + d] ?? 0;
          ringPos = (ringPos + 1) % kernelLen;
        }
        let acc = 0;
        for (let k = 0; k < kernelLen; k++) {
          acc += (lpKernel[k] ?? 0) * (ringBuf[(ringPos - 1 - k + kernelLen * 2) % kernelLen] ?? 0);
        }
        const s    = Math.max(-1, Math.min(1, acc));
        pcm16[outIdx] = s < 0 ? s * 0x8000 : s * 0x7FFF;
      }
      onFrame({ data: pcm16.buffer, codec: 'pcm16', sampleRate: TARGET_SAMPLE_RATE, timestamp: Date.now() });
    };

    this.running = true;
  }

  stop(): void {
    this.running = false;
    try { this.processor?.disconnect(); } catch {}
    try { this.ctx?.close(); } catch {}
    this.processor = null;
    this.ctx       = null;
  }

  isRunning(): boolean { return this.running; }
}
