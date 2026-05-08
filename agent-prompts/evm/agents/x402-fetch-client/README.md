# EVM USDC x402 Autonomous Fetch Client

A production-ready TypeScript CLI agent that autonomously handles HTTP 402 payment gates on EVM chains. It detects `X-Payment-Required` headers, pays the required USDC amount via the Pump cross-chain bridge, and retries the original request with a `X-Payment` proof header.

## Supported Chains

| Chain | ID | USDC Address |
|---|---|---|
| Base | 8453 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Ethereum | 1 | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| Arbitrum One | 42161 | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| Polygon | 137 | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` |
| BNB Smart Chain | 56 | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` |
| Avalanche | 43114 | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` |

## Installation

```bash
npm install
```

## Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `EVM_PRIVATE_KEY` | yes | — | EVM private key (hex, with or without `0x` prefix) |
| `EVM_CHAIN_ID` | no | `8453` | Chain ID to pay from |
| `EVM_RPC_URL` | no | public RPC | Custom RPC endpoint for the chosen chain |
| `MAX_PAYMENT_USDC` | no | `2.0` | Maximum USDC to pay per request |

## Usage

**GET request:**
```bash
EVM_PRIVATE_KEY=0x... node index.ts https://api.example.com/resource
```

**POST request with JSON body:**
```bash
EVM_PRIVATE_KEY=0x... node index.ts https://api.example.com/chat '{"message":"hello"}'
```

**Use Arbitrum, custom RPC, 5 USDC cap:**
```bash
EVM_PRIVATE_KEY=0x... \
EVM_CHAIN_ID=42161 \
EVM_RPC_URL=https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY \
MAX_PAYMENT_USDC=5.0 \
node index.ts https://api.example.com/resource
```

## Payment Flow

```
1.  GET/POST  →  HTTP 402  (X-Payment-Required header)
2.  Decode payment requirements (scheme, maxAmountRequired, agentMint, memo)
3.  Check MAX_PAYMENT_USDC gate — abort if exceeded
4.  Fetch bridge quote via Pump cross-chain API
5.  Build approval + bridge transactions
6.  Send ERC-20 approve tx (if needed) → wait for receipt
7.  Send bridge tx → wait for receipt
8.  Encode X-Payment proof header (base64 JSON)
9.  Retry original request with X-Payment header
10. Print response
```

## Example Output

```
[preflight] address: 0xABCD...1234
[preflight] chain: Base (8453)
[preflight] USDC balance: 25.500000 USDC on Base
[x402] approving payment: 1.5 USDC
[approval] sent approve tx: 0xabc...
[approval] confirmed
[x402] bridge tx submitted | hash=0xdef... | depositId=q_xyz | chain=Base
[response] status=200
{
  "result": "..."
}
```

## Security Notes

- The private key is read from `EVM_PRIVATE_KEY` at startup — never commit it or log it.
- `MAX_PAYMENT_USDC` is enforced before any on-chain transaction is submitted.
- Network errors are retried up to 2 times with a 3-second delay before failing.
- Viem revert reasons are decoded and printed when a transaction fails.
