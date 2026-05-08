# Solana USDC Buyback Trigger Agent

A long-running TypeScript daemon that monitors the Pump Agent's `buybackVault` USDC balance on Solana mainnet. When the vault exceeds a configurable threshold it fetches a real Jupiter V6 swap quote, builds the `agentBuybackTrigger` instruction, and—after optional interactive confirmation—submits the transaction so the agent's own token is bought and burned on-chain.

## How it works

```
poll loop (POLL_INTERVAL_MS)
  └─ checkBuybackVault()       → PumpAgent.getBalances(USDC_MINT)
       └─ balance ≥ threshold?
            ├─ fetchJupiterQuote()           → GET /v6/quote
            ├─ fetchJupiterSwapInstructions() → POST /v6/swap-instructions
            ├─ resolveAddressLookupTables()  → connection.getAddressLookupTable
            ├─ buildBuybackTransaction()     → agent.buybackTrigger() + VersionedTransaction
            ├─ [confirmation gate if not --auto]
            ├─ connection.sendRawTransaction()
            └─ append buyback-log.jsonl
```

The program's `agentBuybackTrigger` instruction CPIs into Jupiter V6 to execute the USDC→agent-token swap, verifies the agent token balance increased, then burns the acquired tokens. This is irreversible.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SOLANA_RPC_URL` | yes | — | Mainnet-beta JSON RPC endpoint |
| `BUYBACK_AUTHORITY_KEY` | yes | — | Global buyback authority keypair (base58 string **or** JSON `[…]` uint8 array) |
| `AGENT_MINT` | yes | — | Agent token mint address |
| `BUYBACK_THRESHOLD_USDC` | no | `5.0` | Min USDC in buyback vault before a trigger is attempted |
| `POLL_INTERVAL_MS` | no | `30000` | Milliseconds between vault checks |
| `SLIPPAGE_BPS` | no | `100` | Jupiter swap slippage tolerance in basis points (100 = 1%) |

## Running

```bash
# Install
npm install

# Manual confirmation mode (default)
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
BUYBACK_AUTHORITY_KEY='[1,2,3,…]' \
AGENT_MINT=YourAgentMintHere \
npm start

# Auto mode — submits without prompting
npm run start:auto
```

Type-check without running:

```bash
npm run typecheck
```

## Confirmation gate

Without `--auto` the agent prints the proposed swap details and waits for `ENTER` before submitting. Use `Ctrl+C` to abort.

```
[buyback] ── Proposed buyback ──────────────────────────────
  Vault balance : 12.500000 USDC
  Swap in       : 12.500000 USDC
  Swap out      : 4821930 agent tokens (to be burned)
  Price impact  : 0.0312%
  Agent mint    : AbcDef12…
  Authority     : XyzPqr89…
────────────────────────────────────────────────────────

Press ENTER to confirm or Ctrl+C to abort:
```

## Buyback log

Every confirmed buyback appends one JSON line to `buyback-log.jsonl` in the working directory:

```json
{"timestamp":"2026-05-08T14:23:01.000Z","vaultBalanceBefore":"12.500000","jupiterQuoteOut":"4821930","signature":"5XvQ…","agentMintBurned":"AbcDef12…"}
```

## Key addresses

The agent derives the **per-agent buyback PDA** (`getBuybackAuthorityPDA(agentMint)`) and uses it as the Jupiter swap `userPublicKey`. This PDA owns the USDC vault that funds the swap and the agent-token vault where purchased tokens land before being burned.

The **global buyback authority** is fetched from `GlobalConfig.buybackAuthority` on-chain. The `BUYBACK_AUTHORITY_KEY` keypair must match this address — if it does not, the transaction will be rejected by the program.

## Architecture notes

- Uses `VersionedTransaction` (V0) with ALT resolution required by Jupiter V6 routes.
- Compute budget is set to 400,000 CU / 1,000 microlamports priority fee — tune `ComputeBudgetProgram` calls in `buildBuybackTransaction` if needed.
- A single `triggerInFlight` guard prevents concurrent triggers when a poll fires while a previous transaction is still in flight.
- Graceful shutdown on `SIGINT` / `SIGTERM`.
