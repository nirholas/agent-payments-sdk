# claude-x402-agent

A Claude-powered AI agent that autonomously discovers x402-protected HTTP endpoints, decides whether to pay for them in USDC, executes payments on Solana mainnet, and returns structured results — all in a single conversational turn.

## How it works

Claude is given three tools:

| Tool | Description |
|---|---|
| `check_usdc_balance` | Reads the agent wallet's live USDC balance via RPC |
| `inspect_402` | Probes an endpoint for payment requirements without paying |
| `fetch_resource` | Fetches a URL, paying in USDC automatically if the server responds 402 |

The agent follows a strict protocol: check balance → inspect requirements → evaluate cost → fetch with payment. Prompt caching is enabled on the system prompt so repeated calls share a cached prefix.

## Setup

```bash
npm install
```

Set environment variables:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."
export SOLANA_RPC_URL="https://mainnet.helius-rpc.com/?api-key=..."
export SOLANA_PRIVATE_KEY="<base58-encoded-keypair or JSON-array>"
export MAX_PAYMENT_USDC="1.0"   # max USDC per fetch_resource call (default: 1.0)
```

`SOLANA_PRIVATE_KEY` accepts either a base58-encoded keypair string or a JSON number array (e.g., `[1,2,3,...]`).

## Usage

```bash
npm start "<user_request>"
```

### Examples

```bash
# Check your balance
npm start "How much USDC do I have?"

# Inspect payment requirements without paying
npm start "What are the payment requirements for https://example-x402-api.com/data?"

# Fetch a paid resource
npm start "Fetch https://example-x402-api.com/price and tell me the result"

# Multi-step: inspect then fetch
npm start "Check the cost of https://example-x402-api.com/report and fetch it if it's under 0.50 USDC"
```

## Output

Claude's final text response is printed to stdout. Tool calls are summarized below it:

```
The current price is $42,150. I paid 0.100000 USDC to access this data.
Transaction: https://solscan.io/tx/5xyz...

[tools used]
  check_usdc_balance → 5.230000 USDC
  inspect_402        → scheme=pump-agent amount=0.100000 USDC
  fetch_resource     → status=200 paid=0.100000 USDC sig=5xyz…
```

Diagnostic logs (model, iteration counts, cache stats) go to stderr.

## Prompt caching

The system prompt is marked with `cache_control: { type: "ephemeral" }`. On repeated calls the tools + system prefix is served from Anthropic's cache, reducing both latency and cost. Verify via the `cache_read` value in stderr logs:

```
[agent] iter=1 stop=tool_use in=312 out=89 cache_create=2541 cache_read=0
[agent] iter=1 stop=end_turn in=44  out=156 cache_create=0   cache_read=2541
```

## Payment safety

- `fetch_resource` probes the endpoint before paying and refuses if the amount exceeds `MAX_PAYMENT_USDC`
- Claude always calls `check_usdc_balance` before deciding to pay
- Every payment produces a Solana transaction signature for independent verification on Solscan
- The agent loop is capped at 10 iterations to prevent runaway execution

## Architecture

```
agent.ts        — CLI entry, Anthropic client, agentic loop, tool dispatch, output
tools.ts        — Tool definitions (JSON schemas) + handler implementations
```

The `fetch_resource` handler:
1. Probes the URL with a plain GET to read payment requirements
2. Compares the required amount against `MAX_PAYMENT_USDC`; returns an error without paying if exceeded
3. Creates a `createX402Fetch` instance with signing/sending callbacks that capture the transaction signature
4. Executes the actual request — `createX402Fetch` handles 402 detection, transaction building, submission, and retry
5. Returns `{ status, body, paymentMade: { signature, amountUsdc, scheme } | false }`
