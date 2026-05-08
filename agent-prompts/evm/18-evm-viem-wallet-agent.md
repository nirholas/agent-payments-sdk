# Task: EVM viem WalletClient Agent — USDC Approval, Transfer & Bridge

## Objective
Build a comprehensive TypeScript agent using **viem** that manages USDC on all 6 supported EVM chains: check balances, approve bridge contracts, send raw USDC transfers, and execute full bridge payments to Solana — all using a single private key that controls accounts on every chain.

## Context
`src/chains.ts` exports `EVM_CHAINS` with RPC URLs and USDC contract addresses for chains 1, 8453, 42161, 137, 56, and 43114. `getChain(chainId)` retrieves the config. viem provides chain-specific client factories and the standard ERC-20 ABI for USDC.

## Environment Variables
```
EVM_PRIVATE_KEY         Private key (hex, with 0x prefix)
RPC_URL_1               Ethereum mainnet RPC (optional, falls back to public)
RPC_URL_8453            Base RPC
RPC_URL_42161           Arbitrum RPC
RPC_URL_137             Polygon RPC
RPC_URL_56              BSC RPC
RPC_URL_43114           Avalanche RPC
```

## Requirements

### 1. Multi-Chain Client Factory
Implement `buildClients(chainId: SupportedEvmChainId)`:
- Import the correct viem chain from `viem/chains` for each ID:
  - 1 → `mainnet`, 8453 → `base`, 42161 → `arbitrum`, 137 → `polygon`, 56 → `bsc`, 43114 → `avalanche`
- Create `walletClient` using `createWalletClient({ account, chain, transport: http(rpcUrl) })`.
- Create `publicClient` using `createPublicClient({ chain, transport: http(rpcUrl) })`.
- Cache clients per chain ID — don't recreate on every call.

### 2. ERC-20 ABI
Define a minimal ERC-20 ABI as a const (no external package):
```ts
const erc20Abi = [
  { name: "balanceOf", type: "function", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }],
    outputs: [{ name: "", type: "uint256" }] },
  { name: "allowance", type: "function", stateMutability: "view",
    inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }],
    outputs: [{ name: "", type: "uint256" }] },
  { name: "approve", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "spender", type: "address" }, { name: "value", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }] },
  { name: "transfer", type: "function", stateMutability: "nonpayable",
    inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }],
    outputs: [{ name: "", type: "bool" }] },
  { name: "decimals", type: "function", stateMutability: "view",
    inputs: [], outputs: [{ name: "", type: "uint8" }] },
] as const;
```

### 3. Balance Operations

#### `async getUsdcBalance(chainId): Promise<{ raw: bigint, human: string }>`
- `readContract({ address: chain.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account.address] })`.
- Return raw bigint and human-readable string (6 decimals).

#### `async getAllBalances(): Promise<BalanceRow[]>`
- Run `getUsdcBalance` on all 6 chains concurrently.
- Return `{ chainId, chainName, usdcAddress, balance: { raw, human } }[]`.

### 4. Approval Operations

#### `async getUsdcAllowance(chainId, spender: Address): Promise<bigint>`
Uses `allowance(account.address, spender)`.

#### `async approveUsdc(chainId, spender: Address, amountMinor: bigint): Promise<Hash>`
- Check current allowance first. If `allowance >= amountMinor`: log "already approved, skipping" and return `"0x"` sentinel.
- If not: call `approve(spender, amountMinor)` via `walletClient.writeContract`.
- Wait for receipt. Verify new allowance.
- Return the tx hash.

### 5. USDC Transfer

#### `async transferUsdc(chainId, to: Address, amountMinor: bigint): Promise<Hash>`
- Check balance; if insufficient, throw `InsufficientUsdcError` with available + required amounts.
- Call `transfer(to, amountMinor)` via `walletClient.writeContract`.
- Wait for receipt.
- Return tx hash.

### 6. Native Balance Check

#### `async getNativeBalance(chainId): Promise<{ raw: bigint, human: string, symbol: string }>`
Uses `publicClient.getBalance({ address: account.address })`. The `symbol` comes from `chain.nativeCurrency.symbol`.

### 7. Bridge Payment (Integration)

#### `async bridgeToSolana(params): Promise<BridgeResult>`
```ts
params: {
  fromChainId: SupportedEvmChainId,
  amountMinor: bigint,
  agentMint: string,
  destinationSolanaWallet: string,
  memo: string,
}
```
- Fetch quote via `getQuote`.
- Build txs via `buildEvmPaymentTransaction`.
- Run `approveUsdc` if approval needed.
- Send bridge tx.
- Return `{ approvalHash, bridgeHash, quoteId, estimatedNetUsdc }`.

### 8. CLI Interface
```
node wallet.js balances                             All chain USDC balances
node wallet.js native                               All chain native balances
node wallet.js allowance <chainId> <spender>        USDC allowance
node wallet.js approve <chainId> <spender> <amount> Approve USDC
node wallet.js transfer <chainId> <to> <amount>     Transfer USDC
node wallet.js bridge <chainId> <agentMint> <solanaWallet> <amount> <memo>  Bridge to Solana
```
All `<amount>` params are decimal USDC strings (e.g., `"1.5"`). Convert internally.

### 9. Transaction Logging
After every on-chain transaction, print:
```
[tx] chain=Base (8453) fn=approve hash=0xabc... status=success gas=45231
```
Fetch the receipt to get actual gas used.

### 10. Error Classes
```ts
class InsufficientUsdcError extends Error {}
class UnsupportedChainError extends Error {}
class TransactionRevertedError extends Error { constructor(hash: string, reason?: string) }
```
Decode revert reasons from viem's `TransactionExecutionError` where available.

## Deliverables
- `agent-prompts/evm/agents/viem-wallet/wallet.ts`
- `agent-prompts/evm/agents/viem-wallet/erc20.ts` — ABI definition
- `agent-prompts/evm/agents/viem-wallet/errors.ts`
- `agent-prompts/evm/agents/viem-wallet/package.json`
- `agent-prompts/evm/agents/viem-wallet/README.md`

## Acceptance Criteria
- `balances` command shows live USDC balances from all 6 chains concurrently.
- `approve` skips if allowance is already sufficient.
- `transfer` rejects with `InsufficientUsdcError` before sending if balance is too low.
- `bridge` successfully submits a real bridge transaction and returns the tx hash.
- All viem clients use the typed `as const` ABI — no `any` casts.
- No hardcoded USDC addresses — always reads from `EVM_CHAINS[chainId].usdc`.
