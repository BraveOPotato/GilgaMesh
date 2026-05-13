/**
 * src/voice/vad.ts — Voice Activity Detection.
 *
 * Computes RMS energy of a PCM frame. Frames below VAD_FLOOR are silently
 * dropped — Opus DTX handles true silence compression on the encode side.
 */

export interface VADOptions {
  /** Minimum RMS to consider a frame as containing voice. Default 0.002. */
  readonly floor?: number;
}

export class VAD {
  private readonly floor: number;

  constructor(options: VADOptions = {}) {
    this.floor = options.floor ?? 0.002;
  }

  /**
   * Returns true if the frame contains voice above the noise floor.
   * Accepts Float32Array (WebCodecs path) or a raw ArrayBuffer containing
   * Int16 PCM (ScriptProcessor fallback path).
   */
  isVoice(frame: Float32Array | ArrayBuffer): boolean {
    if (frame instanceof Float32Array) {
      return this.rmsFloat32(frame) >= this.floor;
    }
    return this.rmsInt16(new Int16Array(frame)) >= this.floor;
  }

  private rmsFloat32(samples: Float32Array): number {
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) {
      sumSq += (samples[i] ?? 0) ** 2;
    }
    return Math.sqrt(sumSq / samples.length);
  }

  private rmsInt16(samples: Int16Array): number {
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) {
      const norm = (samples[i] ?? 0) / 32768;
      sumSq += norm * norm;
    }
    return Math.sqrt(sumSq / samples.length);
  }
}
