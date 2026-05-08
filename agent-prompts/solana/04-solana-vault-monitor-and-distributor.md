<!-- agent-payments-sdk | Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas -->

# Task: Solana USDC Vault Monitor & Auto-Distributor

## Objective
Build a long-running TypeScript daemon that continuously watches the three on-chain vaults of a Pump Agent (`paymentVault`, `buybackVault`, `withdrawVault`) for USDC balance changes and automatically calls `buildDistributePaymentsInstructions` when the payment vault crosses a configurable threshold.

## Context
`PumpAgent.getBalances(currencyMint)` fetches live balances for all three vaults. The vault addresses are deterministic PDAs derived by `getTokenAgentPaymentsPDA`, `getBuybackAuthorityPDA`, and `getWithdrawAuthorityPDA` — all exported from `@nirholas/agent-payments-sdk/solana`.

The distribution instruction moves funds from `paymentVault` to `buybackVault` and `withdrawVault` according to `buybackBps`. The authority must sign.

## Environment Variables
```
SOLANA_RPC_URL            Mainnet RPC endpoint (supports websocket: wss://)
SOLANA_PRIVATE_KEY        Authority keypair
AGENT_MINT                Agent token mint
DISTRIBUTION_THRESHOLD    Minimum USDC in payment vault to trigger distribution (default: 1.0)
POLL_INTERVAL_MS          How often to poll balances (default: 15000)
```

## Requirements

### 1. Vault Watcher
Implement a polling loop (using `setInterval`) that every `POLL_INTERVAL_MS` ms:
1. Calls `agent.getBalances(USDC_MINT)`.
2. Compares the `paymentVault.balance` against `thresholdMinor` (threshold * 1_000_000n).
3. If balance >= threshold and no distribution is currently in flight: triggers distribution.
4. Logs a one-line status: `[monitor] slot=<slot> payment=<X> USDC buyback=<Y> USDC withdraw=<Z> USDC`.

### 2. WebSocket Account Subscription (Primary)
In addition to polling, subscribe to the payment vault ATA via `connection.onAccountChange(paymentVaultAta, callback, "confirmed")`. On any change, immediately call the vault watcher logic without waiting for the next poll interval. Store the subscription ID for graceful shutdown.

### 3. Distribution Execution
When triggered, implement `async runDistribution()`:
- Set a `distributionInFlight = true` flag to prevent concurrent runs.
- Fetch current balances and log `pre-distribution` state.
- Build and send `buildDistributePaymentsInstructions` transaction.
- Wait for `"confirmed"`.
- Fetch balances again and log `post-distribution` state showing delta.
- Record the distribution in a local append-only JSON log file: `distributions.jsonl`. Each line: `{ timestamp, signature, paymentBefore, buybackAfter, withdrawAfter }`.
- Reset `distributionInFlight = false` in a `finally` block.

### 4. Retry Logic
If `runDistribution` fails (e.g. network error, blockhash expired):
- Wait 5 seconds, then retry up to 3 times.
- On all retries exhausted: log the error, reset the in-flight flag, and continue monitoring (do not crash the daemon).

### 5. Graceful Shutdown
Handle `SIGINT` and `SIGTERM`:
- Remove the account-change subscription: `connection.removeAccountChangeListener(subId)`.
- Clear the polling interval.
- Log `[shutdown] goodbye` and exit 0.

### 6. Startup Summary
On startup, print:
```
[vault-monitor] starting
  Agent mint:  <AGENT_MINT>
  USDC mint:   EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
  Payment ATA: <address>
  Buyback ATA: <address>
  Withdraw ATA: <address>
  Threshold:   <DISTRIBUTION_THRESHOLD> USDC
  Poll:        <POLL_INTERVAL_MS> ms
```
Compute the ATA addresses using `getAssociatedTokenAddressSync` from `@solana/spl-token` with the vault PDAs.

### 7. Current Slot Tracking
Fetch `connection.getSlot("confirmed")` in each poll cycle and include it in logs so every log line is traceable to a specific block.

## Deliverables
- `agent-prompts/solana/agents/vault-monitor/monitor.ts`
- `agent-prompts/solana/agents/vault-monitor/package.json`
- `agent-prompts/solana/agents/vault-monitor/README.md`

## Acceptance Criteria
- The daemon runs indefinitely without crashing under normal network conditions.
- A new payment to the vault triggers a distribution within one poll cycle of the vault passing the threshold.
- `distributions.jsonl` grows exactly once per distribution event with valid JSON per line.
- `SIGINT` shuts down cleanly without hanging WebSocket connections.
- All RPC calls are real mainnet calls; no stubs.
