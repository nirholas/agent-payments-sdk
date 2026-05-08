# Agent-to-Agent USDC Payment Protocol

A complete Solana mainnet demonstration of two autonomous agents exchanging value:
**Agent B** runs a paid compute service; **Agent A** discovers its capabilities,
pays in USDC, and cryptographically verifies the service was delivered.

## Overview

```
Agent A (client)                           Agent B (server)
  │                                            │
  ├─ GET /.well-known/agent-payments ─────────►│  Discover capabilities + prices
  │◄─────────────────────── manifest ──────────┤
  │                                            │
  ├─ POST /compute/sha256 ─────────────────────►│  Probe request (no payment)
  │◄──────────────────── 402 + requirements ───┤  Returns invoice memo + price
  │                                            │
  ├── builds & signs payment tx (memo M) ──────┤  Agent A pays on-chain
  ├── confirms tx on Solana mainnet ───────────┤
  │                                            │
  ├─ POST /compute/sha256 + PAYMENT-SIGNATURE ►│  Retry with proof of payment
  │◄──── 200 + result + X-SERVICE-PROOF ───────┤  Service rendered + proof
  │                                            │
  ├── validates X-SERVICE-PROOF ───────────────┤  invoiceMemo + agentMint match
```

## Payment Scheme

Uses the `pump-agent` x402 scheme on Solana mainnet.  
Currency: **USDC** (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`)

## Endpoints

| Endpoint | Price |
|---|---|
| `POST /compute/sha256` | 0.1 USDC |
| `POST /compute/wordcount` | 0.05 USDC |
| `GET /.well-known/agent-payments` | Free |
| `GET /health` | Free |

## Environment Variables

```bash
# Both agents
SOLANA_RPC_URL=https://api.mainnet-beta.solana.com

# Agent B (server)
AGENT_B_MINT=<base58 pump token mint>
AGENT_B_PAYMENT_VAULT=<base58 payment vault PDA>
AGENT_B_PORT=3001                          # default

# Agent A (client)
AGENT_A_PRIVATE_KEY=<base58 or JSON array keypair>
AGENT_B_MINT=<same as above — for proof validation>
AGENT_B_BASE_URL=http://localhost:3001     # default
```

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Start Agent B

```bash
SOLANA_RPC_URL=... \
AGENT_B_MINT=... \
AGENT_B_PAYMENT_VAULT=... \
npm run server
```

### 3. Run Agent A

```bash
SOLANA_RPC_URL=... \
AGENT_A_PRIVATE_KEY=... \
AGENT_B_MINT=... \
tsx client-a.ts discover
```

```bash
# SHA-256 hash (costs 0.1 USDC)
tsx client-a.ts sha256 "hello world"

# Word count (costs 0.05 USDC)
tsx client-a.ts wordcount "the quick brown fox"

# Benchmark (N rounds × 2 endpoints)
tsx client-a.ts benchmark 3
```

## CLI Commands

| Command | Description |
|---|---|
| `discover` | Fetch and print Agent B's capability manifest |
| `sha256 <input>` | Pay 0.1 USDC, get SHA-256 hash, validate service proof |
| `wordcount <text>` | Pay 0.05 USDC, get word count, validate service proof |
| `benchmark <N>` | Call each endpoint N times, print timing + total USDC spent |

## Service Proof

After settlement Agent B attaches a base64-encoded JSON to `X-SERVICE-PROOF`:

```json
{
  "agentMint": "<AGENT_B_MINT>",
  "invoiceMemo": "<memo>",
  "servedAt": "<ISO8601>",
  "paymentSignature": "<tx_sig>"
}
```

Agent A validates:
1. `invoiceMemo` matches the memo captured during the pre-probe
2. `agentMint` matches `AGENT_B_MINT`
3. `paymentSignature` and `servedAt` are non-empty

## Gate Design Note

Agent B's payment gates are created **once at startup** with a 24-hour invoice window.
This is intentional: both the 402 response and the on-chain validation must use the
exact same `(memo, startTime, endTime)` triple — if the gate were recreated per-request
the fresh memo would not match the client's submitted payment. Replay attacks are
prevented at two layers: Solana's global transaction-signature uniqueness and the
server's in-memory `SettlementCache` (TTL 120 s). For multi-day deployments, restart
the server before the 24-hour window expires or implement periodic gate rotation.

## Files

| File | Role |
|---|---|
| `types.ts` | Shared TypeScript types (`AgentCapabilityManifest`, `ServiceProof`, etc.) |
| `server-b.ts` | Agent B — Hono HTTP server with x402 payment gates |
| `client-a.ts` | Agent A — CLI orchestrator with discovery, payment, and validation |
| `package.json` | Dependencies and scripts |
