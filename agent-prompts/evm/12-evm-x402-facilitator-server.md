# Task: EVM USDC x402 Facilitator & Resource Server

## Objective
Build a production-ready HTTP API server that acts as both an **x402 Resource Server** (using `buildPaymentRequiredHeader` from `src/x402/evm-facilitator.ts`) and a **Facilitator** (using `verifyEvmPayment`) for EVM USDC cross-chain payments. The server verifies `X-Payment` proof headers, waits for Solana-side arrival, and only serves the gated resource after full settlement.

## Context
`buildPaymentRequiredHeader` encodes `EvmX402PaymentRequirements` as base64 JSON into `X-Payment-Required`.
`verifyEvmPayment` calls `PUMP_CROSSCHAIN_API/deposit?txHash=<hash>&chainId=<id>` to look up the bridge deposit, checks USDC amount, and optionally polls until the bridge arrives on Solana.
`decodePaymentHeader` decodes the `X-Payment` header from incoming requests.

The cross-chain API base (`PUMP_CROSSCHAIN_API`) is defined in `src/constants.ts` — import it directly.

## Environment Variables
```
AGENT_MINT              Solana pump agent token mint (identifies which agent earns)
AGENT_PAYMENT_VAULT     Solana address receiving the cross-chain USDC
PORT                    HTTP port (default: 3002)
WAIT_FOR_SOLANA         Whether to wait for Solana arrival before responding (default: true)
PRICE_USDC_MINOR        Price per request in 6-decimal USDC minor units (default: 1000000 = $1)
```

## Requirements

### 1. Framework
Use **Hono** with the `@hono/node-server` adapter.

### 2. Invoice Memo Generation
Generate a unique memo per 402 challenge:
```ts
function newMemo(): string {
  return `${Date.now()}${Math.floor(Math.random() * 1_000_000).toString().padStart(6, "0")}`;
}
```
Store active memos in a `Map<string, { createdAt: number, path: string }>` with a 10-minute TTL. Expired memos must be rejected even if the payment was valid.

### 3. Payment Required Route (402)
For every gated route, if no `X-Payment` header is present, respond:
```
HTTP 402 Payment Required
X-Payment-Required: <base64 of EvmX402PaymentRequirements>
Content-Type: application/json
```
Use `buildPaymentRequiredHeader` with:
```ts
{
  agentMint: AGENT_MINT,
  maxAmountUsdc: BigInt(PRICE_USDC_MINOR),
  resource: req.url,
  description: "<route description>",
  payTo: AGENT_PAYMENT_VAULT,
  memo: newMemo(),
}
```

### 4. Payment Verification Middleware
Implement `verifyPaymentMiddleware` (Hono middleware):
1. Read `X-Payment` header.
2. Decode via `decodePaymentHeader` — if null, send 402.
3. Look up the memo in the active-memo store. If not found or expired: 402 with `"Unknown or expired memo"`.
4. Call `verifyEvmPayment({ proof, expectedMemo: storedMemo, minAmountUsdc, agentMint, waitForSolana })`.
5. If `!result.valid`: 402 with `result.error`.
6. If valid: delete memo from store (prevent replay), set `c.set("paymentProof", result)`, call `next()`.

### 5. Gated Routes
Apply `verifyPaymentMiddleware` to:

- `GET /api/quote` — calls the CoinGecko API for real ETH and SOL USD prices:
  `https://api.coingecko.com/api/v3/simple/price?ids=ethereum,solana&vs_currencies=usd`
  Returns `{ ethereum: { usd: number }, solana: { usd: number } }`.

- `POST /api/echo` — returns the request body verbatim as JSON. Validates body is valid JSON (400 if not).

- `GET /api/timestamp` — returns `{ timestamp: <unix_seconds>, iso: <ISO8601>, network: "solana-mainnet" }`.

### 6. Payment Receipt Header
After every successful gated response, attach:
```
X-Payment-Receipt: <base64 JSON of { depositId, solanaSignature, confirmedAmountUsdc, servedAt }>
```
Extract these fields from `verifyEvmPayment`'s return value.

### 7. Health & Discovery
- `GET /health` — `{ status: "ok", agentMint, priceUsdc: "<human>", waitForSolana: <bool> }`.
- `GET /.well-known/evm-payments` — returns the agent's payment manifest:
  ```json
  {
    "agentMint": "...",
    "supportedChains": [1, 8453, 42161, 137, 56, 43114],
    "usdcAddresses": { "1": "0xA0b86...", "8453": "0x833589..." },
    "priceUsdc": "1.000000",
    "routes": ["/api/quote", "/api/echo", "/api/timestamp"]
  }
  ```
  The USDC addresses must be imported from `src/chains.ts` — no hardcoding.

### 8. Duplicate Payment Protection
Use the memo store deletion in step 4.6 as primary protection. Additionally, maintain a `Set<string>` of used deposit IDs with a 24-hour TTL. If a deposit ID reappears: 402 with `"Deposit already used"`.

### 9. Error Handling
All errors return `{ error: string }` JSON. Log every request: `[method] path status payer=<depositId|none> time=<ms>ms`.

## Deliverables
- `agent-prompts/evm/agents/x402-facilitator-server/server.ts`
- `agent-prompts/evm/agents/x402-facilitator-server/middleware.ts`
- `agent-prompts/evm/agents/x402-facilitator-server/package.json`
- `agent-prompts/evm/agents/x402-facilitator-server/README.md`

## Acceptance Criteria
- Unauthenticated `GET /api/quote` returns 402 with a valid `X-Payment-Required` header.
- A paid request (from task 11 EVM client) returns 200 with real CoinGecko data and `X-Payment-Receipt`.
- Memo replay (reusing the same `X-Payment` header) returns 402 `"Deposit already used"`.
- Expired memo (wait > 10 min) returns 402 `"Unknown or expired memo"`.
- `/.well-known/evm-payments` returns USDC addresses matching `src/chains.ts`.
