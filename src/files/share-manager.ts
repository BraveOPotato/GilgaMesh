/**
 * // src/files/share-manager.ts — File share link creation and expiry.
 *
 * Creates a timed download link, stores the File reference locally,
 * announces it via bus events. Transfer is handled by FileTransfer.
 */

import type { EventBus, PeerId, RoomId } from '../core/events.js';
import type { FileShare } from '../core/types.js';
import { FILE_LINK_TTL } from '../core/constants.js';
import { genId } from '../utils/id-generator.js';
import { identityStore } from '../core/state/identity.js';

export interface StoredShare {
  readonly file:     File;
  readonly expires:  number;
  readonly filename: string;
  readonly size:     number;
  readonly mime:     string;
}

const shares = new Map<string, StoredShare>();

export class ShareManager {
  constructor(private readonly bus: EventBus) {}

  /**
   * Create a timed share for a file.
   * Returns a FileShare descriptor that can be embedded in a chat message.
   */
  createShare(file: File): FileShare {
    const { myId, myName } = identityStore.get();
    const token   = genId();
    const expires = Date.now() + FILE_LINK_TTL;

    const stored: StoredShare = {
      file,
      expires,
      filename: file.name,
      size:     file.size,
      mime:     file.type || 'application/octet-stream',
    };
    shares.set(token, stored);

    // Schedule expiry cleanup.
    setTimeout(() => {
      shares.delete(token);
      this.bus.emit('file:share-expired', { token });
    }, FILE_LINK_TTL);

    const fileShare: FileShare = {
      token,
      fromId:   myId ?? '' as PeerId,
      fromName: myName,
      filename: file.name,
      size:     file.size,
      expires,
    };

    this.bus.emit('file:share-created', { token, fileShare });
    return fileShare;
  }

  /** Build a shareable URL for embedding in an invite or message. */
  buildShareUrl(token: string, filename: string, size: number): string {
    const { myId } = identityStore.get();
    const base = location.href.split('?')[0];
    return `${base}?share=${token}&from=${encodeURIComponent(myId ?? '')}&name=${encodeURIComponent(filename)}&size=${size}`;
  }

  getShare(token: string): StoredShare | null {
    const s = shares.get(token);
    if (!s) return null;
    if (Date.now() > s.expires) { shares.delete(token); return null; }
    return s;
  }

  hasShare(token: string): boolean {
    return this.getShare(token) !== null;
  }

  /** Parse URL params on app load and trigger download prompt if present. */
  checkShareUrl(onDownload: (token: string, fromId: PeerId, filename: string, size: number) => void): void {
    const p       = new URLSearchParams(location.search);
    const token   = p.get('share');
    const fromId  = p.get('from');
    const name    = p.get('name') ?? 'file';
    const size    = parseInt(p.get('size') ?? '0', 10);

    if (token && fromId) {
      history.replaceState({}, '', location.pathname);
      const attempt = () => {
        if (!identityStore.get().myId) { setTimeout(attempt, 500); return; }
        if (confirm(`Download "${name}" (${size} bytes) from a peer?\nDirect P2P transfer.`)) {
          onDownload(token, fromId as PeerId, name, size);
        }
      };
      setTimeout(attempt, 1000);
    }
  }
}
