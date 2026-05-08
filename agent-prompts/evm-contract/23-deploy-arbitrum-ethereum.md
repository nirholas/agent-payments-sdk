# Task 23 — Deploy AgentPayments to Ethereum mainnet and Arbitrum One

You are a senior smart contract deployment engineer. Complete this task end-to-end — extend the deployment scripts to support multiple chains, deploy to Ethereum and Arbitrum, and update the SDK address file.

## Goal

Extend the deployment setup from Task 22 to support all 5 chains and deploy AgentPayments to Ethereum mainnet (chainId 1) and Arbitrum One (chainId 42161).

## Files to read first

1. `/workspaces/agent-payments-sdk/contracts/scripts/deploy.js` — existing deploy script from Task 22
2. `/workspaces/agent-payments-sdk/contracts/hardhat.config.js` — network config
3. `/workspaces/agent-payments-sdk/src/evm/addresses.ts` — all 5 chain entries to update
4. `/workspaces/agent-payments-sdk/.gitignore` — verify deployments are excluded

## Step 1 — Update `deploy.js` for multi-network

The existing `deploy.js` already reads `network.name` from hardhat. Ensure it handles all 5 networks without modification. Add gas price configuration for Ethereum mainnet (which can be expensive):

Add to `deploy.js` before contract deployment:

```js
// Optional gas price override for high-fee networks
let overrides = {};
if (networkName === 'ethereum') {
  const feeData = await ethers.provider.getFeeData();
  const maxFeePerGas = feeData.maxFeePerGas;
  if (maxFeePerGas) {
    // Add 10% buffer to avoid underpriced errors
    overrides.maxFeePerGas = maxFeePerGas * 110n / 100n;
    overrides.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
    console.log(`Gas price (Ethereum mainnet): ${ethers.formatUnits(overrides.maxFeePerGas, 'gwei')} gwei`);
  }
}
const contract = await AgentPayments.deploy(overrides);
```

## Step 2 — Update `hardhat.config.js` for all 5 chains

Verify `/workspaces/agent-payments-sdk/contracts/hardhat.config.js` has entries for all these networks:
- `base` (chainId 8453)
- `base-sepolia` (chainId 84532)
- `ethereum` (chainId 1)
- `arbitrum` (chainId 42161)
- `polygon` (chainId 137)
- `bsc` (chainId 56)

If any are missing, add them following the existing pattern.

## Step 3 — Create `contracts/scripts/deploy-all.js`

```js
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Deploy AgentPayments to all configured networks sequentially.
 * Skips networks that already have a deployment.
 * Updates src/evm/addresses.ts after each successful deploy.
 */

const NETWORKS = [
  { name: 'base',     chainId: 8453,  requiredEnv: 'DEPLOYER_PRIVATE_KEY' },
  { name: 'arbitrum', chainId: 42161, requiredEnv: 'DEPLOYER_PRIVATE_KEY' },
  { name: 'ethereum', chainId: 1,     requiredEnv: 'DEPLOYER_PRIVATE_KEY' },
  { name: 'polygon',  chainId: 137,   requiredEnv: 'DEPLOYER_PRIVATE_KEY' },
  { name: 'bsc',      chainId: 56,    requiredEnv: 'DEPLOYER_PRIVATE_KEY' },
];

async function main() {
  console.log('AgentPayments Multi-Chain Deploy');
  console.log('================================\n');

  // Validate required env vars
  if (!process.env.DEPLOYER_PRIVATE_KEY) {
    console.error('ERROR: DEPLOYER_PRIVATE_KEY is not set.');
    console.error('Usage: DEPLOYER_PRIVATE_KEY=0x... node scripts/deploy-all.js');
    process.exit(1);
  }

  const deploymentsDir = path.join(__dirname, '../deployments');
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });

  const results = [];

  for (const net of NETWORKS) {
    const deployFile = path.join(deploymentsDir, `${net.name}.json`);

    // Skip if already deployed
    if (fs.existsSync(deployFile)) {
      const existing = JSON.parse(fs.readFileSync(deployFile, 'utf8'));
      console.log(`[${net.name}] Already deployed at ${existing.address} — skipping.`);
      results.push({ network: net.name, address: existing.address, status: 'skipped' });
      continue;
    }

    console.log(`\n[${net.name}] Deploying...`);
    try {
      execSync(
        `npx hardhat run scripts/deploy.js --network ${net.name}`,
        { stdio: 'inherit', env: process.env }
      );

      // Read back the deployment result
      if (fs.existsSync(deployFile)) {
        const deployed = JSON.parse(fs.readFileSync(deployFile, 'utf8'));
        results.push({ network: net.name, address: deployed.address, status: 'deployed' });
        console.log(`[${net.name}] SUCCESS: ${deployed.address}`);
      } else {
        results.push({ network: net.name, address: null, status: 'failed' });
        console.error(`[${net.name}] FAILED: deployment file not created`);
      }
    } catch (err) {
      results.push({ network: net.name, address: null, status: 'error', error: err.message });
      console.error(`[${net.name}] ERROR: ${err.message}`);
      // Continue to next network instead of aborting
    }
  }

  // Summary
  console.log('\n\nDeployment Summary');
  console.log('==================');
  for (const r of results) {
    const icon = r.status === 'deployed' ? '✓' : r.status === 'skipped' ? '-' : '✗';
    console.log(`${icon} ${r.network.padEnd(12)} ${r.address || r.error || 'N/A'}`);
  }

  // Write combined deployment summary
  const summaryFile = path.join(deploymentsDir, 'summary.json');
  fs.writeFileSync(summaryFile, JSON.stringify({
    deployedAt: new Date().toISOString(),
    results,
  }, null, 2));
  console.log(`\nSummary written to: ${summaryFile}`);
}

main().catch(err => {
  console.error('deploy-all failed:', err);
  process.exit(1);
});
```

## Step 4 — Create `contracts/scripts/verify-all.js`

```js
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const NETWORKS = ['base', 'arbitrum', 'ethereum', 'polygon', 'bsc'];

async function main() {
  const deploymentsDir = path.join(__dirname, '../deployments');

  for (const net of NETWORKS) {
    const deployFile = path.join(deploymentsDir, `${net}.json`);
    if (!fs.existsSync(deployFile)) {
      console.log(`[${net}] No deployment found — skipping verification.`);
      continue;
    }
    const deployment = JSON.parse(fs.readFileSync(deployFile, 'utf8'));
    console.log(`\n[${net}] Verifying ${deployment.address}...`);
    try {
      execSync(
        `npx hardhat run scripts/verify.js --network ${net}`,
        { stdio: 'inherit', env: process.env }
      );
    } catch (err) {
      console.error(`[${net}] Verification failed: ${err.message}`);
    }
  }
}

main().catch(console.error);
```

## Step 5 — Create `contracts/scripts/check-deployments.js`

This script reads all deployment files and confirms each contract is live on its chain:

```js
const { ethers } = require('ethers');
const fs = require('fs');
const path = require('path');

const RPC_URLS = {
  base:     process.env.BASE_RPC_URL      || 'https://mainnet.base.org',
  ethereum: process.env.ETHEREUM_RPC_URL  || 'https://eth.llamarpc.com',
  arbitrum: process.env.ARBITRUM_RPC_URL  || 'https://arb1.arbitrum.io/rpc',
  polygon:  process.env.POLYGON_RPC_URL   || 'https://polygon-rpc.com',
  bsc:      process.env.BSC_RPC_URL       || 'https://bsc-dataseed.binance.org',
};

// Minimal ABI for smoke test
const ABI = [{
  name: 'getAgentConfig',
  type: 'function',
  stateMutability: 'view',
  inputs: [{ name: 'agentToken', type: 'address' }],
  outputs: [
    { name: 'authority', type: 'address' },
    { name: 'buybackBps', type: 'uint16' },
    { name: 'exists', type: 'bool' },
  ],
}];

async function main() {
  const deploymentsDir = path.join(__dirname, '../deployments');
  const files = fs.readdirSync(deploymentsDir).filter(f => f.endsWith('.json') && f !== 'summary.json');

  console.log('Checking deployments...\n');

  for (const file of files) {
    const networkName = file.replace('.json', '');
    const deployment = JSON.parse(fs.readFileSync(path.join(deploymentsDir, file), 'utf8'));
    const rpcUrl = RPC_URLS[networkName];

    if (!rpcUrl) {
      console.log(`[${networkName}] No RPC URL configured — skipping.`);
      continue;
    }

    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const contract = new ethers.Contract(deployment.address, ABI, provider);
      const randomAddr = ethers.Wallet.createRandom().address;
      const [,, exists] = await contract.getAgentConfig(randomAddr);

      if (exists !== false) {
        console.log(`[${networkName}] WARNING: getAgentConfig returned exists=true for random address — unexpected!`);
      } else {
        console.log(`[${networkName}] OK: ${deployment.address} is live and responding correctly.`);
      }
    } catch (err) {
      console.error(`[${networkName}] ERROR: ${err.message}`);
    }
  }
}

main().catch(console.error);
```

## Step 6 — `.gitignore` entries

Ensure `/workspaces/agent-payments-sdk/.gitignore` contains:

```
# EVM contract deployments (contain tx hashes — treat as sensitive)
contracts/deployments/*.json
contracts/node_modules/
```

## Step 7 — Deploy to Ethereum and Arbitrum

```bash
cd /workspaces/agent-payments-sdk/contracts

export DEPLOYER_PRIVATE_KEY=0x...

# Arbitrum One (lower gas than Ethereum — deploy first)
npx hardhat run scripts/deploy.js --network arbitrum

# Ethereum mainnet (most expensive — deploy last)
npx hardhat run scripts/deploy.js --network ethereum
```

After each deployment:
- Verify `contracts/deployments/{network}.json` was created
- Verify `src/evm/addresses.ts` was updated

## Step 8 — Run verification

```bash
# Optional: verify on explorers (requires API keys)
export ARBISCAN_API_KEY=...
npx hardhat run scripts/verify.js --network arbitrum

export ETHERSCAN_API_KEY=...
npx hardhat run scripts/verify.js --network ethereum
```

## Step 9 — Run check-deployments

```bash
node scripts/check-deployments.js
```

All deployed contracts must respond with `exists: false` for a random address.

## Step 10 — Rebuild SDK

```bash
cd /workspaces/agent-payments-sdk
npm run build
```

Must pass with zero TypeScript errors.

## Checklist

- [ ] Read `deploy.js` and `hardhat.config.js` before making changes
- [ ] Update `deploy.js` with Ethereum gas price override
- [ ] Verify `hardhat.config.js` has all 5 chains
- [ ] Create `contracts/scripts/deploy-all.js`
- [ ] Create `contracts/scripts/verify-all.js`
- [ ] Create `contracts/scripts/check-deployments.js`
- [ ] Update `.gitignore` with deployment exclusions
- [ ] Deploy to Arbitrum One
- [ ] Deploy to Ethereum mainnet
- [ ] `src/evm/addresses.ts` updated for chainIds 1 and 42161
- [ ] `check-deployments.js` shows all contracts live
- [ ] `npm run build` passes

## Do not

- Do not use the same nonce for multiple chains (hardhat handles this automatically)
- Do not deploy to Polygon or BSC in this task (reserved for later)
- Do not forget to save the deployment JSON files
- Do not commit private keys or deployment JSON files
- Do not force-deploy if a deployment file already exists (the deploy-all script skips them)
