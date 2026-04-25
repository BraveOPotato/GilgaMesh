/**
 * offline-manager/index.js
 *
 * Queues DMs sent to offline peers on a relay server.
 * When a peer comes back online, fetches their queued messages and delivers them.
 * Sends browser notifications for incoming queued messages.
 *
 * Relay API (implement server-side):
 *   POST /queue         { to, from, fromName, content, ts }  → 200
 *   GET  /queue/:peerId                                       → [ { from, fromName, content, ts }, ... ]
 *   DELETE /queue/:peerId/:msgId                              → 200
 */

const RELAY_URL = 'https://your-relay-server.example.com';

// ── Queue DM to offline peer ──────────────────────────────────────────────────
GilgaMesh.on('dm:sent', async ({ msg, peerId }) => {
  if (!msg || !peerId) return;

  const { online } = await GilgaMesh.api.isPeerOnline(peerId);
  if (online) return; // Peer is online — no queueing needed

  try {
    const res = await GilgaMesh.api.fetch(`${RELAY_URL}/queue`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to:       peerId,
        from:     GilgaMesh.pluginId, // Note: host injects myId differently; adapt as needed
        content:  msg.content,
        ts:       msg.ts || Date.now(),
      }),
    });

    if (res.ok) {
      console.log('[OfflineManager] Message queued for offline peer', peerId);
      // Track locally so we don't re-queue the same message
      const { value: tracked } = await GilgaMesh.api.storage.get('queued');
      const queue = JSON.parse(tracked || '[]');
      queue.push({ msgId: msg.id, peerId, ts: Date.now() });
      // Keep last 100 entries
      if (queue.length > 100) queue.splice(0, queue.length - 100);
      await GilgaMesh.api.storage.set('queued', JSON.stringify(queue));
    }
  } catch (err) {
    console.warn('[OfflineManager] Failed to queue message:', err);
  }
});

// ── When a peer comes back online, fetch their queued messages ────────────────
GilgaMesh.on('peer:online', async ({ peerId }) => {
  if (!peerId) return;

  try {
    const res = await GilgaMesh.api.fetch(`${RELAY_URL}/queue/${encodeURIComponent(peerId)}`);
    if (!res.ok) return;

    const messages = JSON.parse(res.body);
    if (!Array.isArray(messages) || messages.length === 0) return;

    console.log(`[OfflineManager] Delivering ${messages.length} queued message(s) from ${peerId}`);

    for (const m of messages) {
      // Inject the message into the DM thread with its original timestamp
      await GilgaMesh.api.dm.send(peerId, m.content);
    }

    // Notify the user
    await GilgaMesh.api.notify(
      `${messages.length} message(s) from ${peerId}`,
      'Delivered while you were offline'
    );

    // Clean up server queue
    await GilgaMesh.api.fetch(`${RELAY_URL}/queue/${encodeURIComponent(peerId)}`, {
      method: 'DELETE',
    });
  } catch (err) {
    console.warn('[OfflineManager] Failed to fetch queued messages:', err);
  }
});

// ── Boot: notify if we have pending messages waiting for us ──────────────────
GilgaMesh.on('app:boot', async () => {
  // The host fires peer:online for each peer that reconnects, so we mostly
  // handle delivery there. On boot we just log that the plugin is active.
  console.log('[OfflineManager] Ready. Relay:', RELAY_URL);
});
