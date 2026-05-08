<!-- agent-payments-sdk | Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas -->

# Task: Solana USDC Payments via solana-agent-kit v2 Plugin

## Objective
Build a complete integration of `PumpAgentPaymentsPlugin` from `@nirholas/agent-payments-sdk/solana-agent-kit` with a `solana-agent-kit` v2 `SolanaAgentKit` instance. The result is a fully functional agentic pipeline where an LLM (via the plugin's action schema) can manage every aspect of USDC agent payments on Solana mainnet by calling the 9 exposed methods.

## Context
The plugin (`src/solana/solana-agent-kit/`) exports `PumpAgentPaymentsPlugin` and a set of `Action` objects wired with Zod schemas and handlers. The actions call `PumpAgent` / `PumpAgentOffline` methods directly using the kit's `connection` and wallet. The actions are:
- `pump_agent_create`
- `pump_agent_pay`
- `pump_agent_balances`
- `pump_agent_validate_invoice`
- `pump_agent_distribute`
- `pump_agent_withdraw`
- `pump_agent_config`
- `pump_agent_stats`
- `pump_agent_update_buyback`

## Environment Variables
```
SOLANA_RPC_URL        Mainnet RPC
SOLANA_PRIVATE_KEY    Agent operator keypair
AGENT_MINT            Pump token mint with agent-payments initialized
ANTHROPIC_API_KEY     For LLM orchestration
OPENAI_API_KEY        Alternative LLM (if solana-agent-kit uses OpenAI by default)
```

## Requirements

### 1. Kit Initialization
```ts
import { SolanaAgentKit } from "solana-agent-kit";
import { PumpAgentPaymentsPlugin } from "@nirholas/agent-payments-sdk/solana-agent-kit";

const kit = new SolanaAgentKit(privateKey, rpcUrl, { OPENAI_API_KEY: "..." })
  .use(PumpAgentPaymentsPlugin);
```
Verify the plugin mounts by checking that `kit.actions` includes all 9 pump-agent actions.

### 2. Direct Action Execution
Implement a test harness that calls each action's handler directly (bypassing the LLM) with valid inputs:

#### `pump_agent_balances`
Call with `{ mint: AGENT_MINT }`. Print all vault balances for every supported currency.

#### `pump_agent_config`
Call with `{ mint: AGENT_MINT }`. Print authority, buybackBps, isInitialized.

#### `pump_agent_stats`
Call with `{ mint: AGENT_MINT, currencyMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }`. Print all counters.

#### `pump_agent_validate_invoice`
Call with:
```ts
{
  mint: AGENT_MINT,
  userPublicKey: kit.wallet.publicKey.toBase58(),
  currencyMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
  amount: 1000000,
  memo: Date.now(),
  startTime: Math.floor(Date.now() / 1000),
  endTime: Math.floor(Date.now() / 1000) + 300,
}
```
This will return `{ valid: false }` unless a real payment exists — that is expected and correct.

#### `pump_agent_distribute`
Call with `{ mint: AGENT_MINT }`. Submit the distribution transaction if payment vault > 0; otherwise print "payment vault is empty, nothing to distribute."

#### `pump_agent_withdraw`
Call with `{ mint: AGENT_MINT, amount: 0 }`. Zero-amount withdrawals should gracefully do nothing or return the available balance.

#### `pump_agent_update_buyback`
Call with `{ mint: AGENT_MINT, buybackBps: 500 }`. Build and submit the update-buyback-bps transaction.

### 3. LLM-Driven Agent Loop
Build a natural-language agent loop using Claude (`claude-sonnet-4-6`) that uses the plugin actions as tools:

```ts
const agent = kit.createReActAgent();
const executor = AgentExecutor.fromAgentAndTools({ agent, tools: kit.tools });
const result = await executor.invoke({
  input: "Check my agent USDC balance and tell me if there is anything ready to distribute"
});
```

If `solana-agent-kit` exposes a different API for agent execution, use the correct one from the library's documentation — do not guess or invent method names.

### 4. Action Schema Validation
For each action, use the Zod schema to parse a valid input object and an invalid one. Print whether validation passes or throws `ZodError`. This confirms the schemas are correctly typed.

### 5. CLI Modes
```
node plugin-demo.js balances           Direct action: get vault balances
node plugin-demo.js distribute         Direct action: distribute if threshold met
node plugin-demo.js chat "<message>"   LLM agent: process natural language request
node plugin-demo.js validate-schemas   Test all 9 Zod schemas
```

### 6. Output Formatting
For LLM mode, print the full chain of thought (intermediate steps) and the final answer. Show each tool call's name and result.

For direct mode, format all USDC amounts as `<X.XXXXXX> USDC` with 6 decimal places.

### 7. Error Handling
The `pump_agent_create` action requires the authority to be the bonding-curve creator. If called with a non-creator key, it will fail on-chain. Catch the anchor error and print a human-readable message.

## Deliverables
- `agent-prompts/solana/agents/solana-agent-kit-demo/demo.ts`
- `agent-prompts/solana/agents/solana-agent-kit-demo/package.json`
- `agent-prompts/solana/agents/solana-agent-kit-demo/README.md`

## Acceptance Criteria
- All 9 action handlers execute without TypeScript errors.
- `validate-schemas` mode passes 9 valid inputs and fails 9 invalid inputs with clear Zod error messages.
- `chat` mode produces a real response from `claude-sonnet-4-6` referencing live on-chain data.
- No mock Solana connections. All `connection.getAccountInfo` / `program.account.fetch` calls hit mainnet.
