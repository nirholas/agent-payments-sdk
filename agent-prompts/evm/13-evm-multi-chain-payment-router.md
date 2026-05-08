# Task: EVM Multi-Chain USDC Payment Router

## Objective
Build a TypeScript service that accepts a USDC payment intent (destination Solana agent, amount), automatically selects the cheapest EVM source chain from among Ethereum, Base, Arbitrum, Polygon, BSC, and Avalanche based on current bridge fees, builds the approval + bridge transactions, and routes the payment through the optimal chain.

## Context
`getChain(chainId)` from `src/chains.ts` returns the config for each of the 6 supported EVM chains including their USDC contract addresses. `getQuote` from `src/evm/quote.ts` and `buildEvmPaymentTransaction` from `src/evm/transaction.ts` are the core primitives for building cross-chain payments.

## Environment Variables
```
EVM_PRIVATE_KEY        EVM private key (used for all 6 chains)
AGENT_MINT             Destination Solana agent mint
DEST_SOLANA_WALLET     Solana wallet to receive USDC
MEMO                   Payment memo / invoice ID
AMOUNT_USDC            Amount to send (decimal, e.g. "1.5")
```

For RPC endpoints per chain, read from:
```
RPC_URL_1              Ethereum RPC
RPC_URL_8453           Base RPC
RPC_URL_42161          Arbitrum RPC
RPC_URL_137            Polygon RPC
RPC_URL_56             BSC RPC
RPC_URL_43114          Avalanche RPC
```
Fall back to the public RPC from `src/chains.ts` if any env var is missing.

## Requirements

### 1. Balance Discovery
Implement `async getAllUsdcBalances(address: Address)`:
- For each of the 6 chains, create a `PublicClient` via viem.
- Call `readContract` with the standard ERC-20 `balanceOf(address)` function.
- Run all 6 calls concurrently with `Promise.allSettled`.
- Return `{ chainId, balance: bigint, balanceUsdc: string, hasEnough: boolean }[]` sorted by balance descending.
- Mark `hasEnough: true` if balance >= `amountUsdc * 1_000_000n`.

### 2. Quote Fetching
Implement `async getQuoteForChain(chainId, amountMinor: bigint)`:
- Call `getQuote({ fromChainId: chainId, fromToken: chain.usdc, fromAmount: amountMinor, agentMint })`.
- Return `{ chainId, quoteId, estimatedFeeUsdc: string, netAmountUsdc: string, quote }`.
- Catch errors per chain — if `getQuote` throws for a chain, mark it `unavailable`.

### 3. Optimal Chain Selection
Implement `selectOptimalChain(quotes, balances)`:
- Filter to chains where `hasEnough === true` AND quote is available.
- Among those, sort by `estimatedFeeUsdc` ascending (fewest fees = optimal).
- Return the top chain with its quote, or `null` if none qualify.
- Print a ranking table:
  ```
  Chain        Balance     Fee      Net       Available
  Base         12.50 USDC  0.02     1.48      ✓
  Arbitrum      8.00 USDC  0.03     1.47      ✓
  Ethereum      2.00 USDC  0.15     1.35      ✓
  Polygon       0.50 USDC  0.01     1.49      ✗ (insufficient balance)
  ```

### 4. Transaction Building
Implement `async buildPaymentTxs(chainId, quote, walletAddress)`:
- Call `buildEvmPaymentTransaction({ quote, agentMint, destinationSolanaWallet: DEST_SOLANA_WALLET, memo: MEMO, sender: walletAddress })`.
- Return `{ approval: TxParams | null, bridge: TxParams }`.

### 5. Transaction Execution
Implement `async executePayment(chainId, txs, walletClient)`:
- If `txs.approval`: send approval tx first, wait for receipt.
- Send bridge tx, wait for receipt.
- Log:
  ```
  [router] selected chain: Base (8453)
  [router] approval tx: <hash> (confirmed)
  [router] bridge tx:   <hash> (confirmed)
  [router] depositId:   <id>
  ```
- Return `{ approvalHash, bridgeHash, chainId, chainName }`.

### 6. Status Polling
Implement `async waitForSolanaArrival(depositId, timeoutMs = 120_000)`:
- Poll `PUMP_CROSSCHAIN_API/deposit?depositId=<id>` every 5 seconds.
- Return when `status === "arrived_on_solana"` or throw on timeout/failure.
- Print progress: `[status] depositId=<id> status=<status> elapsed=<s>s`.

### 7. CLI Interface
```
node router.js balances          Show USDC balances on all 6 chains
node router.js quotes            Show bridge quotes for all chains
node router.js pay               Execute optimal payment
node router.js pay --chain=8453  Force a specific chain
node router.js status <depositId> Poll a bridge deposit
```

### 8. Dry Run Mode
`node router.js pay --dry-run` — show which chain would be selected and estimated fees, but do not submit any transactions.

## Deliverables
- `agent-prompts/evm/agents/multi-chain-router/router.ts`
- `agent-prompts/evm/agents/multi-chain-router/chains.ts` — viem chain builders for all 6
- `agent-prompts/evm/agents/multi-chain-router/package.json`
- `agent-prompts/evm/agents/multi-chain-router/README.md`

## Acceptance Criteria
- `balances` command shows real USDC balances from all 6 chains concurrently.
- `quotes` command fetches real quotes from the bridge API for all available chains.
- `pay` selects the chain with lowest fee where balance is sufficient.
- `pay --chain=<id>` overrides selection and uses the specified chain.
- `--dry-run` prints the full analysis without submitting any transaction.
- No hardcoded chain configs — all data comes from `src/chains.ts` via `getChain`.
