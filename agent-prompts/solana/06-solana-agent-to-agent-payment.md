<!-- agent-payments-sdk | Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas -->

# Task: Solana USDC Agent-to-Agent Payment Protocol

## Objective
Build a TypeScript system where **Agent A** discovers Agent B's x402 payment requirements via an HTTP negotiation endpoint, pays Agent B in USDC using the `"pump-agent"` scheme, and receives a cryptographically verifiable proof of service delivery — establishing a complete agent-to-agent micropayment flow on Solana mainnet.

## Context
Both agents use `@nirholas/agent-payments-sdk/solana`. Agent B runs an x402 resource server (built with `createResourceServer` + `PumpAgentFacilitator`). Agent A uses `createX402Fetch` to autonomously pay and consume Agent B's service. The key innovation here is the **capability negotiation**: Agent A queries Agent B's `/.well-known/agent-payments` endpoint to discover what Agent B sells and at what price before committing to a payment.

## Environment Variables
```
SOLANA_RPC_URL          Mainnet RPC
AGENT_A_PRIVATE_KEY     Agent A's Solana keypair (payer)
AGENT_B_PRIVATE_KEY     Agent B's Solana keypair (server authority)
AGENT_B_MINT            Agent B's pump token mint
AGENT_B_PAYMENT_VAULT   Agent B's payment vault address
AGENT_B_PORT            Port for Agent B's HTTP server (default: 3001)
```

## Requirements

### Part 1: Agent B Server

#### 1.1 Well-Known Capability Endpoint
`GET /.well-known/agent-payments` returns JSON (no payment gate):
```json
{
  "agentMint": "<AGENT_B_MINT>",
  "name": "Agent B Compute Service",
  "capabilities": [
    {
      "path": "/compute/sha256",
      "description": "Compute SHA-256 hash of input",
      "priceUsdc": "0.1",
      "priceMinorUnits": "100000"
    },
    {
      "path": "/compute/wordcount",
      "description": "Count words in text",
      "priceUsdc": "0.05",
      "priceMinorUnits": "50000"
    }
  ],
  "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
  "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
}
```

#### 1.2 Gated Compute Endpoints
- `POST /compute/sha256` — body: `{ input: string }`, returns `{ hash: string }`. Price: 0.1 USDC.
- `POST /compute/wordcount` — body: `{ text: string }`, returns `{ words: number, chars: number }`. Price: 0.05 USDC.

Both gated by `createResourceServer` with `buildPumpAgentRequirements` using `AGENT_B_MINT` and `AGENT_B_PAYMENT_VAULT`.

#### 1.3 Service Proof Header
After settlement, Agent B appends a custom `X-SERVICE-PROOF` response header containing:
```json
{
  "agentMint": "<AGENT_B_MINT>",
  "invoiceMemo": "<memo>",
  "servedAt": "<ISO8601>",
  "paymentSignature": "<tx_sig>"
}
```
Base64-encoded.

### Part 2: Agent A Client

#### 2.1 Capability Discovery
Implement `async discoverCapabilities(agentBBaseUrl)`:
- Fetch `GET <agentBBaseUrl>/.well-known/agent-payments`.
- Parse and return the capability manifest.
- Log each capability: `[discover] path=<path> price=<priceUsdc> USDC`.

#### 2.2 Autonomous Payment & Call
Implement `async callAgentB(path, body)`:
- Create a `createX402Fetch` instance using `AGENT_A_PRIVATE_KEY` and the Solana connection.
- POST to `<agentBBaseUrl><path>` with the provided body.
- The x402Fetch wrapper handles the 402 → pay → retry automatically.
- Decode and validate `X-SERVICE-PROOF` from the response headers.
- Return `{ result, serviceProof }`.

#### 2.3 Service Proof Validation
Implement `validateServiceProof(proof, expectedMemo)`:
- Decode the base64 JSON.
- Verify `proof.invoiceMemo === expectedMemo` (extracted from the payment payload).
- Verify `proof.agentMint === AGENT_B_MINT`.
- Return `{ valid: boolean, reason?: string }`.

#### 2.4 CLI Orchestration
```
node orchestrator.js discover           Show Agent B's capabilities
node orchestrator.js sha256 <input>     Pay and compute SHA-256
node orchestrator.js wordcount <text>   Pay and count words
node orchestrator.js benchmark <N>      Call each endpoint N times, report total USDC spent
```

The `benchmark` command runs N calls sequentially, prints per-call timing, and summarizes total USDC spent.

### Part 3: Shared Types
Define a shared `AgentCapabilityManifest` TypeScript type used by both A and B.

## Deliverables
- `agent-prompts/solana/agents/agent-to-agent/server-b.ts` — Agent B server
- `agent-prompts/solana/agents/agent-to-agent/client-a.ts` — Agent A client
- `agent-prompts/solana/agents/agent-to-agent/types.ts` — shared types
- `agent-prompts/solana/agents/agent-to-agent/package.json`
- `agent-prompts/solana/agents/agent-to-agent/README.md`

## Acceptance Criteria
- Agent A discovers Agent B's capabilities without any hard-coded pricing.
- A single `node orchestrator.js sha256 "hello world"` triggers a real USDC on-chain payment and returns the hash.
- The service proof is validated and printed.
- No mocks, no stubs. Both agents use real Solana mainnet transactions.
