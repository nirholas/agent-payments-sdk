# Vault Monitor & Auto-Distributor

A long-running TypeScript daemon that watches the three on-chain USDC vaults of a Pump Agent and automatically calls `distributePayments` whenever the payment vault crosses a configurable threshold.

## How it works

On startup the daemon:
1. Prints a summary of the vault addresses and configuration.
2. Opens a **WebSocket account-change subscription** on the payment vault ATA — any incoming USDC triggers an immediate balance check.
3. Starts a **polling loop** every `POLL_INTERVAL_MS` ms as a reliable heartbeat.

Each check fetches live balances via `PumpAgent.getBalances(USDC_MINT)` and logs a one-liner with the current Solana slot. If `paymentVault.balance >= threshold` and no distribution is already in flight, it calls `runDistribution()`.

`runDistribution()` builds instructions via `agent.distributePayments()`, submits a signed transaction, waits for `"confirmed"` commitment, and appends a JSON record to `distributions.jsonl`.

Failed distributions are retried up to 3 times with a 5-second back-off. After all retries are exhausted the daemon logs the error and continues monitoring — it never crashes.

`SIGINT` / `SIGTERM` cleanly removes the WebSocket subscription, clears the polling interval, and exits 0.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `SOLANA_RPC_URL` | Yes | — | Mainnet RPC endpoint (`https://` or `wss://`) |
| `SOLANA_PRIVATE_KEY` | Yes | — | Authority keypair as a JSON byte array `[1,2,3,...]` |
| `AGENT_MINT` | Yes | — | Agent token mint address |
| `DISTRIBUTION_THRESHOLD` | No | `1.0` | Minimum USDC in payment vault to trigger distribution |
| `POLL_INTERVAL_MS` | No | `15000` | Polling interval in milliseconds |

## Running

```bash
npm install
```

```bash
export SOLANA_RPC_URL="https://mainnet.helius-rpc.com/?api-key=YOUR_KEY"
export SOLANA_PRIVATE_KEY="[1,2,3,...]"
export AGENT_MINT="YourAgentMintAddressHere"
export DISTRIBUTION_THRESHOLD="1.0"
export POLL_INTERVAL_MS="15000"

npm start
```

## Output

```
[vault-monitor] starting
  Agent mint:  YourAgentMintAddressHere
  USDC mint:   EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
  Payment ATA: <derived address>
  Buyback ATA: <derived address>
  Withdraw ATA: <derived address>
  Threshold:   1.0 USDC
  Poll:        15000 ms
[monitor] slot=340000000  payment=0.000000 USDC  buyback=0.000000 USDC  withdraw=0.000000 USDC
[monitor] slot=340000060  payment=5.250000 USDC  buyback=0.000000 USDC  withdraw=0.000000 USDC
[monitor] threshold crossed (5.250000 >= 1.0 USDC) — triggering distribution
[distribute] pre-distribution  payment=5.250000 USDC  buyback=0.000000 USDC  withdraw=0.000000 USDC
[distribute] post-distribution sig=5xyz...  payment=0.000000 USDC (-5.250000)  buyback=3.937500 USDC  withdraw=1.312500 USDC
```

## distributions.jsonl

Each distribution appends one JSON line:

```json
{"timestamp":"2026-05-08T12:00:00.000Z","signature":"5xyz...","paymentBefore":"5250000","buybackAfter":"3937500","withdrawAfter":"1312500"}
```

Balances are raw minor units (1 USDC = 1,000,000).
