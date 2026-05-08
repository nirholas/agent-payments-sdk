# Task 19 — AgentPayments Solidity contract architecture

You are a senior Solidity/EVM engineer. Complete this task end-to-end in a single session — create all files, write complete content, verify the ABI matches exactly.

## Goal

Design and scaffold the AgentPayments Solidity contract architecture for `/workspaces/agent-payments-sdk/contracts/`. The contract must implement every function and event in the ABI at `/workspaces/agent-payments-sdk/src/evm/abi.ts`.

## Files to read first

1. `/workspaces/agent-payments-sdk/src/evm/abi.ts` — the complete ABI. Every function signature and event in this file is a contract requirement.
2. `/workspaces/agent-payments-sdk/src/evm/addresses.ts` — chain IDs and RPC URLs to use in hardhat config
3. `/workspaces/agent-payments-sdk/src/evm/EvmAgent.ts` — see how the SDK reads from the contract
4. `/workspaces/agent-payments-sdk/src/evm/EvmAgentOffline.ts` — see how unsigned transactions are built

## What to create

### 1. Directory structure

```
/workspaces/agent-payments-sdk/contracts/
├── src/
│   └── AgentPayments.sol         (Task 20)
├── test/
│   └── AgentPayments.test.js     (Task 21)
├── scripts/
│   ├── deploy.js                 (Task 22)
│   ├── deploy-all.js             (Task 23)
│   └── verify.js                 (Task 22)
├── deployments/
│   └── .gitkeep
├── ARCHITECTURE.md
├── hardhat.config.js
└── package.json
```

Create all directories and non-Solidity files in this task. The `.sol` files come in Task 20.

### 2. `ARCHITECTURE.md`

Write a complete architecture document covering:

**Storage layout**

```solidity
// Agent registration
struct AgentConfig {
    address authority;     // who can withdraw and update config
    uint16 buybackBps;     // percentage of payments to route to buyback (0-10000)
    bool exists;           // registration guard
}
mapping(address agentToken => AgentConfig) public agents;

// Per-(agentToken, currencyToken) vault accounting
struct VaultBalances {
    uint256 paymentVault;   // accumulated unpaid payments
    uint256 buybackVault;   // post-distribute, awaiting swap+burn
    uint256 withdrawVault;  // post-distribute, awaiting authority withdrawal
}
mapping(address agentToken => mapping(address currencyToken => VaultBalances)) public vaults;

// Per-(agentToken, currencyToken) lifetime stats
struct PaymentStats {
    uint256 totalPayments;
    uint256 totalBuybacks;
    uint256 totalWithdrawn;
    uint256 tokensBurned;
}
mapping(address agentToken => mapping(address currencyToken => PaymentStats)) public stats;

// Invoice deduplication
mapping(bytes32 invoiceId => bool) public invoicePaid;
```

**Invoice ID derivation**

```solidity
function _invoiceId(
    address agentToken,
    address currencyToken,
    uint256 amount,
    uint64 memo,
    int64 startTime,
    int64 endTime
) internal pure returns (bytes32) {
    return keccak256(abi.encodePacked(
        agentToken, currencyToken, amount, memo, startTime, endTime
    ));
}
```

**Security model**

- `onlyAgentAuthority(agentToken)` modifier: `require(agents[agentToken].authority == msg.sender)`
- `agentExists(agentToken)` modifier: `require(agents[agentToken].exists)`
- ReentrancyGuard on all state-modifying external functions (inherit OpenZeppelin's `ReentrancyGuard`)
- No `delegatecall`, no upgradeable proxy pattern — matches Solana program immutability
- ETH accounting: for `acceptPaymentNative`, use a per-agent-token ETH balance tracked in `vaults[agentToken][NATIVE_TOKEN]` where `NATIVE_TOKEN = address(0)` (or EIP-7528 sentinel)
- Integer overflow: Solidity 0.8+ checked arithmetic by default — no SafeMath needed
- No flash loan vectors: payments go to vault, not to sender
- Swap data in `buybackTrigger` is arbitrary calldata — trust the authority to set a safe router

**Upgrade strategy**

Not upgradeable. Deploy as a plain contract. Version the contract name (`AgentPaymentsV1`) so future versions can be deployed at new addresses and the SDK updated. Mirrors Solana program immutability.

**Chain deployment plan**

| Chain        | ChainId | Primary Use         |
|---|---|---|
| Base         | 8453    | Primary (low fees)  |
| Ethereum     | 1       | High-value agents   |
| Arbitrum One | 42161   | DeFi-native agents  |
| Polygon      | 137     | High-volume micropayments |
| BSC          | 56      | Asian market agents |

### 3. `hardhat.config.js`

```js
require('@nomicfoundation/hardhat-toolbox');
require('dotenv').config();

const accounts = process.env.DEPLOYER_PRIVATE_KEY
  ? [process.env.DEPLOYER_PRIVATE_KEY]
  : [];

module.exports = {
  solidity: {
    version: '0.8.24',
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: false,
    },
  },
  networks: {
    base: {
      url: process.env.BASE_RPC_URL || 'https://mainnet.base.org',
      chainId: 8453,
      accounts,
    },
    'base-sepolia': {
      url: process.env.BASE_SEPOLIA_RPC_URL || 'https://sepolia.base.org',
      chainId: 84532,
      accounts,
    },
    ethereum: {
      url: process.env.ETHEREUM_RPC_URL || 'https://eth.llamarpc.com',
      chainId: 1,
      accounts,
    },
    arbitrum: {
      url: process.env.ARBITRUM_RPC_URL || 'https://arb1.arbitrum.io/rpc',
      chainId: 42161,
      accounts,
    },
    polygon: {
      url: process.env.POLYGON_RPC_URL || 'https://polygon-rpc.com',
      chainId: 137,
      accounts,
    },
    bsc: {
      url: process.env.BSC_RPC_URL || 'https://bsc-dataseed.binance.org',
      chainId: 56,
      accounts,
    },
    localhost: {
      url: 'http://127.0.0.1:8545',
    },
  },
  etherscan: {
    apiKey: {
      base: process.env.BASESCAN_API_KEY || '',
      mainnet: process.env.ETHERSCAN_API_KEY || '',
      arbitrumOne: process.env.ARBISCAN_API_KEY || '',
      polygon: process.env.POLYGONSCAN_API_KEY || '',
      bsc: process.env.BSCSCAN_API_KEY || '',
    },
    customChains: [
      {
        network: 'base',
        chainId: 8453,
        urls: {
          apiURL: 'https://api.basescan.org/api',
          browserURL: 'https://basescan.org',
        },
      },
      {
        network: 'base-sepolia',
        chainId: 84532,
        urls: {
          apiURL: 'https://api-sepolia.basescan.org/api',
          browserURL: 'https://sepolia.basescan.org',
        },
      },
    ],
  },
};
```

### 4. `package.json`

```json
{
  "name": "@nirholas/agent-payments-contracts",
  "version": "1.0.0",
  "private": true,
  "description": "AgentPayments Solidity contracts for EVM deployment",
  "scripts": {
    "compile": "hardhat compile",
    "test": "hardhat test",
    "test:coverage": "hardhat coverage",
    "deploy:base": "hardhat run scripts/deploy.js --network base",
    "deploy:base-sepolia": "hardhat run scripts/deploy.js --network base-sepolia",
    "deploy:ethereum": "hardhat run scripts/deploy.js --network ethereum",
    "deploy:arbitrum": "hardhat run scripts/deploy.js --network arbitrum",
    "deploy:all": "node scripts/deploy-all.js",
    "verify:base": "hardhat run scripts/verify.js --network base",
    "clean": "hardhat clean"
  },
  "devDependencies": {
    "@nomicfoundation/hardhat-toolbox": "^5.0.0",
    "@openzeppelin/contracts": "^5.1.0",
    "dotenv": "^16.4.0",
    "hardhat": "^2.22.0"
  }
}
```

### 5. `deployments/.gitkeep`

Create an empty `.gitkeep` file. Deployment JSON files must NOT be committed — add to `.gitignore`.

Update `/workspaces/agent-payments-sdk/.gitignore` to include:
```
contracts/deployments/*.json
contracts/node_modules/
```

### 6. `.env.example` in contracts/

```
# Required for deployment
DEPLOYER_PRIVATE_KEY=0x...

# RPC URLs (fallback to public RPCs if not set)
BASE_RPC_URL=https://mainnet.base.org
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
ETHEREUM_RPC_URL=https://eth.llamarpc.com
ARBITRUM_RPC_URL=https://arb1.arbitrum.io/rpc
POLYGON_RPC_URL=https://polygon-rpc.com
BSC_RPC_URL=https://bsc-dataseed.binance.org

# Explorer API keys for contract verification
BASESCAN_API_KEY=
ETHERSCAN_API_KEY=
ARBISCAN_API_KEY=
POLYGONSCAN_API_KEY=
BSCSCAN_API_KEY=
```

## ABI crosscheck

Extract every function name from `/workspaces/agent-payments-sdk/src/evm/abi.ts` and verify the architecture doc accounts for each one. The complete list from the ABI is:

**Write functions** (must have full implementation):
- `createAgent(address agentToken, address agentAuthority, uint16 buybackBps)`
- `acceptPayment(address agentToken, address currencyToken, uint256 amount, uint64 memo, int64 startTime, int64 endTime) returns (bytes32 invoiceId)`
- `acceptPaymentNative(address agentToken, uint64 memo, int64 startTime, int64 endTime) returns (bytes32 invoiceId)`
- `distributePayments(address agentToken, address currencyToken)`
- `buybackTrigger(address agentToken, address currencyToken, address swapRouter, bytes swapData) returns (uint256 tokensBurned)`
- `withdraw(address agentToken, address currencyToken, address receiver) returns (uint256 amount)`
- `updateBuybackBps(address agentToken, uint16 buybackBps)`
- `updateAuthority(address agentToken, address newAuthority)`

**Read functions** (must return correct struct fields):
- `getAgentConfig(address agentToken) returns (address authority, uint16 buybackBps, bool exists)`
- `getBalances(address agentToken, address currencyToken) returns (uint256 paymentVault, uint256 buybackVault, uint256 withdrawVault)`
- `getPaymentStats(address agentToken, address currencyToken) returns (uint256 totalPayments, uint256 totalBuybacks, uint256 totalWithdrawn, uint256 tokensBurned)`
- `isInvoicePaid(bytes32 invoiceId) returns (bool)`

**Events** (must match exactly — indexed fields must match):
- `AgentCreated(address indexed agentToken, address indexed authority, uint16 buybackBps)`
- `PaymentAccepted(address indexed agentToken, address indexed payer, address currencyToken, uint256 amount, uint64 memo, bytes32 invoiceId)`
- `PaymentsDistributed(address indexed agentToken, address currencyToken, uint256 buybackAmount, uint256 withdrawAmount)`
- `BuybackTriggered(address indexed agentToken, address currencyToken, uint256 currencySpent, uint256 tokensBurned)`
- `Withdrawn(address indexed agentToken, address indexed authority, address currencyToken, uint256 amount, address receiver)`
- `AuthorityUpdated(address indexed agentToken, address oldAuthority, address newAuthority)`
- `BuybackBpsUpdated(address indexed agentToken, uint16 oldBps, uint16 newBps)`

## Installation

After creating `package.json`, install dependencies:

```bash
cd /workspaces/agent-payments-sdk/contracts
npm install
```

Verify `npx hardhat compile` succeeds (it will fail on missing `.sol` — that's fine for now, just verify hardhat loads correctly).

## Checklist

- [ ] Read `src/evm/abi.ts` in full before starting
- [ ] Create `/workspaces/agent-payments-sdk/contracts/` directory
- [ ] Create all subdirectories: `src/`, `test/`, `scripts/`, `deployments/`
- [ ] Write `ARCHITECTURE.md` with complete storage layout and security model
- [ ] Write `hardhat.config.js` with all 5 chains + testnets
- [ ] Write `package.json` with all dependencies
- [ ] Write `.env.example`
- [ ] Create `deployments/.gitkeep`
- [ ] Update root `.gitignore`
- [ ] Run `npm install` in contracts/
- [ ] Verify hardhat config loads without syntax errors

## Do not

- Do not write the Solidity contract yet (that is Task 20)
- Do not deploy anything
- Do not hardcode private keys anywhere
