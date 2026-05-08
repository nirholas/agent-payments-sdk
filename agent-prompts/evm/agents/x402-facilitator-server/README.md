# x402 EVM USDC Facilitator Server

A production-ready HTTP API server that acts as both an **x402 Resource Server** and a **Facilitator** for EVM USDC cross-chain payments. The server issues HTTP 402 challenges, verifies `X-Payment` proof headers, and only serves gated resources after full EVM → Solana settlement.

## How it works

1. Client calls a gated route without `X-Payment` → receives `402 Payment Required` with `X-Payment-Required` (base64 JSON challenge including a unique memo).
2. Client pays via EVM cross-chain bridge, receives bridge tx hash and quote ID.
3. Client retries with `X-Payment: <base64 proof>`.
4. Server verifies the EVM tx on-chain, checks USDC amount, optionally waits for Solana arrival.
5. Server serves the gated resource and attaches `X-Payment-Receipt` to the response.

## Setup

```bash
npm install
```

## Environment Variables

| Variable             | Default     | Description                                          |
|----------------------|-------------|------------------------------------------------------|
| `AGENT_MINT`         | **required** | Solana pump agent token mint (base58)               |
| `AGENT_PAYMENT_VAULT`| **required** | Solana address that receives cross-chain USDC        |
| `PORT`               | `3002`       | HTTP port                                            |
| `WAIT_FOR_SOLANA`    | `true`       | Wait for Solana arrival before responding            |
| `PRICE_USDC_MINOR`   | `1000000`    | Price per request in 6-decimal USDC units (default $1.00) |

## Run

```bash
AGENT_MINT=YourMintAddressHere \
AGENT_PAYMENT_VAULT=YourVaultAddressHere \
npm start
```

## Routes

### Public

| Route | Description |
|-------|-------------|
| `GET /health` | Liveness check — returns agent mint, price, and config |
| `GET /.well-known/evm-payments` | Payment manifest — supported chains, USDC addresses, routes |

### Gated (require x402 payment)

| Route | Description |
|-------|-------------|
| `GET /api/quote` | Real-time ETH and SOL USD prices from CoinGecko |
| `POST /api/echo` | Echoes the JSON request body verbatim |
| `GET /api/timestamp` | Current Unix timestamp + ISO-8601 on `solana-mainnet` |

## Headers

### 402 Response (challenge)
```
HTTP/1.1 402 Payment Required
X-Payment-Required: <base64 JSON EvmX402PaymentRequirements>
Content-Type: application/json
```

### 200 Response (paid)
```
HTTP/1.1 200 OK
X-Payment-Receipt: <base64 JSON { depositId, solanaSignature, confirmedAmountUsdc, servedAt }>
Content-Type: application/json
```

## Security

- **Memo TTL**: Each challenge memo expires after 10 minutes. Expired memos return `402 "Unknown or expired memo"`.
- **Replay protection**: Successfully redeemed deposit IDs are stored for 24 hours. Reuse returns `402 "Deposit already used"`.
- **Amount enforcement**: `minAmountUsdc` is enforced server-side via `verifyEvmPayment`.

## Supported Chains

Ethereum (1), Base (8453), Arbitrum One (42161), Polygon (137), BNB Smart Chain (56), Avalanche (43114).

USDC addresses are imported directly from `src/chains.ts` — not hardcoded.
