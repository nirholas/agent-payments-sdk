# Task: Update and verify the x402 module in @nirholas/agent-payments-sdk

## Context

- SDK repo: `/workspaces/agent-payments-sdk`
- x402 Solana module: `src/solana/x402/` (client, facilitator, headers, types, index)
- x402 EVM module: `src/x402/` (evm-client, evm-facilitator, index)
- These modules are exported from the package as `@nirholas/agent-payments-sdk/x402` (EVM) and `@nirholas/agent-payments-sdk/solana` (Solana, which re-exports x402 helpers via `src/solana/index.ts`)

The three.ws x402 integration uses the **coinbase/x402 v1 wire protocol** (not the v2 SDK types). The SDK's `src/solana/x402/` already implements the v2 spec. We need to:
1. Verify the existing implementation is correct and complete
2. Add `createX402Client` and `createX402Facilitator` factory exports
3. Add a working example
4. Ensure everything builds cleanly

---

## Step 1: Read all x402 source files

Read every file before making changes:

```
/workspaces/agent-payments-sdk/src/solana/x402/index.ts
/workspaces/agent-payments-sdk/src/solana/x402/types.ts
/workspaces/agent-payments-sdk/src/solana/x402/headers.ts
/workspaces/agent-payments-sdk/src/solana/x402/client.ts
/workspaces/agent-payments-sdk/src/solana/x402/facilitator.ts
/workspaces/agent-payments-sdk/src/x402/index.ts
/workspaces/agent-payments-sdk/src/x402/evm-client.ts
/workspaces/agent-payments-sdk/src/x402/evm-facilitator.ts
/workspaces/agent-payments-sdk/src/solana/index.ts
/workspaces/agent-payments-sdk/src/index.ts
/workspaces/agent-payments-sdk/tsup.config.ts
```

---

## Step 2: Verify the Solana x402 client

The client in `src/solana/x402/client.ts` must:

1. **Build USDC transfer instructions** — for the `"exact"` scheme, it should create a `TransferChecked` instruction from the payer's USDC ATA to the recipient's USDC ATA. Read the current implementation.

2. **Encode/decode the X-PAYMENT header** — headers must use the format:
   ```json
   {
     "x402Version": 1,
     "scheme": "exact",
     "network": "solana-mainnet",
     "payload": {
       "signature": "<tx_base58>",
       "payTo": "<recipient_base58>",
       "amount": "<minor_units_string>",
       "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
     }
   }
   ```
   Base64-encoded for the header value.

3. **Handle both `"exact"` and `"pump-agent"` schemes** — the client already handles both; verify that `buildExactProof` builds and submits a real USDC SPL TransferChecked instruction.

4. **Export `createX402Fetch`** — already exists in `client.ts`. Verify it is exported from the index.

If anything is missing or incorrect in the current implementation, fix it. Do not break existing behavior.

---

## Step 3: Add `createX402Client` factory

In `src/solana/x402/client.ts`, add a convenience factory function that wraps `createX402Fetch` with a simpler interface. Add it **after** the existing `createX402Fetch` export:

```ts
/**
 * Create a Solana x402 payment client.
 *
 * Convenience wrapper over createX402Fetch that creates a ready-to-use
 * fetch function for paying x402-gated APIs on Solana.
 *
 * @example
 * ```ts
 * const client = createX402Client({
 *   connection: new Connection("https://api.mainnet-beta.solana.com"),
 *   payer: wallet.publicKey.toBase58(),
 *   signTransaction: async (txBase64) => {
 *     const tx = Transaction.from(Buffer.from(txBase64, "base64"));
 *     const signed = await wallet.signTransaction(tx);
 *     return Buffer.from(signed.serialize()).toString("base64");
 *   },
 *   sendTransaction: async (signedTxBase64) => {
 *     const raw = Buffer.from(signedTxBase64, "base64");
 *     const sig = await connection.sendRawTransaction(raw);
 *     await connection.confirmTransaction(sig, "confirmed");
 *     return sig;
 *   },
 * });
 *
 * const response = await client.fetch("https://api.agent.example/chat", {
 *   method: "POST",
 *   body: JSON.stringify({ message: "Hello" }),
 * });
 * ```
 */
export function createX402Client(
  config: X402ClientConfig & { connection: Connection },
): {
  fetch: typeof fetch;
  connection: Connection;
  payer: string;
} {
  const fetchFn = createX402Fetch(config);
  return {
    fetch: fetchFn,
    connection: config.connection,
    payer: config.payer,
  };
}
```

Export it from `src/solana/x402/index.ts`:
```ts
export { createX402Fetch, createX402Client } from "./client";
```

---

## Step 4: Add `createX402Facilitator` factory

In `src/solana/x402/facilitator.ts`, add a convenience factory at the bottom:

```ts
/**
 * Create a Solana x402 facilitator client.
 *
 * @example
 * ```ts
 * const facilitator = createX402Facilitator({
 *   connection: new Connection("https://api.mainnet-beta.solana.com"),
 * });
 *
 * // In your API route:
 * const result = await facilitator.verify(paymentPayload, requirements);
 * if (!result.isValid) return res.status(402).json({ error: result.invalidReason });
 *
 * await facilitator.settle(paymentPayload, requirements);
 * ```
 */
export function createX402Facilitator(
  config: PumpAgentFacilitatorConfig,
): PumpAgentFacilitator {
  return new PumpAgentFacilitator(config);
}
```

Export from `src/solana/x402/index.ts`:
```ts
export { PumpAgentFacilitator, buildPumpAgentRequirements, createResourceServer, createX402Facilitator } from "./facilitator";
```

---

## Step 5: Verify EVM x402 exports

The EVM x402 module at `src/x402/` exports `createEvmX402Fetch` and `verifyEvmPayment`. Verify:

1. `src/x402/index.ts` exports from both `evm-client.ts` and `evm-facilitator.ts`
2. The exports are accessible via `import { createEvmX402Fetch } from "@nirholas/agent-payments-sdk/x402"`
3. The `createEvmX402Fetch` function builds ERC-20 USDC transfers for Base, Ethereum, and Arbitrum

Read the current `src/x402/index.ts` — if it only exports `export * from "./evm-client.js"` and `export * from "./evm-facilitator.js"`, that is correct. No changes needed unless types are wrong.

---

## Step 6: Create a working example

Create `/workspaces/agent-payments-sdk/src/solana/examples/x402-payment-example.ts`:

```ts
// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

/**
 * x402 end-to-end example — resource server + client.
 *
 * This example shows:
 * 1. A resource server that charges $0.10 per request
 * 2. A client that automatically pays and fetches
 *
 * Prerequisites:
 *   - Node.js 18+
 *   - SOLANA_RPC_URL set to a Solana RPC endpoint
 *   - PAYER_PRIVATE_KEY set to a base58 private key with USDC balance
 *   - AGENT_MINT set to the agent token mint address
 *
 * Usage (read-only demo — no real payments unless you provide keys):
 *   SOLANA_RPC_URL=https://api.mainnet-beta.solana.com \
 *   npx tsx src/solana/examples/x402-payment-example.ts
 */

import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import {
  PumpAgentFacilitator,
  buildPumpAgentRequirements,
  createResourceServer,
  createX402Facilitator,
} from "../x402/index.js";
import { createX402Fetch } from "../x402/client.js";
import {
  USDC_MAINNET,
  SOLANA_MAINNET,
  X402_VERSION,
} from "../x402/types.js";
import type { PaymentRequirements, ResourceServerConfig } from "../x402/types.js";

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const AGENT_MINT = process.env.AGENT_MINT ?? "So11111111111111111111111111111111111111112";
const PRICE_USDC = 0.10;
const MINOR_UNITS = String(Math.round(PRICE_USDC * 1_000_000));

// ─── 1. Server Side ──────────────────────────────────────────────────────────

/**
 * Demonstrate building the payment requirements a server would return in its 402.
 */
function demonstrateServerSide() {
  console.log("\n=== Server Side ===");

  const connection = new Connection(RPC_URL, "confirmed");

  // The server creates a facilitator to verify + settle payments
  const facilitator = createX402Facilitator({ connection });

  // Build payment requirements for a hypothetical resource
  const agentMintPk = AGENT_MINT;
  const payToAddress = AGENT_MINT; // In real usage, this is the agent's payment PDA

  // "pump-agent" scheme — uses on-chain invoice via PumpAgent
  const pumpAgentReqs = buildPumpAgentRequirements({
    agentMint: agentMintPk,
    priceUsdc: PRICE_USDC,
    resource: "https://api.example.com/chat",
    description: "Chat with agent",
    network: SOLANA_MAINNET,
  });
  console.log("pump-agent payment requirements:", JSON.stringify(pumpAgentReqs, null, 2));

  // "exact" scheme — standard SPL TransferChecked
  const exactReqs: PaymentRequirements = {
    scheme: "exact",
    network: SOLANA_MAINNET,
    asset: USDC_MAINNET,
    amount: MINOR_UNITS,
    payTo: payToAddress,
    maxTimeoutSeconds: 300,
    extra: { name: "USDC", decimals: 6 },
  };
  console.log("\nexact payment requirements:", JSON.stringify(exactReqs, null, 2));

  // Show what the 402 response body looks like
  const paymentRequired = {
    x402Version: X402_VERSION,
    error: "payment required",
    resource: { url: "https://api.example.com/chat", description: "AI Chat" },
    accepts: [exactReqs],
  };
  console.log("\n402 response body:", JSON.stringify(paymentRequired, null, 2));

  return { facilitator, exactReqs };
}

// ─── 2. Client Side ──────────────────────────────────────────────────────────

/**
 * Demonstrate building the payment payload a client would send in X-PAYMENT.
 */
function demonstrateClientSide() {
  console.log("\n=== Client Side ===");

  // In real usage, the payer would come from a connected wallet.
  // Here we generate a throwaway keypair for demonstration only.
  const payerKeypair = Keypair.generate();
  const payerAddress = payerKeypair.publicKey.toBase58();
  console.log("Demo payer (throwaway):", payerAddress);

  // Show what the X-PAYMENT header payload looks like for an exact payment
  const demoTxSignature = "5Wx7xFakeSignatureForDemoOnly111111111111111111111111111";
  const paymentPayload = {
    x402Version: X402_VERSION,
    scheme: "exact",
    network: SOLANA_MAINNET,
    payload: {
      signature: demoTxSignature,
      payTo: "AgentPaymentAddress111111111111111111111111",
      amount: MINOR_UNITS,
      asset: USDC_MAINNET,
    },
  };

  const encodedHeader = Buffer.from(JSON.stringify(paymentPayload)).toString("base64");
  console.log("\nX-PAYMENT header value (base64):", encodedHeader.slice(0, 60) + "...");
  console.log("Decoded payload:", JSON.stringify(paymentPayload, null, 2));
}

// ─── 3. createX402Fetch factory ──────────────────────────────────────────────

/**
 * Show how to create a payment-aware fetch function.
 * (Does not make real network calls in this demo.)
 */
function demonstrateX402Fetch() {
  console.log("\n=== x402 Fetch Factory ===");

  const connection = new Connection(RPC_URL, "confirmed");

  // In production: use a real wallet
  const demoKeypair = Keypair.generate();

  const x402fetch = createX402Fetch({
    connection,
    payer: demoKeypair.publicKey.toBase58(),
    signTransaction: async (txBase64: string) => {
      // In production: use wallet.signTransaction
      console.log("  [demo] signTransaction called (not sending real tx)");
      return txBase64; // return unsigned for demo
    },
    sendTransaction: async (signedTxBase64: string) => {
      // In production: connection.sendRawTransaction(...)
      console.log("  [demo] sendTransaction called (not sending real tx)");
      return "DemoSignature111111111111111111111111111111";
    },
  });

  console.log("x402fetch created:", typeof x402fetch);
  console.log(
    "Usage: const res = await x402fetch('https://api.agent.example/chat', { method: 'POST', body: ... })"
  );

  return x402fetch;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("@nirholas/agent-payments-sdk — x402 payment example\n");
  console.log("RPC:", RPC_URL);
  console.log("Agent mint:", AGENT_MINT);
  console.log("Price:", `$${PRICE_USDC} USDC (${MINOR_UNITS} minor units)`);

  demonstrateServerSide();
  demonstrateClientSide();
  demonstrateX402Fetch();

  console.log("\n✔ Example completed. No real payments were made.");
  console.log("\nTo make real payments, integrate with a Solana wallet:");
  console.log("  const client = createX402Client({ connection, payer, signTransaction, sendTransaction });");
  console.log("  const res = await client.fetch('https://api.agent.example/chat', { method: 'POST', ... });");
}

main().catch(console.error);
```

---

## Step 7: Build and verify

### 7a. Build

```bash
cd /workspaces/agent-payments-sdk && npm run build 2>&1
```

Must exit 0 with no DTS errors.

### 7b. Verify exports from compiled output

```bash
node --input-type=module <<'EOF'
import('/workspaces/agent-payments-sdk/dist/solana/index.js').then(m => {
  const keys = Object.keys(m);
  console.log('solana/index exports:', keys.length, 'symbols');
  // Verify x402 exports are present
  const x402exports = ['createX402Fetch', 'PumpAgentFacilitator', 'buildPumpAgentRequirements', 'createResourceServer'];
  const missing = x402exports.filter(k => !keys.includes(k));
  if (missing.length) {
    console.error('MISSING x402 exports:', missing);
    process.exit(1);
  } else {
    console.log('✔ All x402 exports found');
  }
}).catch(e => { console.error('FAILED:', e.message); process.exit(1); });
EOF
```

```bash
node --input-type=module <<'EOF'
import('/workspaces/agent-payments-sdk/dist/x402/index.js').then(m => {
  const keys = Object.keys(m);
  console.log('x402/index exports:', keys);
  const required = ['createEvmX402Fetch', 'verifyEvmPayment'];
  const missing = required.filter(k => !keys.includes(k));
  if (missing.length) {
    console.error('MISSING EVM x402 exports:', missing);
    process.exit(1);
  } else {
    console.log('✔ All EVM x402 exports found');
  }
}).catch(e => { console.error('FAILED:', e.message); process.exit(1); });
EOF
```

### 7c. Check DTS files

```bash
grep -c 'createX402' /workspaces/agent-payments-sdk/dist/solana/index.d.ts && echo "x402 types present"
grep -c 'EvmX402' /workspaces/agent-payments-sdk/dist/x402/index.d.ts && echo "EVM x402 types present"
```

### 7d. Run tests

```bash
cd /workspaces/agent-payments-sdk && npm test 2>&1
```

All tests must pass.

---

## Constraints

- Do NOT change the existing `createX402Fetch` signature — it is a public API
- Do NOT remove any existing exports from the x402 index files
- The `createX402Client` and `createX402Facilitator` functions are NEW additions, not replacements
- The example file must not make real network calls (it's for documentation/development)
- All code must be TypeScript that compiles without errors

---

## Success criteria

```
✔ createX402Client exported from src/solana/x402/index.ts
✔ createX402Facilitator exported from src/solana/x402/index.ts
✔ Both appear in dist/solana/index.d.ts
✔ EVM x402 exports (createEvmX402Fetch, verifyEvmPayment) still accessible
✔ Example file at src/solana/examples/x402-payment-example.ts compiles
✔ npm run build exits 0
✔ npm test passes
```
