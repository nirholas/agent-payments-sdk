<!-- agent-payments-sdk | Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas -->

# Task: Solana USDC x402 Autonomous Fetch Client

## Objective
Build a production-ready, standalone TypeScript CLI agent that wraps `createX402Fetch` from `@nirholas/agent-payments-sdk/solana` to autonomously call any HTTP endpoint, detect HTTP 402 responses, pay the exact USDC amount demanded, and retry — without any human interaction.

## Context
The SDK exposes `createX402Fetch(config: X402ClientConfig & { connection: Connection })` in `src/solana/x402/client.ts`. It supports two payment schemes:
- `"pump-agent"` — on-chain invoice via `PumpAgentOffline.buildAcceptPaymentInstructions`
- `"exact"` — SPL `TransferChecked` to an arbitrary recipient ATA

USDC mainnet mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (6 decimals)
Solana mainnet CAIP-2: `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp`

## Requirements

### 1. Wallet Loading
- Load a Solana keypair from `SOLANA_PRIVATE_KEY` env var (base58 or JSON array).
- Throw with a clear message if the env var is missing or the key is malformed.
- Never hard-code any private key.

### 2. RPC Connection
- Read RPC URL from `SOLANA_RPC_URL` env var; default to `https://api.mainnet-beta.solana.com`.
- Create a `Connection` with `commitment: "confirmed"`.

### 3. x402 Fetch Configuration
Wire `createX402Fetch` with:
```ts
{
  payer: keypair.publicKey.toBase58(),
  connection,
  signTransaction: async (txBase64) => {
    const tx = Transaction.from(Buffer.from(txBase64, "base64"));
    tx.partialSign(keypair);
    return Buffer.from(tx.serialize({ requireAllSignatures: false })).toString("base64");
  },
  sendTransaction: async (signedTxBase64) => {
    const raw = Buffer.from(signedTxBase64, "base64");
    const sig = await connection.sendRawTransaction(raw, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    await connection.confirmTransaction(sig, "confirmed");
    return sig;
  },
  confirmationTimeoutMs: 60_000,
}
```

### 4. Pre-flight Balance Check
Before the first request, fetch the payer's USDC ATA balance using `connection.getTokenAccountBalance`. If the balance is 0 or the ATA does not exist, print a human-readable warning but do **not** abort — the endpoint might be free.

### 5. Request Execution
Accept the target URL and optional JSON body from CLI args (`process.argv`):
```
node agent.js <URL> [JSON_BODY]
```
- If `JSON_BODY` is provided, send `POST` with `Content-Type: application/json`.
- Otherwise, send `GET`.
- Use the x402-wrapped fetch for the call.

### 6. Response Handling
- If final response is 2xx: pretty-print `JSON.stringify(await res.json(), null, 2)` or `await res.text()`.
- If final response is still 402 after payment attempt: print the `PAYMENT-REQUIRED` header decoded as JSON and exit with code 1.
- If any other non-2xx: print status + body and exit with code 1.
- Always print the `PAYMENT-RESPONSE` header (decoded from base64 JSON) if present.

### 7. Payment Logging
After a successful payment, print a structured log line:
```
[x402] paid | scheme=<scheme> | asset=<mint> | amount=<human_usdc> USDC | sig=<signature> | resource=<url>
```
Convert minor units (6 decimals) to human USDC for the log.

### 8. Error Handling
- Wrap the entire execution in a try/catch. On error, print the error message and stack, then exit with code 1.
- If transaction confirmation times out, print the partial signature so it can be looked up manually on Solscan.

## Deliverables
- `agent-prompts/solana/agents/x402-fetch-client/index.ts` — the full implementation
- `agent-prompts/solana/agents/x402-fetch-client/package.json` — with all necessary dependencies (`@nirholas/agent-payments-sdk`, `@solana/web3.js`, `@solana/spl-token`)
- `agent-prompts/solana/agents/x402-fetch-client/README.md` — usage instructions with real example invocations

## Acceptance Criteria
- The agent compiles with `tsc --noEmit`.
- Running against a live x402-protected endpoint (e.g., one created by task 02) pays USDC and returns the protected resource.
- No mocks, no stubs, no demo mode. All Solana calls target mainnet via the configured RPC.
- The `PAYMENT-RESPONSE` header is always decoded and logged when present.
