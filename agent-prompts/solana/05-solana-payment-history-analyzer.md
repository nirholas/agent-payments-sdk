<!-- agent-payments-sdk | Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas -->

# Task: Solana USDC Payment History Analyzer

## Objective
Build a TypeScript CLI tool that fetches, parses, and reports the full on-chain payment history for a Pump Agent by scanning `agentAcceptPaymentEvent` logs using `PumpAgent.getPaymentHistory` and `PumpAgent.getEventHistory`, then produces a structured JSON report and a human-readable summary.

## Context
`PumpAgent.getPaymentHistory(limit)` in `src/solana/PumpAgent.ts` scans the `TokenAgentPayments` PDA for transaction signatures, fetches each transaction, and parses `agentAcceptPaymentEvent` events via the Anchor `EventParser`. The event data type is `AgentAcceptPaymentEvent` exported from `src/solana/events.ts`.

`PumpAgent.getEventHistory(limit)` returns all event types: payments, distributions, buybacks, withdrawals, and config changes — as `ParsedAgentEvent[]`.

## Environment Variables
```
SOLANA_RPC_URL   Mainnet RPC endpoint
AGENT_MINT       Agent token mint to analyze
```

## Requirements

### 1. Full History Fetch
Implement `async fetchFullHistory(limit = 200)`:
- Call `agent.getEventHistory(limit)`.
- Call `agent.getPaymentHistory(limit)` separately.
- Deduplicate by event content hash (memo + payer + amount + startTime).
- Return the merged, chronologically sorted list.

### 2. Payment Event Enrichment
For each `agentAcceptPaymentEvent`, add:
- `amountHuman`: the USDC amount in decimal form (divide by 1_000_000, formatted to 6 decimal places).
- `solscanUrl`: `https://solscan.io/tx/<signature>`.
- `payerShort`: first 8 + "..." + last 8 chars of the payer public key.

### 3. Report Structure
Generate a report object:
```ts
{
  agentMint: string,
  reportGeneratedAt: string,   // ISO 8601
  totalPaymentsCount: number,
  totalUsdcReceived: string,   // e.g. "142.500000"
  uniquePayers: number,
  avgPaymentUsdc: string,
  largestPaymentUsdc: string,
  smallestPaymentUsdc: string,
  payments: EnrichedPaymentEvent[],
  distributions: ParsedAgentEvent[],
  buybacks: ParsedAgentEvent[],
}
```

### 4. CLI Commands
```
node analyzer.js report [--limit=200]      Print JSON report to stdout
node analyzer.js summary [--limit=200]     Print human-readable summary table
node analyzer.js payers [--limit=200]      Print top 10 payers by total USDC paid
node analyzer.js export [--limit=200]      Write report to payments-<AGENT_MINT_SHORT>-<date>.json
```

### 5. Summary Table Format
```
══════════════════════════════════════════════════
  Pump Agent Payment Summary
  Mint: <first8>...<last8>
══════════════════════════════════════════════════
  Total payments:      42
  Total USDC received: 142.500000
  Unique payers:       18
  Avg per payment:     3.392857 USDC
  Largest payment:     10.000000 USDC
  Smallest payment:    1.000000 USDC
══════════════════════════════════════════════════
  Recent payments:
  #  Payer             Amount     Time
  1  AbCd1234...Ef89   1.000000   2026-05-08 12:34:56
  2  ...
══════════════════════════════════════════════════
```

### 6. Top Payers Output
Sort payers by cumulative USDC paid, descending. Print rank, payer address, payment count, and total USDC.

### 7. Live Stats Comparison
After generating the historical report, fetch live vault balances via `agent.getBalances(USDC_MINT)` and `agent.getPaymentStats(USDC_MINT)`. Include both in the report under `liveState: { paymentVault, buybackVault, withdrawVault, totalInvoicePaymentsMade }`.

### 8. Rate Limiting
Between transaction fetches, wait 100 ms to avoid 429 errors from public RPCs. This applies inside the loop in `getEventHistory` — wrap the per-signature `connection.getTransaction` calls with a configurable delay.

## Deliverables
- `agent-prompts/solana/agents/payment-analyzer/analyzer.ts`
- `agent-prompts/solana/agents/payment-analyzer/package.json`
- `agent-prompts/solana/agents/payment-analyzer/README.md`

## Acceptance Criteria
- `summary` command prints a complete table without throwing for an agent with 0 payments.
- `export` command writes valid JSON matching the report schema.
- `payers` command correctly aggregates payments per unique public key.
- All numbers use integer arithmetic internally — never `parseFloat` on amount strings.
- Works against real mainnet data; no fixtures or mocks.
