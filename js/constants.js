// ─── CONSTANTS ────────────────────────────────────────────────────────────────
export const MAX_CHILDREN        = 5;       // kept for election.js compatibility
export const SOFT_CHILD_LIMIT    = 7;       // normal max children per node (fan of up to 7)
export const HARD_CHILD_LIMIT    = 10;      // temporary max during recovery
export const HEARTBEAT_INTERVAL  = 1000;    // ms between pings
export const PING_TIMEOUT        = 3000;    // 3 missed pings → peer dead
export const CONN_TIMEOUT        = 20000;   // ms to wait for PeerJS connect (TURN can take 10-15s)
export const ELECTION_INTERVAL   = 300000;  // 5 minutes between local elections
export const MSG_CACHE_SIZE      = 10;      // recent msg IDs to deduplicate
export const FILE_LINK_TTL       = 60000;   // 60 s file share TTL
export const STORAGE_KEY         = 'gilgamesh_v5';
export const SCORE_WINDOW        = 10;      // RTT samples to average
export const RECONNECT_DELAY     = 2000;    // ms between parent-candidate retries

// Recovery & rebalancing
export const RECOVERY_LOCK_MS    = 2000;    // lock window after a recovery decision (ms)
export const REBALANCE_INTERVAL  = 30000;   // how often to check tree balance (ms)
export const REBALANCE_THRESHOLD = 3;       // min descendant-count difference to trigger rebalance
