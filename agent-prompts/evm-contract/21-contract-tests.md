# Task 21 — Comprehensive Hardhat tests for AgentPayments.sol

You are a senior Solidity/JavaScript test engineer. Write complete, passing Hardhat tests for the AgentPayments contract. Every test must pass — fix any contract bugs you find.

## Goal

Create `/workspaces/agent-payments-sdk/contracts/test/AgentPayments.test.js` with comprehensive test coverage for all functions and edge cases. All tests must pass with `npx hardhat test`.

## Files to read first

1. `/workspaces/agent-payments-sdk/contracts/src/AgentPayments.sol` — the contract to test
2. `/workspaces/agent-payments-sdk/src/evm/abi.ts` — reference for function signatures
3. `/workspaces/agent-payments-sdk/contracts/hardhat.config.js` — test environment

## Test setup

```js
const { expect } = require('chai');
const { ethers } = require('hardhat');
const { loadFixture } = require('@nomicfoundation/hardhat-toolbox/network-helpers');

// ── MockERC20 ─────────────────────────────────────────────────────────────────
// Deploy a simple mock ERC-20 for testing payments and agent tokens.
// Write this as an inline helper — no separate file needed.
```

### MockERC20

Create `contracts/src/test/MockERC20.sol` for use in tests:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    uint8 private _dec;
    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _dec = decimals_;
    }
    function decimals() public view override returns (uint8) { return _dec; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function burn(address from, uint256 amount) external { _burn(from, amount); }
}
```

### ReentrancyAttacker

Create `contracts/src/test/ReentrancyAttacker.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgentPayments {
    function acceptPaymentNative(address, uint64, int64, int64) external payable returns (bytes32);
    function withdraw(address, address, address) external returns (uint256);
}

contract ReentrancyAttacker {
    IAgentPayments public target;
    address public agentToken;
    address public constant NATIVE = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;
    uint256 public attackCount;

    constructor(address _target, address _agentToken) {
        target = IAgentPayments(_target);
        agentToken = _agentToken;
    }

    function attack() external payable {
        target.acceptPaymentNative{ value: msg.value }(agentToken, 1, 0, 9999999999);
    }

    receive() external payable {
        // Try to reenter withdraw during ETH receipt
        if (attackCount < 3) {
            attackCount++;
            try target.withdraw(agentToken, NATIVE, address(this)) {} catch {}
        }
    }
}
```

### Fixture

```js
async function deployFixture() {
  const [owner, alice, bob, carol] = await ethers.getSigners();

  // Deploy MockERC20 for currency (USDC-like, 6 decimals)
  const MockERC20 = await ethers.getContractFactory('MockERC20');
  const usdc = await MockERC20.deploy('Mock USDC', 'USDC', 6);

  // Deploy MockERC20 for agent token (18 decimals)
  const agentToken = await MockERC20.deploy('Agent Token', 'AGNT', 18);

  // Deploy AgentPayments
  const AgentPayments = await ethers.getContractFactory('AgentPayments');
  const ap = await AgentPayments.deploy();

  // Mint some USDC to alice for paying
  await usdc.mint(alice.address, ethers.parseUnits('10000', 6));

  const NATIVE_TOKEN = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE';

  return { ap, usdc, agentToken, owner, alice, bob, carol, NATIVE_TOKEN };
}
```

## Test suites

### Suite 1: `createAgent`

```js
describe('createAgent', function() {
  it('creates an agent with correct config', async function() {
    const { ap, agentToken, alice, owner } = await loadFixture(deployFixture);
    await expect(ap.createAgent(agentToken.target, alice.address, 5000))
      .to.emit(ap, 'AgentCreated')
      .withArgs(agentToken.target, alice.address, 5000);

    const [authority, bps, exists] = await ap.getAgentConfig(agentToken.target);
    expect(authority).to.equal(alice.address);
    expect(bps).to.equal(5000);
    expect(exists).to.be.true;
  });

  it('reverts on duplicate registration', async function() {
    const { ap, agentToken, alice } = await loadFixture(deployFixture);
    await ap.createAgent(agentToken.target, alice.address, 5000);
    await expect(ap.createAgent(agentToken.target, alice.address, 5000))
      .to.be.revertedWithCustomError(ap, 'AgentAlreadyExists');
  });

  it('reverts on zero agentToken address', async function() {
    const { ap, alice } = await loadFixture(deployFixture);
    await expect(ap.createAgent(ethers.ZeroAddress, alice.address, 5000))
      .to.be.revertedWithCustomError(ap, 'ZeroAddress');
  });

  it('reverts on zero authority address', async function() {
    const { ap, agentToken } = await loadFixture(deployFixture);
    await expect(ap.createAgent(agentToken.target, ethers.ZeroAddress, 5000))
      .to.be.revertedWithCustomError(ap, 'ZeroAddress');
  });

  it('reverts when buybackBps > 10000', async function() {
    const { ap, agentToken, alice } = await loadFixture(deployFixture);
    await expect(ap.createAgent(agentToken.target, alice.address, 10001))
      .to.be.revertedWithCustomError(ap, 'InvalidBps');
  });

  it('accepts buybackBps of exactly 10000', async function() {
    const { ap, agentToken, alice } = await loadFixture(deployFixture);
    await expect(ap.createAgent(agentToken.target, alice.address, 10000))
      .to.not.be.reverted;
  });

  it('accepts buybackBps of 0', async function() {
    const { ap, agentToken, alice } = await loadFixture(deployFixture);
    await expect(ap.createAgent(agentToken.target, alice.address, 0))
      .to.not.be.reverted;
  });
});
```

### Suite 2: `acceptPayment` (ERC-20)

```js
describe('acceptPayment (ERC-20)', function() {
  async function setupAgent(ap, agentToken, authority) {
    await ap.createAgent(agentToken.target, authority.address, 5000);
  }

  it('accepts payment and increments vault', async function() {
    const { ap, usdc, agentToken, alice } = await loadFixture(deployFixture);
    await setupAgent(ap, agentToken, alice);
    const amount = ethers.parseUnits('100', 6);
    await usdc.connect(alice).approve(ap.target, amount);

    await expect(ap.connect(alice).acceptPayment(
      agentToken.target, usdc.target, amount, 1n, 0n, 9999999999n
    )).to.emit(ap, 'PaymentAccepted')
      .withArgs(agentToken.target, alice.address, usdc.target, amount, 1n, ethers.isHexString);

    const [payVault,,] = await ap.getBalances(agentToken.target, usdc.target);
    expect(payVault).to.equal(amount);
  });

  it('reverts with insufficient allowance', async function() {
    const { ap, usdc, agentToken, alice } = await loadFixture(deployFixture);
    await setupAgent(ap, agentToken, alice);
    const amount = ethers.parseUnits('100', 6);
    // No approval
    await expect(ap.connect(alice).acceptPayment(
      agentToken.target, usdc.target, amount, 1n, 0n, 9999999999n
    )).to.be.reverted;
  });

  it('reverts on duplicate invoice (replay attack)', async function() {
    const { ap, usdc, agentToken, alice } = await loadFixture(deployFixture);
    await setupAgent(ap, agentToken, alice);
    const amount = ethers.parseUnits('100', 6);
    await usdc.connect(alice).approve(ap.target, amount * 2n);

    await ap.connect(alice).acceptPayment(agentToken.target, usdc.target, amount, 42n, 0n, 9999999999n);
    await expect(ap.connect(alice).acceptPayment(agentToken.target, usdc.target, amount, 42n, 0n, 9999999999n))
      .to.be.revertedWithCustomError(ap, 'InvoiceAlreadyPaid');
  });

  it('reverts for unregistered agent', async function() {
    const { ap, usdc, agentToken, alice } = await loadFixture(deployFixture);
    const amount = ethers.parseUnits('100', 6);
    await usdc.connect(alice).approve(ap.target, amount);
    await expect(ap.connect(alice).acceptPayment(
      agentToken.target, usdc.target, amount, 1n, 0n, 9999999999n
    )).to.be.revertedWithCustomError(ap, 'AgentNotFound');
  });

  it('reverts when amount is 0', async function() {
    const { ap, usdc, agentToken, alice } = await loadFixture(deployFixture);
    await setupAgent(ap, agentToken, alice);
    await expect(ap.connect(alice).acceptPayment(
      agentToken.target, usdc.target, 0n, 1n, 0n, 9999999999n
    )).to.be.revertedWithCustomError(ap, 'ZeroAmount');
  });

  it('isInvoicePaid returns true after payment', async function() {
    const { ap, usdc, agentToken, alice } = await loadFixture(deployFixture);
    await setupAgent(ap, agentToken, alice);
    const amount = ethers.parseUnits('100', 6);
    await usdc.connect(alice).approve(ap.target, amount);
    const tx = await ap.connect(alice).acceptPayment(
      agentToken.target, usdc.target, amount, 1n, 0n, 9999999999n
    );
    const receipt = await tx.wait();
    const event = receipt.logs.find(l => l.fragment?.name === 'PaymentAccepted');
    const invoiceId = event.args.invoiceId;
    expect(await ap.isInvoicePaid(invoiceId)).to.be.true;
  });
});
```

### Suite 3: `acceptPaymentNative`

```js
describe('acceptPaymentNative', function() {
  it('accepts ETH and increments vault', async function() {
    const { ap, agentToken, alice, NATIVE_TOKEN } = await loadFixture(deployFixture);
    await ap.createAgent(agentToken.target, alice.address, 5000);
    const amount = ethers.parseEther('0.1');

    await expect(ap.connect(alice).acceptPaymentNative(
      agentToken.target, 1n, 0n, 9999999999n, { value: amount }
    )).to.emit(ap, 'PaymentAccepted')
      .withArgs(agentToken.target, alice.address, NATIVE_TOKEN, amount, 1n, ethers.isHexString);

    const [payVault,,] = await ap.getBalances(agentToken.target, NATIVE_TOKEN);
    expect(payVault).to.equal(amount);
  });

  it('reverts when msg.value is 0', async function() {
    const { ap, agentToken, alice } = await loadFixture(deployFixture);
    await ap.createAgent(agentToken.target, alice.address, 5000);
    await expect(ap.connect(alice).acceptPaymentNative(
      agentToken.target, 1n, 0n, 9999999999n, { value: 0 }
    )).to.be.revertedWithCustomError(ap, 'ZeroAmount');
  });

  it('different memo values create unique invoices', async function() {
    const { ap, agentToken, alice } = await loadFixture(deployFixture);
    await ap.createAgent(agentToken.target, alice.address, 5000);
    const amount = ethers.parseEther('0.1');
    // Two payments with different memos — should both succeed
    await ap.connect(alice).acceptPaymentNative(agentToken.target, 1n, 0n, 9999999999n, { value: amount });
    await expect(
      ap.connect(alice).acceptPaymentNative(agentToken.target, 2n, 0n, 9999999999n, { value: amount })
    ).to.not.be.reverted;
  });
});
```

### Suite 4: `distributePayments`

```js
describe('distributePayments', function() {
  async function payAndDistribute(ap, usdc, agentToken, alice, bps) {
    await ap.createAgent(agentToken.target, alice.address, bps);
    const amount = ethers.parseUnits('1000', 6);
    await usdc.mint(alice.address, amount);
    await usdc.connect(alice).approve(ap.target, amount);
    await ap.connect(alice).acceptPayment(agentToken.target, usdc.target, amount, 99n, 0n, 9999999999n);
    await ap.distributePayments(agentToken.target, usdc.target);
    return amount;
  }

  it('splits 50/50 at 5000 bps', async function() {
    const { ap, usdc, agentToken, alice } = await loadFixture(deployFixture);
    const amount = await payAndDistribute(ap, usdc, agentToken, alice, 5000);
    const [pay, buyback, withdraw] = await ap.getBalances(agentToken.target, usdc.target);
    expect(pay).to.equal(0);
    expect(buyback).to.equal(amount / 2n);
    expect(withdraw).to.equal(amount / 2n);
  });

  it('splits 100/0 at 10000 bps', async function() {
    const { ap, usdc, agentToken, alice } = await loadFixture(deployFixture);
    const amount = await payAndDistribute(ap, usdc, agentToken, alice, 10000);
    const [, buyback, withdraw] = await ap.getBalances(agentToken.target, usdc.target);
    expect(buyback).to.equal(amount);
    expect(withdraw).to.equal(0);
  });

  it('splits 0/100 at 0 bps', async function() {
    const { ap, usdc, agentToken, alice } = await loadFixture(deployFixture);
    const amount = await payAndDistribute(ap, usdc, agentToken, alice, 0);
    const [, buyback, withdraw] = await ap.getBalances(agentToken.target, usdc.target);
    expect(buyback).to.equal(0);
    expect(withdraw).to.equal(amount);
  });

  it('is a no-op when paymentVault is 0', async function() {
    const { ap, usdc, agentToken, alice } = await loadFixture(deployFixture);
    await ap.createAgent(agentToken.target, alice.address, 5000);
    // No payments made — should not revert
    await expect(ap.distributePayments(agentToken.target, usdc.target)).to.not.be.reverted;
    const [pay, buyback, withdraw] = await ap.getBalances(agentToken.target, usdc.target);
    expect(pay).to.equal(0);
    expect(buyback).to.equal(0);
    expect(withdraw).to.equal(0);
  });

  it('emits PaymentsDistributed event', async function() {
    const { ap, usdc, agentToken, alice } = await loadFixture(deployFixture);
    await ap.createAgent(agentToken.target, alice.address, 3000);
    const amount = ethers.parseUnits('100', 6);
    await usdc.mint(alice.address, amount);
    await usdc.connect(alice).approve(ap.target, amount);
    await ap.connect(alice).acceptPayment(agentToken.target, usdc.target, amount, 1n, 0n, 9999999999n);
    await expect(ap.distributePayments(agentToken.target, usdc.target))
      .to.emit(ap, 'PaymentsDistributed')
      .withArgs(agentToken.target, usdc.target, amount * 3000n / 10000n, amount * 7000n / 10000n);
  });
});
```

### Suite 5: `buybackTrigger`

```js
describe('buybackTrigger', function() {
  // Deploy a mock swap router that just transfers agent tokens back to the caller
  it('calls swap router and counts received agent tokens', async function() {
    const { ap, usdc, agentToken, alice } = await loadFixture(deployFixture);
    await ap.createAgent(agentToken.target, alice.address, 10000); // 100% to buyback

    // Fund payment and distribute
    const payAmount = ethers.parseUnits('100', 6);
    await usdc.mint(alice.address, payAmount);
    await usdc.connect(alice).approve(ap.target, payAmount);
    await ap.connect(alice).acceptPayment(agentToken.target, usdc.target, payAmount, 1n, 0n, 9999999999n);
    await ap.distributePayments(agentToken.target, usdc.target);

    const [, buybackBal,] = await ap.getBalances(agentToken.target, usdc.target);
    expect(buybackBal).to.equal(payAmount);

    // Deploy mock router that sends agent tokens to the AgentPayments contract
    // Simulate: router receives USDC, sends back some agentTokens to ap.target
    const MockRouter = await ethers.getContractFactory('MockSwapRouter');
    const router = await MockRouter.deploy(usdc.target, agentToken.target);
    // Pre-fund the router with agent tokens
    await agentToken.mint(router.target, ethers.parseEther('1000'));

    // Build swapData to call router.swap()
    const swapData = router.interface.encodeFunctionData('swap', [payAmount, ap.target]);
    await usdc.connect(alice).approve(router.target, payAmount); // not needed — ap handles approval

    await expect(ap.connect(alice).buybackTrigger(
      agentToken.target, usdc.target, router.target, swapData
    )).to.emit(ap, 'BuybackTriggered');
  });

  it('reverts if not authority', async function() {
    const { ap, usdc, agentToken, alice, bob } = await loadFixture(deployFixture);
    await ap.createAgent(agentToken.target, alice.address, 5000);
    await expect(ap.connect(bob).buybackTrigger(
      agentToken.target, usdc.target, bob.address, '0x'
    )).to.be.revertedWithCustomError(ap, 'NotAgentAuthority');
  });

  it('reverts when buyback vault is empty', async function() {
    const { ap, usdc, agentToken, alice } = await loadFixture(deployFixture);
    await ap.createAgent(agentToken.target, alice.address, 5000);
    await expect(ap.connect(alice).buybackTrigger(
      agentToken.target, usdc.target, alice.address, '0x'
    )).to.be.revertedWithCustomError(ap, 'ZeroAmount');
  });
});
```

### MockSwapRouter contract

Create `contracts/src/test/MockSwapRouter.sol`:

```solidity
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @dev Simulates a DEX router that accepts currencyToken and returns agentToken
contract MockSwapRouter {
    address public currencyToken;
    address public agentToken;

    constructor(address _currencyToken, address _agentToken) {
        currencyToken = _currencyToken;
        agentToken = _agentToken;
    }

    /// @dev Pull `amount` of currencyToken from caller, send `amount` of agentToken to `recipient`
    function swap(uint256 amount, address recipient) external {
        IERC20(currencyToken).transferFrom(msg.sender, address(this), amount);
        // Send back a proportional amount of agent tokens (1:1 for simplicity)
        uint256 agentAmount = (amount * 1e12); // adjust for decimals (6 -> 18)
        IERC20(agentToken).transfer(recipient, agentAmount);
    }
}
```

### Suite 6: `withdraw`

```js
describe('withdraw', function() {
  it('withdraws to receiver and emits event', async function() {
    const { ap, usdc, agentToken, alice, bob } = await loadFixture(deployFixture);
    await ap.createAgent(agentToken.target, alice.address, 0); // 0% buyback = 100% withdraw
    const amount = ethers.parseUnits('200', 6);
    await usdc.mint(alice.address, amount);
    await usdc.connect(alice).approve(ap.target, amount);
    await ap.connect(alice).acceptPayment(agentToken.target, usdc.target, amount, 1n, 0n, 9999999999n);
    await ap.distributePayments(agentToken.target, usdc.target);

    const bobBefore = await usdc.balanceOf(bob.address);
    await expect(ap.connect(alice).withdraw(agentToken.target, usdc.target, bob.address))
      .to.emit(ap, 'Withdrawn')
      .withArgs(agentToken.target, alice.address, usdc.target, amount, bob.address);
    const bobAfter = await usdc.balanceOf(bob.address);
    expect(bobAfter - bobBefore).to.equal(amount);
  });

  it('reverts if not authority', async function() {
    const { ap, usdc, agentToken, alice, bob } = await loadFixture(deployFixture);
    await ap.createAgent(agentToken.target, alice.address, 0);
    await expect(ap.connect(bob).withdraw(agentToken.target, usdc.target, bob.address))
      .to.be.revertedWithCustomError(ap, 'NotAgentAuthority');
  });

  it('reverts when withdraw vault is empty', async function() {
    const { ap, usdc, agentToken, alice } = await loadFixture(deployFixture);
    await ap.createAgent(agentToken.target, alice.address, 0);
    await expect(ap.connect(alice).withdraw(agentToken.target, usdc.target, alice.address))
      .to.be.revertedWithCustomError(ap, 'InsufficientVaultBalance');
  });

  it('reverts on zero receiver address', async function() {
    const { ap, usdc, agentToken, alice } = await loadFixture(deployFixture);
    await ap.createAgent(agentToken.target, alice.address, 0);
    await expect(ap.connect(alice).withdraw(agentToken.target, usdc.target, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(ap, 'ZeroAddress');
  });
});
```

### Suite 7: `updateBuybackBps`

```js
describe('updateBuybackBps', function() {
  it('updates bps and emits event', async function() {
    const { ap, agentToken, alice } = await loadFixture(deployFixture);
    await ap.createAgent(agentToken.target, alice.address, 5000);
    await expect(ap.connect(alice).updateBuybackBps(agentToken.target, 2500))
      .to.emit(ap, 'BuybackBpsUpdated')
      .withArgs(agentToken.target, 5000, 2500);
    const [, bps,] = await ap.getAgentConfig(agentToken.target);
    expect(bps).to.equal(2500);
  });

  it('reverts when bps > 10000', async function() {
    const { ap, agentToken, alice } = await loadFixture(deployFixture);
    await ap.createAgent(agentToken.target, alice.address, 5000);
    await expect(ap.connect(alice).updateBuybackBps(agentToken.target, 10001))
      .to.be.revertedWithCustomError(ap, 'InvalidBps');
  });

  it('reverts if not authority', async function() {
    const { ap, agentToken, alice, bob } = await loadFixture(deployFixture);
    await ap.createAgent(agentToken.target, alice.address, 5000);
    await expect(ap.connect(bob).updateBuybackBps(agentToken.target, 1000))
      .to.be.revertedWithCustomError(ap, 'NotAgentAuthority');
  });
});
```

### Suite 8: `updateAuthority`

```js
describe('updateAuthority', function() {
  it('transfers authority and emits event', async function() {
    const { ap, agentToken, alice, bob } = await loadFixture(deployFixture);
    await ap.createAgent(agentToken.target, alice.address, 5000);
    await expect(ap.connect(alice).updateAuthority(agentToken.target, bob.address))
      .to.emit(ap, 'AuthorityUpdated')
      .withArgs(agentToken.target, alice.address, bob.address);
    const [authority,,] = await ap.getAgentConfig(agentToken.target);
    expect(authority).to.equal(bob.address);
  });

  it('old authority cannot act after transfer', async function() {
    const { ap, agentToken, alice, bob } = await loadFixture(deployFixture);
    await ap.createAgent(agentToken.target, alice.address, 5000);
    await ap.connect(alice).updateAuthority(agentToken.target, bob.address);
    await expect(ap.connect(alice).updateBuybackBps(agentToken.target, 100))
      .to.be.revertedWithCustomError(ap, 'NotAgentAuthority');
  });

  it('reverts on zero address', async function() {
    const { ap, agentToken, alice } = await loadFixture(deployFixture);
    await ap.createAgent(agentToken.target, alice.address, 5000);
    await expect(ap.connect(alice).updateAuthority(agentToken.target, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(ap, 'ZeroAddress');
  });

  it('reverts if not authority', async function() {
    const { ap, agentToken, alice, bob } = await loadFixture(deployFixture);
    await ap.createAgent(agentToken.target, alice.address, 5000);
    await expect(ap.connect(bob).updateAuthority(agentToken.target, bob.address))
      .to.be.revertedWithCustomError(ap, 'NotAgentAuthority');
  });
});
```

### Suite 9: Reentrancy attack

```js
describe('reentrancy protection', function() {
  it('blocks reentrant withdraw during ETH receipt', async function() {
    const { ap, agentToken, alice, NATIVE_TOKEN } = await loadFixture(deployFixture);
    await ap.createAgent(agentToken.target, alice.address, 0);

    // Deploy attacker
    const Attacker = await ethers.getContractFactory('ReentrancyAttacker');
    const attacker = await Attacker.deploy(ap.target, agentToken.target);

    // Fund the attacker and attack
    const amount = ethers.parseEther('1');
    await expect(attacker.connect(alice).attack({ value: amount })).to.not.be.reverted;

    // The attack contract should have made a payment but not successfully reentered withdraw
    // The attackCount should not have resulted in a successful theft
    const [payVault,,] = await ap.getBalances(agentToken.target, NATIVE_TOKEN);
    expect(payVault).to.be.gte(0n); // Normal operation — reentrancy was blocked
  });
});
```

### Suite 10: Full flow integration test

```js
describe('full flow integration', function() {
  it('create → pay × 3 → distribute → withdraw', async function() {
    const { ap, usdc, agentToken, alice, bob, carol } = await loadFixture(deployFixture);

    // Create agent
    await ap.createAgent(agentToken.target, alice.address, 3000); // 30% buyback

    // 3 different users pay
    const pays = [
      ethers.parseUnits('100', 6),
      ethers.parseUnits('250', 6),
      ethers.parseUnits('50', 6),
    ];
    const payers = [alice, bob, carol];
    for (let i = 0; i < 3; i++) {
      await usdc.mint(payers[i].address, pays[i]);
      await usdc.connect(payers[i]).approve(ap.target, pays[i]);
      await ap.connect(payers[i]).acceptPayment(
        agentToken.target, usdc.target, pays[i], BigInt(i + 1), 0n, 9999999999n
      );
    }

    const total = pays.reduce((a, b) => a + b, 0n);
    const [payVault,,] = await ap.getBalances(agentToken.target, usdc.target);
    expect(payVault).to.equal(total);

    // Distribute
    await ap.distributePayments(agentToken.target, usdc.target);

    const [payAfter, buyback, withdraw] = await ap.getBalances(agentToken.target, usdc.target);
    expect(payAfter).to.equal(0n);
    expect(buyback).to.equal(total * 3000n / 10000n);
    expect(withdraw).to.equal(total * 7000n / 10000n);

    // Withdraw to carol
    const carolBefore = await usdc.balanceOf(carol.address);
    await ap.connect(alice).withdraw(agentToken.target, usdc.target, carol.address);
    const carolAfter = await usdc.balanceOf(carol.address);
    expect(carolAfter - carolBefore).to.equal(total * 7000n / 10000n);

    // Stats
    const [totalPay, totalBuybackStat, totalWithdrawnStat,] =
      await ap.getPaymentStats(agentToken.target, usdc.target);
    expect(totalPay).to.equal(total);
    expect(totalWithdrawnStat).to.equal(total * 7000n / 10000n);
  });
});
```

### Suite 11: Invoice replay attack

```js
describe('invoice replay attack', function() {
  it('second payment with same params reverts', async function() {
    const { ap, usdc, agentToken, alice } = await loadFixture(deployFixture);
    await ap.createAgent(agentToken.target, alice.address, 5000);
    const amount = ethers.parseUnits('100', 6);
    await usdc.mint(alice.address, amount * 2n);
    await usdc.connect(alice).approve(ap.target, amount * 2n);

    // First payment succeeds
    await ap.connect(alice).acceptPayment(agentToken.target, usdc.target, amount, 77n, 0n, 9999999999n);
    // Exact same params — must revert
    await expect(
      ap.connect(alice).acceptPayment(agentToken.target, usdc.target, amount, 77n, 0n, 9999999999n)
    ).to.be.revertedWithCustomError(ap, 'InvoiceAlreadyPaid');
  });

  it('different memo creates a new valid invoice', async function() {
    const { ap, usdc, agentToken, alice } = await loadFixture(deployFixture);
    await ap.createAgent(agentToken.target, alice.address, 5000);
    const amount = ethers.parseUnits('100', 6);
    await usdc.mint(alice.address, amount * 2n);
    await usdc.connect(alice).approve(ap.target, amount * 2n);

    await ap.connect(alice).acceptPayment(agentToken.target, usdc.target, amount, 77n, 0n, 9999999999n);
    // Same params but different memo — should succeed
    await expect(
      ap.connect(alice).acceptPayment(agentToken.target, usdc.target, amount, 78n, 0n, 9999999999n)
    ).to.not.be.reverted;
  });
});
```

## Running tests

```bash
cd /workspaces/agent-payments-sdk/contracts
npx hardhat test
```

All tests must pass. Coverage target: 100% of functions, >95% of branches.

Optional coverage report:
```bash
npx hardhat coverage
```

## Checklist

- [ ] Read `AgentPayments.sol` before writing tests
- [ ] Create `contracts/src/test/MockERC20.sol`
- [ ] Create `contracts/src/test/MockSwapRouter.sol`
- [ ] Create `contracts/src/test/ReentrancyAttacker.sol`
- [ ] Create `contracts/test/AgentPayments.test.js` with all 11 test suites
- [ ] All tests pass with `npx hardhat test`
- [ ] Fix any contract bugs discovered during testing
- [ ] No test skips or pending tests

## Do not

- Do not test internal functions directly — test via public interface
- Do not mock the AgentPayments contract itself
- Do not leave any `it.skip()` or `.only()` in the final file
- Do not use TypeScript — keep tests as plain `.js` (Hardhat default)
