# x402 Resource Server — Solana USDC Payment Wall

A production-ready Hono HTTP server that gates every API route behind an
x402 USDC payment verified on Solana mainnet. Every unauthenticated request
returns HTTP 402 with a fresh `PAYMENT-REQUIRED` challenge. Paid requests are
verified on-chain via `PumpAgentFacilitator` and settled before the handler
runs.

---

## Architecture

```
Client                Resource Server             Facilitator (in-process)
  │                        │                              │
  │── GET /api/price ──────►│                              │
  │◄── 402 PAYMENT-REQUIRED─│                              │
  │                        │                              │
  │  (client builds tx,    │                              │
  │   signs + sends it)    │                              │
  │                        │                              │
  │── GET /api/price ──────►│                              │
  │   PAYMENT-SIGNATURE     │── verify(payload, req) ─────►│
  │                        │◄── { isValid: true } ─────────│
  │                        │── settle(payload, req) ──────►│
  │                        │◄── { success: true, txSig } ──│
  │◄── 200 PAYMENT-RESPONSE─│                              │
```

---

## Environment Variables

| Variable          | Required | Description                                             |
|-------------------|----------|---------------------------------------------------------|
| `SOLANA_RPC_URL`  | Yes      | Solana mainnet RPC endpoint (e.g. Helius, QuickNode)    |
| `AGENT_MINT`      | Yes      | Base58 pump token mint with agent-payments initialized  |
| `PAYMENT_VAULT`   | Yes      | Base58 address to receive USDC (payment vault PDA)      |
| `PORT`            | No       | HTTP port (default: `3000`)                             |

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Set environment variables
export SOLANA_RPC_URL="https://mainnet.helius-rpc.com/?api-key=YOUR_KEY"
export AGENT_MINT="YourAgentMintBase58..."
export PAYMENT_VAULT="YourVaultAddressBase58..."
export PORT=3000

# 3. Start the server
npm start
```

---

## Routes

| Method | Path           | Price      | Description                          |
|--------|----------------|------------|--------------------------------------|
| GET    | `/health`      | Free       | Server liveness + current slot       |
| GET    | `/api/price`   | 1 USDC     | Live SOL/USD price from CoinGecko    |
| POST   | `/api/analyze` | 1 USDC     | Word and character count for text    |
| GET    | `/api/block`   | 0.1 USDC   | Current Solana slot and block time   |

---

## Example: 402 Challenge → Paid Response

### Step 1 — Unauthenticated request returns 402

```bash
curl -i http://localhost:3000/api/price
```

```
HTTP/1.1 402 Payment Required
Content-Type: application/json
PAYMENT-REQUIRED: eyJ4NDAyVmVyc2lvbiI6MiwiY...

{
  "x402Version": 2,
  "resource": { "url": "/api/price", "description": "Live SOL price in USD" },
  "accepts": [
    {
      "scheme": "pump-agent",
      "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "amount": "1000000",
      "payTo": "YourVaultAddressBase58...",
      "maxTimeoutSeconds": 60,
      "extra": {
        "agentMint": "YourAgentMintBase58...",
        "memo": "1746700123456000042",
        "startTime": 1746700123,
        "endTime": 1746700423
      }
    }
  ]
}
```

### Step 2 — Decode the challenge, build + send a payment tx, retry with proof

Use the `createX402Fetch` client from `@nirholas/agent-payments-sdk/solana` (see
`agent-prompts/solana/01-solana-x402-fetch-client.md`) to handle this
automatically.

### Step 3 — Paid request returns 200

```bash
curl -i \
  -H "PAYMENT-SIGNATURE: eyJ4NDAyVmVyc2lvbiI6Mn..." \
  http://localhost:3000/api/price
```

```
HTTP/1.1 200 OK
Content-Type: application/json
PAYMENT-RESPONSE: eyJzdWNjZXNzIjp0cnVlLCJ0...

{ "price": 148.32 }
```

Decode `PAYMENT-RESPONSE` (base64 JSON) to get:

```json
{
  "success": true,
  "transaction": "5KtPn1LGuxhFiwjxqPHAvnWwmRcBmtZjEh7uuBJGa4qN...",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "payer": "YourWalletAddressBase58..."
}
```

### Step 4 — Replay of the same signature returns 402

```bash
# Same PAYMENT-SIGNATURE header reused
curl -i \
  -H "PAYMENT-SIGNATURE: eyJ4NDAyVmVyc2lvbiI6Mn..." \
  http://localhost:3000/api/price
```

```
HTTP/1.1 402 Payment Required
Content-Type: application/json

{ "error": "Duplicate payment" }
```

---

## POST /api/analyze Example

```bash
curl -i -X POST \
  -H "Content-Type: application/json" \
  -H "PAYMENT-SIGNATURE: <encoded-payload>" \
  -d '{"text": "Hello Solana world"}' \
  http://localhost:3000/api/analyze
```

```json
{ "words": 3, "chars": 18, "text": "Hello Solana world" }
```

---

## Replay Protection

`PumpAgentFacilitator` maintains an in-memory `SettlementCache` (TTL 120 s,
max 10 000 entries). A transaction signature accepted once is rejected with
`"Duplicate payment"` for the next 120 seconds.

> **Multi-replica warning:** each replica has its own in-process cache. To
> prevent replay attacks across replicas, replace the in-memory cache with a
> shared external store such as Redis (`SET <sig> 1 NX EX 120`). This requires
> forking `PumpAgentFacilitator` and injecting a Redis client.

---

## Log Format

```
[GET] /api/price | status=200 | payer=ABC...XYZ | sig=5Kt...N1L
[GET] /api/price | status=402 | payer=none | sig=none
```
