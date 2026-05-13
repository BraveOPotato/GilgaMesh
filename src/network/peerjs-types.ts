// src/network/peerjs-types.ts
// ─── PEERJS TYPE SHIM ────────────────────────────────────────────────────────
// Minimal declarations for PeerJS browser global.
// Replace with 'peerjs' package types if added as a dependency.

export interface DataConnection {
  readonly peer:   string;
  readonly label:  string;
  readonly open:   boolean;
  send(data: unknown): void;
  close(): void;
  on(event: 'open',  cb: () => void): void;
  on(event: 'data',  cb: (data: unknown) => void): void;
  on(event: 'close', cb: () => void): void;
  on(event: 'error', cb: (err: Error & { type?: string }) => void): void;
}

export interface PeerInstance {
  readonly id:        string;
  readonly open:      boolean;
  readonly destroyed: boolean;
  connect(targetId: string, options?: {
    reliable?:      boolean;
    serialization?: string;
    label?:         string;
  }): DataConnection | null;
  on(event: 'open',         cb: (id: string) => void): void;
  on(event: 'connection',   cb: (conn: DataConnection) => void): void;
  on(event: 'error',        cb: (err: Error & { type: string }) => void): void;
  on(event: 'disconnected', cb: () => void): void;
  once(event: string, cb: (...args: unknown[]) => void): void;
  off(event: string,  cb: (...args: unknown[]) => void): void;
  reconnect(): void;
  destroy(): void;
}

export interface IceServer {
  readonly urls:        string;
  readonly username?:   string;
  readonly credential?: string;
}

export const ICE_SERVERS: readonly IceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.services.mozilla.com' },
  { urls: 'turn:openrelay.metered.ca:80',                username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443',               username: 'openrelayproject', credential: 'openrelayproject' },
  { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' },
];

export const PEER_OPTIONS = {
  debug: 0,
  config: {
    iceServers:           ICE_SERVERS,
    iceCandidatePoolSize: 10,
    iceTransportPolicy:   'all' as const,
  },
} as const;
