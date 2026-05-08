# viem-wallet

Multi-chain EVM USDC wallet agent using **viem WalletClient**. Manages USDC on all 6 supported chains: check balances, approve bridge contracts, send USDC transfers, and execute full bridge payments to Solana — all from a single private key.

## Supported chains

| Chain | ID | USDC address |
|---|---|---|
| Ethereum | 1 | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |
| Base | 8453 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| Arbitrum One | 42161 | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` |
| Polygon | 137 | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` |
| BNB Smart Chain | 56 | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` |
| Avalanche | 43114 | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` |

## Setup

```bash
npm install
```

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `EVM_PRIVATE_KEY` | Yes | Hex private key (with `0x` prefix) |
| `RPC_URL_1` | No | Ethereum RPC (falls back to public) |
| `RPC_URL_8453` | No | Base RPC |
| `RPC_URL_42161` | No | Arbitrum RPC |
| `RPC_URL_137` | No | Polygon RPC |
| `RPC_URL_56` | No | BSC RPC |
| `RPC_URL_43114` | No | Avalanche RPC |

```bash
export EVM_PRIVATE_KEY=0xabc123...
export RPC_URL_8453=https://mainnet.base.org
```

## Commands

All `<amount>` arguments are decimal USDC strings (e.g. `"1.5"` = 1.5 USDC = 1,500,000 minor units).

### Check USDC balances on all chains

```bash
node wallet.ts balances
```

Output:
```
[wallet] address: 0xYourAddress
[balances] fetching USDC balances on all chains...

  Ethereum           (1):     0.000000 USDC
  Base               (8453):  42.500000 USDC
  Arbitrum One       (42161): 10.000000 USDC
  ...
```

### Check native token balances on all chains

```bash
node wallet.ts native
```

### Check USDC allowance

```bash
node wallet.ts allowance 8453 0xSpenderAddress
```

### Approve USDC spending

Skips automatically if the current allowance is already sufficient.

```bash
node wallet.ts approve 8453 0xSpenderAddress 100.0
```

Output (approval submitted):
```
[tx] chain=Base (8453) fn=approve hash=0xabc... status=success gas=45231
[approve] new allowance: 100.000000 USDC
[approve] done: 0xabc...
```

Output (already approved):
```
[approve] already approved, skipping (allowance=100.000000 USDC >= required=100.000000 USDC)
```

### Transfer USDC

Rejects before sending if balance is insufficient.

```bash
node wallet.ts transfer 8453 0xRecipientAddress 10.0
```

Output:
```
[tx] chain=Base (8453) fn=transfer hash=0xdef... status=success gas=52100
[transfer] done: 0xdef...
```

### Bridge USDC to Solana

Fetches a live quote, optionally approves the bridge contract, then submits the bridge transaction.

```bash
node wallet.ts bridge 8453 <agentMint> <solanaWalletAddress> 5.0 "payment-for-service"
```

Output:
```
[bridge] quoting 5.000000 USDC from Base → Solana
[bridge] quote=abc123 estimatedNet=4.975000 USDC fee=$0.0250 est=30s
[bridge] approving bridge spender 0xBridgeContract...
[tx] chain=Base (8453) fn=approve hash=0xaaa... status=success gas=46000
[approve] new allowance: 5.000000 USDC
[tx] chain=Base (8453) fn=bridge hash=0xbbb... status=success gas=210000

[bridge] complete
  quoteId:          abc123
  bridgeHash:       0xbbb...
  approvalHash:     0xaaa...
  estimatedNetUsdc: 4.975000 USDC
```

## Architecture

```
wallet.ts          — CLI entry point + all operations
erc20.ts           — Typed ERC-20 ABI (no external package)
errors.ts          — InsufficientUsdcError, UnsupportedChainError, TransactionRevertedError
```

### Client caching

`buildClients(chainId)` returns a `{ walletClient, publicClient }` pair and caches it per chain ID, so concurrent operations on the same chain reuse the same connection.

### Approval guard

`approveUsdc` reads the current on-chain allowance before submitting any transaction. If `allowance >= required`, it logs a skip message and returns the `"0x"` sentinel hash.

### Bridge flow

1. `getQuote` — fetches a live cross-chain quote from the Pump.fun API
2. `buildEvmPaymentTransaction` — builds the approval + bridge calldata
3. `approveUsdc` — approves the bridge spender if needed (with allowance guard)
4. `walletClient.sendTransaction` — submits the bridge transaction
5. Receipt polling + structured log output
