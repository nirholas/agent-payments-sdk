# solana-agent-kit v2 + PumpAgentPaymentsPlugin demo

CLI demo that mounts `PumpAgentPaymentsPlugin` from `@nirholas/agent-payments-sdk/solana-agent-kit` onto a `SolanaAgentKit` v2 instance and exercises all 9 exposed actions — both directly (no LLM) and through a Claude-powered tool-calling agent loop.

## Setup

```bash
npm install
```

## Environment variables

| Variable | Required for | Description |
|----------|-------------|-------------|
| `SOLANA_RPC_URL` | all modes | Mainnet RPC endpoint |
| `SOLANA_PRIVATE_KEY` | all modes | Base58-encoded agent operator keypair |
| `AGENT_MINT` | all modes | Pump token mint with agent-payments initialized |
| `ANTHROPIC_API_KEY` | `chat` mode | Claude API key for the LLM agent loop |

```bash
export SOLANA_RPC_URL="https://api.mainnet-beta.solana.com"
export SOLANA_PRIVATE_KEY="<base58-keypair>"
export AGENT_MINT="<your-agent-mint>"
export ANTHROPIC_API_KEY="sk-ant-..."
```

## Commands

```bash
# Fetch USDC and SOL vault balances for all three vaults
npx tsx demo.ts balances

# Distribute USDC from payment vault (skips if vault is empty)
npx tsx demo.ts distribute

# Run all 9 action handlers directly and print results
npx tsx demo.ts all

# LLM agent loop — default prompt checks balance and distribution readiness
npx tsx demo.ts chat

# Custom LLM prompt
npx tsx demo.ts chat "What is the current buyback percentage and total USDC received?"

# Validate all 9 Zod schemas with a valid and an invalid input each
npx tsx demo.ts validate-schemas
```

Or via npm scripts for the most common operations:

```bash
npm run balances
npm run distribute
npm run all
npm run validate-schemas
```

## How it works

### Kit initialization

`SolanaAgentKit` v2 uses a `BaseWallet` interface and exposes actions via `kit.actions`. Plugins must implement an `initialize(agent)` method. Because `PumpAgentPaymentsPlugin` targets structural compatibility rather than the exact SAK v2 type, we add a no-op `initialize` when calling `.use()`:

```ts
const kit = new SolanaAgentKit(wallet, rpcUrl, {})
  .use({ ...PumpAgentPaymentsPlugin, initialize: () => {} } as any);
```

After this call `kit.actions` contains all 9 pump-agent actions.

### SolanaAgentKitLike adapter

The plugin's action handlers expect `{ connection, wallet: Keypair, wallet_address: PublicKey }`. Because `SolanaAgentKit` v2 exposes `wallet: BaseWallet` (not a `Keypair`), we create a thin adapter:

```ts
const adapter: SolanaAgentKitLike = {
  connection: kit.connection,
  wallet: keypair,
  wallet_address: keypair.publicKey,
};
```

This adapter is passed to action handlers when calling them directly, and is captured in the closure of each LangChain tool's `func`.

### LLM agent loop

`chat` mode wraps each action as a `DynamicStructuredTool` (preserving the Zod schema for Claude's structured tool use) and builds a `createToolCallingAgent` + `AgentExecutor` pipeline backed by `claude-sonnet-4-6`. Claude's native tool-calling drives the ReAct loop — no text-based scratchpad format required.

### Direct action handlers

All modes other than `chat` call `action.handler(adapter, input)` directly — no LLM, no network round-trip beyond the Solana RPC call inside the handler. This is useful for automation, cron jobs, and integration tests.

## Actions

| Action name | What it does |
|-------------|-------------|
| `pump_agent_create` | Initialize the on-chain agent-payments PDA (authority must be bonding-curve creator) |
| `pump_agent_build_payment_instructions` | Build accept-payment instructions for a payer to sign |
| `pump_agent_get_balances` | Fetch payment / buyback / withdraw vault balances for a currency |
| `pump_agent_validate_invoice` | Verify a specific payment exists on-chain |
| `pump_agent_distribute_payments` | Split payment vault into buyback and withdraw vaults |
| `pump_agent_withdraw` | Withdraw from the withdraw vault to the agent's ATA |
| `pump_agent_get_config` | Read authority, buybackBps, and mint from the config PDA |
| `pump_agent_get_payment_stats` | Cumulative per-currency stats (totalPayments, totalBuyback, etc.) |
| `pump_agent_update_buyback_bps` | Update the buyback percentage (authority only) |

## Notes

- **No transactions are submitted.** Action handlers that build instructions return them serialized as base64 — submitting to the chain is left to the caller.
- **`pump_agent_create` on non-creator wallets:** The instruction builds successfully, but submitting it will fail with an Anchor error if the wallet is not the bonding-curve creator. The demo catches and surfaces this error with a human-readable message.
- **`pump_agent_withdraw` schema:** Uses `{ mint, currencyMint, receiverAta? }`. There is no `amount` field — the on-chain program withdraws the entire withdraw-vault balance.
