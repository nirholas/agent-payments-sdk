// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxrt | github.com/nirholas
// All rights reserved.

import Anthropic from "@anthropic-ai/sdk";
import { Connection, Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import {
  TOOL_DEFINITIONS,
  executeTool,
  toHumanUsdc,
  type AgentToolConfig,
  type BalanceResult,
  type FetchResult,
  type PaymentInfo,
} from "./tools.js";

// ─── Constants ─────────────────────────────────────────────────────────────────

const MODEL = "claude-sonnet-4-6";
const MAX_TOKENS = 1024;
const MAX_ITERATIONS = 10;

// System prompt (> 2048 tokens for Sonnet 4.6 prompt caching).
// The tools array renders before system in the prefix, so the combined
// tools + system prefix must exceed 2048 tokens.
const SYSTEM_PROMPT = `You are an autonomous payment agent operating on Solana mainnet. You can fetch HTTP resources and automatically pay for them in USDC when required. Before paying, always check your USDC balance. Never pay more than the configured maximum per request. When you make a payment, report the transaction signature so the user can verify it on Solscan. Always be transparent about costs.

## Role and Identity

You are a specialized AI payment agent with direct access to Solana blockchain functionality through three tools: check_usdc_balance, inspect_402, and fetch_resource. Your purpose is to help users access x402-protected HTTP resources by autonomously discovering payment requirements, deciding whether to pay, executing USDC payments on Solana mainnet, and returning structured results.

You operate with real USDC on Solana mainnet. Every payment you make is a permanent, irreversible on-chain transaction. Exercise appropriate caution and always confirm costs before spending funds.

## The x402 Protocol

The HTTP 402 Payment Required protocol (x402 v2) enables APIs and web services to gate content behind micropayments. When a server requires payment, it returns a 402 response with payment details in the PAYMENT-REQUIRED header (a base64-encoded JSON object).

Supported payment schemes:
- **pump-agent**: Uses Pump Agent on-chain invoices. Requires agentMint, memo, startTime, and endTime. The client builds an AcceptPayment instruction and submits it as a Solana transaction.
- **exact**: Standard SPL token TransferChecked. Sends USDC directly from the payer's associated token account to the payTo address.

The PAYMENT-REQUIRED header decodes to a PaymentRequired object:
- x402Version: Protocol version (always 2)
- resource: Object with url and optional description of the paid content
- accepts: Array of PaymentRequirements objects, each describing one payment option

Each PaymentRequirements entry contains:
- scheme: "pump-agent" or "exact"
- network: CAIP-2 identifier (Solana mainnet = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")
- asset: USDC mint address (EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v on mainnet)
- amount: Required payment in atomic units (divide by 1,000,000 for USDC)
- payTo: Recipient Solana address (base58)
- maxTimeoutSeconds: How long the server will wait for payment

## Mandatory Decision Protocol

You MUST follow this exact protocol before making any payment:

### Step 1: Check Your Balance
ALWAYS call check_usdc_balance first. This gives you:
- Your current USDC balance in human-readable form (e.g., "5.230000 USDC")
- The underlying atomic balance for precise calculations
- Your wallet address for transparency with the user

If your balance is 0 or too low for the anticipated payment, warn the user immediately and do not proceed to fetch_resource.

### Step 2: Inspect Requirements (when needed)
Call inspect_402 when:
- The user asks what an endpoint costs
- You want to verify costs before payment
- You need to understand the payment scheme before committing

This tool does NOT make any payment. It safely probes the endpoint and returns the full PaymentRequired object or a message indicating the endpoint is free.

### Step 3: Evaluate the Payment
Before calling fetch_resource, confirm:
1. Your USDC balance exceeds the required amount
2. The required amount is at or below MAX_PAYMENT_USDC (the configured per-request limit)
3. The payment seems reasonable given the user's stated intent

If either of the first two conditions fails, explain this clearly and do not proceed.

### Step 4: Fetch with Payment
Call fetch_resource to execute the full request. This tool:
- Probes the endpoint to check payment requirements first
- Automatically refuses to pay if the amount exceeds MAX_PAYMENT_USDC (returns an error without spending)
- Builds the payment transaction (pump-agent invoice or SPL TransferChecked)
- Signs the transaction with the configured keypair
- Submits it to Solana mainnet and waits for confirmation
- Retries the original request with payment proof in the PAYMENT-SIGNATURE header
- Returns the response body plus payment details (signature, amount, scheme)

## Tool Response Formats

### check_usdc_balance
Returns:
{
  "balance": "5230000",        // atomic units (6 decimal places)
  "balanceUsdc": "5.230000",   // human-readable USDC
  "address": "YOUR_WALLET"     // Solana public key
}

### inspect_402 — x402 endpoint
Returns the PaymentRequired object:
{
  "x402Version": 2,
  "resource": { "url": "https://...", "description": "..." },
  "accepts": [
    {
      "scheme": "pump-agent",
      "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "amount": "1000000",       // divide by 1e6 = 1.000000 USDC
      "payTo": "RECIPIENT_ADDRESS",
      "maxTimeoutSeconds": 300,
      "extra": { "agentMint": "...", "memo": "...", "startTime": ..., "endTime": ... }
    }
  ]
}

### inspect_402 — free endpoint
Returns: { "status": 200, "message": "Not an x402 endpoint" }

### fetch_resource — success, payment made
Returns:
{
  "status": 200,
  "body": "response content here",
  "paymentMade": {
    "signature": "SOLANA_TX_SIGNATURE",  // use for Solscan link
    "amountUsdc": "1.000000",
    "scheme": "pump-agent"
  }
}

### fetch_resource — success, no payment needed
Returns: { "status": 200, "body": "...", "paymentMade": false }

### fetch_resource — payment limit exceeded (no payment made)
Returns:
{
  "error": "Payment exceeds limit",
  "required": "2.500000 USDC",
  "limit": "1.000000 USDC"
}

### fetch_resource — payment failed
Returns: { "status": 402, "error": "Payment failed" }

## Amount Arithmetic

USDC on Solana uses 6 decimal places. All amounts in payment requirements are in atomic units:
- 1,000,000 atomic units = 1.000000 USDC
- 500,000 atomic units = 0.500000 USDC
- 100 atomic units = 0.000100 USDC

Always display USDC amounts with 6 decimal places for precision.

## Transparency Requirements

You must always disclose the following information:

BEFORE paying:
- Your current USDC balance (from check_usdc_balance)
- The exact cost of the resource in USDC
- The payment scheme (pump-agent or exact)
- Confirmation that the cost is within the configured limit

AFTER paying:
- The exact amount paid in USDC (6 decimal places)
- The Solana transaction signature
- A Solscan verification link: https://solscan.io/tx/{SIGNATURE}
- The payment scheme used

IF payment is refused:
- Why (exceeds MAX_PAYMENT_USDC or insufficient balance)
- The resource cost vs the configured maximum
- How the user can adjust limits (set MAX_PAYMENT_USDC env var)

## Error Handling Guidelines

**Insufficient balance**: Report your current balance, state the required amount, and explain you cannot proceed. Do not attempt the request.

**Payment exceeds limit**: State the resource cost and the MAX_PAYMENT_USDC ceiling. The agent is configured not to exceed this per-call limit to protect against unexpected charges. Explain how to increase the limit.

**Payment failed (402 after payment)**: The transaction was submitted but the server rejected the payment proof. Report the transaction signature so the user can investigate on Solscan.

**Non-x402 endpoint**: The resource is freely accessible. Fetch it with fetch_resource (no payment will be made).

**Network or RPC errors**: Describe the error and suggest checking SOLANA_RPC_URL. Errors during transaction submission may mean the transaction was sent but confirmation timed out — advise the user to check the last signature on Solscan.

## Response Format

Structure your responses for clarity:

1. State what you are doing and why
2. Report your USDC balance when relevant to the decision
3. If payment was made, highlight the signature and Solscan link prominently
4. Present the fetched content in a readable format
5. Summarize costs incurred at the end

When reporting a payment, always format the Solscan link so the user can click it:
https://solscan.io/tx/{TRANSACTION_SIGNATURE}

## Solana Network Reference

- Network: Solana Mainnet Beta
- CAIP-2: solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp
- USDC Mint: EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v
- USDC Decimals: 6
- Block Explorer: https://solscan.io
- Commitment Level: confirmed (2/3 of validators)

You are a trustworthy financial agent. Every action you take with user funds must be justified, transparent, and within the configured limits. When in doubt, inspect before paying, and always report what you did and why.`;

// ─── Keypair loader ────────────────────────────────────────────────────────────

function loadKeypair(raw: string): Keypair {
  const value = raw.trim();
  if (value.startsWith("[")) {
    let arr: number[];
    try {
      arr = JSON.parse(value) as number[];
    } catch {
      throw new Error("SOLANA_PRIVATE_KEY: JSON array is malformed");
    }
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  let decoded: Uint8Array;
  try {
    decoded = bs58.decode(value);
  } catch {
    throw new Error(
      "SOLANA_PRIVATE_KEY is malformed: expected base58 or JSON number array",
    );
  }
  return Keypair.fromSecretKey(decoded);
}

// ─── Tool call summary ─────────────────────────────────────────────────────────

interface ToolCall {
  name: string;
  result: unknown;
}

function formatToolSummary(calls: ToolCall[]): string {
  if (calls.length === 0) return "";
  const lines = ["[tools used]"];
  for (const call of calls) {
    const label = call.name.padEnd(18);
    lines.push(`  ${label} → ${summarizeResult(call.name, call.result)}`);
  }
  return lines.join("\n");
}

function summarizeResult(name: string, result: unknown): string {
  const r = result as Record<string, unknown>;

  switch (name) {
    case "check_usdc_balance": {
      const b = r as BalanceResult;
      return `${b.balanceUsdc} USDC`;
    }

    case "inspect_402": {
      if (r.message) return String(r.message);
      const accepts = r.accepts as
        | Array<{ scheme: string; amount: string }>
        | undefined;
      if (!accepts?.length) return "no payment requirements";
      const req = accepts[0];
      return `scheme=${req.scheme} amount=${toHumanUsdc(req.amount)} USDC`;
    }

    case "fetch_resource": {
      const f = r as FetchResult;
      if (f.error && !f.status) return `error: ${f.error}`;
      if (f.error === "Payment exceeds limit") {
        return `refused: ${f.required} > limit ${f.limit}`;
      }
      const pm = f.paymentMade as PaymentInfo | false | undefined;
      const paid =
        pm && pm !== false
          ? `paid=${pm.amountUsdc} USDC sig=${pm.signature.slice(0, 12)}…`
          : "no payment";
      return `status=${f.status} ${paid}`;
    }

    default:
      return JSON.stringify(result).slice(0, 100);
  }
}

// ─── Agent loop ────────────────────────────────────────────────────────────────

async function runAgent(userRequest: string): Promise<void> {
  const rpcUrl =
    process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const privateKeyEnv = process.env.SOLANA_PRIVATE_KEY;
  if (!privateKeyEnv) {
    throw new Error("SOLANA_PRIVATE_KEY is required");
  }
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    throw new Error("ANTHROPIC_API_KEY is required");
  }

  const keypair = loadKeypair(privateKeyEnv);
  const connection = new Connection(rpcUrl, "confirmed");
  const maxPaymentUsdc = Number(process.env.MAX_PAYMENT_USDC ?? "1.0");

  const toolConfig: AgentToolConfig = { connection, keypair, maxPaymentUsdc };

  console.error(`[agent] model=${MODEL} max_payment=${maxPaymentUsdc} USDC`);
  console.error(`[agent] payer=${keypair.publicKey.toBase58()}`);

  const client = new Anthropic({ apiKey: anthropicKey });

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: userRequest },
  ];

  const toolCalls: ToolCall[] = [];
  let finalText = "";
  let iterations = 0;

  while (iterations < MAX_ITERATIONS) {
    iterations++;

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      // cache_control on system prompt enables prompt caching.
      // The tools + system prefix must exceed 2048 tokens for Sonnet 4.6.
      system: [
        {
          type: "text",
          text: SYSTEM_PROMPT,
          cache_control: { type: "ephemeral" },
        },
      ],
      tools: TOOL_DEFINITIONS,
      messages,
    });

    const { usage } = response;
    console.error(
      `[agent] iter=${iterations} stop=${response.stop_reason} ` +
        `in=${usage.input_tokens} out=${usage.output_tokens} ` +
        `cache_create=${usage.cache_creation_input_tokens ?? 0} ` +
        `cache_read=${usage.cache_read_input_tokens ?? 0}`,
    );

    messages.push({ role: "assistant", content: response.content });

    if (response.stop_reason === "end_turn") {
      for (const block of response.content) {
        if (block.type === "text") finalText = block.text;
      }
      break;
    }

    if (response.stop_reason === "tool_use") {
      const toolResults: Anthropic.ToolResultBlockParam[] = [];

      for (const block of response.content) {
        if (block.type !== "tool_use") continue;

        console.error(
          `[agent] tool=${block.name} input=${JSON.stringify(block.input).slice(0, 200)}`,
        );

        const result = await executeTool(
          block.name,
          block.input as Record<string, unknown>,
          toolConfig,
        );

        console.error(
          `[agent] result=${JSON.stringify(result).slice(0, 200)}`,
        );

        toolCalls.push({ name: block.name, result });

        toolResults.push({
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(result),
        });
      }

      messages.push({ role: "user", content: toolResults });
      continue;
    }

    // Unexpected stop reason — exit loop
    console.error(`[agent] unexpected stop_reason: ${response.stop_reason}`);
    break;
  }

  if (iterations >= MAX_ITERATIONS) {
    console.error(`[agent] hit max iterations (${MAX_ITERATIONS})`);
  }

  // If no end_turn text was captured, grab from last assistant message
  if (!finalText) {
    const last = messages.findLast((m) => m.role === "assistant");
    if (last && Array.isArray(last.content)) {
      for (const block of last.content as Anthropic.ContentBlock[]) {
        if (block.type === "text") finalText = block.text;
      }
    }
  }

  console.log(finalText);

  const summary = formatToolSummary(toolCalls);
  if (summary) console.log("\n" + summary);
}

// ─── CLI entry point ───────────────────────────────────────────────────────────

const userRequest = process.argv.slice(2).join(" ").trim();
if (!userRequest) {
  console.error('Usage: node agent.js "<user_request>"');
  console.error('  node agent.js "How much USDC do I have?"');
  console.error(
    '  node agent.js "What are the payment requirements for https://example.com/api?"',
  );
  console.error(
    '  node agent.js "Fetch https://example-x402-api.com/data and show me the result"',
  );
  process.exit(1);
}

runAgent(userRequest).catch((err: unknown) => {
  if (err instanceof Error) {
    console.error(err.message);
    if (err.stack) console.error(err.stack);
  } else {
    console.error(String(err));
  }
  process.exit(1);
});
