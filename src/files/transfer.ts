/**
 * src/files/transfer.ts — Chunked file transfer over a dedicated DataConnection.
 *
 * Sender: StoredShare → base64 chunks → file_done
 * Receiver: file_request → assembles chunks → triggers browser download
 *
 * Uses a separate labelled connection (label: 'file:<token>') so audio/data
 * traffic is not affected.
 */

import type { EventBus, PeerId } from '../core/events.js';
import type { ShareManager } from './share-manager.js';
import { identityStore } from '../core/state/identity.js';
import { formatBytes } from '../utils/format.js';

const CHUNK_SIZE = 48 * 1024; // 48 KB per chunk
const TIMEOUT_MS = 30_000;

export class FileTransfer {
  constructor(
    private readonly bus:          EventBus,
    private readonly shareManager: ShareManager,
    private readonly getPeer:      () => unknown,
  ) {}

  // ── Download (receiver side) ───────────────────────────────────────────────

  download(token: string, fromId: PeerId, filename: string): void {
    if (!fromId || !token) {
      this.bus.emit('ui:toast', { message: 'Invalid share link', kind: 'error' });
      return;
    }

    this.bus.emit('ui:toast', { message: 'Connecting for file transfer…', kind: 'info' });

    const peer = this.getPeer() as { connect?: (id: string, opts: unknown) => unknown } | null;
    if (!peer?.connect) { this.bus.emit('ui:toast', { message: 'Not connected', kind: 'error' }); return; }

    const conn = peer.connect(fromId, { reliable: true, serialization: 'json', label: `file:${token}` }) as {
      on: (e: string, cb: (data: unknown) => void) => void;
      send: (d: unknown) => void;
      close: () => void;
    } | null;

    if (!conn) { this.bus.emit('ui:toast', { message: 'Connection failed', kind: 'error' }); return; }

    const b64chunks: string[] = [];
    let fileMime     = 'application/octet-stream';
    let fileFilename = filename;

    const failTimer = setTimeout(() => {
      this.bus.emit('ui:toast', { message: 'File transfer timed out', kind: 'error' });
      try { conn.close(); } catch {}
    }, TIMEOUT_MS);

    conn.on('open', () => conn.send({ type: 'file_request', token, requesterId: identityStore.get().myId }));

    conn.on('data', (msg: unknown) => {
      const m = msg as Record<string, unknown>;
      switch (m['type'] as string) {
        case 'file_expired':
          clearTimeout(failTimer);
          this.bus.emit('ui:toast', { message: 'Link expired', kind: 'error' });
          conn.close();
          break;

        case 'file_error':
          clearTimeout(failTimer);
          this.bus.emit('ui:toast', { message: `Transfer error: ${String(m['reason'] ?? '?')}`, kind: 'error' });
          conn.close();
          break;

        case 'file_meta':
          fileFilename = String(m['filename'] ?? filename);
          fileMime     = String(m['mime']     ?? 'application/octet-stream');
          this.bus.emit('ui:toast', {
            message: `Receiving ${fileFilename} (${formatBytes(Number(m['size'] ?? 0))})…`,
            kind: 'info',
          });
          break;

        case 'file_chunk':
          b64chunks.push(String(m['data'] ?? ''));
          break;

        case 'file_done':
          clearTimeout(failTimer);
          try {
            const bin  = atob(b64chunks.join(''));
            const buf  = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i);
            const blob = new Blob([buf], { type: fileMime });
            const url  = URL.createObjectURL(blob);
            const a    = document.createElement('a');
            a.href     = url; a.download = fileFilename;
            document.body.appendChild(a); a.click();
            setTimeout(() => { URL.revokeObjectURL(url); a.remove(); }, 1500);
            this.bus.emit('ui:toast', { message: `Downloaded ${fileFilename}!`, kind: 'success' });
          } catch (e) {
            this.bus.emit('ui:toast', { message: `Decode error: ${(e as Error).message}`, kind: 'error' });
          }
          conn.close();
          break;
      }
    });

    conn.on('error', () => {
      clearTimeout(failTimer);
      this.bus.emit('ui:toast', { message: 'File connection failed', kind: 'error' });
    });
  }

  // ── Upload (sender side) ───────────────────────────────────────────────────

  /**
   * Called when a peer opens a file: connection and sends file_request.
   * Streams the file in CHUNK_SIZE base64 chunks.
   */
  sendOverConn(conn: { send(d: unknown): void; open: boolean; close(): void }, token: string): void {
    const share = this.shareManager.getShare(token);
    if (!share) {
      conn.send({ type: 'file_expired' });
      conn.close();
      return;
    }

    conn.send({ type: 'file_meta', filename: share.filename, size: share.size, mime: share.mime });

    let offset = 0;
    const next = () => {
      if (!conn.open) return;
      if (offset >= share.file.size) { conn.send({ type: 'file_done' }); return; }

      const reader = new FileReader();
      reader.onload = (e) => {
        if (!conn.open) return;
        const bytes  = new Uint8Array(e.target!.result as ArrayBuffer);
        let   binary = '';
        for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
        try {
          conn.send({ type: 'file_chunk', data: btoa(binary) });
          offset += CHUNK_SIZE;
          setTimeout(next, 0);
        } catch (err) {
          conn.send({ type: 'file_error', reason: (err as Error).message });
        }
      };
      reader.readAsArrayBuffer(share.file.slice(offset, offset + CHUNK_SIZE));
    };

    next();
  }
}
