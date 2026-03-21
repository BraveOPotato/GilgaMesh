# MeshTalk — P2P Mesh Chat PWA

A fully peer-to-peer browser-based chat network with automatic server election, failover, and direct file transfers.

---

## Architecture Overview

### Network Topology

```
          [Peer A — Elected Server]
         /           |            \
   [Peer B]      [Peer C]      [Peer D]
                    |
               [Peer E]  ← connects via C, gets routed to A
```

### Server Election

Every peer continuously monitors network quality and participates in elections:

1. **Scoring** — Each peer calculates a score based on:
   - Number of active connections (× 100 weight)
   - Average RTT latency to connected peers (negative penalty)

2. **Election round** — Triggered every 8 seconds. Each peer broadcasts its score via `election_vote` messages.

3. **Winner determination** — After a 1.5s vote-collection window, the peer with the highest score becomes (or remains) server.

4. **Server announcement** — Winner broadcasts `elected` message; all peers connect/re-connect to the server.

### Candidate List

- Up to **10 candidates** are tracked per peer, sorted by connection quality.
- Candidates are derived from: currently connected peers + saved peer history.
- Candidate lists are exchanged during handshakes so the network's topology propagates.

### Failover

If the current server becomes unreachable:

1. Server conn drop is detected by heartbeat timeout (~12s) or DataChannel close event.
2. Peer iterates through candidate list, trying each in order.
3. If a contacted peer is itself a client (not server), it responds with `route_response` pointing to the current server.
4. If all candidates fail, peer falls back to **saved peer list** and attempts reconnect through any previously known peer.

### Routing for New Joiners

When a peer connects to another peer that is itself a client:
- The receiving client sends a `route_response` pointing to the server.
- The new peer then establishes a direct connection to the elected server.

### Saved Peer List

- On every successful connection, the remote peer ID is saved to `localStorage`.
- On startup, the app attempts to reconnect to saved peers in order.
- List is capped at 100 entries (most-recent-first).
- This enables "hop back on" behavior: even after leaving the network for hours, a peer can reconnect through any formerly-known peer that's still online.

---

## File Transfer Protocol

1. **Sharer** selects a file → app generates a 60-second share token.
2. A **share link** is created: `?share=TOKEN&from=PEER_ID&name=FILENAME&size=BYTES`
3. Link is displayed and announced to the network chat.
4. **Receiver** clicks the link → direct `peer.connect()` to the sharer's Peer ID.
5. Transfer occurs over a **binary DataChannel** in 64 KB chunks.
6. No data passes through any server — completely peer-to-peer.
7. After 60 seconds the token is invalidated; the sharer responds with `file_expired`.

---

## Message Flow

```
Client → serverConn.send(message)
Server receives → broadcasts to all clientConns
All clients display the message
```

If not connected to a server (island mode), messages are broadcast directly to all known connected peers.

---

## Running Locally

```bash
# Simple static server (Python)
cd p2p-chat
python3 -m http.server 8080

# Or Node.js
npx serve .
```

Open `http://localhost:8080` in multiple tabs or browsers to test P2P connections.

**For cross-device testing:** PeerJS uses public STUN servers (Google + Twilio) for NAT traversal. Works on local network and across the internet.

---

## Files

| File | Purpose |
|------|---------|
| `index.html` | App shell, all UI markup |
| `app.js` | P2P networking, election, routing, chat, file transfer |
| `sw.js` | PWA service worker (offline caching) |
| `manifest.json` | PWA manifest |

---

## Key Constants

| Constant | Default | Purpose |
|----------|---------|---------|
| `MAX_CANDIDATES` | 10 | Max server candidates tracked |
| `ELECTION_INTERVAL` | 8000ms | How often elections run |
| `HEARTBEAT_INTERVAL` | 3000ms | Peer liveness ping interval |
| `RECONNECT_DELAY` | 2000ms | Wait between candidate failover attempts |
| `FILE_LINK_TTL` | 60000ms | File share link validity window |
| `SCORE_WINDOW` | 10 | Last N pings used for latency score |

---

## Dependencies

- **[PeerJS](https://peerjs.com/)** (1.5.1) — WebRTC abstraction, signaling, NAT traversal
- No backend required — all communication is browser-to-browser
- PeerJS public signaling server used for initial connection establishment only

---

## PWA Features

- Installable on desktop and mobile
- Offline app shell (chat history is in-memory; reconnects on return)
- Service Worker caches app assets
- Responsive layout (sidebar hides on mobile)
