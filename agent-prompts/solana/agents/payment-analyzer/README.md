# Pump Agent Payment History Analyzer

CLI tool that fetches, parses, and reports the full on-chain USDC payment history for a Pump Agent by scanning `agentAcceptPaymentEvent` logs.

## Setup

```bash
npm install
```

## Environment Variables

| Variable        | Description                    |
|-----------------|--------------------------------|
| `SOLANA_RPC_URL` | Mainnet RPC endpoint          |
| `AGENT_MINT`    | Agent token mint address       |

```bash
export SOLANA_RPC_URL="https://api.mainnet-beta.solana.com"
export AGENT_MINT="<your-agent-mint>"
```

## Commands

```bash
# Full JSON report to stdout
npx tsx analyzer.ts report [--limit=200]

# Human-readable summary table
npx tsx analyzer.ts summary [--limit=200]

# Top 10 payers by total USDC paid
npx tsx analyzer.ts payers [--limit=200]

# Write JSON report to payments-<mint>-<date>.json
npx tsx analyzer.ts export [--limit=200]
```

Or via npm scripts:

```bash
npm run report
npm run summary
npm run payers
npm run export
```

## Report Schema

```ts
{
  agentMint: string,
  reportGeneratedAt: string,       // ISO 8601
  totalPaymentsCount: number,
  totalUsdcReceived: string,        // e.g. "142.500000"
  uniquePayers: number,
  avgPaymentUsdc: string,
  largestPaymentUsdc: string,
  smallestPaymentUsdc: string,
  payments: EnrichedPaymentEvent[], // agentAcceptPaymentEvent + enrichment fields
  distributions: ParsedAgentEvent[],
  buybacks: ParsedAgentEvent[],
  liveState: {
    paymentVault: string,
    buybackVault: string,
    withdrawVault: string,
    totalInvoicePaymentsMade: string,
  }
}
```

Each `EnrichedPaymentEvent` includes:
- `amountHuman` — USDC amount in decimal form (6 decimal places)
- `solscanUrl` — `https://solscan.io/tx/<signature>`
- `payerShort` — first 8 + `...` + last 8 chars of the payer public key
- All original `AgentAcceptPaymentEvent` fields (serialized as strings)

## Implementation Notes

- **Deduplication**: payment events from `getEventHistory` and `getPaymentHistory` are merged by a content hash of `(memo, payer, amount, startTime)`, ensuring each payment is counted once.
- **Integer arithmetic**: all USDC amounts are handled as `bigint` internally; `formatUsdc` performs fixed-point division without floating-point.
- **Signature correlation**: a separate PDA scan builds an `invoiceId → txSignature` map for Solscan URL generation without modifying the SDK's public API.
- **Rate limiting**: 100 ms sleep between `getTransaction` calls in the signature map builder to avoid 429s on public RPCs.
- **Zero-payment safety**: all stats default to `"0.000000"` when no payments exist; the summary prints `No payments found.` instead of a table.
