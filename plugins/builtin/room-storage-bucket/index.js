/**
 * room-storage-bucket/index.js
 *
 * Mirrors every room message to an external storage server.
 * On boot (or when joining a room), fetches missed messages since last seen
 * and injects them into the room's message history via room:write.
 *
 * Server API (implement server-side):
 *   POST /rooms/:roomId/messages   { id, author, authorId, content, channel, ts }  → 200
 *   GET  /rooms/:roomId/messages?since=<ts>&channel=<ch>  → [ ...messages ]
 */

const STORAGE_URL = 'https://your-storage-server.example.com';

// ── Mirror every incoming room message to the server ─────────────────────────
GilgaMesh.on('room:message', async ({ msg, roomId }) => {
  if (!msg || !roomId) return;
  if (msg.type === 'system') return; // skip system messages

  try {
    await GilgaMesh.api.fetch(`${STORAGE_URL}/rooms/${encodeURIComponent(roomId)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id:       msg.id,
        author:   msg.author,
        authorId: msg.authorId,
        content:  msg.content,
        channel:  msg.channel || 'general',
        ts:       msg.ts || Date.now(),
        msgType:  msg.msgType || 'text',
      }),
    });
  } catch (err) {
    console.warn('[RoomStorageBucket] Failed to store message:', err.message);
  }
});

// ── On join: fetch missed messages since last visit ───────────────────────────
GilgaMesh.on('room:joined', async ({ roomId, channel }) => {
  if (!roomId) return;

  // Load last-seen timestamp for this room+channel
  const key = `last_seen:${roomId}:${channel || 'general'}`;
  const { value: raw } = await GilgaMesh.api.storage.get(key);
  const since = raw ? parseInt(raw, 10) : 0;

  try {
    const ch  = encodeURIComponent(channel || 'general');
    const res = await GilgaMesh.api.fetch(
      `${STORAGE_URL}/rooms/${encodeURIComponent(roomId)}/messages?since=${since}&channel=${ch}`
    );
    if (!res.ok) return;

    const missed = JSON.parse(res.body);
    if (!Array.isArray(missed) || missed.length === 0) return;

    console.log(`[RoomStorageBucket] Injecting ${missed.length} missed messages into ${roomId}#${channel}`);

    for (const m of missed) {
      // room:write injects into the room's local message store & UI
      await GilgaMesh.api.room.send(roomId, m.channel || 'general', m.content);
    }
  } catch (err) {
    console.warn('[RoomStorageBucket] Failed to fetch missed messages:', err.message);
  }

  // Update last-seen to now
  await GilgaMesh.api.storage.set(key, String(Date.now()));
});

GilgaMesh.on('app:boot', () => {
  console.log('[RoomStorageBucket] Ready. Storage:', STORAGE_URL);
});
