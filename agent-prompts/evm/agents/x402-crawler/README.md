# x402-crawler

EVM USDC autonomous x402 endpoint crawler and payment agent.

Discovers payment-gated HTTP resources, evaluates costs against a configurable budget, autonomously pays via EVM USDC cross-chain bridge, stores all results in SQLite, and produces a structured JSON report.

## Files

| File | Purpose |
|------|---------|
| `crawler.ts` | CLI entrypoint — orchestrates discovery, payment, and reporting |
| `db.ts` | SQLite schema and typed query helpers |
| `semaphore.ts` | Concurrency semaphore for capping in-flight requests |
| `report.ts` | Report builder and formatter |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `EVM_PRIVATE_KEY` | required (crawl mode) | EVM private key (hex) |
| `EVM_CHAIN_ID` | `8453` | Source chain ID (Base) |
| `EVM_RPC_URL` | public RPC | RPC endpoint for the chain |
| `AGENT_MINT` | — | Pump agent mint address |
| `TOTAL_BUDGET_USDC` | `10.0` | Max total USDC to spend |
| `PER_REQUEST_MAX_USDC` | `1.0` | Max USDC per single request |
| `SEED_URLS` | — | Comma-separated initial URLs |
| `DB_PATH` | `./crawl.db` | SQLite database path |
| `MAX_DEPTH` | `2` | Link-follow depth |
| `MAX_CONCURRENCY` | `3` | Concurrent HTTP requests |

## Usage

```bash
# Install dependencies
npm install

# Crawl and pay for x402 resources
EVM_PRIVATE_KEY=0x... \
EVM_CHAIN_ID=8453 \
TOTAL_BUDGET_USDC=5.0 \
PER_REQUEST_MAX_USDC=1.0 \
MAX_DEPTH=2 \
npm run crawl https://api.example.com/

# Discovery only — no payments
npm run discover https://api.example.com/

# Print the last session report
npm run report

# Show all sessions from the database
npm run history

# Wipe all crawl data
npm run purge
```

## Crawl Flow

**Phase 1 — Discovery:** BFS from seed URLs up to `MAX_DEPTH`. Each URL is fetched with plain `fetch`. 402 responses record payment requirements; 200 responses extract links and body.

**Phase 2 — Payment:** Payable pages are sorted by price ascending. Each is evaluated against `TOTAL_BUDGET_USDC` and `PER_REQUEST_MAX_USDC`. Approved pages are paid via `createEvmX402Fetch` (EVM→Solana cross-chain bridge).

**Phase 3 — Re-crawl:** New links discovered in paid responses are queued for discovery (within `MAX_DEPTH`).

## Report Schema

```json
{
  "session": { "startedAt": "...", "finishedAt": "...", "duration": "42s" },
  "budget": { "total": "10.000000", "spent": "3.200000", "remaining": "6.800000" },
  "discovery": {
    "totalUrls": 57,
    "freeUrls": 42,
    "paidUrls": 15,
    "skippedUrls": 7
  },
  "payments": [
    { "url": "...", "priceUsdc": "1.000000", "txHash": "0x...", "chainId": 8453 }
  ],
  "errors": []
}
```

## Database Schema

```sql
CREATE TABLE pages (
  url              TEXT PRIMARY KEY,
  status           INTEGER,
  payment_required INTEGER DEFAULT 0,
  payment_scheme   TEXT,
  price_usdc       TEXT,
  paid             INTEGER DEFAULT 0,
  payment_tx_hash  TEXT,
  content_type     TEXT,
  body             TEXT,
  discovered_at    INTEGER,
  paid_at          INTEGER,
  depth            INTEGER DEFAULT 0,
  parent_url       TEXT
);

CREATE TABLE crawl_sessions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at       INTEGER,
  finished_at      INTEGER,
  total_spent_usdc TEXT,
  pages_discovered INTEGER,
  pages_paid       INTEGER,
  seed_urls        TEXT
);
```
