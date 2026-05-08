# Deposit Poller

Real-time EVM→Solana USDC bridge deposit tracker. Polls `getPaymentStatus` from the Pump cross-chain API, persists state to SQLite, and serves a live JSON API over HTTP.

## Setup

```bash
cd agent-prompts/evm/agents/deposit-poller
npm install
```

## Running

### HTTP server + background poller (default)

```bash
# start on port 5000, polling every 10 s
tsx poller.ts

# custom config
PORT=8080 POLL_INTERVAL_MS=5000 DB_PATH=/tmp/deposits.db tsx poller.ts
```

### Live terminal dashboard

```bash
tsx poller.ts watch
```

Clears the terminal every 5 s and prints a live table of all tracked deposits alongside running the poller.

### Register a deposit from a bridge tx hash

```bash
tsx poller.ts import <txHash> <chainId> [agentMint] [memo]

# example — Base chain (8453)
tsx poller.ts import 0xabc123... 8453 So1MintAddr... "agent session"
```

Hits `PUMP_CROSSCHAIN_API/deposit?txHash=…&chainId=…`, extracts the deposit ID, and inserts it into the DB.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `5000` | HTTP port |
| `POLL_INTERVAL_MS` | `10000` | Poll frequency (ms) |
| `DB_PATH` | `./deposits.db` | SQLite file path |

## HTTP API

### `GET /health`
```json
{ "status": "ok", "dbPath": "...", "pollIntervalMs": 10000, "pendingDeposits": 3 }
```

### `GET /summary`
```json
{
  "total": 42,
  "pending": 3,
  "arrived": 38,
  "failed": 1,
  "totalUsdcBridged": "142.500000",
  "avgArrivalTimeSeconds": 47.3,
  "oldestPending": { "depositId": "...", "ageSeconds": 120 }
}
```

### `GET /deposits`
Returns all deposits sorted by `createdAt` descending.

Optional filter: `?status=pending` | `arrived_on_solana` | `failed` | `bridging` | `pending_evm_confirmation`

### `GET /deposits/:depositId`
Single deposit record, 404 if not found.

### `POST /deposits`
Register a new deposit for tracking.

**Body:**
```json
{
  "depositId": "abc123",
  "txHash": "0xdef456...",
  "chainId": 8453,
  "amountUsdc": "1.000000",
  "agentMint": "So1MintAddress...",
  "memo": "agent session"
}
```
Returns `201` with the created row.

### `DELETE /deposits/:depositId`
Remove a deposit from tracking. Returns `204`.

## Status Values

The poller maps raw API statuses to the following values stored in SQLite:

| Status | Meaning |
|---|---|
| `pending` | Initial state at registration |
| `pending_evm_confirmation` | Waiting for EVM confirmation |
| `bridging` | In transit across the bridge |
| `arrived_on_solana` | Terminal — successfully bridged |
| `failed` | Terminal — failed or expired |

Both `arrived_on_solana` and `failed` are terminal; the poller stops polling them.

## Architecture

```
poller.ts          — entry point, CLI commands, graceful shutdown
├── db.ts          — better-sqlite3 wrapper, all DB queries
└── server.ts      — Hono HTTP API
```

The polling engine runs `Promise.allSettled` on batches of up to 10 pending deposits concurrently to avoid hammering the API.
