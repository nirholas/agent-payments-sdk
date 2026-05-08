# EVM Payment Proof Validator

Server-side library and CLI for decoding, validating, and enforcing EVM x402 `X-Payment` headers in any Node.js application.

## What it does

1. Decodes the base64 JSON `X-Payment` header into an `EvmPaymentProof`.
2. Verifies the memo matches the expected invoice ID.
3. Looks up the bridge deposit via the Pump cross-chain API and checks the USDC amount.
4. Optionally waits for Solana-side confirmation before approving the request.

## Setup

From the workspace root, build the SDK first:

```bash
npm run build          # from repo root
```

Then install this package's dependencies:

```bash
cd agent-prompts/evm/agents/payment-validator
npm install
```

## CLI

### Decode a proof

```bash
npx tsx cli.ts decode <base64_header>
```

Pretty-prints all fields of the `EvmPaymentProof`.

### Verify a proof against the live API

```bash
npx tsx cli.ts verify <base64_header> \
  --memo=<expected_memo> \
  --min=<usdc_decimal>   \
  --agent=<agent_mint>   \
  [--wait]
```

- `--min` is a decimal USDC amount (e.g. `1.5` = 1,500,000 minor units).
- `--wait` blocks until the payment arrives on Solana (default: EVM-only verification).

### Generate a challenge header

```bash
npx tsx cli.ts challenge \
  --agent=<solana_mint>       \
  --amount=<usdc_decimal>     \
  --resource=<request_url>    \
  --pay-to=<solana_wallet>    \
  [--window=<seconds>]        # default 300
```

Prints the `X-Payment-Required` header value, the memo to store, and the expiry time.

### List supported chains

```bash
npx tsx cli.ts supported-chains
```

## Library usage

### Core validation

```typescript
import { decodeAndValidateHeader, validatePayment, buildChallenge, isExpired } from "./index.js";

// Build a 402 challenge
const { header, memo, expiresAt } = buildChallenge({
  agentMint: "AgentMint...",
  minAmountUsdc: 1.0,
  resource: "https://api.example.com/data",
  description: "Access to premium data",
  payTo: "SolanaWallet...",
});
// Store memo + expiresAt keyed by request ID, return header in 402 response

// Later, validate the client's X-Payment header
const proof = decodeAndValidateHeader(req.headers["x-payment"]);
if (!proof) return res.status(402).end();

const result = await validatePayment({
  proof,
  expectedMemo: storedMemo,
  minAmountUsdcMinor: 1_000_000n,  // 1 USDC
  agentMint: "AgentMint...",
  waitForSolana: false,
});

if (!result.valid) return res.status(402).json({ error: result.error });
// proceed...
```

### Express middleware

```typescript
import express from "express";
import { createEvmPaymentMiddleware } from "./index.js";

const app = express();

const invoiceStore = new Map<string, { memo: string; expiresAt: Date }>();

app.use(
  "/api/paid",
  createEvmPaymentMiddleware({
    agentMint: process.env.AGENT_MINT!,
    minAmountUsdcMinor: 1_000_000n,
    waitForSolana: false,
    getMemo: async (req) => {
      const inv = invoiceStore.get(req.url ?? "");
      if (!inv || isExpired(inv.expiresAt)) return null;
      return inv.memo;
    },
    onValid: (req, result) => {
      console.log(`Payment confirmed: ${result.depositId}`);
    },
  })
);

app.get("/api/paid/data", (req, res) => {
  // req.paymentProof is available here
  res.json({ data: "...", proof: req.paymentProof });
});
```

## Error types

| Error | When |
|---|---|
| `InvalidSchemeError` | `X-Payment` header has a non-`pump-agent-evm` scheme |
| `MemoMismatchError` | Header memo doesn't match the expected invoice memo |
| `InsufficientAmountError` | Deposit amount is below the required minimum |
| `DepositNotFoundError` | No deposit found for the given tx hash |
| `SolanaArrivalTimeoutError` | `waitForSolana` timed out before confirmation |

> `validatePayment` never throws — errors are returned in `result.error` with `result.valid: false`.  
> Only `decodeAndValidateHeader` throws `InvalidSchemeError`.

## ValidationResult fields

| Field | Present when |
|---|---|
| `valid` | Always |
| `depositId` | Deposit lookup succeeded |
| `confirmedAmountUsdc` | Deposit lookup succeeded (human-readable, e.g. `"1.5"`) |
| `confirmedAmountMinor` | Deposit lookup succeeded (bigint, 6 decimals) |
| `solanaSignature` | `waitForSolana: true` and payment arrived |
| `chainId` / `chainName` | Always |
| `txHash` | Always |
| `verifiedAt` | `valid: true` |
| `error` | `valid: false` |

## Running tests

```bash
npm test
```

For optional end-to-end test with a real bridge tx:

```bash
TEST_TX_HASH=0x... TEST_CHAIN_ID=8453 TEST_AGENT_MINT=... TEST_MEMO=... npm test
```

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `PUMP_CROSSCHAIN_API` | `https://api.pump.fun/crosschain` | Override the Pump API base URL |
