<!-- agent-payments-sdk | Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas -->

# Task: Solana USDC x402 Claude-Powered AI Agent

## Objective
Build a Claude-powered AI agent (using the Anthropic SDK with tool use) that can autonomously discover x402-protected API endpoints, decide whether to pay for them in USDC, execute the payment via `createX402Fetch`, and return structured results to the user — all in a single conversational turn.

## Context
Claude's tool use API allows the model to call custom tools. We expose the x402-aware Solana fetch as a Claude tool, along with USDC balance checking. The agent uses `claude-sonnet-4-6` (the current model). Prompt caching is enabled on the system prompt to reduce cost.

The x402 machinery: `createX402Fetch` from `@nirholas/agent-payments-sdk/solana` automatically handles 402 responses with USDC on Solana mainnet.

## Environment Variables
```
ANTHROPIC_API_KEY       Anthropic API key
SOLANA_RPC_URL          Mainnet RPC
SOLANA_PRIVATE_KEY      Payer keypair (base58 or JSON array)
MAX_PAYMENT_USDC        Max USDC the agent is allowed to spend per tool call (default: 1.0)
```

## Requirements

### 1. Tool Definitions
Define the following tools for Claude:

#### `check_usdc_balance`
```json
{
  "name": "check_usdc_balance",
  "description": "Check the agent wallet's USDC balance on Solana mainnet",
  "input_schema": { "type": "object", "properties": {}, "required": [] }
}
```

#### `fetch_resource`
```json
{
  "name": "fetch_resource",
  "description": "Fetch a URL. If the server requires payment (HTTP 402), automatically pay in USDC up to the configured maximum and retry. Returns the response body and payment details if a payment was made.",
  "input_schema": {
    "type": "object",
    "properties": {
      "url": { "type": "string" },
      "method": { "type": "string", "enum": ["GET", "POST"], "default": "GET" },
      "body": { "type": "string", "description": "JSON string for POST body" }
    },
    "required": ["url"]
  }
}
```

#### `inspect_402`
```json
{
  "name": "inspect_402",
  "description": "Inspect the payment requirements of an HTTP 402 endpoint without paying",
  "input_schema": {
    "type": "object",
    "properties": { "url": { "type": "string" } },
    "required": ["url"]
  }
}
```

### 2. Tool Handlers

#### `check_usdc_balance` handler
- Use `connection.getTokenAccountBalance(usdcAta)` to get the live USDC balance.
- Return `{ balance: string, balanceUsdc: string, address: string }`.

#### `fetch_resource` handler
- Check if the amount required (from `inspect_402` first, then attempt) exceeds `MAX_PAYMENT_USDC`. If so, return `{ error: "Payment exceeds limit", required: "<X> USDC", limit: "<MAX> USDC" }` — do not pay.
- Use `createX402Fetch` to make the request.
- If response is 200: return `{ status: 200, body: <string>, paymentMade: false | { signature, amountUsdc, scheme } }`.
- If response is still 402 after payment attempt: return `{ status: 402, error: "Payment failed" }`.

#### `inspect_402` handler
- Fetch the URL with plain `fetch` (no payment).
- If 402: decode `PAYMENT-REQUIRED` header (base64 JSON), return the parsed `PaymentRequired` object.
- If not 402: return `{ status: <N>, message: "Not an x402 endpoint" }`.

### 3. Agent Loop
Implement the standard Anthropic tool-use agentic loop:
```ts
while (true) {
  const response = await client.messages.create({ ... tools, messages });
  if (response.stop_reason === "end_turn") break;
  if (response.stop_reason === "tool_use") {
    // execute tools, append results, continue loop
  }
}
```
Cap at 10 iterations to prevent infinite loops.

### 4. Prompt Caching
Use `cache_control: { type: "ephemeral" }` on the system prompt content block (the system prompt is > 1024 tokens). This reduces latency and cost on subsequent calls.

System prompt:
```
You are an autonomous payment agent operating on Solana mainnet. You can fetch HTTP resources and automatically pay for them in USDC when required. Before paying, always check your USDC balance. Never pay more than the configured maximum per request. When you make a payment, report the transaction signature so the user can verify it on Solscan. Always be transparent about costs.
```

### 5. CLI Interface
```
node agent.js "<user_request>"
```
Examples:
- `node agent.js "Fetch https://example-x402-api.com/price and tell me the result"`
- `node agent.js "What are the payment requirements for https://example-x402-api.com/data?"`
- `node agent.js "How much USDC do I have?"`

### 6. Output
Print Claude's final text response. If any tools were called, also print a structured summary:
```
[tools used]
  check_usdc_balance → 5.230000 USDC
  inspect_402        → scheme=pump-agent amount=1.000000 USDC
  fetch_resource     → status=200 paid=1.000000 USDC sig=<txSig>
```

### 7. Model Configuration
- Model: `claude-sonnet-4-6`
- Max tokens: 1024
- Temperature: not set (default)
- No streaming required

## Deliverables
- `agent-prompts/solana/agents/claude-x402-agent/agent.ts`
- `agent-prompts/solana/agents/claude-x402-agent/tools.ts` — tool definitions and handlers
- `agent-prompts/solana/agents/claude-x402-agent/package.json`
- `agent-prompts/solana/agents/claude-x402-agent/README.md`

## Acceptance Criteria
- The agent calls `check_usdc_balance` before deciding to pay.
- A request to a real x402 endpoint triggers a real USDC payment and Claude reports the transaction signature.
- A request exceeding `MAX_PAYMENT_USDC` is refused without any on-chain transaction.
- Prompt cache hit rate is > 0 on repeated calls (verifiable via API response `usage.cache_read_input_tokens`).
- No mock Anthropic SDK. Uses real `claude-sonnet-4-6` model.
