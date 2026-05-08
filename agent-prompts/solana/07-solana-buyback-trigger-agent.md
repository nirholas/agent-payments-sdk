<!-- agent-payments-sdk | Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas -->

# Task: Solana USDC Buyback Trigger Agent

## Objective
Build a TypeScript agent that monitors the Pump Agent's `buybackVault` USDC balance on Solana mainnet and, when it exceeds a configurable threshold, constructs and submits the `agent_buyback_trigger` instruction with a real Jupiter V6 swap instruction to buy back the agent's own token and burn it.

## Context
`PumpAgentOffline.buildBuybackTriggerInstructions` (in `src/solana/PumpAgentOffline.ts`) takes:
- `authority`: the `buyback_authority` PDA signer (global, not agent-specific)
- `jupiterInstructionData`: raw bytes of a Jupiter V6 swap instruction
- `jupiterProgramId`: Jupiter's aggregator program ID
- `jupiterAccounts`: all account metas for the swap

The program verifies post-swap that the agent's token balance increased, then burns the acquired tokens. This is irreversible — the buyback authority is global protocol infrastructure. This agent monitors and alerts but defers actual trigger to explicit confirmation unless `--auto` flag is set.

Jupiter V6 API quote endpoint: `https://quote-api.jup.ag/v6/quote`
Jupiter V6 swap instruction endpoint: `https://quote-api.jup.ag/v6/swap-instructions`

## Environment Variables
```
SOLANA_RPC_URL           Mainnet RPC
BUYBACK_AUTHORITY_KEY    The global buyback authority keypair (base58 / JSON array)
AGENT_MINT               Agent token mint
BUYBACK_THRESHOLD_USDC   Min USDC in buyback vault to trigger (default: 5.0)
POLL_INTERVAL_MS         Polling interval (default: 30000)
SLIPPAGE_BPS             Jupiter swap slippage tolerance (default: 100 = 1%)
```

## Requirements

### 1. Vault Balance Check
Implement `async checkBuybackVault()`:
- Call `agent.getBalances(USDC_MINT)`.
- Return `{ balance: bigint, balanceUsdc: string, aboveThreshold: boolean }`.
- Log: `[buyback] vault=<X> USDC threshold=<Y> USDC above=<bool>`.

### 2. Jupiter Quote Fetch
Implement `async fetchJupiterQuote(inputAmountUsdc: bigint)`:
- Call `https://quote-api.jup.ag/v6/quote` with params:
  ```
  inputMint=EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
  outputMint=<AGENT_MINT>
  amount=<inputAmountUsdc>
  slippageBps=<SLIPPAGE_BPS>
  swapMode=ExactIn
  ```
- Parse and return the full quote JSON.
- Log the quote: `[jupiter] in=<X> USDC out=<Y> <AGENT_TOKEN> price_impact=<Z>%`.

### 3. Jupiter Swap Instruction Fetch
Implement `async fetchJupiterSwapInstructions(quote, userPublicKey)`:
- POST to `https://quote-api.jup.ag/v6/swap-instructions` with body:
  ```json
  {
    "quoteResponse": <quote>,
    "userPublicKey": "<userPublicKey>",
    "wrapAndUnwrapSol": false,
    "dynamicComputeUnitLimit": true,
    "prioritizationFeeLamports": 1000
  }
  ```
- Return the `swapInstruction` field (programId, accounts, data — all as base64/base58).
- Return also `addressLookupTableAddresses` for ALT resolution.

### 4. ALT Resolution
Implement `async resolveAddressLookupTables(connection, altAddresses)`:
- Fetch each ALT via `connection.getAddressLookupTable(new PublicKey(addr))`.
- Return an array of `AddressLookupTableAccount`.
- Required for `VersionedTransaction` construction.

### 5. Buyback Transaction Construction
Implement `async buildBuybackTransaction(quote, swapInstruction, userPublicKey)`:
- Convert the Jupiter swap instruction response to a `TransactionInstruction`.
- Call `agent.buildBuybackTriggerInstructions({ authority, jupiterInstructionData, jupiterProgramId, jupiterAccounts })`.
- Build a `VersionedTransaction` using `TransactionMessage` with:
  - The resolved ALTs
  - `ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 })`
  - `ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1000 })`
  - The buyback instruction(s)
- Return serialized base64.

### 6. Execution with Confirmation Gate
When `aboveThreshold` is true:
- If `--auto` flag is NOT set: print the proposed swap details and prompt `Press ENTER to confirm or Ctrl+C to abort`.
- If `--auto` flag IS set: proceed immediately.
- Submit the transaction, wait for `"confirmed"`, print the Solscan link.

### 7. Buyback Log
Append to `buyback-log.jsonl`:
```json
{ "timestamp": "...", "vaultBalanceBefore": "...", "jupiterQuoteOut": "...", "signature": "...", "agentMintBurned": "..." }
```

### 8. Monitoring Loop
Run `checkBuybackVault` every `POLL_INTERVAL_MS`. On signal `SIGINT`/`SIGTERM`, exit cleanly.

## Deliverables
- `agent-prompts/solana/agents/buyback-trigger/agent.ts`
- `agent-prompts/solana/agents/buyback-trigger/package.json`
- `agent-prompts/solana/agents/buyback-trigger/README.md`

## Acceptance Criteria
- The agent fetches a real Jupiter V6 quote and swap instructions for the configured agent token.
- In non-auto mode, the transaction is only submitted after explicit Enter key confirmation.
- In `--auto` mode, the buyback submits without prompting.
- `buyback-log.jsonl` records every triggered buyback with real on-chain signatures.
- No mocked Jupiter API calls. All network calls are real.
