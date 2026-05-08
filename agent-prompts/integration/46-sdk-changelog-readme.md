# SDK Changelog, README, and Documentation

## Goal
Write complete README.md, CHANGELOG.md, and API documentation for @nirholas/agent-payments-sdk@0.2.0 before npm publish.

## Context
- Repo: /workspaces/agent-payments-sdk
- Package: @nirholas/agent-payments-sdk, published at github.com/nirholas/agent-payments-sdk
- Key modules:
  - Solana: PumpAgent, PumpAgentOffline, PumpTradeClient, WhitelistMonitor, PumpMarketData
  - Legacy Solana (1.0.7): legacyAgentPayments.LegacyPumpAgent, LegacyPumpAgentOffline
  - EVM: EvmAgent, EvmAgentOffline, CrossChainPaymentClient
  - x402: x402 payment protocol for both Solana and EVM
  - Events: createEventParser, subscribeToAgentEvents

## Implementation

### 1. Rewrite /workspaces/agent-payments-sdk/README.md

Must include:
- Hero: "TypeScript SDK for pump.fun agent payments on Solana and EVM"
- Install: `npm install @nirholas/agent-payments-sdk`
- Quick start (4 sections):
  1. Accept a payment (Solana, 10 lines of code)
  2. Check vault balances (5 lines)
  3. v2 bonding curve (USDC-aware, 8 lines)
  4. EVM payment (Base, 8 lines)
- Full API reference table for each module
- Architecture diagram (ASCII)
- Links: GitHub, npm, pump.fun

### 2. Write /workspaces/agent-payments-sdk/CHANGELOG.md

Format: Keep a Changelog (keepachangelog.com)

```markdown
# Changelog

## [0.2.0] - 2026-05-08
### Added
- Solana v2 bonding curve support: buy_v2, sell_v2, create_v2, USDC quote mint
- `PumpTradeClient` — unified v1/v2 trade client with auto-routing
- `WhitelistMonitor` — real-time WebSocket subscription for USDC whitelist
- `PumpMarketData` — USD-normalized price/marketcap for SOL and USDC coins
- Legacy 1.0.7 program support (`legacyAgentPayments` namespace)
- EVM module: `EvmAgent`, `EvmAgentOffline`, `CrossChainPaymentClient`
- x402 protocol support for both Solana and EVM payment gating
- Bonding curve v2 decoder (115-byte format with quoteMint, creator fields)

## [0.1.0] - 2026-04-01
### Added
- Initial release: PumpAgent, PumpAgentOffline for Solana agent payments
```

### 3. Update all JSDoc in key files
Add JSDoc to:
- PumpTradeClient.ts — class and all methods
- PumpAgent.ts — getBalances, validateInvoicePayment
- WhitelistMonitor.ts — subscribe, isWhitelisted

### 4. Create docs/ directory with:
- docs/SOLANA.md — full Solana module guide
- docs/EVM.md — full EVM module guide  
- docs/X402.md — x402 payment gating guide
- docs/LEGACY.md — legacy 1.0.7 module guide

Each doc: 200-400 lines, code examples for every function, no stubs.

## Deliverables
- README.md (complete rewrite)
- CHANGELOG.md
- docs/SOLANA.md, docs/EVM.md, docs/X402.md, docs/LEGACY.md
- Updated JSDoc in key source files
