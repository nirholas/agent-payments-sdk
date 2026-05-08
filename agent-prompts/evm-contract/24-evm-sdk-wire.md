# Task 24 — Wire deployed EVM addresses into the SDK and verify end-to-end

You are a senior TypeScript engineer. Complete this task end-to-end — sync deployed contract addresses into the SDK, write working code examples, rebuild, and confirm the EVM module works against deployed contracts.

## Goal

After EVM contract deployment (Tasks 22–23), wire the deployed addresses into `@nirholas/agent-payments-sdk` and create complete working examples for the three most important EVM flows.

## Files to read first

1. `/workspaces/agent-payments-sdk/src/evm/addresses.ts` — current state of addresses
2. `/workspaces/agent-payments-sdk/src/evm/EvmAgent.ts` — read-only on-chain queries
3. `/workspaces/agent-payments-sdk/src/evm/EvmAgentOffline.ts` — unsigned transaction building
4. `/workspaces/agent-payments-sdk/src/evm/types.ts` — EVM types
5. `/workspaces/agent-payments-sdk/src/evm/index.ts` — what's exported
6. `/workspaces/agent-payments-sdk/contracts/deployments/` — deployment JSON files (if they exist)
7. `/workspaces/agent-payments-sdk/package.json` — current version

## Script 1: `scripts/sync-evm-addresses.mjs`

This script reads deployment JSON files and updates `src/evm/addresses.ts`:

```js
#!/usr/bin/env node
// sync-evm-addresses.mjs
// Usage: node scripts/sync-evm-addresses.mjs

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const DEPLOYMENTS_DIR = path.join(ROOT, 'contracts/deployments');
const ADDRESSES_FILE = path.join(ROOT, 'src/evm/addresses.ts');

const CHAIN_IDS = {
  base:     8453,
  ethereum: 1,
  arbitrum: 42161,
  polygon:  137,
  bsc:      56,
};

async function main() {
  if (!existsSync(DEPLOYMENTS_DIR)) {
    console.log('No deployments directory found. Nothing to sync.');
    process.exit(0);
  }

  const files = readdirSync(DEPLOYMENTS_DIR)
    .filter(f => f.endsWith('.json') && f !== 'summary.json');

  if (files.length === 0) {
    console.log('No deployment files found. Deploy first.');
    process.exit(0);
  }

  let content = readFileSync(ADDRESSES_FILE, 'utf8');
  let updated = false;

  for (const file of files) {
    const networkName = file.replace('.json', '');
    const chainId = CHAIN_IDS[networkName];
    if (!chainId) {
      console.log(`[${networkName}] Unknown chain ID — skipping.`);
      continue;
    }

    const deployment = JSON.parse(readFileSync(path.join(DEPLOYMENTS_DIR, file), 'utf8'));
    const newAddress = deployment.address;

    // Replace agentPayments for this chainId
    const pattern = new RegExp(
      `(${chainId}:\\s*\\{[^}]*?agentPayments:\\s*)(?:UNDEPLOYED|"0x[0-9a-fA-F]+")`,
      's'
    );

    if (pattern.test(content)) {
      const newContent = content.replace(pattern, `$1"${newAddress}"`);
      if (newContent !== content) {
        content = newContent;
        updated = true;
        console.log(`[${networkName}] Updated chainId ${chainId}: ${newAddress}`);
      } else {
        console.log(`[${networkName}] Address already set to ${newAddress}`);
      }
    } else {
      console.warn(`[${networkName}] Could not find pattern for chainId ${chainId} in addresses.ts`);
    }
  }

  if (updated) {
    writeFileSync(ADDRESSES_FILE, content);
    console.log('\naddresses.ts updated. Running build to verify...');
    execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
    console.log('Build successful!');
  } else {
    console.log('No changes needed.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

## Example 1: `src/evm/examples/create-agent-base.ts`

Complete working example of the full agent lifecycle on Base mainnet. This is meant to be read and run by developers integrating the SDK.

```typescript
/**
 * create-agent-base.ts
 *
 * Complete example: connect to Base mainnet, create an agent,
 * accept a USDC payment, distribute it, and withdraw.
 *
 * Run with: npx tsx src/evm/examples/create-agent-base.ts
 * Requires: PRIVATE_KEY env var with a funded Base wallet
 */
import {
  createWalletClient,
  createPublicClient,
  http,
  parseUnits,
  formatUnits,
  type Address,
} from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { EVM_CHAINS } from '../addresses';
import { EvmAgentOffline } from '../EvmAgentOffline';
import { EvmAgent } from '../EvmAgent';
import { AGENT_PAYMENTS_ABI, ERC20_ABI } from '../abi';

// ── Config ────────────────────────────────────────────────────────────────────

const CHAIN_CONFIG = EVM_CHAINS[8453]; // Base mainnet
const USDC_BASE = CHAIN_CONFIG.usdc;   // 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
const CONTRACT = CHAIN_CONFIG.agentPayments;

// For this example, we use USDC as both the agent token (unusual in prod)
// and the currency token. In production, agentToken would be your pump.fun ERC-20 bridge.
// Here we just demonstrate the payment flow.
const EXAMPLE_AGENT_TOKEN = '0x0000000000000000000000000000000000000001' as Address; // placeholder

async function main() {
  if (!process.env.PRIVATE_KEY) {
    console.error('Set PRIVATE_KEY env var to a funded Base wallet.');
    process.exit(1);
  }

  // ── Setup clients ────────────────────────────────────────────────────────
  const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);

  const publicClient = createPublicClient({
    chain: base,
    transport: http(CHAIN_CONFIG.rpcUrl),
  });

  const walletClient = createWalletClient({
    chain: base,
    transport: http(CHAIN_CONFIG.rpcUrl),
    account,
  });

  console.log('Wallet:', account.address);
  const balance = await publicClient.getBalance({ address: account.address });
  console.log('ETH balance:', formatUnits(balance, 18), 'ETH');

  // ── Initialize SDK ────────────────────────────────────────────────────────
  const offline = new EvmAgentOffline(CHAIN_CONFIG);
  const agent = new EvmAgent(CHAIN_CONFIG);

  // ── Step 1: Check if agent already exists ────────────────────────────────
  const config = await agent.getAgentConfig(EXAMPLE_AGENT_TOKEN);
  console.log('\nAgent config before:', config);

  if (!config.exists) {
    console.log('\nStep 1: Creating agent...');
    // Build unsigned transaction
    const { to, data } = offline.buildCreateAgentTx(
      EXAMPLE_AGENT_TOKEN,
      account.address, // authority
      5000,            // 50% buyback BPS
    );

    const hash = await walletClient.sendTransaction({ to, data });
    console.log('createAgent tx:', hash);
    await publicClient.waitForTransactionReceipt({ hash });
    console.log('Agent created!');
  }

  // ── Step 2: Accept a USDC payment ────────────────────────────────────────
  console.log('\nStep 2: Checking USDC balance...');
  const usdcBalance = await publicClient.readContract({
    address: USDC_BASE,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    args: [account.address],
  });
  console.log('USDC balance:', formatUnits(usdcBalance as bigint, 6), 'USDC');

  const paymentAmount = parseUnits('1', 6); // 1 USDC

  if ((usdcBalance as bigint) >= paymentAmount) {
    // Approve first
    console.log('Approving USDC...');
    const approveHash = await walletClient.writeContract({
      address: USDC_BASE,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [CONTRACT, paymentAmount],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });

    // Accept payment
    const memo = BigInt(Date.now());
    const now = BigInt(Math.floor(Date.now() / 1000));
    const { to, data } = offline.buildAcceptPaymentTx(
      EXAMPLE_AGENT_TOKEN,
      USDC_BASE,
      paymentAmount,
      memo,
      now,
      now + 3600n, // 1 hour validity
    );
    const payHash = await walletClient.sendTransaction({ to, data });
    console.log('acceptPayment tx:', payHash);
    await publicClient.waitForTransactionReceipt({ hash: payHash });
    console.log('Payment accepted!');
  } else {
    console.log('Insufficient USDC balance — skipping payment step.');
  }

  // ── Step 3: Check balances ────────────────────────────────────────────────
  const balances = await agent.getBalances(EXAMPLE_AGENT_TOKEN, USDC_BASE);
  console.log('\nVault balances:');
  console.log('  paymentVault:', formatUnits(balances.paymentVault, 6), 'USDC');
  console.log('  buybackVault:', formatUnits(balances.buybackVault, 6), 'USDC');
  console.log('  withdrawVault:', formatUnits(balances.withdrawVault, 6), 'USDC');

  // ── Step 4: Distribute ────────────────────────────────────────────────────
  if (balances.paymentVault > 0n) {
    console.log('\nStep 3: Distributing payments...');
    const { to, data } = offline.buildDistributePaymentsTx(EXAMPLE_AGENT_TOKEN, USDC_BASE);
    const distHash = await walletClient.sendTransaction({ to, data });
    await publicClient.waitForTransactionReceipt({ hash: distHash });
    console.log('Distributed!');
  }

  // ── Step 5: Withdraw ─────────────────────────────────────────────────────
  const afterDist = await agent.getBalances(EXAMPLE_AGENT_TOKEN, USDC_BASE);
  if (afterDist.withdrawVault > 0n) {
    console.log('\nStep 4: Withdrawing to self...');
    const { to, data } = offline.buildWithdrawTx(EXAMPLE_AGENT_TOKEN, USDC_BASE, account.address);
    const wHash = await walletClient.sendTransaction({ to, data });
    await publicClient.waitForTransactionReceipt({ hash: wHash });
    console.log('Withdrawn!');
  }

  console.log('\nDone! Full flow complete.');
}

main().catch(console.error);
```

## Example 2: `src/evm/examples/accept-payment-example.ts`

Focused example showing the complete payment flow from a user's perspective:

```typescript
/**
 * accept-payment-example.ts
 *
 * Shows the complete acceptPayment flow from a user (payer) perspective.
 * 1. Check USDC allowance
 * 2. Approve if needed
 * 3. Accept payment (ERC-20)
 * 4. Accept native ETH payment
 *
 * Run: PRIVATE_KEY=0x... npx tsx src/evm/examples/accept-payment-example.ts
 */
import {
  createWalletClient,
  createPublicClient,
  http,
  parseUnits,
  parseEther,
  formatUnits,
  encodeAbiParameters,
  keccak256,
  type Address,
} from 'viem';
import { base } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { EVM_CHAINS } from '../addresses';
import { AGENT_PAYMENTS_ABI, ERC20_ABI } from '../abi';

const CHAIN = EVM_CHAINS[8453];
const CONTRACT_ADDRESS = CHAIN.agentPayments;
// Base USDC: https://basescan.org/token/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
const USDC = CHAIN.usdc as Address;

/**
 * Computes the invoice ID for deduplication checking.
 * Must match the Solidity: keccak256(abi.encodePacked(agentToken, currencyToken, amount, memo, startTime, endTime))
 */
function computeInvoiceId(
  agentToken: Address,
  currencyToken: Address,
  amount: bigint,
  memo: bigint,
  startTime: bigint,
  endTime: bigint,
): `0x${string}` {
  return keccak256(
    encodeAbiParameters(
      [
        { type: 'address' }, { type: 'address' }, { type: 'uint256' },
        { type: 'uint64' }, { type: 'int64' }, { type: 'int64' },
      ],
      [agentToken, currencyToken, amount, memo, startTime, endTime],
    ),
  );
}

async function main() {
  if (!process.env.PRIVATE_KEY) {
    throw new Error('PRIVATE_KEY required');
  }
  const account = privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`);
  const publicClient = createPublicClient({ chain: base, transport: http(CHAIN.rpcUrl) });
  const walletClient = createWalletClient({ chain: base, transport: http(CHAIN.rpcUrl), account });

  const AGENT_TOKEN = '0x0000000000000000000000000000000000000001' as Address; // replace with real agent token

  // ── USDC Payment Flow ─────────────────────────────────────────────────────
  console.log('=== USDC Payment Flow ===');

  const payAmount = parseUnits('0.01', 6); // 0.01 USDC (small test amount)
  const memo = BigInt(Math.floor(Math.random() * 1e15)); // unique memo
  const now = BigInt(Math.floor(Date.now() / 1000));
  const endTime = now + 3600n;

  // Check invoice hasn't been paid already
  const invoiceId = computeInvoiceId(AGENT_TOKEN, USDC, payAmount, memo, now, endTime);
  const alreadyPaid = await publicClient.readContract({
    address: CONTRACT_ADDRESS,
    abi: AGENT_PAYMENTS_ABI,
    functionName: 'isInvoicePaid',
    args: [invoiceId],
  });
  if (alreadyPaid) {
    console.log('Invoice already paid! Use a different memo.');
    return;
  }

  // Check current allowance
  const allowance = await publicClient.readContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: 'allowance',
    args: [account.address, CONTRACT_ADDRESS],
  }) as bigint;

  console.log('Current USDC allowance:', formatUnits(allowance, 6));

  if (allowance < payAmount) {
    console.log('Approving USDC...');
    const approveHash = await walletClient.writeContract({
      address: USDC,
      abi: ERC20_ABI,
      functionName: 'approve',
      args: [CONTRACT_ADDRESS, payAmount],
    });
    await publicClient.waitForTransactionReceipt({ hash: approveHash });
    console.log('Approved.');
  }

  // Send payment
  console.log(`Sending ${formatUnits(payAmount, 6)} USDC to agent ${AGENT_TOKEN}...`);
  const payHash = await walletClient.writeContract({
    address: CONTRACT_ADDRESS,
    abi: AGENT_PAYMENTS_ABI,
    functionName: 'acceptPayment',
    args: [AGENT_TOKEN, USDC, payAmount, memo, now, endTime],
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash: payHash });
  console.log('Payment tx:', receipt.transactionHash);
  console.log('Invoice ID:', invoiceId);

  // ── Native ETH Payment ────────────────────────────────────────────────────
  console.log('\n=== Native ETH Payment Flow ===');
  const ethAmount = parseEther('0.0001'); // 0.0001 ETH
  const ethMemo = BigInt(Math.floor(Math.random() * 1e15));
  const ethNow = BigInt(Math.floor(Date.now() / 1000));

  const ethHash = await walletClient.writeContract({
    address: CONTRACT_ADDRESS,
    abi: AGENT_PAYMENTS_ABI,
    functionName: 'acceptPaymentNative',
    args: [AGENT_TOKEN, ethMemo, ethNow, ethNow + 3600n],
    value: ethAmount,
  });
  const ethReceipt = await publicClient.waitForTransactionReceipt({ hash: ethHash });
  console.log('Native ETH payment tx:', ethReceipt.transactionHash);
  console.log('Paid:', formatUnits(ethAmount, 18), 'ETH');
}

main().catch(console.error);
```

## Step: Verify `EvmAgent.getAgentConfig`

After updating addresses, verify the deployed contract responds:

```bash
# Check that EvmAgent works against deployed contract
node -e "
const { EvmAgent } = require('./dist/evm/index.js');
const { EVM_CHAINS } = require('./dist/evm/addresses.js');
const agent = new EvmAgent(EVM_CHAINS[8453]);
const randomAddr = '0x' + '1'.repeat(40);
agent.getAgentConfig(randomAddr).then(r => {
  console.log('getAgentConfig result:', r);
  if (r.exists !== false) { console.error('ERROR: expected exists=false'); process.exit(1); }
  console.log('OK: Contract is live and responding.');
}).catch(e => { console.error('Failed:', e.message); process.exit(1); });
"
```

## Step: Version bump and rebuild

Update version in `/workspaces/agent-payments-sdk/package.json`:
- If current version is `0.2.0`, bump to `0.2.1`
- If current version is something else, bump the patch version

Then rebuild:
```bash
cd /workspaces/agent-payments-sdk
npm run build
```

Must pass with zero TypeScript errors.

## Checklist

- [ ] Read `EvmAgent.ts`, `EvmAgentOffline.ts`, and `addresses.ts` before starting
- [ ] Create `scripts/sync-evm-addresses.mjs`
- [ ] Run `node scripts/sync-evm-addresses.mjs` (no-op if no deployments yet)
- [ ] Create `src/evm/examples/create-agent-base.ts`
- [ ] Create `src/evm/examples/accept-payment-example.ts`
- [ ] Verify `invoiceId` computation in example matches Solidity `keccak256(abi.encodePacked(...))`
- [ ] Bump package.json version (patch)
- [ ] Run `npm run build` — zero TypeScript errors
- [ ] Run `EvmAgent.getAgentConfig` smoke test against deployed contract

## Do not

- Do not hardcode private keys in example files
- Do not import from `../../` — use the package's own exports
- Do not add new dependencies to the root `package.json` (viem is already there)
- Do not publish to npm in this task (that is separate)
