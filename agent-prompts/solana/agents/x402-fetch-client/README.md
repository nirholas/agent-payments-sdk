# x402 Fetch Client — Solana USDC

Autonomous CLI agent that calls any HTTP endpoint, detects HTTP 402 responses, pays the exact USDC amount demanded on Solana mainnet, and retries — without human interaction.

Supports both payment schemes exposed by `@nirholas/agent-payments-sdk`:
- **`exact`** — SPL `TransferChecked` to an arbitrary recipient ATA
- **`pump-agent`** — on-chain invoice via Pump Agent program

---

## Prerequisites

- Node.js 20+
- A Solana wallet with SOL (for transaction fees) and USDC on mainnet
- An RPC endpoint (default: `https://api.mainnet-beta.solana.com`)

---

## Installation

```bash
# From this directory
npm install
```

### Monorepo vs. standalone

`package.json` currently points at the local workspace (`"file:../../../../"`). When the SDK is published to npm, replace the entry in `package.json` with the version pin:

```json
"@nirholas/agent-payments-sdk": "^0.1.0"
```

`index.ts` imports x402 helpers via a monorepo-relative path (`../../../../src/solana/x402`). Once the SDK is published and its `.d.ts` declarations are available, you can replace that with the package import:

```ts
import { createX402Fetch, ... } from "@nirholas/agent-payments-sdk/solana";
```

---

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `SOLANA_PRIVATE_KEY` | **Yes** | Wallet keypair — base58-encoded secret key **or** a JSON number array `[1,2,…,64]` |
| `SOLANA_RPC_URL` | No | Solana RPC endpoint. Defaults to `https://api.mainnet-beta.solana.com` |

### Loading your keypair

**From a Solana CLI keypair file (JSON array):**
```bash
export SOLANA_PRIVATE_KEY="$(cat ~/.config/solana/id.json)"
```

**From a base58 secret key (e.g. exported from a browser wallet):**
```bash
export SOLANA_PRIVATE_KEY="your_base58_secret_key_here"
```

Never commit your private key to version control.

---

## Usage

```
npm start -- <URL> [JSON_BODY]
```

Or, after `npm run build` (compiles to `dist/`):

```
node dist/index.js <URL> [JSON_BODY]
```

- If `JSON_BODY` is provided the request is sent as `POST` with `Content-Type: application/json`.
- Otherwise the request is sent as `GET`.

---

## Example Invocations

### GET a free endpoint
```bash
export SOLANA_PRIVATE_KEY="$(cat ~/.config/solana/id.json)"

npm start -- https://api.example.com/free-resource
```

### GET a paid endpoint (x402 auto-payment)
```bash
export SOLANA_PRIVATE_KEY="$(cat ~/.config/solana/id.json)"
export SOLANA_RPC_URL="https://mainnet.helius-rpc.com/?api-key=YOUR_KEY"

npm start -- https://api.example.com/protected-data
```

### POST with a JSON body
```bash
npm start -- https://api.example.com/inference '{"prompt":"What is the price of SOL?"}'
```

---

## Example Output

```
[x402] payer:  7xKX...abc
[x402] rpc:    https://mainnet.helius-rpc.com/?api-key=...
[x402] USDC balance: 12.500000 USDC
[x402] GET https://api.example.com/protected-data
[x402] 402 received — will pay 0.010000 USDC via exact
[x402] PAYMENT-RESPONSE: {
  "success": true,
  "transaction": "5jGh...xyz",
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "payer": "7xKX...abc"
}
[x402] paid | scheme=exact | asset=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v | amount=0.010000 USDC | sig=5jGh...xyz | resource=https://api.example.com/protected-data
{
  "data": "protected content here"
}
```

---

## Type Checking

```bash
npm run typecheck
```

Runs `tsc --noEmit` against `index.ts` using the included `tsconfig.json`.

---

## Exit Codes

| Code | Meaning |
|---|---|
| `0` | Success — response was 2xx |
| `1` | Error — payment failed, non-2xx response, or unhandled exception |

---

## Notes

- USDC mainnet mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (6 decimals)
- All Solana calls target mainnet (or whichever network your RPC URL points to).
- If transaction confirmation times out, the partial signature is printed so you can look it up on [Solscan](https://solscan.io).
- The agent performs a pre-flight USDC balance check and warns (but does not abort) if the balance is zero or the ATA does not exist.
