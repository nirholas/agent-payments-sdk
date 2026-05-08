<!-- agent-payments-sdk | Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas -->

# Task: Solana USDC Payment Stats REST API

## Objective
Build a production-quality REST API (Hono + Node adapter) that exposes real-time and historical payment statistics for any Pump Agent by querying on-chain data via `PumpAgent`. No authentication required; all data is public on-chain.

## Context
`PumpAgent` (in `src/solana/PumpAgent.ts`) exposes:
- `getAgentConfig()` → `TokenAgentPayments` (authority, buybackBps, mint)
- `getGlobalConfig()` → `GlobalConfig` (supported currencies, authorities)
- `getPaymentStats(currencyMint)` → `TokenAgentPaymentInCurrency` (counters)
- `getBalances(currencyMint)` → `AgentBalances` (vault addresses + live balances)
- `getAllCurrencyBalances()` → `Map<string, AgentBalances>`
- `getPaymentHistory(limit)` → `AgentAcceptPaymentEvent[]`
- `getEventHistory(limit)` → `ParsedAgentEvent[]`
- `getSupportedCurrencies()` → `PublicKey[]`

## Environment Variables
```
SOLANA_RPC_URL   Mainnet RPC endpoint
PORT             HTTP port (default: 4000)
CACHE_TTL_MS     How long to cache per-mint responses (default: 10000)
```

## Requirements

### 1. Routes

#### `GET /agents/:mint/config`
Returns the agent's on-chain config:
```json
{
  "mint": "...",
  "authority": "...",
  "buybackBps": 500,
  "isInitialized": true
}
```
Validate that `mint` is a valid base58 public key; return 400 if not.

#### `GET /agents/:mint/balances`
Returns all vault balances for all supported currencies:
```json
{
  "mint": "...",
  "currencies": [
    {
      "currencyMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "symbol": "USDC",
      "paymentVault": { "address": "...", "balance": "1500000", "balanceHuman": "1.500000" },
      "buybackVault":  { "address": "...", "balance": "0",       "balanceHuman": "0.000000" },
      "withdrawVault": { "address": "...", "balance": "750000",  "balanceHuman": "0.750000" }
    }
  ]
}
```

#### `GET /agents/:mint/stats`
Returns aggregated stats for USDC (and any other supported currencies):
```json
{
  "mint": "...",
  "stats": [
    {
      "currencyMint": "...",
      "totalInvoicePaymentsMade": "42",
      "totalBuybackAmountUsdc": "21000000",
      "totalWithdrawAmountUsdc": "21000000"
    }
  ]
}
```

#### `GET /agents/:mint/payments?limit=50`
Returns the last `limit` payment events (max 200):
```json
{
  "mint": "...",
  "count": 42,
  "payments": [
    {
      "payer": "...",
      "amount": "1000000",
      "amountHuman": "1.000000",
      "memo": "...",
      "startTime": 1234567890,
      "endTime": 1234568190,
      "currencyMint": "..."
    }
  ]
}
```

#### `GET /agents/:mint/summary`
Combines config + balances + stats + last 10 payments in a single response. Uses `Promise.all` to fetch concurrently.

#### `GET /global`
Returns `GlobalConfig`: supported currency mints, authorities. No mint param needed.

#### `GET /health`
Returns `{ status: "ok", rpc: "<rpc_url_host>", slot: <current_slot> }`.

### 2. Caching
Implement a simple in-memory TTL cache keyed by `"<mint>-<route>"`. Respect `Cache-Control: no-cache` request header to bypass cache. Include `X-Cache: HIT|MISS` response header.

### 3. Input Validation
- Validate all `:mint` params with `PublicKey.isOnCurve` via `new PublicKey(mint)` — if it throws, return 400 `{ error: "Invalid mint address" }`.
- Validate `limit` query param: must be integer 1–200; default 50.

### 4. Error Responses
All errors return `{ error: string, code: string }`:
- 400: invalid input
- 404: agent not initialized on-chain (catch `AccountNotFoundError` from Anchor)
- 429: if the caller makes > 30 requests/minute to any mint (simple in-memory rate limiter by IP)
- 500: unexpected RPC errors

### 5. CORS
Allow all origins (`Access-Control-Allow-Origin: *`) — this is a public read-only API.

### 6. Response Times
Log each request's duration in ms. Add an `X-Response-Time: <ms>ms` header to every response.

### 7. Concurrent Agent Support
The API must support any valid agent mint on Solana mainnet — it instantiates `new PumpAgent(mint, "mainnet", connection)` per request (cached by mint for `CACHE_TTL_MS`).

## Deliverables
- `agent-prompts/solana/agents/stats-api/server.ts`
- `agent-prompts/solana/agents/stats-api/cache.ts`
- `agent-prompts/solana/agents/stats-api/package.json`
- `agent-prompts/solana/agents/stats-api/README.md` — with curl examples for every route

## Acceptance Criteria
- All 7 routes return correct data for a real agent mint on mainnet.
- `GET /agents/<invalid>/config` returns 400.
- `GET /agents/<uninitialized_mint>/config` returns 404.
- Cache hits are significantly faster than cache misses (observable in logs).
- No hardcoded mint addresses in the server code — every request works with any valid agent mint.
