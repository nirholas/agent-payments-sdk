# Task: EVM USDC Autonomous x402 Endpoint Crawler & Payment Agent

## Objective
Build a TypeScript autonomous agent that takes a list of seed URLs, crawls linked resources to discover x402-protected endpoints, evaluates payment requirements against a budget, autonomously pays for accessible endpoints using EVM USDC, stores all discovered resources and their content in a local database, and produces a structured discovery report.

## Context
This agent combines the EVM x402 client (`createEvmX402Fetch` from `src/x402/evm-client.ts`), the payment validator (`decodePaymentHeader`, `verifyEvmPayment` from `src/x402/evm-facilitator.ts`), and the cross-chain status API (`getPaymentStatus` from `src/evm/validate.ts`) into a fully autonomous crawler that can discover and consume monetized web resources.

## Environment Variables
```
EVM_PRIVATE_KEY           EVM private key
EVM_CHAIN_ID              Chain to pay from (default: 8453)
EVM_RPC_URL               RPC for the chain
AGENT_MINT                Pump agent mint
TOTAL_BUDGET_USDC         Max total USDC to spend across all crawls (default: 10.0)
PER_REQUEST_MAX_USDC      Max per single request (default: 1.0)
SEED_URLS                 Comma-separated initial URLs to crawl
DB_PATH                   SQLite file (default: ./crawl.db)
MAX_DEPTH                 Link-follow depth (default: 2)
MAX_CONCURRENCY           Concurrent requests (default: 3)
```

## Requirements

### 1. SQLite Database (`db.ts`)
Schema:
```sql
CREATE TABLE IF NOT EXISTS pages (
  url TEXT PRIMARY KEY,
  status INTEGER,             -- HTTP status code
  payment_required BOOLEAN DEFAULT 0,
  payment_scheme TEXT,        -- "pump-agent-evm" or null
  price_usdc TEXT,            -- human decimal or null
  paid BOOLEAN DEFAULT 0,
  payment_tx_hash TEXT,
  content_type TEXT,
  body TEXT,
  discovered_at INTEGER,
  paid_at INTEGER,
  depth INTEGER DEFAULT 0,
  parent_url TEXT
);

CREATE TABLE IF NOT EXISTS crawl_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at INTEGER,
  finished_at INTEGER,
  total_spent_usdc TEXT,
  pages_discovered INTEGER,
  pages_paid INTEGER,
  seed_urls TEXT
);
```

### 2. Discovery Phase
Implement `async discover(url, depth, parentUrl)`:
- Fetch `url` with plain `fetch` (no payment).
- If 200: parse response body for URLs (`href` attributes in HTML via regex, `url`/`href` fields in JSON).
- If 402: decode `X-Payment-Required`, record payment requirements.
- Insert/update the `pages` table.
- Return `{ url, status, paymentRequired, links: string[] }`.

Crawl rules:
- Only follow links that share the same origin as the seed URL.
- Do not re-visit already-discovered URLs.
- Respect `MAX_DEPTH` — do not recurse beyond it.
- Do not crawl `mailto:`, `javascript:`, or anchor-only (`#`) links.

### 3. Payment Decision Engine
Implement `shouldPay(page): boolean`:
- `page.payment_required === true`
- `parseFloat(page.price_usdc) <= PER_REQUEST_MAX_USDC`
- `totalSpentSoFar + parseFloat(page.price_usdc) <= TOTAL_BUDGET_USDC`
- Log decision: `[decision] url=<url> price=<X> USDC budget_remaining=<Y> USDC → PAY | SKIP`.

### 4. Payment Execution
Implement `async payAndFetch(page)`:
- Create `createEvmX402Fetch` with the configured chain.
- Wire `onPaymentRequired` to re-check `shouldPay` at execution time (budget may have changed due to concurrency).
- Wire `onPaymentSubmitted` to log the tx hash and update `totalSpentSoFar`.
- Execute the fetch.
- On success: update `pages` DB row with `paid=true`, `payment_tx_hash`, `body`, `paid_at`.
- On failure: update `paid=false`, log the error.

### 5. Crawl Orchestrator
Implement `async crawl(seedUrls)`:
- Use a queue (array) + in-flight counter for `MAX_CONCURRENCY`.
- Phase 1 (Discovery): crawl all seed URLs and their links up to `MAX_DEPTH`, recording requirements. Do not pay yet.
- Phase 2 (Payment): sort payable pages by price ascending. Pay each that passes `shouldPay` check.
- Phase 3 (Re-crawl links): if any paid page returned new URLs, add them to the queue and continue discovery (at depth + 1, still within `MAX_DEPTH`).
- Return a `CrawlSession` object with totals.

### 6. Concurrency Control
Use a semaphore pattern to cap concurrent HTTP requests at `MAX_CONCURRENCY`:
```ts
class Semaphore {
  constructor(private max: number) {}
  async acquire(): Promise<() => void> { /* ... */ }
}
```
Both discovery and payment phases respect this limit.

### 7. Progress Display
While crawling, print a live one-line status (overwrite using `\r`):
```
[crawl] queued=12 in-flight=3 done=45 paid=8 spent=3.200000/10.000000 USDC
```

### 8. Report Generation
After crawling, generate `crawl-report-<timestamp>.json`:
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

### 9. CLI
```
node crawler.js crawl <url1> [url2...]      Crawl and pay
node crawler.js discover <url1> [url2...]   Discovery only, no payments
node crawler.js report                      Print last session report
node crawler.js history                     Show all crawl sessions from DB
node crawler.js purge                       Delete all crawl data from DB
```

### 10. Duplicate URL Normalization
Before inserting any URL: normalize it (remove fragments, trailing slashes, sort query params). Use the `URL` global for parsing — no string manipulation.

## Deliverables
- `agent-prompts/evm/agents/x402-crawler/crawler.ts`
- `agent-prompts/evm/agents/x402-crawler/db.ts`
- `agent-prompts/evm/agents/x402-crawler/semaphore.ts`
- `agent-prompts/evm/agents/x402-crawler/report.ts`
- `agent-prompts/evm/agents/x402-crawler/package.json`
- `agent-prompts/evm/agents/x402-crawler/README.md`

## Acceptance Criteria
- `discover` mode populates the DB with real page records including 402 payment requirements.
- `crawl` mode pays for pages within budget and records real bridge tx hashes.
- `MAX_CONCURRENCY` is respected — never more than N simultaneous outbound requests.
- `TOTAL_BUDGET_USDC` is enforced — payments stop when the budget is exhausted.
- The generated report JSON matches the schema exactly.
- No mocks. Discovery fetches and payment bridge calls are real.
- URL normalization prevents duplicate entries for the same resource.
