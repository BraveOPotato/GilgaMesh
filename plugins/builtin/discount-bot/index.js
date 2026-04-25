/**
 * discount-bot/index.js
 *
 * Fetches deals from a configured feed URL and posts them to target rooms
 * on a schedule. Only the root node in each room sends the message to avoid
 * duplicates — it listens for the 'room:became-root' hook.
 *
 * Deal feed API (implement server-side or use a public deals API):
 *   GET /deals   → [ { title, code, description, expiry, url }, ... ]
 *
 * Config stored in plugin's isolated storage:
 *   target_rooms   JSON array of roomIds to post into
 *   last_deal_ts   timestamp of last posted deal (dedup)
 */

const FEED_URL         = 'https://your-deals-api.example.com/deals';
const INTERVAL_MS      = 60 * 60 * 1000; // 1 hour
const TARGET_CHANNEL   = 'general';

let _isRoot   = false;
let _timer    = null;
let _roomIds  = [];

// ── Track which rooms we're root in ──────────────────────────────────────────
GilgaMesh.on('room:became-root', ({ roomId }) => {
  if (!_roomIds.includes(roomId)) _roomIds.push(roomId);
  _isRoot = true;
  _scheduleIfNeeded();
});

GilgaMesh.on('room:lost-root', ({ roomId }) => {
  _roomIds = _roomIds.filter(id => id !== roomId);
  _isRoot  = _roomIds.length > 0;
  if (!_isRoot && _timer) { clearInterval(_timer); _timer = null; }
});

// ── Load saved target rooms on boot ──────────────────────────────────────────
GilgaMesh.on('app:boot', async () => {
  const { value } = await GilgaMesh.api.storage.get('target_rooms');
  _roomIds = value ? JSON.parse(value) : [];
  console.log('[DiscountBot] Ready. Target rooms:', _roomIds);
  _scheduleIfNeeded();
});

// ── When joining a room, save it as a target ──────────────────────────────────
GilgaMesh.on('room:joined', async ({ roomId }) => {
  if (!_roomIds.includes(roomId)) {
    _roomIds.push(roomId);
    await GilgaMesh.api.storage.set('target_rooms', JSON.stringify(_roomIds));
  }
});

// ── Scheduling ────────────────────────────────────────────────────────────────
function _scheduleIfNeeded() {
  if (_timer || !_isRoot || _roomIds.length === 0) return;
  // Fire immediately on first schedule, then on interval
  _fetchAndPost();
  _timer = setInterval(_fetchAndPost, INTERVAL_MS);
}

// ── Fetch deals & post ────────────────────────────────────────────────────────
async function _fetchAndPost() {
  if (!_isRoot || _roomIds.length === 0) return;

  try {
    const res = await GilgaMesh.api.fetch(FEED_URL);
    if (!res.ok) return;

    const deals = JSON.parse(res.body);
    if (!Array.isArray(deals) || deals.length === 0) return;

    // Dedup — only post deals newer than last posted
    const { value: raw } = await GilgaMesh.api.storage.get('last_deal_ts');
    const lastTs = raw ? parseInt(raw, 10) : 0;
    const newDeals = deals.filter(d => !d.ts || d.ts > lastTs);
    if (newDeals.length === 0) return;

    for (const deal of newDeals.slice(0, 3)) { // max 3 per batch
      const msg = _formatDeal(deal);
      for (const roomId of _roomIds) {
        await GilgaMesh.api.room.send(roomId, TARGET_CHANNEL, msg);
      }
    }

    const latest = Math.max(...newDeals.map(d => d.ts || Date.now()));
    await GilgaMesh.api.storage.set('last_deal_ts', String(latest));

    console.log(`[DiscountBot] Posted ${newDeals.length} deal(s) to ${_roomIds.length} room(s).`);
  } catch (err) {
    console.warn('[DiscountBot] Failed to fetch deals:', err.message);
  }
}

function _formatDeal(deal) {
  let msg = `🏷️ **Deal Alert**: ${deal.title || 'New Deal'}`;
  if (deal.code)        msg += `\n💳 Code: \`${deal.code}\``;
  if (deal.description) msg += `\n${deal.description}`;
  if (deal.expiry)      msg += `\n⏳ Expires: ${deal.expiry}`;
  if (deal.url)         msg += `\n🔗 ${deal.url}`;
  return msg;
}
