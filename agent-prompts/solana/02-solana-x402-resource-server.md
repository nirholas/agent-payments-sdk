<!-- agent-payments-sdk | Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas -->

# Task: Solana USDC x402 Resource Server (Hono)

## Objective
Build a production-ready HTTP API server using **Hono** that gates every route behind an x402 USDC payment wall using `createResourceServer` and `PumpAgentFacilitator` from `@nirholas/agent-payments-sdk/solana`. The server must earn real USDC on every call — no payment, no response.

## Context
`createResourceServer` (in `src/solana/x402/facilitator.ts`) returns a middleware that:
1. Returns HTTP 402 + `PAYMENT-REQUIRED` header on unauthenticated requests.
2. Verifies the `PAYMENT-SIGNATURE` header via `PumpAgentFacilitator.verify()`.
3. Calls `PumpAgentFacilitator.settle()` (marks invoice as settled, prevents replay).
4. Forwards to the real handler and attaches `PAYMENT-RESPONSE` header.

`buildPumpAgentRequirements` generates fresh invoice memos so each 402 challenge is unique.

## Environment Variables
```
SOLANA_RPC_URL         Mainnet RPC endpoint
AGENT_MINT             Base58 pump token mint that has agent-payments initialized
PAYMENT_VAULT          Base58 address to receive USDC (typically the payment vault PDA)
PORT                   HTTP port (default 3000)
```

## Requirements

### 1. Server Setup
- Use `hono` with the Node.js adapter (`@hono/node-server`).
- Read all config from env vars; crash with a descriptive error if any required var is missing.
- Create a `Connection` with `commitment: "confirmed"` from `SOLANA_RPC_URL`.
- Instantiate `PumpAgentFacilitator({ connection })`.

### 2. Payment Requirements Factory
On every incoming request, generate **fresh** requirements using `buildPumpAgentRequirements`:
```ts
buildPumpAgentRequirements({
  agentMint: process.env.AGENT_MINT,
  payTo: process.env.PAYMENT_VAULT,
  amount: "1000000",          // 1 USDC (6 decimals)
  invoiceWindowSeconds: 300,
  maxTimeoutSeconds: 60,
})
```
Requirements must be regenerated per-request (not cached) so each invoice memo is unique.

### 3. Gated Routes
Wrap **every** handler with the `createResourceServer` gate:

- `GET /api/price` — returns `{ price: <current_sol_price_usd> }` fetched from the **CoinGecko public API** (`https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd`). Price for 1 USDC.

- `POST /api/analyze` — accepts `{ text: string }` in the request body, returns a basic word count and character count: `{ words: number, chars: number, text: string }`. Price for 1 USDC.

- `GET /api/block` — returns the current Solana slot and block time fetched live from the RPC connection (`connection.getSlot()`, `connection.getBlockTime(slot)`). Price for 0.1 USDC (100000 minor units).

### 4. Resource Server Wiring
Each route's `createResourceServer` config must include a distinct `resource.url` and `resource.description`.

Example wiring for Hono:
```ts
app.get("/api/price", async (c) => {
  const gate = createResourceServer({
    facilitator,
    requirements: [buildPumpAgentRequirements({ ... })],
    resource: { url: "/api/price", description: "Live SOL price in USD" },
  });
  return gate(c.req.raw, async () => {
    // real handler — fetch CoinGecko
  });
});
```

### 5. Health Check
`GET /health` — returns `{ status: "ok", agentMint, slot: <current_slot> }` with no payment gate.

### 6. Logging
Log every request: `[METHOD] /path | status=<N> | payer=<pubkey|none> | sig=<txSig|none>`. Extract `payer` and `sig` from the settled `PAYMENT-RESPONSE` header when present.

### 7. Replay Protection
`PumpAgentFacilitator` contains an in-memory `SettlementCache` (TTL 120 s). Document in comments that a production deployment with multiple replicas needs an external store (Redis) replacing this cache.

### 8. Error Handling
Return structured JSON errors for all 4xx/5xx cases. Never expose raw stack traces to HTTP clients.

## Deliverables
- `agent-prompts/solana/agents/x402-resource-server/server.ts` — full server implementation
- `agent-prompts/solana/agents/x402-resource-server/package.json`
- `agent-prompts/solana/agents/x402-resource-server/README.md` — startup instructions, env var table, example curl showing 402 then paid response

## Acceptance Criteria
- Server starts, binds on `PORT`, and responds to `GET /health`.
- An unauthenticated `GET /api/price` returns HTTP 402 with valid `PAYMENT-REQUIRED` header decodable as `PaymentRequired`.
- A paid request (using the client from task 01) returns 200 with `PAYMENT-RESPONSE` header.
- Replay of the same `PAYMENT-SIGNATURE` returns 402 with `"Duplicate payment"` error.
- No mocks. All on-chain validation calls hit the real Solana mainnet.
