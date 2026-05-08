# Complete Vitest Test Suite for @nirholas/agent-payments-sdk

## Goal
Write a comprehensive test suite for @nirholas/agent-payments-sdk covering all Solana modules with real RPC calls to mainnet.

## Context
- Repo: /workspaces/agent-payments-sdk
- vitest.config.ts exists at root
- Test files: src/solana/**/*.test.ts
- Real coins on mainnet:
  - TEST coin: 7DU5iH56AjEgbjmGJ21i1GiyxPxxGVLJwnPdar8ZmDrv (v2, wSOL quote, created by EVMpqJEY...)
  - Any active pump.fun coin (fetch from API if needed)
- Wallet (read-only for tests): EVMpqJEYoWHKhAnDZEa2mT4GyBoMTWGXkSdV1zQB9v8B

## Implementation

### 1. src/solana/PumpTradeClient.test.ts
- buildBuyInstructions — verify instruction array returned for TEST coin
- buildSellInstructions — verify instruction array
- quoteForBuy — returns numeric quote in lamports
- resolveQuoteMint — returns NATIVE_MINT for v2 wSOL coin
- All tests: real mainnet RPC, no mocks

### 2. src/solana/legacy-agent-payments/__tests__/pdas.test.ts (already exists — extend it)
- Verify LEGACY_AGENT_PAYMENTS_PROGRAM_ID = pUmPFn9WvfaN2WTVGnCEtJTd2ATTpvpsKRz6jVzu6u4
- Verify all 7 PDA functions return valid PublicKey objects
- Verify PDAs differ from modern program PDAs for same inputs

### 3. src/solana/WhitelistMonitor.test.ts (already exists — verify it passes)
- Run: npx vitest run src/solana/WhitelistMonitor.test.ts
- Fix any failing tests

### 4. src/solana/bondingCurveDecoder.test.ts
- Fetch real v2 bonding curve bytes from mainnet (TEST coin: 7DU5iH56...)
- Decode and verify: version=2, quoteMint=NATIVE_MINT, complete=false
- Fetch real v1 bonding curve bytes (any old pump.fun coin)
- Decode and verify: version=1

### 5. src/solana/PumpAgent.test.ts
- getBalances — real on-chain call for TEST coin's agent PDA (may return zero, that's ok)
- Test that PumpAgentOffline.load works without RPC

### 6. Run all tests
```bash
npx vitest run --reporter=verbose
```
All tests must pass. Fix any failures.

## Deliverables
- All test files written/fixed
- `npx vitest run` exits 0
- Test count: minimum 20 passing tests across all files
