// src/core/constants.ts
// ─── CONSTANTS ────────────────────────────────────────────────────────────────
// All values match original constants.js. Typed as const for inference.

export const MAX_CHILDREN        = 5   as const;  // kept for election compat
export const SOFT_CHILD_LIMIT    = 7   as const;  // normal max children per node
export const HARD_CHILD_LIMIT    = 10  as const;  // temp max during recovery
export const HEARTBEAT_INTERVAL  = 1000 as const; // ms between pings
export const PING_TIMEOUT        = 3000 as const; // 3 missed pings → peer dead
export const CONN_TIMEOUT        = 20000 as const;// ms to wait for PeerJS open
export const ELECTION_INTERVAL   = 300000 as const; // 5 min between elections
export const MSG_CACHE_SIZE      = 10  as const;  // recent msg IDs to dedup
export const FILE_LINK_TTL       = 60000 as const;// 60 s file share TTL
export const STORAGE_KEY         = 'gilgamesh_v5' as const;
export const SCORE_WINDOW        = 10  as const;  // RTT samples to average
export const RECONNECT_DELAY     = 2000 as const; // ms between parent retries

// Recovery & rebalancing
export const RECOVERY_LOCK_MS    = 2000 as const; // lock window after recovery
export const REBALANCE_INTERVAL  = 30000 as const;// how often to check balance
export const REBALANCE_THRESHOLD = 3    as const; // min desc-count diff to rebalance
