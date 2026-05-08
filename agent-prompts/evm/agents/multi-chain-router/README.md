# EVM Multi-Chain USDC Payment Router

Routes USDC payments from any of 6 EVM chains to a Solana destination by automatically selecting the chain with the lowest bridge fee where the wallet holds sufficient balance.

## Supported Chains

| Chain | ID | USDC Contract |
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

## Environment Variables

| Variable | Description |
|---|---|
| `EVM_PRIVATE_KEY` | EVM private key (`0x…`), used for all 6 chains |
| `AGENT_MINT` | Destination Solana agent token mint address |
| `DEST_SOLANA_WALLET` | Solana wallet to receive the bridged USDC |
| `MEMO` | Payment memo / invoice ID |
| `AMOUNT_USDC` | Amount to send in decimal USDC, e.g. `"1.5"` |

**Optional RPC overrides** (fall back to public RPCs if unset):

```
RPC_URL_1       Ethereum RPC endpoint
RPC_URL_8453    Base RPC endpoint
RPC_URL_42161   Arbitrum RPC endpoint
RPC_URL_137     Polygon RPC endpoint
RPC_URL_56      BSC RPC endpoint
RPC_URL_43114   Avalanche RPC endpoint
```

Example `.env`:

```env
EVM_PRIVATE_KEY=0xabc123...
AGENT_MINT=YourSolanaAgentMint...
DEST_SOLANA_WALLET=YourSolanaWallet...
MEMO=invoice-001
AMOUNT_USDC=1.5

# Optional — faster/more reliable RPCs
RPC_URL_8453=https://base-mainnet.g.alchemy.com/v2/YOUR_KEY
RPC_URL_42161=https://arb-mainnet.g.alchemy.com/v2/YOUR_KEY
```

## Commands

### Show USDC balances across all chains

```bash
npx tsx router.ts balances
```

Output:
```
Fetching USDC balances for 0xYour...

Chain               Balance        Sufficient
------------------------------------------
Base                12.50 USDC     ✓
Arbitrum One        8.00 USDC      ✓
Ethereum            2.00 USDC      ✓
Polygon             0.50 USDC      ✗
BNB Smart Chain     0.00 USDC      ✗
Avalanche           0.00 USDC      ✗
```

### Fetch bridge quotes for all chains

```bash
npx tsx router.ts quotes
```

Output:
```
Fetching quotes for 1.5 USDC...

Chain            Fee (USDC)  Net       Status
--------------------------------------------------
Base             0.02        1.48      available
Arbitrum One     0.03        1.47      available
Ethereum         0.15        1.35      available
Polygon          0.01        1.49      available
BNB Smart Chain  —           —         unavailable
Avalanche        0.04        1.46      available
```

### Execute the optimal payment

```bash
npx tsx router.ts pay
```

Output:
```
Preparing 1.5 USDC payment from 0xYour...

Chain           Balance     Fee      Net       Available
-------------------------------------------------------
Base            12.50 USDC  0.02     1.48      ✓
Arbitrum One    8.00 USDC   0.03     1.47      ✓
Ethereum        2.00 USDC   0.15     1.35      ✓
Polygon         0.50 USDC   0.01     1.49      ✗ (insufficient balance)

[router] optimal chain: Base (8453), fee: 0.02 USDC, net: 1.48 USDC
[router] selected chain: Base (8453)
[router] approval tx: 0xabc... (confirmed)
[router] bridge tx:   0xdef... (confirmed)
[router] depositId:   0x123...
```

### Force a specific chain

```bash
npx tsx router.ts pay --chain=8453
```

### Dry run (no transactions submitted)

```bash
npx tsx router.ts pay --dry-run
```

### Poll bridge deposit status

```bash
npx tsx router.ts status <depositId>
```

Output:
```
[status] polling depositId=0x123...
[status] depositId=0x123... status=bridging elapsed=5s
[status] depositId=0x123... status=bridging elapsed=10s
[status] depositId=0x123... status=arrived_on_solana elapsed=45s
[status] funds arrived on Solana!
```

## Selection Algorithm

1. Fetch USDC balances on all 6 chains concurrently.
2. Fetch bridge quotes for all chains concurrently.
3. Filter to chains where `balance >= AMOUNT_USDC`.
4. Among qualifying chains, sort by `bridgeFeeUsd` ascending.
5. Submit approval (if needed) + bridge transaction on the winning chain.

## Architecture

```
router.ts          CLI entry point + all business logic
chains.ts          viem chain builders + RPC URL resolution
../../src/chains.ts         chain configs (USDC addresses, RPC fallbacks)
../../src/evm/quote.ts      bridge quote fetching
../../src/evm/transaction.ts approval + bridge tx building
../../src/constants.ts      PUMP_CROSSCHAIN_API endpoint
```
