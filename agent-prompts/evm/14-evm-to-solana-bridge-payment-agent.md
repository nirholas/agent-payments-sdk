# Task: EVM-to-Solana USDC Bridge Payment Agent

## Objective
Build a TypeScript agent that executes a complete EVM→Solana USDC cross-chain payment end-to-end: fetch a bridge quote, build the EVM approval + bridge transactions via `buildEvmPaymentTransaction`, submit them with a viem WalletClient, and poll the `PUMP_CROSSCHAIN_API` until the USDC arrives on Solana and is credited to the Pump Agent's payment vault.

## Context
The bridge flow from `src/x402/evm-client.ts` and `src/evm/`:
1. `getQuote({ fromChainId, fromToken, fromAmount, agentMint })` — returns a quote with `quoteId`.
2. `buildEvmPaymentTransaction({ quote, agentMint, destinationSolanaWallet, memo, sender })` — returns `{ approval?, bridge }` tx params.
3. Send approval (USDC `approve` to the bridge contract) if needed.
4. Send bridge tx.
5. Poll `PUMP_CROSSCHAIN_API/deposit?txHash=<hash>&chainId=<id>` for `depositId`.
6. Poll `getPaymentStatus(depositId)` from `src/evm/validate.ts` until `status === "arrived_on_solana"`.
7. Verify the Solana agent vault balance increased using `PumpAgent.getBalances(USDC_MINT)`.

## Environment Variables
```
EVM_PRIVATE_KEY             EVM private key (hex)
EVM_CHAIN_ID                Source chain (default: 8453 = Base)
EVM_RPC_URL                 RPC for the source chain
SOLANA_RPC_URL              Solana mainnet RPC
AGENT_MINT                  Pump agent token mint (Solana)
DEST_SOLANA_WALLET          Solana wallet to receive USDC
MEMO                        Invoice memo string (16-char numeric)
AMOUNT_USDC                 Amount to bridge in decimal USDC (e.g., "1.0")
SLIPPAGE_BPS                Bridge slippage tolerance (default: 50)
```

## Requirements

### 1. Quote Fetch
Implement `async fetchQuote()`:
- Convert `AMOUNT_USDC` to minor units: `BigInt(Math.round(parseFloat(AMOUNT_USDC) * 1_000_000))`.
- Call `getQuote({ fromChainId, fromToken: chain.usdc, fromAmount, agentMint })`.
- Print:
  ```
  [quote] chainId=8453 (Base)
  [quote] fromToken=0x833589...  amount=1.000000 USDC
  [quote] quoteId=<id>
  [quote] estimatedFee=<fee> USDC
  [quote] netReceived=<net> USDC
  [quote] expires=<ISO timestamp>
  ```
- Return the full quote object.

### 2. Transaction Building
Implement `async buildTxs(quote)`:
- Call `buildEvmPaymentTransaction({ quote, agentMint, destinationSolanaWallet: DEST_SOLANA_WALLET, memo: MEMO, sender: walletAddress })`.
- Log whether an approval tx is required.
- Return `{ approval, bridge }`.

### 3. Approval Transaction
If `approval` is non-null:
- Check current allowance via `readContract` (ERC-20 `allowance(owner, spender)`).
- Skip if allowance is already sufficient.
- Send the approval tx, wait for receipt.
- Verify new allowance is >= bridge amount.
- Log: `[approval] hash=<hash> allowance_before=<X> allowance_after=<Y>`.

### 4. Bridge Transaction
Implement `async sendBridgeTx(bridge)`:
- Estimate gas via `publicClient.estimateGas`.
- Send with 10% gas buffer: `gas = estimatedGas * 110n / 100n`.
- Wait for receipt with `publicClient.waitForTransactionReceipt({ hash, timeout: 60_000 })`.
- Return `{ hash, receipt }`.

### 5. Deposit Lookup
Implement `async lookupDeposit(bridgeTxHash, chainId)`:
- Poll `PUMP_CROSSCHAIN_API/deposit?txHash=<hash>&chainId=<id>` every 5 seconds for up to 60 seconds.
- Return `{ depositId, amountUsdc }` when found.
- Throw if not found after timeout.

### 6. Solana Arrival Polling
Implement `async waitForSolanaArrival(depositId)`:
- Call `getPaymentStatus(depositId)` from `src/evm/validate.ts` every 5 seconds.
- Print progress: `[bridge] depositId=<id> status=<status> elapsed=<s>s`.
- Return `{ solanaSignature, status }` when `arrived_on_solana`.
- Throw with status on `failed`.
- Timeout after 120 seconds.

### 7. Vault Verification
After Solana arrival, call `PumpAgent.getBalances(USDC_MINT)` and verify:
- `paymentVault.balance > 0n` (the payment is on-chain).
- Log:
  ```
  [verify] paymentVault balance: <X.XXXXXX> USDC ✓
  [verify] solana tx: https://solscan.io/tx/<signature>
  ```

### 8. Full Run Summary
Print a final summary:
```
════════════════════════════════════════════
  EVM→Solana Bridge Payment Complete
════════════════════════════════════════════
  Source:    Base (8453)
  Amount:    1.000000 USDC
  Fee:       0.020000 USDC
  Net:       0.980000 USDC
  Approval:  <hash | skipped>
  Bridge tx: <hash>
  DepositId: <id>
  Solana tx: <signature>
  Vault bal: <X.XXXXXX> USDC
  Total time: <seconds>s
════════════════════════════════════════════
```

### 9. CLI
```
node bridge-agent.js quote      Show quote only
node bridge-agent.js send       Execute full bridge payment
node bridge-agent.js status <depositId>  Poll an existing deposit
```

## Deliverables
- `agent-prompts/evm/agents/bridge-payment/agent.ts`
- `agent-prompts/evm/agents/bridge-payment/package.json`
- `agent-prompts/evm/agents/bridge-payment/README.md`

## Acceptance Criteria
- `quote` command fetches and displays a real bridge quote from the API.
- `send` command submits real EVM transactions and waits for Solana arrival.
- Vault verification confirms the USDC actually arrived on Solana via `PumpAgent.getBalances`.
- Approval is skipped when allowance is already sufficient.
- Gas estimation uses `estimateGas` with the 10% buffer — no hardcoded gas limits.
