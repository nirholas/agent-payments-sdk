# EVM→Solana USDC Bridge Payment Agent

Executes a complete EVM→Solana USDC cross-chain payment end-to-end using the Pump.fun bridge API.

## Flow

```
EVM wallet
  → getQuote()            # fetch bridge quote (fees, estimated net, expiry)
  → buildEvmPaymentTransaction()  # get approval + bridge calldata
  → approve() if needed   # ERC-20 allowance for bridge contract (skipped if sufficient)
  → bridge tx             # gas-estimated with 10% buffer, confirmed on-chain
  → poll /deposit         # wait for Pump API to assign a depositId
  → poll getPaymentStatus # wait for "arrived_on_solana"
  → PumpAgent.getBalances # verify payment vault received USDC
```

## Setup

```bash
npm install
cp .env.example .env   # fill in your keys
```

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `EVM_PRIVATE_KEY` | yes | EVM private key (hex, 0x-prefixed) |
| `EVM_CHAIN_ID` | no | Source chain ID (default: `8453` = Base) |
| `EVM_RPC_URL` | no | RPC for the source chain (falls back to public RPC) |
| `SOLANA_RPC_URL` | yes | Solana mainnet RPC endpoint |
| `AGENT_MINT` | yes | Pump agent token mint (base58) |
| `DEST_SOLANA_WALLET` | yes | Solana wallet to credit with USDC (base58) |
| `MEMO` | yes | Invoice memo string (16-char numeric) |
| `AMOUNT_USDC` | yes | Decimal USDC amount to bridge (e.g. `"1.0"`) |

Supported `EVM_CHAIN_ID` values: `1` (Ethereum), `8453` (Base), `42161` (Arbitrum One), `137` (Polygon), `56` (BNB Smart Chain), `43114` (Avalanche).

## Commands

### Show quote only

Fetches a live bridge quote and prints fee/net breakdown. No transactions submitted.

```bash
npm run quote
# or
tsx agent.ts quote
```

Example output:
```
[quote] chainId=8453 (Base)
[quote] fromToken=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913  amount=1.000000 USDC
[quote] quoteId=qid_abc123
[quote] estimatedFee=0.020000 USDC
[quote] netReceived=0.980000 USDC
[quote] expires=2026-05-08T12:01:30.000Z
```

### Execute bridge payment

Runs the full bridge flow end-to-end. Submits real EVM transactions.

```bash
npm run send
# or
tsx agent.ts send
```

Example output:
```
── Fetching quote ──
[quote] chainId=8453 (Base)
[quote] fromToken=0x833589...  amount=1.000000 USDC
[quote] quoteId=qid_abc123
[quote] estimatedFee=0.020000 USDC
[quote] netReceived=0.980000 USDC
[quote] expires=2026-05-08T12:01:30.000Z

── Building transactions ──
[build] approval tx required (ERC-20 allowance needed)

── Sending approval ──
[approval] hash=0xabc... allowance_before=0.000000 allowance_after=115792089...

── Sending bridge transaction ──
[bridge] estimatedGas=145000 gas=159500 (+10% buffer)
[bridge] submitted txHash=0xdef...
[bridge] confirmed block=12345678 status=success

── Looking up deposit ──
[deposit] waiting for txHash=0xdef... elapsed=5s
[deposit] found depositId=dep_xyz789

── Waiting for Solana arrival ──
[bridge] depositId=dep_xyz789 status=pending_evm_confirmation elapsed=0s
[bridge] depositId=dep_xyz789 status=bridging elapsed=10s
[bridge] depositId=dep_xyz789 status=arrived_on_solana elapsed=45s

── Verifying vault balance ──
[verify] paymentVault balance: 0.980000 USDC ✓
[verify] solana tx: https://solscan.io/tx/5abc...

════════════════════════════════════════════
  EVM→Solana Bridge Payment Complete
════════════════════════════════════════════
  Source:    Base (8453)
  Amount:    1.000000 USDC
  Fee:       0.020000 USDC
  Net:       0.980000 USDC
  Approval:  0xabc...
  Bridge tx: 0xdef...
  DepositId: dep_xyz789
  Solana tx: 5abc...
  Vault bal: 0.980000 USDC
  Total time: 52s
════════════════════════════════════════════
```

### Poll an existing deposit

Use this to resume tracking a bridge deposit if the agent was interrupted after the bridge tx confirmed.

```bash
tsx agent.ts status dep_xyz789
```

## Approval behaviour

The agent checks the current ERC-20 allowance before sending an approval transaction:

- If `allowance >= bridgeAmount` → approval is **skipped** (saves gas)
- Otherwise → sends `approve(spender, maxUint256)` and waits for confirmation

## Gas estimation

Gas is estimated via `publicClient.estimateGas` with a **10% buffer** applied:

```
gas = estimatedGas * 110n / 100n
```

No hardcoded gas limits are used.

## Timeouts

| Step | Timeout |
|---|---|
| Deposit lookup | 60 seconds (polls every 5s) |
| Solana arrival | 120 seconds (polls every 5s) |
| Bridge tx receipt | 60 seconds |
