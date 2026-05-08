# Task 25 — Add EVM agent payment tools to three.ws chat

You are a senior JavaScript engineer. Complete this task end-to-end — add working browser-side EVM payment tools to the three.ws chat tool system. All tools use `window.ethereum` directly for maximum compatibility.

## Goal

Add four EVM payment tools to `/workspaces/three.ws/chat/src/tools.js` and export them as `evmPaymentsToolSchema`. The tools enable Base mainnet agent payments directly from the chat interface.

## Files to read first

1. `/workspaces/three.ws/chat/src/tools.js` — read in full:
   - How `pumpTradingToolSchema` is structured
   - How `agentPaymentsToolSchema` is structured
   - The `_pumpTx` helper pattern
   - Existing exports at the bottom of the file
2. `/workspaces/agent-payments-sdk/src/evm/abi.ts` — the ABI (copy the relevant function signatures into the tool bodies)
3. `/workspaces/agent-payments-sdk/src/evm/addresses.ts` — deployed contract address for Base (chainId 8453)

## Constants (embed in the tool file)

```js
const BASE_CHAIN_ID = 8453;
const BASE_CHAIN_ID_HEX = '0x' + (8453).toString(16); // '0x2105'
const BASE_RPC_URL = 'https://mainnet.base.org';
const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
// CONTRACT_ADDRESS is the deployed AgentPayments on Base — read from addresses.ts and embed here
// Replace UNDEPLOYED placeholder once Task 22 is complete.
const AGENT_PAYMENTS_BASE = '<DEPLOYED_ADDRESS_FROM_TASK_22>';
```

## Shared helpers (embed in tool bodies)

All four tools share the same EVM wallet connection pattern. Define a helper string that can be prepended:

```js
const _evmConnect = `
// Connect to MetaMask/injected wallet
if (!window.ethereum) throw new Error('No EVM wallet found. Install MetaMask to continue.');
const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
const userAddress = accounts[0];
if (!userAddress) throw new Error('No account selected');

// Switch to Base mainnet
const currentChainId = await window.ethereum.request({ method: 'eth_chainId' });
if (currentChainId !== '0x2105') {
  try {
    await window.ethereum.request({
      method: 'wallet_switchEthereumChain',
      params: [{ chainId: '0x2105' }],
    });
  } catch (switchErr) {
    if (switchErr.code === 4902) {
      await window.ethereum.request({
        method: 'wallet_addEthereumChain',
        params: [{
          chainId: '0x2105',
          chainName: 'Base',
          rpcUrls: ['https://mainnet.base.org'],
          nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
          blockExplorerUrls: ['https://basescan.org'],
        }],
      });
    } else {
      throw new Error('Failed to switch to Base: ' + switchErr.message);
    }
  }
}
`.trim();
```

### ABI encoding helper (minimal, no dependencies)

```js
const _evmAbi = `
// Minimal ABI encoder for function calls (no ethers/viem needed)
// Encodes: address, uint256, uint64, uint16, int64, bytes32, bool
function abiEncode(types, values) {
  // Use ethers.js from esm.sh for ABI encoding
  return null; // placeholder — see tool bodies below
}
`.trim();
```

Since encoding is complex without a library, import ethers from esm.sh in tool bodies:

```js
const importEthers = `const { ethers } = await import('https://esm.sh/ethers@6');`;
```

## Tool 1: `evmCreateAgent`

```js
{
  clientDefinition: {
    id: 'evm-create-agent-001',
    name: 'evmCreateAgent',
    description: 'Register an agent token on Base mainnet with the AgentPayments contract.',
    arguments: [
      { name: 'agentToken', type: 'string', description: 'ERC-20 token address on Base (0x...)' },
      { name: 'buybackBps', type: 'number', description: 'Buyback percentage in basis points (0-10000, default 5000)' },
    ],
    body: `
${_evmConnect}
const { ethers } = await import('https://esm.sh/ethers@6');
const agentToken = String(args.agentToken || '').trim();
if (!agentToken || !agentToken.startsWith('0x')) throw new Error('agentToken must be a valid 0x address');
const buybackBps = Math.min(10000, Math.max(0, Number(args.buybackBps ?? 5000)));

const CONTRACT = '<AGENT_PAYMENTS_BASE_ADDRESS>';
const iface = new ethers.Interface([
  'function createAgent(address agentToken, address agentAuthority, uint16 buybackBps)',
]);
const data = iface.encodeFunctionData('createAgent', [agentToken, userAddress, buybackBps]);

const txHash = await window.ethereum.request({
  method: 'eth_sendTransaction',
  params: [{ from: userAddress, to: CONTRACT, data, chainId: '0x2105' }],
});

// Wait for confirmation (poll receipt)
let receipt = null;
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 2000));
  receipt = await window.ethereum.request({ method: 'eth_getTransactionReceipt', params: [txHash] });
  if (receipt) break;
}
if (!receipt || receipt.status !== '0x1') throw new Error('Transaction failed or not confirmed: ' + txHash);

return {
  txHash,
  agentToken,
  authority: userAddress,
  buybackBps,
  explorer: 'https://basescan.org/tx/' + txHash,
  message: \`Agent created on Base! Token: \${agentToken} | Buyback: \${buybackBps} bps\`,
};`,
  },
  type: 'function',
  function: {
    name: 'evmCreateAgent',
    description: 'Register an ERC-20 token as an AI agent on Base mainnet AgentPayments contract. The connected wallet becomes the agent authority (can withdraw and update config). After creating, use evmAcceptPayment to accept payments.',
    parameters: {
      type: 'object',
      properties: {
        agentToken: { type: 'string', description: 'ERC-20 token contract address on Base (0x...)' },
        buybackBps: { type: 'integer', description: 'Buyback split in basis points (default 5000 = 50% to buyback, 50% to withdraw)' },
      },
      required: ['agentToken'],
    },
  },
}
```

## Tool 2: `evmAcceptPayment`

Handles both ERC-20 and native ETH payments. If `currencyToken` is `"native"` or the ETH sentinel, uses `acceptPaymentNative`.

```js
{
  clientDefinition: {
    id: 'evm-accept-payment-002',
    name: 'evmAcceptPayment',
    description: 'Pay an agent on Base. Handles ERC-20 approval + payment, or native ETH.',
    arguments: [
      { name: 'agentToken', type: 'string', description: 'Agent token address' },
      { name: 'currencyToken', type: 'string', description: 'Currency token address, or "native" for ETH' },
      { name: 'amount', type: 'string', description: 'Amount in human units (e.g. "1.5" for 1.5 USDC or 0.001 ETH)' },
      { name: 'memo', type: 'number', description: 'Invoice memo/ID number (optional, random if not provided)' },
    ],
    body: `
${_evmConnect}
const { ethers } = await import('https://esm.sh/ethers@6');

const CONTRACT = '<AGENT_PAYMENTS_BASE_ADDRESS>';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const NATIVE_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

const agentToken = String(args.agentToken || '').trim();
if (!agentToken || !agentToken.startsWith('0x')) throw new Error('agentToken required');

const currency = String(args.currencyToken || 'native').trim().toLowerCase();
const isNative = currency === 'native' || currency === NATIVE_SENTINEL.toLowerCase() || currency === '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

const memo = BigInt(args.memo || Math.floor(Math.random() * 1e15));
const now = BigInt(Math.floor(Date.now() / 1000));
const endTime = now + 3600n;

const iface = new ethers.Interface([
  'function acceptPayment(address agentToken, address currencyToken, uint256 amount, uint64 memo, int64 startTime, int64 endTime) returns (bytes32)',
  'function acceptPaymentNative(address agentToken, uint64 memo, int64 startTime, int64 endTime) returns (bytes32)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function decimals() view returns (uint8)',
]);

let txHash;

if (isNative) {
  const ethAmount = ethers.parseEther(String(args.amount || '0.001'));
  const data = iface.encodeFunctionData('acceptPaymentNative', [agentToken, memo, now, endTime]);
  txHash = await window.ethereum.request({
    method: 'eth_sendTransaction',
    params: [{ from: userAddress, to: CONTRACT, data, value: '0x' + ethAmount.toString(16), chainId: '0x2105' }],
  });
} else {
  // ERC-20 flow
  const currencyAddress = args.currencyToken;

  // Get decimals
  const provider = new ethers.BrowserProvider(window.ethereum);
  const tokenContract = new ethers.Contract(currencyAddress, ['function decimals() view returns (uint8)', 'function allowance(address,address) view returns (uint256)'], provider);
  const decimals = await tokenContract.decimals();
  const amount = ethers.parseUnits(String(args.amount || '1'), decimals);

  // Check and set allowance
  const currentAllowance = await tokenContract.allowance(userAddress, CONTRACT);
  if (currentAllowance < amount) {
    const approveData = iface.encodeFunctionData('approve', [CONTRACT, amount]);
    const approveTx = await window.ethereum.request({
      method: 'eth_sendTransaction',
      params: [{ from: userAddress, to: currencyAddress, data: approveData, chainId: '0x2105' }],
    });
    // Wait for approval
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const receipt = await window.ethereum.request({ method: 'eth_getTransactionReceipt', params: [approveTx] });
      if (receipt) break;
    }
  }

  // Send payment
  const data = iface.encodeFunctionData('acceptPayment', [agentToken, currencyAddress, amount, memo, now, endTime]);
  txHash = await window.ethereum.request({
    method: 'eth_sendTransaction',
    params: [{ from: userAddress, to: CONTRACT, data, chainId: '0x2105' }],
  });
}

// Wait for receipt
let receipt = null;
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 2000));
  receipt = await window.ethereum.request({ method: 'eth_getTransactionReceipt', params: [txHash] });
  if (receipt) break;
}
if (!receipt || receipt.status !== '0x1') throw new Error('Payment transaction failed: ' + txHash);

// Extract invoiceId from logs
const paySig = ethers.id('PaymentAccepted(address,address,address,uint256,uint64,bytes32)');
const payLog = (receipt.logs || []).find(l => l.topics?.[0] === paySig);
const invoiceId = payLog ? payLog.data?.slice(0, 66) : null; // first 32 bytes of non-indexed data

return {
  txHash,
  invoiceId,
  currency: isNative ? 'ETH' : args.currencyToken,
  amount: args.amount,
  memo: memo.toString(),
  explorer: 'https://basescan.org/tx/' + txHash,
};`,
  },
  type: 'function',
  function: {
    name: 'evmAcceptPayment',
    description: 'Send a payment to an agent on Base mainnet. Handles ERC-20 token approval automatically. Supports USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913) or native ETH. Returns invoice ID for deduplication.',
    parameters: {
      type: 'object',
      properties: {
        agentToken: { type: 'string', description: 'Agent token address on Base' },
        currencyToken: { type: 'string', description: 'Token address for payment, or "native" for ETH. Use USDC: 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' },
        amount: { type: 'string', description: 'Amount in human-readable units (e.g. "1.5" for 1.5 USDC, "0.001" for 0.001 ETH)' },
        memo: { type: 'number', description: 'Optional invoice memo number for deduplication' },
      },
      required: ['agentToken', 'currencyToken', 'amount'],
    },
  },
}
```

## Tool 3: `evmAgentBalances`

Read-only query — no wallet transaction needed, just an `eth_call`:

```js
{
  clientDefinition: {
    id: 'evm-agent-balances-003',
    name: 'evmAgentBalances',
    description: 'Read vault balances for an agent on Base mainnet.',
    arguments: [
      { name: 'agentToken', type: 'string', description: 'Agent token address' },
      { name: 'currencyToken', type: 'string', description: 'Currency token address, or "native" for ETH' },
    ],
    body: `
const { ethers } = await import('https://esm.sh/ethers@6');
const CONTRACT = '<AGENT_PAYMENTS_BASE_ADDRESS>';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const NATIVE_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

const agentToken = String(args.agentToken || '').trim();
const currency = String(args.currencyToken || USDC).trim();
const currencyToken = currency.toLowerCase() === 'native' ? NATIVE_SENTINEL : currency;

const provider = window.ethereum
  ? new ethers.BrowserProvider(window.ethereum)
  : new ethers.JsonRpcProvider('https://mainnet.base.org');

const iface = new ethers.Interface([
  'function getBalances(address agentToken, address currencyToken) view returns (uint256 paymentVault, uint256 buybackVault, uint256 withdrawVault)',
  'function getAgentConfig(address agentToken) view returns (address authority, uint16 buybackBps, bool exists)',
  'function getPaymentStats(address agentToken, address currencyToken) view returns (uint256 totalPayments, uint256 totalBuybacks, uint256 totalWithdrawn, uint256 tokensBurned)',
]);
const contract = new ethers.Contract(CONTRACT, iface, provider);

const [balances, config, stats] = await Promise.all([
  contract.getBalances(agentToken, currencyToken),
  contract.getAgentConfig(agentToken),
  contract.getPaymentStats(agentToken, currencyToken),
]);

// Format amounts (detect USDC 6 decimals vs ETH 18 decimals)
const decimals = currencyToken.toLowerCase() === NATIVE_SENTINEL.toLowerCase() ? 18 : 6;
const fmt = (v) => ethers.formatUnits(v, decimals);

if (!config.exists) {
  return { exists: false, message: \`No agent registered for \${agentToken} on Base.\` };
}

return {
  exists: true,
  authority: config.authority,
  buybackBps: Number(config.buybackBps),
  vaults: {
    paymentVault: fmt(balances.paymentVault),
    buybackVault: fmt(balances.buybackVault),
    withdrawVault: fmt(balances.withdrawVault),
  },
  stats: {
    totalPayments: fmt(stats.totalPayments),
    totalBuybacks: fmt(stats.totalBuybacks),
    totalWithdrawn: fmt(stats.totalWithdrawn),
    tokensBurned: ethers.formatEther(stats.tokensBurned),
  },
  currency: currencyToken,
  chain: 'base',
  explorer: \`https://basescan.org/address/\${agentToken}\`,
};`,
  },
  type: 'function',
  function: {
    name: 'evmAgentBalances',
    description: 'Read the payment, buyback, and withdraw vault balances for an agent on Base mainnet. No wallet required for this read-only call.',
    parameters: {
      type: 'object',
      properties: {
        agentToken: { type: 'string', description: 'Agent token address on Base' },
        currencyToken: { type: 'string', description: 'Currency token address, or "native" for ETH (default: USDC)' },
      },
      required: ['agentToken'],
    },
  },
}
```

## Tool 4: `evmWithdraw`

```js
{
  clientDefinition: {
    id: 'evm-withdraw-004',
    name: 'evmWithdraw',
    description: 'Withdraw funds from the withdraw vault on Base mainnet. Authority only.',
    arguments: [
      { name: 'agentToken', type: 'string', description: 'Agent token address' },
      { name: 'currencyToken', type: 'string', description: 'Currency token address, or "native" for ETH' },
      { name: 'receiver', type: 'string', description: 'Address to receive funds (default: connected wallet)' },
    ],
    body: `
${_evmConnect}
const { ethers } = await import('https://esm.sh/ethers@6');
const CONTRACT = '<AGENT_PAYMENTS_BASE_ADDRESS>';
const NATIVE_SENTINEL = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

const agentToken = String(args.agentToken || '').trim();
if (!agentToken || !agentToken.startsWith('0x')) throw new Error('agentToken required');

const currency = String(args.currencyToken || 'native').trim();
const currencyToken = currency.toLowerCase() === 'native' ? NATIVE_SENTINEL : currency;
const receiver = String(args.receiver || userAddress).trim();

const iface = new ethers.Interface([
  'function withdraw(address agentToken, address currencyToken, address receiver) returns (uint256)',
]);
const data = iface.encodeFunctionData('withdraw', [agentToken, currencyToken, receiver]);

const txHash = await window.ethereum.request({
  method: 'eth_sendTransaction',
  params: [{ from: userAddress, to: CONTRACT, data, chainId: '0x2105' }],
});

let receipt = null;
for (let i = 0; i < 30; i++) {
  await new Promise(r => setTimeout(r, 2000));
  receipt = await window.ethereum.request({ method: 'eth_getTransactionReceipt', params: [txHash] });
  if (receipt) break;
}
if (!receipt || receipt.status !== '0x1') throw new Error('Withdraw transaction failed: ' + txHash);

// Extract withdrawn amount from Withdrawn event log
const withdrawSig = ethers.id('Withdrawn(address,address,address,uint256,address)');
const log = (receipt.logs || []).find(l => l.topics?.[0] === withdrawSig);

return {
  txHash,
  agentToken,
  currencyToken,
  receiver,
  explorer: 'https://basescan.org/tx/' + txHash,
  message: \`Withdrawal submitted. Tx: \${txHash}\`,
};`,
  },
  type: 'function',
  function: {
    name: 'evmWithdraw',
    description: 'Withdraw accumulated funds from an agent\'s withdraw vault on Base mainnet. Must be called by the agent authority (wallet that created the agent). Sends funds to the specified receiver address.',
    parameters: {
      type: 'object',
      properties: {
        agentToken: { type: 'string', description: 'Agent token address on Base' },
        currencyToken: { type: 'string', description: 'Token to withdraw, or "native" for ETH' },
        receiver: { type: 'string', description: 'Receiver address (default: connected wallet)' },
      },
      required: ['agentToken', 'currencyToken'],
    },
  },
}
```

## Export

Add the complete `evmPaymentsToolSchema` export to the bottom of `tools.js`:

```js
export const evmPaymentsToolSchema = {
  name: 'EVM Agent Payments (Base)',
  schema: [
    // Tool 1: evmCreateAgent
    { clientDefinition: { ... }, type: 'function', function: { ... } },
    // Tool 2: evmAcceptPayment
    { clientDefinition: { ... }, type: 'function', function: { ... } },
    // Tool 3: evmAgentBalances
    { clientDefinition: { ... }, type: 'function', function: { ... } },
    // Tool 4: evmWithdraw
    { clientDefinition: { ... }, type: 'function', function: { ... } },
  ],
};
```

## Implementation notes

1. Replace `<AGENT_PAYMENTS_BASE_ADDRESS>` with the actual deployed address from Task 22 (`src/evm/addresses.ts` chainId 8453 entry). If it's still `UNDEPLOYED`, leave the placeholder and add a comment explaining it must be updated after Task 22.

2. The `_evmConnect` pattern is repeated in each tool body because tool bodies are executed as isolated strings — no shared scope.

3. USDC on Base has 6 decimals. Amounts formatted as 6-decimal strings are correct for USDC.

4. The `eth_getTransactionReceipt` polling loop (every 2s, 30 tries = 60s max) handles Base's ~2-second block time.

5. If `window.ethereum` is not available (no MetaMask), tools 1, 2, and 4 throw clearly. Tool 3 (`evmAgentBalances`) falls back to a public RPC read-only call since it doesn't require signing.

## Checklist

- [ ] Read `tools.js` in full before editing
- [ ] Read `abi.ts` for exact function signatures
- [ ] Get deployed Base address from `addresses.ts` (or mark as placeholder if undeployed)
- [ ] Add `evmCreateAgent` with MetaMask connect + chain switch + createAgent call
- [ ] Add `evmAcceptPayment` with ERC-20 approval + payment (or native ETH path)
- [ ] Add `evmAgentBalances` as read-only with fallback RPC
- [ ] Add `evmWithdraw` with authority check (contract enforces, not client)
- [ ] Export `evmPaymentsToolSchema` from the file
- [ ] All four tools have correct `type: 'function'` and `function:` definitions
- [ ] Tool IDs are unique: `evm-create-agent-001` through `evm-withdraw-004`
- [ ] No syntax errors in the JS (test-parse the file)

## Do not

- Do not use `window.solana` — these are EVM tools only
- Do not use ethers.js for the wallet connection itself — use `window.ethereum.request()` directly
- Do not add new npm dependencies to three.ws
- Do not modify existing tool schemas (Solana tools are untouched)
- Do not use TypeScript in tools.js — it's plain JavaScript
