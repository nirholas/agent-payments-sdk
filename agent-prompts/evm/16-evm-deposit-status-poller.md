# Task: EVM USDC Bridge Deposit Status Poller & Dashboard

## Objective
Build a TypeScript CLI tool and lightweight status server that tracks multiple EVM→Solana bridge deposits in real-time by polling `getPaymentStatus` from `src/evm/validate.ts`, persists deposit state to a local SQLite database, and serves a live status dashboard over HTTP.

## Context
`getPaymentStatus(depositId)` from `src/evm/validate.ts` queries the `PUMP_CROSSCHAIN_API` and returns `CrossChainPaymentStatusResult` with `status: "pending" | "arrived_on_solana" | "failed"`. The constant `PUMP_CROSSCHAIN_API` is exported from `src/constants.ts`.

`CrossChainPaymentStatusResult` from `src/types.ts`:
```ts
{
  status: "pending" | "arrived_on_solana" | "failed";
  depositId: string;
  solanaSignature?: string;
  confirmedAmountUsdc?: string;
  error?: string;
}
```

## Environment Variables
```
PORT             HTTP port for status server (default: 5000)
POLL_INTERVAL_MS Poll frequency (default: 10000)
DB_PATH          SQLite file path (default: ./deposits.db)
```

## Requirements

### 1. SQLite Schema
Use the `better-sqlite3` package. Create a `deposits` table on startup:
```sql
CREATE TABLE IF NOT EXISTS deposits (
  deposit_id TEXT PRIMARY KEY,
  tx_hash TEXT NOT NULL,
  chain_id INTEGER NOT NULL,
  chain_name TEXT NOT NULL,
  amount_usdc TEXT,
  agent_mint TEXT,
  memo TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  solana_signature TEXT,
  confirmed_amount_usdc TEXT,
  error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  arrived_at INTEGER
);
```

### 2. Deposit Registration
Implement `registerDeposit(params)`:
```ts
{
  depositId: string,
  txHash: string,
  chainId: number,
  amountUsdc?: string,
  agentMint?: string,
  memo?: string,
}
```
Inserts the deposit into SQLite with `status = "pending"`, `created_at = Date.now()`.

### 3. Polling Engine
Implement `startPoller()`:
- Every `POLL_INTERVAL_MS`, fetch all deposits with `status = "pending"` from the DB.
- For each, call `getPaymentStatus(depositId)`.
- If status changed: update the DB row (`status`, `solana_signature`, `confirmed_amount_usdc`, `arrived_at` if arrived, `error` if failed, always update `updated_at`).
- Log each status change: `[poller] depositId=<id> <old_status> → <new_status>`.
- Run all pending deposits concurrently with `Promise.allSettled` (cap concurrency at 10).

### 4. HTTP Status Server (Hono)
Serve a JSON API at `PORT`:

#### `GET /deposits`
Returns all deposits from the DB, sorted by `created_at` descending. Supports `?status=pending|arrived_on_solana|failed` filter.

#### `GET /deposits/:depositId`
Returns a single deposit record. 404 if not found.

#### `POST /deposits`
Register a new deposit. Body:
```json
{ "depositId": "...", "txHash": "0x...", "chainId": 8453, "amountUsdc": "1.000000", "agentMint": "...", "memo": "..." }
```
Validates all fields, inserts into DB. Returns 201.

#### `DELETE /deposits/:depositId`
Removes a deposit from tracking (does not affect the on-chain state). Returns 204.

#### `GET /summary`
Returns aggregate stats:
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

#### `GET /health`
```json
{ "status": "ok", "dbPath": "...", "pollIntervalMs": 10000, "pendingDeposits": 3 }
```

### 5. Terminal Dashboard Mode
`node poller.js watch` — clears the terminal every 5 seconds and prints a live table:
```
═══════════════════════════════════════════════════════════════════════════
  Bridge Deposit Monitor   [2026-05-08 12:34:56]   polling every 10s
═══════════════════════════════════════════════════════════════════════════
  DepositId         TxHash        Chain      Amount    Status    Age
  abc123...         0xdef456...   Base       1.00 USDC  pending   42s
  ghi789...         0xjkl012...   Arbitrum   0.50 USDC  arrived   3m
═══════════════════════════════════════════════════════════════════════════
  Total: 12  Pending: 1  Arrived: 10  Failed: 1
═══════════════════════════════════════════════════════════════════════════
```
Use ANSI escape codes directly — no external terminal UI library required.

### 6. Import from Bridge Tx
`node poller.js import <txHash> <chainId> [agentMint] [memo]`:
- Calls `PUMP_CROSSCHAIN_API/deposit?txHash=<hash>&chainId=<id>` to get the deposit ID.
- Registers the deposit in the DB.
- Prints the deposit ID.

### 7. Graceful Shutdown
`SIGINT`/`SIGTERM`: stop the poller, close the SQLite connection, shut down the HTTP server, exit 0.

## Deliverables
- `agent-prompts/evm/agents/deposit-poller/poller.ts`
- `agent-prompts/evm/agents/deposit-poller/db.ts` — SQLite wrapper
- `agent-prompts/evm/agents/deposit-poller/server.ts` — Hono HTTP API
- `agent-prompts/evm/agents/deposit-poller/package.json`
- `agent-prompts/evm/agents/deposit-poller/README.md`

## Acceptance Criteria
- `POST /deposits` registers a deposit and it appears in `GET /deposits`.
- Status transitions (`pending` → `arrived_on_solana`) are persisted to SQLite.
- `watch` mode prints a live-updating table without crashing.
- `import` command successfully looks up a real deposit ID from a real bridge tx hash.
- Poller concurrency is capped at 10 (no N+1 API hammering).
- No mocked API calls. All deposit status queries call the real cross-chain API.
