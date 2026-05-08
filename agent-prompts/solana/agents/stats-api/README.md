# Pump Agent Payment Stats API

A production-quality REST API that exposes real-time and historical payment statistics for any Pump Agent by querying on-chain data via `PumpAgent`. No authentication required; all data is public on-chain.

## Stack

- **Runtime**: Node.js (ESM)
- **Framework**: [Hono](https://hono.dev) + `@hono/node-server`
- **Chain**: Solana mainnet via `@solana/web3.js`
- **SDK**: `@nirholas/agent-payments-sdk`

## Setup

```bash
npm install
```

## Environment Variables

| Variable        | Default                                    | Description                              |
| --------------- | ------------------------------------------ | ---------------------------------------- |
| `SOLANA_RPC_URL` | `https://api.mainnet-beta.solana.com`     | Mainnet RPC endpoint                     |
| `PORT`          | `4000`                                     | HTTP port                                |
| `CACHE_TTL_MS`  | `10000`                                    | Per-mint response cache TTL (ms)         |

## Running

```bash
# Development (auto-restart on changes)
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY npm run dev

# Production
SOLANA_RPC_URL=https://mainnet.helius-rpc.com/?api-key=YOUR_KEY npm start
```

## Routes

### `GET /health`

Liveness check. Returns current slot to confirm RPC connectivity.

```bash
curl http://localhost:4000/health
```

```json
{
  "status": "ok",
  "rpc": "mainnet.helius-rpc.com",
  "slot": 310845291
}
```

---

### `GET /global`

Returns the protocol-wide `GlobalConfig`: supported currency mints and protocol authorities.

```bash
curl http://localhost:4000/global
```

```json
{
  "protocolAuthority": "...",
  "buybackAuthority": "...",
  "supportedCurrenciesMint": [
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
  ],
  "tokenizedAgentSequence": "42"
}
```

---

### `GET /agents/:mint/config`

Returns the agent's on-chain `TokenAgentPayments` config.

```bash
AGENT_MINT=<your_agent_mint>
curl http://localhost:4000/agents/$AGENT_MINT/config
```

```json
{
  "mint": "...",
  "authority": "...",
  "buybackBps": 500,
  "isInitialized": true
}
```

**Error cases**

```bash
# Invalid base58 → 400
curl http://localhost:4000/agents/not-a-pubkey/config

# Valid pubkey but no agent on-chain → 404
curl http://localhost:4000/agents/11111111111111111111111111111111/config
```

---

### `GET /agents/:mint/balances`

Returns live vault balances for every supported currency.

```bash
curl http://localhost:4000/agents/$AGENT_MINT/balances
```

```json
{
  "mint": "...",
  "currencies": [
    {
      "currencyMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "symbol": "USDC",
      "paymentVault": {
        "address": "...",
        "balance": "1500000",
        "balanceHuman": "1.500000"
      },
      "buybackVault": {
        "address": "...",
        "balance": "0",
        "balanceHuman": "0.000000"
      },
      "withdrawVault": {
        "address": "...",
        "balance": "750000",
        "balanceHuman": "0.750000"
      }
    }
  ]
}
```

---

### `GET /agents/:mint/stats`

Returns aggregated on-chain accounting counters for all supported currencies.

```bash
curl http://localhost:4000/agents/$AGENT_MINT/stats
```

```json
{
  "mint": "...",
  "stats": [
    {
      "currencyMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "totalInvoicePaymentsMade": "42",
      "totalBuybackAmount": "21000000",
      "totalWithdrawAmount": "21000000",
      "tokensBoughtBackAndBurned": "1000000000"
    }
  ]
}
```

---

### `GET /agents/:mint/payments?limit=50`

Returns the last `limit` payment events (1–200, default 50) from on-chain transaction logs.

```bash
# Last 50 payments (default)
curl http://localhost:4000/agents/$AGENT_MINT/payments

# Last 10 payments
curl "http://localhost:4000/agents/$AGENT_MINT/payments?limit=10"

# Bypass cache
curl -H "Cache-Control: no-cache" "http://localhost:4000/agents/$AGENT_MINT/payments?limit=25"
```

```json
{
  "mint": "...",
  "count": 3,
  "payments": [
    {
      "payer": "...",
      "amount": "1000000",
      "amountHuman": "1.000000",
      "memo": "1234",
      "startTime": 1700000000,
      "endTime": 1700003600,
      "currencyMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "timestamp": 1700001234
    }
  ]
}
```

**Error case — invalid limit**

```bash
curl "http://localhost:4000/agents/$AGENT_MINT/payments?limit=999"
# → 400 { "error": "limit must be an integer between 1 and 200", "code": "INVALID_LIMIT" }
```

---

### `GET /agents/:mint/summary`

Combines config + balances + stats + last 10 payments in a single response. All four data sources are fetched concurrently via `Promise.all`.

```bash
curl http://localhost:4000/agents/$AGENT_MINT/summary
```

```json
{
  "mint": "...",
  "config": {
    "mint": "...",
    "authority": "...",
    "buybackBps": 500
  },
  "balances": [ { "currencyMint": "...", "symbol": "USDC", "paymentVault": { ... }, ... } ],
  "stats": [ { "currencyMint": "...", "totalInvoicePaymentsMade": "42", ... } ],
  "recentPayments": [ { "payer": "...", "amount": "1000000", ... } ]
}
```

---

## Response Headers

| Header              | Description                                  |
| ------------------- | -------------------------------------------- |
| `X-Cache`           | `HIT` if served from cache, `MISS` otherwise |
| `X-Response-Time`   | Wall-clock time for the request (e.g. `12ms`) |

## Rate Limiting

30 requests per minute per IP. Exceeding the limit returns:

```json
{ "error": "Rate limit exceeded", "code": "RATE_LIMITED" }
```

with HTTP status `429`.

## Caching

Responses are cached in memory for `CACHE_TTL_MS` milliseconds, keyed by `<mint>-<route>`. Send `Cache-Control: no-cache` to bypass the cache and force a fresh RPC fetch.

## Error Response Shape

All errors follow the same shape:

```json
{ "error": "Human-readable message", "code": "MACHINE_READABLE_CODE" }
```

| HTTP Status | Code               | Cause                                    |
| ----------- | ------------------ | ---------------------------------------- |
| 400         | `INVALID_MINT`     | `:mint` is not a valid base58 public key |
| 400         | `INVALID_LIMIT`    | `?limit` is outside 1–200               |
| 404         | `AGENT_NOT_FOUND`  | No `TokenAgentPayments` account on-chain |
| 429         | `RATE_LIMITED`     | > 30 req/min from this IP                |
| 500         | `INTERNAL_ERROR`   | Unexpected RPC or program error          |
| 500         | `RPC_ERROR`        | RPC unreachable (health route only)      |
