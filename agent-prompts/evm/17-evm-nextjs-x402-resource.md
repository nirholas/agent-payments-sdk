# Task: EVM USDC x402 Resource Server in Next.js App Router

## Objective
Build a production-quality Next.js 14 App Router application with USDC-gated API routes using the EVM x402 payment scheme. Each API route returns HTTP 402 with `X-Payment-Required` until a valid `X-Payment` bridge proof is submitted, at which point the route verifies the payment via `verifyEvmPayment` and serves the resource.

## Context
Next.js App Router Route Handlers use the standard `Request` / `Response` Web API, making them compatible with `verifyEvmPayment` from `src/x402/evm-facilitator.ts` and `buildPaymentRequiredHeader` / `decodePaymentHeader`.

## Environment Variables (`.env.local`)
```
AGENT_MINT                     Solana pump agent mint
AGENT_PAYMENT_VAULT            Solana address receiving bridged USDC
PRICE_USDC_MINOR               Price in 6-decimal minor units (default: 500000 = $0.50)
WAIT_FOR_SOLANA                "true" or "false" (default: "false" for fast responses)
NEXT_PUBLIC_SUPPORTED_CHAINS   Comma-separated chain IDs (e.g., "8453,42161")
```

## Requirements

### 1. Next.js Project Setup
Initialize a Next.js 14 project with:
- TypeScript
- App Router
- Tailwind CSS (for the front-end pages)
- No `src/` directory — use the root `app/` directory

Install: `@nirholas/agent-payments-sdk`, `viem`

### 2. Payment Challenge Utility (`lib/payment.ts`)
```ts
export function buildChallenge(resource: string, description: string): {
  header: string;
  memo: string;
  expiresAt: number;
}
```
- Generates a fresh memo via `${Date.now()}${Math.floor(Math.random() * 999999).toString().padStart(6, "0")}`.
- Calls `buildPaymentRequiredHeader`.
- Stores memo → expiry in a module-level `Map<string, number>` (in-memory; document the multi-replica caveat).
- Returns `{ header, memo, expiresAt }`.

```ts
export function consumeMemo(memo: string): boolean
```
Returns `true` and deletes the memo if it exists and is not expired. Returns `false` otherwise.

### 3. Gated API Routes

#### `app/api/crypto/price/route.ts`
- `GET`: if no `X-Payment`, return 402 with challenge. If valid payment, return real CoinGecko prices for BTC, ETH, SOL.
  URL: `https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana&vs_currencies=usd,btc`

#### `app/api/crypto/news/route.ts`
- `GET`: if no `X-Payment`, return 402. If valid, return latest 5 crypto news headlines from the CoinGecko news endpoint:
  `https://api.coingecko.com/api/v3/news` (returns `{ data: [{ title, description, url, published_at }] }`).

#### `app/api/agent/[mint]/stats/route.ts`
Dynamic route. `GET /api/agent/<mint>/stats` — if no payment, 402. If paid, call the Pump.fun blockchain client:
`https://fun-block.pump.fun/agents/<mint>/stats`
Return the raw JSON from that endpoint. Validate `mint` is a valid base58 string (return 400 if not).

### 4. Payment Verification Implementation
In each route handler, implement the verification inline (not as middleware, since Next.js App Router doesn't support Express-style middleware):

```ts
export async function GET(req: NextRequest) {
  const paymentHeader = req.headers.get("x-payment");

  if (!paymentHeader) {
    const challenge = buildChallenge(req.url, "description");
    return new Response(JSON.stringify({ error: "Payment required" }), {
      status: 402,
      headers: {
        "Content-Type": "application/json",
        "X-Payment-Required": challenge.header,
        "X-Payment-Memo": challenge.memo,
      },
    });
  }

  const proof = decodePaymentHeader(paymentHeader);
  if (!proof) return new Response("Invalid payment header", { status: 400 });

  const memo = req.headers.get("x-payment-memo") ?? "";
  if (!consumeMemo(memo)) {
    return new Response(JSON.stringify({ error: "Unknown or expired memo" }), { status: 402 });
  }

  const result = await verifyEvmPayment({
    proof,
    expectedMemo: memo,
    minAmountUsdc: BigInt(process.env.PRICE_USDC_MINOR ?? "500000"),
    agentMint: process.env.AGENT_MINT!,
    waitForSolana: process.env.WAIT_FOR_SOLANA === "true",
  });

  if (!result.valid) {
    return new Response(JSON.stringify({ error: result.error }), { status: 402 });
  }

  // ... real handler
}
```

### 5. Front-End Demo Page (`app/page.tsx`)
A React page that shows:
- A list of the 3 gated API endpoints with their prices.
- A `Connect Wallet` button using `window.ethereum` (MetaMask / injected provider).
- For each endpoint: a `Pay & Fetch` button that:
  1. Fetches the endpoint (no payment header).
  2. Gets the 402 + `X-Payment-Required` header.
  3. Decodes the payment requirements.
  4. Asks for MetaMask confirmation (show the amount and destination).
  5. Sends the bridge tx via `window.ethereum`.
  6. Retries the request with `X-Payment` + `X-Payment-Memo` headers.
  7. Displays the response data.

Use no React state management library — plain `useState` / `useEffect` only.

### 6. Types
Export a shared `PaymentChallenge` type from `lib/types.ts`. Do not `any`-cast payment proofs.

### 7. Error Boundaries
The front-end must catch and display errors from:
- Wallet not connected
- User rejected the MetaMask transaction
- Payment verification failure (display the error message from the API)
- Network errors

## Deliverables
- Full Next.js project at `agent-prompts/evm/agents/nextjs-x402/`
- All route handlers: `app/api/crypto/price/route.ts`, `app/api/crypto/news/route.ts`, `app/api/agent/[mint]/stats/route.ts`
- Front-end: `app/page.tsx`, `app/layout.tsx`
- Utilities: `lib/payment.ts`, `lib/types.ts`
- `package.json`, `tsconfig.json`, `next.config.ts`, `.env.local.example`
- `README.md` with setup and MetaMask testing instructions

## Acceptance Criteria
- `next build` completes without TypeScript or lint errors.
- `GET /api/crypto/price` without a header returns 402 with a parseable `X-Payment-Required`.
- A valid payment proof with matching memo returns real CoinGecko data.
- Expired memo returns 402 `"Unknown or expired memo"`.
- The front-end page loads and shows all 3 endpoints.
- MetaMask integration uses `window.ethereum.request({ method: "eth_sendTransaction" })` — no wagmi/rainbow kit.
