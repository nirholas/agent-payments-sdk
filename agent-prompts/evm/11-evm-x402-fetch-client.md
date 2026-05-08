# Task: EVM USDC x402 Autonomous Fetch Client (Base / Arbitrum / Ethereum)

## Objective
Build a production-ready TypeScript CLI agent that uses `createEvmX402Fetch` from `@nirholas/agent-payments-sdk/x402` to autonomously detect HTTP 402 responses, pay the required USDC amount from an EVM wallet via cross-chain bridge, and retry the original request with a `X-Payment` proof header.

## Context
`createEvmX402Fetch` (in `src/x402/evm-client.ts`) wraps fetch to:
1. Detect HTTP 402 with `X-Payment-Required` header (base64 JSON of `EvmX402PaymentRequirements`).
2. Fetch a bridge quote via `getQuote` from `src/evm/quote.ts`.
3. Build EVM approval + bridge transactions via `buildEvmPaymentTransaction` from `src/evm/transaction.ts`.
4. Send approval (if needed) then bridge tx via the wallet client.
5. Retry with `X-Payment: <base64_proof>` header.

Supported chains and USDC addresses (from `src/chains.ts`):
- Ethereum (1): `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`
- Base (8453): `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913`
- Arbitrum (42161): `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`
- Polygon (137): `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359`
- BSC (56): `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d`
- Avalanche (43114): `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E`

## Environment Variables
```
EVM_PRIVATE_KEY         EVM private key (hex, with or without 0x prefix)
EVM_CHAIN_ID            Chain ID to pay from (default: 8453 = Base)
EVM_RPC_URL             RPC URL for the chosen chain
MAX_PAYMENT_USDC        Maximum USDC per request (default: 2.0)
```

## Requirements

### 1. Wallet Client
Use **viem** to build a `WalletClient` and `PublicClient`:
```ts
import { createWalletClient, createPublicClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const account = privateKeyToAccount(`0x${privateKey}`);
const walletClient = createWalletClient({ account, chain: <viemChain>, transport: http(rpcUrl) });
const publicClient = createPublicClient({ chain: <viemChain>, transport: http(rpcUrl) });
```

Map `EVM_CHAIN_ID` to the correct viem chain object (import from `viem/chains`): `mainnet`, `base`, `arbitrum`, `polygon`, `bsc`, `avalanche`.

### 2. EvmWalletClient Adapter
Build an `EvmWalletClient` adapter satisfying the interface from `src/x402/evm-client.ts`:
```ts
{
  chainId: EVM_CHAIN_ID,
  address: account.address,
  sendTransaction: async ({ to, data, value, chainId }) => {
    const hash = await walletClient.sendTransaction({ to, data, value, chain: ... });
    await publicClient.waitForTransactionReceipt({ hash });
    return hash;
  }
}
```

### 3. Pre-flight USDC Balance Check
Before the first request, check the USDC balance for the configured chain using:
```ts
const balance = await publicClient.readContract({
  address: chain.usdc,
  abi: erc20Abi,   // standard ERC-20 ABI with balanceOf
  functionName: "balanceOf",
  args: [account.address],
});
```
Print `[preflight] USDC balance: <X.XXXXXX> USDC on <chain_name>`. If balance is 0, warn but continue.

### 4. Payment Gate Confirmation
Wire `onPaymentRequired` to enforce `MAX_PAYMENT_USDC`:
```ts
onPaymentRequired: async (requirements) => {
  const amountUsdc = Number(BigInt(requirements.maxAmountRequired)) / 1_000_000;
  if (amountUsdc > MAX_PAYMENT_USDC) {
    console.error(`[x402] refused: ${amountUsdc} USDC exceeds limit ${MAX_PAYMENT_USDC} USDC`);
    return false;  // abort payment
  }
  console.log(`[x402] approving payment: ${amountUsdc} USDC`);
  return true;
}
```

### 5. Payment Submitted Logging
Wire `onPaymentSubmitted` to log:
```
[x402] bridge tx submitted | hash=<txHash> | depositId=<id> | chain=<chainName>
```

### 6. CLI Interface
```
node client.js <URL> [JSON_BODY]
```
- If `JSON_BODY` provided: POST with `Content-Type: application/json`.
- Otherwise: GET.
- Print final response body (pretty-printed JSON if parseable, else raw text).
- Print the `X-Payment` response header if present, decoded to JSON.

### 7. Approval Transaction Handling
If the bridge requires a USDC approval (ERC-20 `approve`), send it first and wait for receipt before sending the bridge tx. Log:
```
[approval] sent approve tx: <hash>
[approval] confirmed
```

### 8. Error Handling
- Viem errors (insufficient gas, reverted tx): print the decoded revert reason if available.
- Network errors: retry up to 2 times with 3-second delay.
- All unhandled: print + exit 1.

## Deliverables
- `agent-prompts/evm/agents/x402-fetch-client/index.ts`
- `agent-prompts/evm/agents/x402-fetch-client/package.json` (with `viem`, `@nirholas/agent-payments-sdk`)
- `agent-prompts/evm/agents/x402-fetch-client/README.md`

## Acceptance Criteria
- The agent compiles without TypeScript errors.
- Running against a live x402 EVM endpoint sends a real bridge transaction and retries with the `X-Payment` header.
- `MAX_PAYMENT_USDC` enforcement refuses without sending any on-chain transaction.
- USDC balance check uses `publicClient.readContract`, not a hard-coded mock.
- No demo mode. All transactions are real.
