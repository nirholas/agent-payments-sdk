# Claude EVM x402 Agent

A Claude-powered AI agent that autonomously discovers, evaluates, and pays for
EVM x402-protected HTTP endpoints using USDC cross-chain bridge payments.

## What it does

Claude uses four tools in a loop (up to 15 iterations) to:

1. **`check_evm_balance`** — read USDC balances across all 6 supported EVM chains
2. **`inspect_402`** — probe an endpoint's payment requirements without paying
3. **`fetch_resource`** — fetch any URL, automatically bridging USDC when a 402 is encountered
4. **`get_bridge_quote`** — get a fee + net-amount quote for a cross-chain USDC payment

The system prompt is cached with `cache_control: { type: "ephemeral" }` so repeated
calls in the same session hit the Anthropic prompt cache.

## Supported chains

| Chain ID | Network |
|----------|---------|
| 1 | Ethereum |
| 8453 | Base (default) |
| 42161 | Arbitrum One |
| 137 | Polygon |
| 56 | BNB Smart Chain |
| 43114 | Avalanche C-Chain |

## Setup

```bash
cd agent-prompts/evm/agents/claude-evm-agent
npm install
```

## Environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | ✅ | — | Anthropic API key |
| `EVM_PRIVATE_KEY` | ✅ | — | EVM wallet private key (hex, with or without `0x`) |
| `EVM_CHAIN_ID` | | `8453` | Default chain to pay from |
| `EVM_RPC_URL` | | public RPC | RPC URL override for the default chain |
| `MAX_PAYMENT_USDC` | | `5.0` | Hard ceiling per `fetch_resource` call |
| `AGENT_MINT` | | — | Pump agent token mint (for bridge context) |

## Usage

```bash
# Ask the agent to fetch a free resource
node agent.ts "Fetch https://httpbin.org/get and summarize the response"

# Ask the agent to pay for a gated resource on Base
node agent.ts "Fetch the premium report at https://agent.example/api/report"

# Force a specific chain
node agent.ts --chain=42161 "Check my USDC balance on Arbitrum"

# Full workflow prompt
node agent.ts "Check my balances, then fetch https://api.example/data/premium and pay if needed"
```

## Output format

```
[tools]
  check_evm_balance → Base: 8.250000 USDC, Arbitrum: 2.100000 USDC
  inspect_402       → scheme=pump-agent-evm amount=1.000000 USDC chain=base
  fetch_resource    → paid 1.000000 USDC from chain=8453 tx=0xabc12345...

The premium report contains: ...
```

Cache metrics are written to stderr after each API call:

```
[cache] read=0 write=1842
[cache] read=1842 write=0
[cache] cumulative read=1842 write=1842 saved≈1658 tokens
```

## Payment safety

- `MAX_PAYMENT_USDC` is enforced **before** any EVM transaction is submitted.
  If the 402 requirement exceeds the limit, `fetch_resource` returns an error
  object and no bridge transaction is sent.
- Claude's system prompt instructs it to always check balance and inspect
  requirements before calling `fetch_resource`.
- The agent reports the bridge `txHash` in every paid response.

## Architecture

```
agent.ts          CLI entry, Anthropic SDK agent loop, tool dispatch, trace output
tools.ts          Tool definitions (Anthropic.Tool[]) + createToolHandlers() factory
  └─ uses:
       src/x402/evm-client.ts   createEvmX402Fetch — 402 detection + bridge payment
       src/evm/quote.ts         getQuote — cross-chain bridge quote
       src/chains.ts            EVM_CHAINS, getChain — chain config + USDC addresses
       src/constants.ts         ERC20_ABI — for balanceOf reads
```
