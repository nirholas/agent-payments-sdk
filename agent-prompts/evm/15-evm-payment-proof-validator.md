# Task: EVM USDC Payment Proof Decoder & Validator

## Objective
Build a TypeScript library + CLI that decodes and validates EVM x402 `X-Payment` headers, looks up the corresponding bridge deposit via the Pump cross-chain API, verifies the USDC amount, and optionally waits for Solana-side confirmation — suitable for use as a server-side middleware in any Node.js framework.

## Context
`decodePaymentHeader` from `src/x402/evm-facilitator.ts` decodes the base64 JSON `X-Payment` header into `EvmPaymentProof`.
`verifyEvmPayment` performs the full verification: memo check, deposit lookup, amount check, and optional Solana wait.
`buildPaymentRequiredHeader` builds the `X-Payment-Required` header for sending 402 responses.

The `EvmPaymentProof` type:
```ts
{
  scheme: "pump-agent-evm";
  chainId: SupportedEvmChainId;  // 1 | 8453 | 42161 | 137 | 56 | 43114
  txHash: `0x${string}`;
  quoteId: string;
  memo: string;
}
```

## Requirements

### 1. Core Library (`validator.ts`)

#### `decodeAndValidateHeader(headerValue: string | null): EvmPaymentProof | null`
- Wraps `decodePaymentHeader`.
- Returns null for missing/malformed headers.
- Throws `InvalidSchemeError` if scheme is not `"pump-agent-evm"`.

#### `async validatePayment(params): ValidationResult`
Full params:
```ts
{
  proof: EvmPaymentProof,
  expectedMemo: string,
  minAmountUsdcMinor: bigint,
  agentMint: string,
  waitForSolana?: boolean,
  timeoutMs?: number,
}
```
Returns:
```ts
{
  valid: boolean,
  depositId?: string,
  confirmedAmountUsdc?: string,      // human-readable
  confirmedAmountMinor?: bigint,
  solanaSignature?: string,
  chainId?: number,
  chainName?: string,
  txHash?: string,
  verifiedAt?: Date,
  error?: string,
}
```

#### `buildChallenge(opts): { header: string, memo: string, expiresAt: Date }`
```ts
opts: {
  agentMint: string,
  minAmountUsdc: number,     // decimal
  resource: string,
  description: string,
  payTo: string,             // Solana address
  windowSeconds?: number,    // default 300
}
```
- Generates a fresh memo.
- Calls `buildPaymentRequiredHeader` with all fields.
- Returns the encoded header value + memo + expiry time.

#### `isExpired(expiresAt: Date): boolean`
Simple utility.

### 2. Express/Node Middleware (`middleware.ts`)

Implement `createEvmPaymentMiddleware(opts)`:
```ts
opts: {
  agentMint: string,
  minAmountUsdcMinor: bigint,
  waitForSolana: boolean,
  getMemo: (req: IncomingMessage) => Promise<string | null>,
  onValid: (req: IncomingMessage, result: ValidationResult) => void,
}
```
Returns a standard `(req, res, next) => void` Express middleware that:
1. Reads `req.headers["x-payment"]`.
2. Decodes and validates via `validatePayment`.
3. If valid: calls `onValid`, sets `(req as any).paymentProof = result`, calls `next()`.
4. If invalid: sends `{ status: 402, error: result.error }`.

#### `getMemo` implementation
The caller provides `getMemo` — typically looks up an expected memo from their own invoice store keyed by request path + user ID. This keeps the validator decoupled from any particular storage.

### 3. CLI Tool (`cli.ts`)

```
node cli.ts decode <base64_header>
```
Decodes and pretty-prints the `EvmPaymentProof` fields.

```
node cli.ts verify <base64_header> --memo=<memo> --min=<usdc_decimal> --agent=<agent_mint>
```
Runs `validatePayment` against the real API and prints the result. Use `--wait` flag to enable `waitForSolana`.

```
node cli.ts challenge --agent=<mint> --amount=<usdc> --resource=<url> --pay-to=<solana_addr>
```
Generates a fresh challenge (`X-Payment-Required` header value) and prints it with the memo and expiry.

```
node cli.ts supported-chains
```
Prints all 6 supported chain IDs and their USDC addresses from `src/chains.ts`.

### 4. Error Types
Export these typed errors:
```ts
class InvalidSchemeError extends Error {}
class MemoMismatchError extends Error { constructor(got: string, expected: string) }
class InsufficientAmountError extends Error { constructor(got: bigint, required: bigint) }
class DepositNotFoundError extends Error { constructor(txHash: string) }
class SolanaArrivalTimeoutError extends Error { constructor(depositId: string) }
```

### 5. Full Validation Flow Tests (no mocks)
Write a `test.ts` script (not a unit test — a real integration test) that:
- Builds a challenge.
- Verifies that an expired memo is rejected.
- Verifies that a memo mismatch is rejected.
- (Optional, requires a real bridge tx) Verifies a real proof end-to-end.

The first two tests work without a real bridge tx. The third is skipped if no `TEST_TX_HASH` env var is set.

### 6. TypeScript Exports
The library must export from `index.ts`:
- `decodeAndValidateHeader`
- `validatePayment`
- `buildChallenge`
- `isExpired`
- `createEvmPaymentMiddleware`
- All error types
- `ValidationResult`, `EvmPaymentProof` re-exports

## Deliverables
- `agent-prompts/evm/agents/payment-validator/validator.ts`
- `agent-prompts/evm/agents/payment-validator/middleware.ts`
- `agent-prompts/evm/agents/payment-validator/cli.ts`
- `agent-prompts/evm/agents/payment-validator/index.ts`
- `agent-prompts/evm/agents/payment-validator/test.ts`
- `agent-prompts/evm/agents/payment-validator/package.json`
- `agent-prompts/evm/agents/payment-validator/README.md`

## Acceptance Criteria
- `node cli.ts decode <valid_base64>` correctly prints all proof fields.
- `node cli.ts challenge --agent=<mint> ...` generates a decodable header.
- `node cli.ts verify` with a mismatched memo returns an error message, not a crash.
- Express middleware types are compatible with Express 4.x `RequestHandler`.
- All exports typecheck without errors under `tsc --noEmit`.
