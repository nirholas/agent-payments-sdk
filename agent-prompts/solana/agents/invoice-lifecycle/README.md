# Invoice Lifecycle Agent

A CLI agent that manages the complete USDC invoice lifecycle for a Pump Agent: generate invoices, build accept-payment transactions, track payment status on-chain, and trigger distribution once the payment vault has a non-zero balance.

## Prerequisites

- Node.js 18+
- `tsx` (installed via devDependencies)

## Setup

```bash
npm install
```

Set the required environment variables:

```bash
export SOLANA_RPC_URL="https://mainnet.helius-rpc.com/?api-key=..."
export SOLANA_PRIVATE_KEY='[1,2,3,...]'   # JSON array or base58 string
export AGENT_MINT="YourAgentMintBase58..."
```

## Commands

### `generate <amount_usdc>`

Creates a new invoice for the given USDC amount with a 5-minute payment window. Prints invoice JSON.

```bash
npx tsx agent.ts generate 10.50
```

Output:
```json
{
  "memo": 1715200000000000,
  "startTime": 1715200000,
  "endTime": 1715200300,
  "amount": 10500000,
  "agentMint": "...",
  "currencyMint": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
}
```

### `accept-tx <invoice_json> <payer_pubkey>`

Builds a base64-encoded, partially-signed `acceptPayment` transaction ready for the payer to sign and submit.

```bash
npx tsx agent.ts accept-tx '{"memo":...}' <PAYER_PUBKEY>
```

The returned base64 transaction can be decoded, signed by the payer, and submitted via any Solana wallet or RPC client.

### `poll <memo> <startTime> <endTime> <amount_usdc> [<payer>]`

Polls `validateInvoicePayment` every 5 seconds until the invoice is paid or the window expires.

```bash
npx tsx agent.ts poll 1715200000000000 1715200000 1715200300 10.50 <PAYER_PUBKEY>
```

- `<payer>` is optional; defaults to the authority key with a warning.
- Exits with code 1 if the invoice expires unpaid.

### `distribute`

Checks the payment vault balance. If non-zero, sends an `agentDistributePayments` transaction that splits the balance into the buyback vault and withdraw vault according to `buybackBps`. Prints the confirmed Solscan link.

```bash
npx tsx agent.ts distribute
```

### `status`

Fetches live on-chain balances and payment stats, then prints a summary.

```bash
npx tsx agent.ts status
```

Output:
```
Agent:           <AGENT_MINT>
Payment vault:   0.000000 USDC
Buyback vault:   0.000000 USDC
Withdraw vault:  0.000000 USDC
Total invoices:  0
Total bought:    0.000000 USDC
```

## Full Lifecycle Example

```bash
# 1. Generate an invoice for $25 USDC
npx tsx agent.ts generate 25 > invoice.json
cat invoice.json

# 2. Build the accept-payment transaction for the payer
PAYER="<customer wallet pubkey>"
INVOICE=$(cat invoice.json)
BASE64_TX=$(npx tsx agent.ts accept-tx "$INVOICE" "$PAYER")
echo "$BASE64_TX"

# 3. (Customer signs and submits the transaction via their wallet)

# 4. Poll until paid
MEMO=$(jq -r .memo invoice.json)
START=$(jq -r .startTime invoice.json)
END=$(jq -r .endTime invoice.json)
npx tsx agent.ts poll "$MEMO" "$START" "$END" 25 "$PAYER"

# 5. Distribute the vault balance
npx tsx agent.ts distribute

# 6. Confirm final state
npx tsx agent.ts status
```

## Transaction Details

All transactions include:
- `ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })`
- Sent via `sendRawTransaction` with `skipPreflight: false`
- Confirmed at `"confirmed"` commitment using `blockhash` + `lastValidBlockHeight`

## Error Handling

- **`CurrencyNotSupportedError`** during `distribute`: prints the list of supported currency mints and exits with code 1.
- All other unhandled errors: prints message + stack trace and exits with code 1.
