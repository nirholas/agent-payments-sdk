# Task 22 — Deploy AgentPayments.sol to Base mainnet

You are a senior smart contract deployment engineer. Complete this task end-to-end — write deployment scripts, deploy to Base mainnet, verify on Basescan, and update the SDK address file.

## Goal

Deploy AgentPayments.sol to Base mainnet (chainId 8453), verify it on Basescan, and update `/workspaces/agent-payments-sdk/src/evm/addresses.ts` with the deployed address.

## Files to read first

1. `/workspaces/agent-payments-sdk/contracts/src/AgentPayments.sol` — the contract to deploy
2. `/workspaces/agent-payments-sdk/contracts/hardhat.config.js` — network config
3. `/workspaces/agent-payments-sdk/src/evm/addresses.ts` — the `agentPayments: UNDEPLOYED` entry to update

## Prerequisites check

Before starting, verify:
1. `contracts/` directory exists with `hardhat.config.js` and `package.json`
2. `npx hardhat compile` passes successfully
3. `DEPLOYER_PRIVATE_KEY` env var is set (check `process.env.DEPLOYER_PRIVATE_KEY`)
4. `BASE_RPC_URL` env var is set or uses default `https://mainnet.base.org`

If `DEPLOYER_PRIVATE_KEY` is not set:
```
ERROR: DEPLOYER_PRIVATE_KEY environment variable is not set.

To deploy AgentPayments to Base mainnet:
  1. Export your deployer wallet private key (WITHOUT the 0x prefix is fine):
     export DEPLOYER_PRIVATE_KEY=0xYOUR_PRIVATE_KEY_HERE
  2. Ensure the deployer wallet has at least 0.01 ETH on Base mainnet for gas
  3. Re-run this script

WARNING: Never commit private keys to git.
```

## Script 1: `contracts/scripts/deploy.js`

```js
const { ethers, network, run } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
  // Safety check
  if (!process.env.DEPLOYER_PRIVATE_KEY) {
    console.error('ERROR: DEPLOYER_PRIVATE_KEY environment variable is not set.');
    console.error('Set it with: export DEPLOYER_PRIVATE_KEY=0x...');
    process.exit(1);
  }

  const networkName = network.name;
  const chainId = network.config.chainId;

  console.log(`\nDeploying AgentPayments to ${networkName} (chainId: ${chainId})`);
  console.log('='.repeat(60));

  const [deployer] = await ethers.getSigners();
  const deployerAddress = await deployer.getAddress();
  const balance = await ethers.provider.getBalance(deployerAddress);

  console.log(`Deployer: ${deployerAddress}`);
  console.log(`Balance:  ${ethers.formatEther(balance)} ETH`);

  if (balance < ethers.parseEther('0.001')) {
    console.error('ERROR: Deployer balance too low (< 0.001 ETH). Fund the deployer wallet and retry.');
    process.exit(1);
  }

  // Deploy
  console.log('\nDeploying contract...');
  const AgentPayments = await ethers.getContractFactory('AgentPayments');
  const contract = await AgentPayments.deploy();
  const deployTx = contract.deploymentTransaction();

  console.log(`Deploy tx hash: ${deployTx.hash}`);
  console.log('Waiting for deployment...');

  await contract.waitForDeployment();
  const contractAddress = await contract.getAddress();

  console.log(`Contract deployed at: ${contractAddress}`);

  // Wait for 5 confirmations
  console.log('Waiting for 5 confirmations...');
  await deployTx.wait(5);
  console.log('5 confirmations received.');

  const deployBlock = deployTx.blockNumber
    || (await ethers.provider.getTransactionReceipt(deployTx.hash)).blockNumber;

  // Save deployment info
  const deploymentsDir = path.join(__dirname, '../deployments');
  if (!fs.existsSync(deploymentsDir)) fs.mkdirSync(deploymentsDir, { recursive: true });

  const deploymentInfo = {
    contract: 'AgentPayments',
    address: contractAddress,
    deployTx: deployTx.hash,
    deployer: deployerAddress,
    chainId,
    network: networkName,
    blockNumber: deployBlock,
    timestamp: new Date().toISOString(),
    compiler: '0.8.24',
    optimizer: { enabled: true, runs: 200 },
  };

  const deploymentFile = path.join(deploymentsDir, `${networkName}.json`);
  fs.writeFileSync(deploymentFile, JSON.stringify(deploymentInfo, null, 2));
  console.log(`Deployment info saved to: ${deploymentFile}`);

  // Update SDK addresses file
  const addressesFile = path.join(__dirname, '../../../src/evm/addresses.ts');
  if (fs.existsSync(addressesFile)) {
    let content = fs.readFileSync(addressesFile, 'utf8');
    // Map network name to chainId
    const chainIdMap = {
      'base': 8453,
      'ethereum': 1,
      'arbitrum': 42161,
      'polygon': 137,
      'bsc': 56,
    };
    const targetChainId = chainIdMap[networkName] || chainId;
    // Replace the agentPayments: UNDEPLOYED (or existing address) for this chainId
    // Strategy: replace within the block for this chainId
    // The file has sections like: 8453: { ... agentPayments: "0x...", ... }
    // Use a regex to find and replace the agentPayments line for this chain
    const updated = updateAddressInFile(content, targetChainId, contractAddress);
    if (updated !== content) {
      fs.writeFileSync(addressesFile, updated);
      console.log(`Updated src/evm/addresses.ts with ${contractAddress} for chainId ${targetChainId}`);
    } else {
      console.warn('WARNING: Could not auto-update addresses.ts — update manually:');
      console.warn(`  EVM_CHAINS[${targetChainId}].agentPayments = "${contractAddress}"`);
    }
  }

  // Smoke test
  console.log('\nRunning smoke test...');
  const randomAddr = ethers.Wallet.createRandom().address;
  const [authority, bps, exists] = await contract.getAgentConfig(randomAddr);
  if (exists !== false) {
    console.error('SMOKE TEST FAILED: getAgentConfig should return exists=false for unknown address');
    process.exit(1);
  }
  console.log('Smoke test passed: getAgentConfig returns { exists: false } for unknown address.');

  console.log('\n' + '='.repeat(60));
  console.log('DEPLOYMENT COMPLETE');
  console.log(`Contract: ${contractAddress}`);
  console.log(`Explorer: https://basescan.org/address/${contractAddress}`);
  console.log('='.repeat(60) + '\n');

  return contractAddress;
}

/**
 * Update the agentPayments address for a specific chainId in addresses.ts.
 * Handles the pattern: agentPayments: UNDEPLOYED or agentPayments: "0x...",
 */
function updateAddressInFile(content, chainId, newAddress) {
  // Find the block for this chainId and replace the agentPayments line
  // This is a simple string replacement — assumes the file structure from addresses.ts
  const chainPattern = new RegExp(
    `(${chainId}:\\s*\\{[^}]*?agentPayments:\\s*)(?:UNDEPLOYED|"0x[0-9a-fA-F]+")`,
    's'
  );
  if (chainPattern.test(content)) {
    return content.replace(chainPattern, `$1"${newAddress}"`);
  }
  return content;
}

main().catch(err => {
  console.error('Deployment failed:', err);
  process.exit(1);
});
```

## Script 2: `contracts/scripts/verify.js`

```js
const { run, network } = require('hardhat');
const fs = require('fs');
const path = require('path');

async function main() {
  const networkName = network.name;
  const deploymentFile = path.join(__dirname, `../deployments/${networkName}.json`);

  if (!fs.existsSync(deploymentFile)) {
    console.error(`No deployment found for ${networkName}. Deploy first with: npx hardhat run scripts/deploy.js --network ${networkName}`);
    process.exit(1);
  }

  const deployment = JSON.parse(fs.readFileSync(deploymentFile, 'utf8'));
  const contractAddress = deployment.address;

  console.log(`Verifying AgentPayments at ${contractAddress} on ${networkName}...`);

  // Hardhat verify (Etherscan / Basescan)
  try {
    await run('verify:verify', {
      address: contractAddress,
      constructorArguments: [],
    });
    console.log('Verification successful!');
    console.log(`Verified at: ${getExplorerUrl(networkName, contractAddress)}`);
  } catch (err) {
    if (err.message.includes('Already Verified')) {
      console.log('Contract already verified.');
    } else {
      console.error('Hardhat verification failed:', err.message);
      // Try sourcify as fallback
      try {
        await run('verify:sourcify', { address: contractAddress });
        console.log('Sourcify verification succeeded as fallback.');
      } catch (sourcifyErr) {
        console.error('Sourcify also failed:', sourcifyErr.message);
        console.log('Manual verification steps:');
        console.log(`1. Go to ${getExplorerUrl(networkName, contractAddress)}`);
        console.log('2. Click "Contract" tab → "Verify and Publish"');
        console.log('3. Compiler: v0.8.24, Optimization: 200 runs');
      }
    }
  }
}

function getExplorerUrl(network, address) {
  const explorers = {
    base: `https://basescan.org/address/${address}`,
    ethereum: `https://etherscan.io/address/${address}`,
    arbitrum: `https://arbiscan.io/address/${address}`,
    polygon: `https://polygonscan.com/address/${address}`,
    bsc: `https://bscscan.com/address/${address}`,
  };
  return explorers[network] || `https://blockscan.com/address/${address}`;
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
```

## Deployment execution

```bash
cd /workspaces/agent-payments-sdk/contracts

# Ensure dependencies are installed
npm install

# Compile
npx hardhat compile

# Deploy to Base mainnet
export DEPLOYER_PRIVATE_KEY=<your-key>
npx hardhat run scripts/deploy.js --network base

# Verify on Basescan (requires BASESCAN_API_KEY)
export BASESCAN_API_KEY=<your-key>
npx hardhat run scripts/verify.js --network base
```

## After successful deployment

1. Confirm `/workspaces/agent-payments-sdk/src/evm/addresses.ts` has the new address for chainId 8453
2. Rebuild the SDK: `cd /workspaces/agent-payments-sdk && npm run build`
3. Confirm the build passes without TypeScript errors

## Smoke test details

The smoke test must:
1. Call `getAgentConfig(randomAddress)` — must return `{ exists: false }`
2. Confirm the contract is callable at the deployed address
3. If it fails, log the error and `process.exit(1)`

## Checklist

- [ ] Read `hardhat.config.js` and `addresses.ts` before writing scripts
- [ ] Create `contracts/scripts/deploy.js`
- [ ] Create `contracts/scripts/verify.js`
- [ ] Check for `DEPLOYER_PRIVATE_KEY` and error clearly if missing
- [ ] Deploy to Base mainnet
- [ ] Wait for 5 confirmations
- [ ] Save deployment JSON to `contracts/deployments/base.json`
- [ ] Update `src/evm/addresses.ts` with deployed address
- [ ] Run smoke test (getAgentConfig on random address)
- [ ] Rebuild SDK (`npm run build`)
- [ ] Run Basescan verification

## Do not

- Do not hardcode any private key
- Do not skip the confirmations wait
- Do not commit the `deployments/*.json` file
- Do not modify the contract after deployment (create a new version if changes are needed)
- Do not deploy to testnet as a substitute — deploy to Base mainnet (or error if no key)
