<!-- agent-payments-sdk | Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas -->

# Task: Solana USDC Invoice Lifecycle Agent

## Objective
Build a TypeScript agent that manages the complete invoice lifecycle for a Pump Agent: generate invoices, track payment status on-chain, validate via `PumpAgent.validateInvoicePayment`, and trigger distribution with `PumpAgentOffline.buildDistributePaymentsInstructions` once the payment vault has a non-zero balance.

## Context
The on-chain invoice model uses a PDA seeded by:
`[b"invoice-id", mint, currency_mint, amount, memo, start_time, end_time]`

`PumpAgent.validateInvoicePayment` first queries `https://fun-block.pump.fun/agents/invoice-id?invoice-id=<pda>&mint=<mint>`, then falls back to RPC log scanning.

`PumpAgentOffline.buildDistributePaymentsInstructions` splits the payment vault balance into `buyback_vault` (buyback %) and `withdraw_vault` (remainder) according to `buybackBps`.

## Environment Variables
```
SOLANA_RPC_URL       Mainnet RPC endpoint
SOLANA_PRIVATE_KEY   Authority keypair (base58 or JSON array)
AGENT_MINT           Base58 pump agent token mint
```

## Requirements

### 1. Invoice Generation
Implement `generateInvoice(amountUsdc: number, windowSeconds = 300)`:
- Converts `amountUsdc` to minor units (multiply by `1_000_000`, no floating point — use integer math).
- Generates a unique memo: `String(Date.now()).padStart(16, "0")`.
- Returns `{ memo, startTime, endTime, amount, agentMint, currencyMint }` ready to pass to `buildAcceptPaymentInstructions`.

### 2. Invoice Polling
Implement `async pollInvoicePayment(invoice, timeoutMs = 120_000)`:
- Instantiate `PumpAgent(agentMint, "mainnet", connection)`.
- Poll `agent.validateInvoicePayment(invoice)` every 5 seconds until it returns `true` or timeout.
- Return `{ paid: boolean, checkedAt: Date, elapsed: number }`.

### 3. Payment Acceptance Transaction Builder
Implement `buildAcceptPaymentTx(invoice, payerPublicKey)`:
- Call `PumpAgentOffline.buildAcceptPaymentInstructions({ user, currencyMint, amount, memo, startTime, endTime })`.
- Wrap instructions in a `Transaction` with a fresh blockhash from the connection.
- Set `feePayer` to the payer's public key.
- Serialize to base64 and return.

### 4. Distribution Trigger
Implement `async triggerDistribution()`:
- Call `agent.getBalances(USDC_MINT)` to check `paymentVault.balance`.
- If balance is `0n`, log and return early.
- Otherwise, call `PumpAgentOffline.buildDistributePaymentsInstructions({ authority })`.
- Sign and send the transaction using the authority keypair loaded from `SOLANA_PRIVATE_KEY`.
- Wait for `"confirmed"` commitment.
- Return `{ signature, paymentVaultBefore, buybackVaultAfter, withdrawVaultAfter }`.

### 5. CLI Interface
```
node agent.js generate <amount_usdc>
node agent.js poll <memo> <startTime> <endTime> <amount_usdc>
node agent.js distribute
node agent.js status
```

The `status` command calls `agent.getPaymentStats(USDC_MINT)` and `agent.getBalances(USDC_MINT)` and prints:
```
Agent:           <AGENT_MINT>
Payment vault:   <balance> USDC
Buyback vault:   <balance> USDC
Withdraw vault:  <balance> USDC
Total invoices:  <totalInvoicePaymentsMade>
Total bought:    <totalBuybackAmountUsdc> USDC
```

### 6. Transaction Submission
All transactions must:
- Add `ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })` before other instructions.
- Use `sendRawTransaction` with `skipPreflight: false`.
- Confirm with `connection.confirmTransaction({ signature, blockhash, lastValidBlockHeight }, "confirmed")`.

### 7. Error Handling
- If `buildDistributePaymentsInstructions` throws `CurrencyNotSupportedError`, print the supported currencies list from `agent.getSupportedCurrencies()` and exit 1.
- All unhandled errors: print message + stack, exit 1.

## Deliverables
- `agent-prompts/solana/agents/invoice-lifecycle/agent.ts`
- `agent-prompts/solana/agents/invoice-lifecycle/package.json`
- `agent-prompts/solana/agents/invoice-lifecycle/README.md`

## Acceptance Criteria
- `generate` prints a valid invoice JSON that can be passed to `buildAcceptPaymentTx`.
- `distribute` sends a real on-chain transaction and prints the confirmed Solscan link.
- `status` shows live on-chain balances, not cached values.
- No simulation mode. Every RPC call targets mainnet.
