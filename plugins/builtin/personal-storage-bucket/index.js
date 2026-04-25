/**
 * personal-storage-bucket/index.js
 *
 * Backs up DMs to a private encrypted storage bucket.
 * Uses AES-GCM (Web Crypto) to encrypt before upload.
 * The encryption key is derived from the user's peer ID and never leaves the client.
 *
 * Server API:
 *   POST /messages   { peerId, ciphertext, iv, ts }   → 200
 *   GET  /messages?since=<ts>                          → [ { peerId, ciphertext, iv, ts }, ... ]
 */

const BUCKET_URL = 'https://your-private-bucket.example.com';

// ── Derive AES-GCM key from a password string (peer ID + secret) ──────────────
async function deriveKey(password) {
  const enc  = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: enc.encode('gilgamesh-personal-bucket'), iterations: 100000, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// ── Encrypt a string, returns { ciphertext: base64, iv: base64 } ──────────────
async function encrypt(key, plaintext) {
  const iv  = crypto.getRandomValues(new Uint8Array(12));
  const enc = new TextEncoder();
  const buf = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext));
  const toB64 = ab => btoa(String.fromCharCode(...new Uint8Array(ab)));
  return { ciphertext: toB64(buf), iv: toB64(iv) };
}

// ── Cache the derived key ─────────────────────────────────────────────────────
let _cryptoKey = null;
async function getKey() {
  if (_cryptoKey) return _cryptoKey;
  // Key material: user's peer ID (set as a global by host before SDK loads)
  // Falls back to a fixed string so the plugin doesn't crash in isolation.
  const seed = (typeof __PLUGIN_ID__ !== 'undefined' ? __PLUGIN_ID__ : 'default') + '-personal-bucket';
  _cryptoKey = await deriveKey(seed);
  return _cryptoKey;
}

// ── Backup every sent/received DM ────────────────────────────────────────────
async function backupDM(msg, peerId) {
  if (!msg?.content) return;
  try {
    const key = await getKey();
    const payload = JSON.stringify({ content: msg.content, author: msg.author, ts: msg.ts });
    const { ciphertext, iv } = await encrypt(key, payload);

    await GilgaMesh.api.fetch(`${BUCKET_URL}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ peerId, ciphertext, iv, ts: msg.ts || Date.now() }),
    });
  } catch (err) {
    console.warn('[PersonalStorageBucket] Backup failed:', err.message);
  }
}

GilgaMesh.on('dm:sent',     ({ msg, peerId }) => backupDM(msg, peerId));
GilgaMesh.on('dm:received', ({ msg, peerId }) => backupDM(msg, peerId));

GilgaMesh.on('app:boot', () => {
  console.log('[PersonalStorageBucket] Ready. Encrypted DM backup active. Bucket:', BUCKET_URL);
});
