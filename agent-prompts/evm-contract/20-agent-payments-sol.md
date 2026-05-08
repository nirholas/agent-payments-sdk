# Task 20 — Write AgentPayments.sol

You are a senior Solidity engineer. Complete this task end-to-end — write a complete, secure, production-quality Solidity contract that matches the ABI exactly, then compile it with hardhat to verify there are no errors.

## Goal

Create `/workspaces/agent-payments-sdk/contracts/src/AgentPayments.sol` — the complete implementation of the AgentPayments EVM contract.

## Files to read first

1. `/workspaces/agent-payments-sdk/src/evm/abi.ts` — REQUIRED: every function, event, and return type must match exactly
2. `/workspaces/agent-payments-sdk/agent-prompts/evm-contract/19-solidity-contract-architecture.md` — storage layout and design decisions
3. `/workspaces/agent-payments-sdk/contracts/hardhat.config.js` — Solidity version and optimizer settings
4. `/workspaces/agent-payments-sdk/contracts/package.json` — OpenZeppelin version

## Contract specification

### Header

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title AgentPayments
 * @notice On-chain payment collection, buyback, and revenue distribution for AI agents.
 *         Mirrors the Solana pump_agent_payments program interface.
 * @dev    Not upgradeable. Deploy at a fixed address. Use AgentPaymentsV2 for future versions.
 */
contract AgentPayments is ReentrancyGuard {
    using SafeERC20 for IERC20;
```

### Sentinel for native ETH payments

```solidity
/// @dev Sentinel address for native ETH (EIP-7528)
address public constant NATIVE_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
```

### Storage

```solidity
struct AgentConfig {
    address authority;
    uint16 buybackBps;
    bool exists;
}

struct VaultBalances {
    uint256 paymentVault;
    uint256 buybackVault;
    uint256 withdrawVault;
}

struct PaymentStats {
    uint256 totalPayments;
    uint256 totalBuybacks;
    uint256 totalWithdrawn;
    uint256 tokensBurned;
}

mapping(address => AgentConfig) public agents;
mapping(address => mapping(address => VaultBalances)) private _vaults;
mapping(address => mapping(address => PaymentStats)) private _stats;
mapping(bytes32 => bool) public invoicePaid;
```

### Events (must match ABI exactly — including indexed fields)

```solidity
event AgentCreated(address indexed agentToken, address indexed authority, uint16 buybackBps);
event PaymentAccepted(address indexed agentToken, address indexed payer, address currencyToken, uint256 amount, uint64 memo, bytes32 invoiceId);
event PaymentsDistributed(address indexed agentToken, address currencyToken, uint256 buybackAmount, uint256 withdrawAmount);
event BuybackTriggered(address indexed agentToken, address currencyToken, uint256 currencySpent, uint256 tokensBurned);
event Withdrawn(address indexed agentToken, address indexed authority, address currencyToken, uint256 amount, address receiver);
event AuthorityUpdated(address indexed agentToken, address oldAuthority, address newAuthority);
event BuybackBpsUpdated(address indexed agentToken, uint16 oldBps, uint16 newBps);
```

### Errors (custom errors for gas efficiency)

```solidity
error AgentAlreadyExists(address agentToken);
error AgentNotFound(address agentToken);
error NotAgentAuthority(address agentToken, address caller);
error InvoiceAlreadyPaid(bytes32 invoiceId);
error ZeroAddress();
error InvalidBps(uint16 bps);
error ZeroAmount();
error InsufficientVaultBalance(address agentToken, address currencyToken);
error TransferFailed();
error BuybackSwapFailed();
```

### Modifiers

```solidity
modifier onlyAgentAuthority(address agentToken) {
    if (agents[agentToken].authority != msg.sender) revert NotAgentAuthority(agentToken, msg.sender);
    _;
}

modifier agentExists(address agentToken) {
    if (!agents[agentToken].exists) revert AgentNotFound(agentToken);
    _;
}
```

### `createAgent`

```solidity
function createAgent(
    address agentToken,
    address agentAuthority,
    uint16 buybackBps
) external nonReentrant {
    if (agents[agentToken].exists) revert AgentAlreadyExists(agentToken);
    if (agentToken == address(0) || agentAuthority == address(0)) revert ZeroAddress();
    if (buybackBps > 10_000) revert InvalidBps(buybackBps);

    agents[agentToken] = AgentConfig({
        authority: agentAuthority,
        buybackBps: buybackBps,
        exists: true,
    });

    emit AgentCreated(agentToken, agentAuthority, buybackBps);
}
```

### `acceptPayment`

```solidity
function acceptPayment(
    address agentToken,
    address currencyToken,
    uint256 amount,
    uint64 memo,
    int64 startTime,
    int64 endTime
) external nonReentrant agentExists(agentToken) returns (bytes32 invoiceId) {
    if (amount == 0) revert ZeroAmount();

    invoiceId = _computeInvoiceId(agentToken, currencyToken, amount, memo, startTime, endTime);
    if (invoicePaid[invoiceId]) revert InvoiceAlreadyPaid(invoiceId);
    invoicePaid[invoiceId] = true;

    // Pull tokens from caller
    IERC20(currencyToken).safeTransferFrom(msg.sender, address(this), amount);

    _vaults[agentToken][currencyToken].paymentVault += amount;
    _stats[agentToken][currencyToken].totalPayments += amount;

    emit PaymentAccepted(agentToken, msg.sender, currencyToken, amount, memo, invoiceId);
}
```

### `acceptPaymentNative`

```solidity
function acceptPaymentNative(
    address agentToken,
    uint64 memo,
    int64 startTime,
    int64 endTime
) external payable nonReentrant agentExists(agentToken) returns (bytes32 invoiceId) {
    if (msg.value == 0) revert ZeroAmount();

    invoiceId = _computeInvoiceId(agentToken, NATIVE_TOKEN, msg.value, memo, startTime, endTime);
    if (invoicePaid[invoiceId]) revert InvoiceAlreadyPaid(invoiceId);
    invoicePaid[invoiceId] = true;

    _vaults[agentToken][NATIVE_TOKEN].paymentVault += msg.value;
    _stats[agentToken][NATIVE_TOKEN].totalPayments += msg.value;

    emit PaymentAccepted(agentToken, msg.sender, NATIVE_TOKEN, msg.value, memo, invoiceId);
}
```

### `distributePayments`

```solidity
function distributePayments(
    address agentToken,
    address currencyToken
) external nonReentrant agentExists(agentToken) {
    VaultBalances storage v = _vaults[agentToken][currencyToken];
    uint256 pending = v.paymentVault;
    if (pending == 0) return; // no-op

    AgentConfig storage cfg = agents[agentToken];
    uint256 buybackAmount = (pending * cfg.buybackBps) / 10_000;
    uint256 withdrawAmount = pending - buybackAmount;

    v.paymentVault = 0;
    v.buybackVault += buybackAmount;
    v.withdrawVault += withdrawAmount;

    _stats[agentToken][currencyToken].totalBuybacks += buybackAmount;

    emit PaymentsDistributed(agentToken, currencyToken, buybackAmount, withdrawAmount);
}
```

### `buybackTrigger`

```solidity
function buybackTrigger(
    address agentToken,
    address currencyToken,
    address swapRouter,
    bytes calldata swapData
) external nonReentrant agentExists(agentToken) onlyAgentAuthority(agentToken) returns (uint256 tokensBurned) {
    VaultBalances storage v = _vaults[agentToken][currencyToken];
    uint256 amount = v.buybackVault;
    if (amount == 0) revert ZeroAmount();
    v.buybackVault = 0;

    uint256 agentTokensBefore = IERC20(agentToken).balanceOf(address(this));

    if (currencyToken == NATIVE_TOKEN) {
        // Send ETH to router
        (bool ok,) = swapRouter.call{ value: amount }(swapData);
        if (!ok) revert BuybackSwapFailed();
    } else {
        // Approve router then call
        IERC20(currencyToken).safeIncreaseAllowance(swapRouter, amount);
        (bool ok,) = swapRouter.call(swapData);
        if (!ok) {
            // Reset allowance on failure
            IERC20(currencyToken).forceApprove(swapRouter, 0);
            revert BuybackSwapFailed();
        }
    }

    // Count received agent tokens
    uint256 agentTokensAfter = IERC20(agentToken).balanceOf(address(this));
    tokensBurned = agentTokensAfter - agentTokensBefore;

    if (tokensBurned > 0) {
        // Burn by sending to address(0) — or call burn() if the token supports it
        // Use safeTransfer to address(0) as a universal burn (some tokens reject this;
        // if the token has a burn function, the authority should include a burn() call in swapData)
        IERC20(agentToken).safeTransfer(address(0), tokensBurned);
    }

    _stats[agentToken][currencyToken].tokensBurned += tokensBurned;

    emit BuybackTriggered(agentToken, currencyToken, amount, tokensBurned);
}
```

**Note on burning**: Pump.fun tokens use Token-2022 on Solana which has a burn instruction. On EVM, the agent token is an ERC-20. The standard approach is to transfer to `address(0)`. If the specific ERC-20 reverts on transfer to zero address, the authority must encode a `burn(uint256)` call in `swapData` instead. Document this in ARCHITECTURE.md.

### `withdraw`

```solidity
function withdraw(
    address agentToken,
    address currencyToken,
    address receiver
) external nonReentrant agentExists(agentToken) onlyAgentAuthority(agentToken) returns (uint256 amount) {
    if (receiver == address(0)) revert ZeroAddress();
    VaultBalances storage v = _vaults[agentToken][currencyToken];
    amount = v.withdrawVault;
    if (amount == 0) revert InsufficientVaultBalance(agentToken, currencyToken);
    v.withdrawVault = 0;

    _stats[agentToken][currencyToken].totalWithdrawn += amount;

    if (currencyToken == NATIVE_TOKEN) {
        (bool ok,) = receiver.call{ value: amount }('');
        if (!ok) revert TransferFailed();
    } else {
        IERC20(currencyToken).safeTransfer(receiver, amount);
    }

    emit Withdrawn(agentToken, msg.sender, currencyToken, amount, receiver);
}
```

### `updateBuybackBps`

```solidity
function updateBuybackBps(
    address agentToken,
    uint16 buybackBps
) external agentExists(agentToken) onlyAgentAuthority(agentToken) {
    if (buybackBps > 10_000) revert InvalidBps(buybackBps);
    uint16 oldBps = agents[agentToken].buybackBps;
    agents[agentToken].buybackBps = buybackBps;
    emit BuybackBpsUpdated(agentToken, oldBps, buybackBps);
}
```

### `updateAuthority`

```solidity
function updateAuthority(
    address agentToken,
    address newAuthority
) external agentExists(agentToken) onlyAgentAuthority(agentToken) {
    if (newAuthority == address(0)) revert ZeroAddress();
    address oldAuthority = agents[agentToken].authority;
    agents[agentToken].authority = newAuthority;
    emit AuthorityUpdated(agentToken, oldAuthority, newAuthority);
}
```

### View functions

```solidity
function getAgentConfig(address agentToken) external view returns (
    address authority,
    uint16 buybackBps,
    bool exists
) {
    AgentConfig storage cfg = agents[agentToken];
    return (cfg.authority, cfg.buybackBps, cfg.exists);
}

function getBalances(address agentToken, address currencyToken) external view returns (
    uint256 paymentVault,
    uint256 buybackVault,
    uint256 withdrawVault
) {
    VaultBalances storage v = _vaults[agentToken][currencyToken];
    return (v.paymentVault, v.buybackVault, v.withdrawVault);
}

function getPaymentStats(address agentToken, address currencyToken) external view returns (
    uint256 totalPayments,
    uint256 totalBuybacks,
    uint256 totalWithdrawn,
    uint256 tokensBurned
) {
    PaymentStats storage s = _stats[agentToken][currencyToken];
    return (s.totalPayments, s.totalBuybacks, s.totalWithdrawn, s.tokensBurned);
}

function isInvoicePaid(bytes32 invoiceId_) external view returns (bool) {
    return invoicePaid[invoiceId_];
}
```

### Internal helpers

```solidity
function _computeInvoiceId(
    address agentToken,
    address currencyToken,
    uint256 amount,
    uint64 memo,
    int64 startTime,
    int64 endTime
) internal pure returns (bytes32) {
    return keccak256(abi.encodePacked(
        agentToken,
        currencyToken,
        amount,
        memo,
        startTime,
        endTime
    ));
}
```

## Compile and verify

After writing the contract:

```bash
cd /workspaces/agent-payments-sdk/contracts
npm install  # if not already done
npx hardhat compile
```

The compilation must succeed with **zero errors and zero warnings** (other than possible optimizer hints).

If there are errors:
- Fix each one before proceeding
- Common issues: import path for OZ, function signature mismatch, missing state variable

## ABI conformance check

After compiling, extract the ABI from `artifacts/src/AgentPayments.sol/AgentPayments.json` and compare function signatures against `src/evm/abi.ts`. They must match exactly:

```bash
node -e "
const artifact = require('./artifacts/src/AgentPayments.sol/AgentPayments.json');
const fns = artifact.abi.filter(x => x.type === 'function').map(x => x.name).sort();
console.log('Functions:', fns);
const events = artifact.abi.filter(x => x.type === 'event').map(x => x.name).sort();
console.log('Events:', events);
"
```

Expected functions: `acceptPayment, acceptPaymentNative, buybackTrigger, createAgent, distributePayments, getAgentConfig, getBalances, getPaymentStats, isInvoicePaid, updateAuthority, updateBuybackBps, withdraw`

Expected events: `AgentCreated, AuthorityUpdated, BuybackBpsUpdated, BuybackTriggered, PaymentAccepted, PaymentsDistributed, Withdrawn`

## Checklist

- [ ] Read `src/evm/abi.ts` in full before writing any Solidity
- [ ] Create `contracts/src/AgentPayments.sol`
- [ ] All 8 write functions implemented with correct signatures
- [ ] All 4 read functions implemented returning correct field names
- [ ] All 7 events match ABI (correct indexed fields)
- [ ] Custom errors defined for all failure modes
- [ ] `ReentrancyGuard` applied to all state-modifying functions
- [ ] `SafeERC20` used for all ERC-20 transfers
- [ ] `acceptPaymentNative` is `payable`
- [ ] Native ETH (NATIVE_TOKEN sentinel) handled in `withdraw` and `buybackTrigger`
- [ ] `distributePayments` is a no-op when `paymentVault == 0`
- [ ] `npx hardhat compile` passes with zero errors
- [ ] ABI conformance check passes

## Do not

- Do not use `tx.origin` — only `msg.sender`
- Do not use `block.timestamp` for invoice validity — the contract trusts the caller's `startTime`/`endTime` values (validation is off-chain)
- Do not implement an upgradeable proxy
- Do not use floating pragma — lock to `^0.8.24`
- Do not add any functions not in the ABI (except private/internal helpers)
- Do not use `transfer()` for ETH — always use `.call{value: ...}('')`
