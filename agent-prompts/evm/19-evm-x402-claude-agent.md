# Task: EVM USDC x402 Claude-Powered AI Agent

## Objective
Build a Claude-powered AI agent using the Anthropic SDK (with tool use and prompt caching) that autonomously discovers EVM x402-protected endpoints, evaluates payment requirements, executes USDC cross-chain bridge payments via `createEvmX402Fetch`, and delivers the paid response — across any of the 6 supported EVM chains.

## Context
`createEvmX402Fetch` from `src/x402/evm-client.ts` wraps fetch to handle `X-Payment-Required` headers, build bridge quotes and transactions, and retry with `X-Payment` proof. The agent's tools give Claude the ability to check balances, inspect 402 requirements, and authorize payments.

Claude model: `claude-sonnet-4-6`. Prompt caching via `cache_control: { type: "ephemeral" }` on the system prompt.

## Environment Variables
```
ANTHROPIC_API_KEY       Anthropic API key
EVM_PRIVATE_KEY         EVM private key
EVM_CHAIN_ID            Default chain (default: 8453 = Base)
EVM_RPC_URL             RPC for the default chain
MAX_PAYMENT_USDC        Hard ceiling per tool call (default: 5.0)
AGENT_MINT              Pump agent mint (used in bridge payment context)
```

## Requirements

### 1. Tool Definitions

#### `check_evm_balance`
```json
{
  "name": "check_evm_balance",
  "description": "Check USDC balance on one or all supported EVM chains. Returns balance in human-readable USDC.",
  "input_schema": {
    "type": "object",
    "properties": {
      "chainId": {
        "type": "number",
        "description": "Chain ID (1=Ethereum, 8453=Base, 42161=Arbitrum, 137=Polygon, 56=BSC, 43114=Avalanche). Omit to check all chains.",
        "enum": [1, 8453, 42161, 137, 56, 43114]
      }
    },
    "required": []
  }
}
```

#### `inspect_402`
```json
{
  "name": "inspect_402",
  "description": "Inspect the payment requirements of an HTTP 402 endpoint without paying. Returns the decoded X-Payment-Required payload.",
  "input_schema": {
    "type": "object",
    "properties": {
      "url": { "type": "string", "description": "URL to inspect" }
    },
    "required": ["url"]
  }
}
```

#### `fetch_resource`
```json
{
  "name": "fetch_resource",
  "description": "Fetch an HTTP resource. Automatically handles EVM x402 USDC payment if the server returns 402. Pays from the configured EVM chain using the bridge. Refuses if amount exceeds the configured maximum.",
  "input_schema": {
    "type": "object",
    "properties": {
      "url": { "type": "string" },
      "method": { "type": "string", "enum": ["GET", "POST"], "default": "GET" },
      "body": { "type": "string", "description": "JSON body for POST" },
      "chainId": {
        "type": "number",
        "description": "EVM chain to pay from. Omit to use default.",
        "enum": [1, 8453, 42161, 137, 56, 43114]
      }
    },
    "required": ["url"]
  }
}
```

#### `get_bridge_quote`
```json
{
  "name": "get_bridge_quote",
  "description": "Get a bridge quote for sending USDC from an EVM chain to a Solana agent. Returns fee estimate and net amount.",
  "input_schema": {
    "type": "object",
    "properties": {
      "fromChainId": { "type": "number", "enum": [1, 8453, 42161, 137, 56, 43114] },
      "amountUsdc": { "type": "string", "description": "Amount in decimal USDC, e.g. '1.5'" },
      "agentMint": { "type": "string" }
    },
    "required": ["fromChainId", "amountUsdc", "agentMint"]
  }
}
```

### 2. Tool Handlers

#### `check_evm_balance` handler
- If `chainId` provided: use `publicClient.readContract` for that chain's USDC.
- If omitted: check all 6 chains concurrently (same approach as task 18).
- Return `{ chainId, chainName, balanceUsdc, usdcAddress }[]`.

#### `inspect_402` handler
- Fetch the URL with plain `fetch`.
- If 402: decode `X-Payment-Required` header (`JSON.parse(atob(header))`).
- Return the decoded `EvmX402PaymentRequirements` object with human-readable `maxAmountUsdc`.
- If not 402: return `{ status: <N>, message: "Not an x402 endpoint" }`.

#### `fetch_resource` handler
- Before paying: `inspect_402` to check the price.
- If `maxAmountRequired / 1_000_000 > MAX_PAYMENT_USDC`: return `{ error: "Payment exceeds limit", required, limit }` — do NOT send the bridge tx.
- Create `createEvmX402Fetch` with the specified or default chain.
- Execute the request.
- Return `{ status, body, paymentMade: { txHash, chainId, amountUsdc } | false }`.

#### `get_bridge_quote` handler
- Call `getQuote({ fromChainId, fromToken: chain.usdc, fromAmount: BigInt(Math.round(parseFloat(amountUsdc) * 1_000_000)), agentMint })`.
- Return `{ quoteId, fromChainId, fromChainName, estimatedFeeUsdc, netAmountUsdc, expiresIn }`.

### 3. Agent Loop
Standard Anthropic tool-use loop with max 15 iterations:
```ts
const messages: MessageParam[] = [{ role: "user", content: userInput }];
for (let i = 0; i < 15; i++) {
  const resp = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2048,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    tools: TOOLS,
    messages,
  });
  if (resp.stop_reason === "end_turn") { /* print response */ break; }
  if (resp.stop_reason === "tool_use") {
    // execute each tool_use block, collect results, append to messages
  }
}
```

### 4. System Prompt
```
You are an autonomous EVM payment agent. You operate a wallet on Ethereum, Base, Arbitrum, Polygon, BSC, and Avalanche. You can fetch HTTP resources and automatically pay for them in USDC by bridging from any EVM chain to Solana when required.

Before making any payment: (1) check your USDC balance on the relevant chain, (2) inspect the 402 requirements to see the exact price, (3) confirm the price is within your limit. Never pay more than the configured maximum. Always report the transaction hash after paying. Always prefer Base (chain 8453) unless the user specifies otherwise.

If a resource is free (no 402), fetch it directly without checking balances first.
```

### 5. Output Format
Print Claude's final text. If tools were used, print a compact tool trace before the response:
```
[tools]
  check_evm_balance → Base: 8.250000 USDC, Arbitrum: 2.100000 USDC
  inspect_402       → scheme=pump-agent-evm amount=1.000000 USDC chain=Base
  fetch_resource    → paid 1.000000 USDC from Base tx=0xabc...
```

### 6. CLI
```
node agent.js "<prompt>"
node agent.js --chain=42161 "<prompt>"   Force a specific chain
```

### 7. Prompt Cache Metrics
After each API call, log `[cache] read=<N> write=<N>` tokens to stderr. Track and print cumulative cache savings at the end of the session.

## Deliverables
- `agent-prompts/evm/agents/claude-evm-agent/agent.ts`
- `agent-prompts/evm/agents/claude-evm-agent/tools.ts`
- `agent-prompts/evm/agents/claude-evm-agent/package.json`
- `agent-prompts/evm/agents/claude-evm-agent/README.md`

## Acceptance Criteria
- Agent checks USDC balance before any payment.
- `MAX_PAYMENT_USDC` enforcement works: refused without any EVM tx.
- A real x402 payment submits a real bridge transaction and Claude reports the tx hash.
- Prompt caching: `cache_read_input_tokens > 0` on second invocation (same session or repeated calls).
- Tool definitions are typed — no `any` in tool input handling.
- All 4 tools are callable from Claude's responses; no tool is declared but unimplemented.
