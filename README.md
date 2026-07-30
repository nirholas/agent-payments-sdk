# @nirholas/agent-payments-sdk

## Overview

Cross-chain payments SDK for Pump tokenized agents. The Solana surface ships two coexisting clients — the modern 3.0.x `pump_agent_payments` program ([src/solana/](src/solana/)) and a vendored 1.0.7 client for coins registered via `@pump-fun/pump-sdk`'s `isTokenizedAgent: true` path ([src/solana/legacy-agent-payments/](src/solana/legacy-agent-payments/)). The EVM surface covers payment acceptance and cross-chain quoting on six EVM chains plus an x402 HTTP 402 client/facilitator. Embedded agent skills under [swap/](swap/), [create-coin/](create-coin/), [coin-fees/](coin-fees/), and [tokenized-agents/](tokenized-agents/) ship runnable Node scripts that the parent agent can drive directly.

## Install

This package is **not published to the npm registry**; `npm i @nirholas/agent-payments-sdk` resolves to a 404. Install it from the GitHub repository instead. Solana is the primary surface and pulls in Anchor and `@solana/web3.js`; EVM uses `viem`.

```bash
npm i github:nirholas/agent-payments-sdk
```

Or clone and link it for local development:

```bash
git clone https://github.com/nirholas/agent-payments-sdk
cd agent-payments-sdk && npm ci && npm run build
```

Runtime requirements (from [package.json](package.json)):

| Dependency | Version |
|---|---|
| `@coral-xyz/anchor` | `^0.31.1` |
| `@solana/web3.js` | `^1.98.0` |
| `@solana/spl-token` | `^0.4.9` |
| `viem` | `^2.21.0` |
| `zod` (peer, optional) | `^3.0.0` |

`package.json` declares `"engines": { "node": ">=18" }`. Node 18+ is required because the package is ESM-first and the SDK depends on `@solana/web3.js@^1.98`.

## Quickstart: Solana modern (3.0.x)

`PumpAgentOffline` builds raw `TransactionInstruction`s with no RPC dependency; `PumpAgent` extends it with balance fetches and other read-only helpers. Verify imports against [src/solana/index.ts](src/solana/index.ts).

```ts
import { Connection, PublicKey } from "@solana/web3.js";
import {
  PumpAgent,
  PumpAgentOffline,
  PUMP_AGENT_PAYMENTS_PROGRAM_ID,
} from "@nirholas/agent-payments-sdk/solana";

const connection = new Connection("https://api.mainnet-beta.solana.com");
const mint = new PublicKey("YourCoinMint1111111111111111111111111111111");

// Connection-bound: fetch balances for a currency vault triplet.
const agent = new PumpAgent(mint, "mainnet", connection);
const balances = await agent.getBalances(
  new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"), // USDC
);

// Offline-only: register a tokenized agent (returns the unsigned ix).
const offline = PumpAgentOffline.load(mint);
const createIx = await offline.create({
  authority: new PublicKey("BondingCurveCreator11111111111111111111111"),
  mint,
  agentAuthority: new PublicKey("AgentAuthority1111111111111111111111111111"),
  buybackBps: 500,
});
```

## Quickstart: Solana legacy (1.0.7)

The legacy program at `pUmPFn9WvfaN2WTVGnCEtJTd2ATTpvpsKRz6jVzu6u4` is a separate on-chain deployment with disjoint PDAs. Use it when:

- The coin's tokenized-agent record was created via `@pump-fun/pump-sdk@1.35.0`'s `isTokenizedAgent: true` flag — that path targets the legacy program.
- Downstream tooling has hardcoded the 1.0.7 program ID.

Public-API import path is the namespaced re-export from [src/solana/index.ts](src/solana/index.ts):

```ts
import { PublicKey } from "@solana/web3.js";
import { legacyAgentPayments } from "@nirholas/agent-payments-sdk/solana";

const { LegacyPumpAgentOffline } = legacyAgentPayments;
const mint = new PublicKey("YourCoinMint1111111111111111111111111111111");
const offline = LegacyPumpAgentOffline.load(mint);

const createIx = await offline.create({
  authority: new PublicKey("BondingCurveCreator11111111111111111111111"),
  mint,
  agentAuthority: new PublicKey("AgentAuthority1111111111111111111111111111"),
  buybackBps: 500,
});
```

The legacy module is also exported under the `legacyAgentPayments` namespace from the package root and from [src/solana/legacy-agent-payments/index.ts](src/solana/legacy-agent-payments/index.ts). Full reference: [docs/legacy-agent-payments.md](docs/legacy-agent-payments.md).

## Quickstart: EVM

`EvmAgentOffline` builds unsigned EVM transactions; `EvmAgent` adds RPC reads. Exports come from [src/evm/index.ts](src/evm/index.ts).

> **No AgentPayments contract is deployed on any of the six chains yet.** Every entry in `EVM_CHAINS` carries `agentPayments: 0x0000...0000`. The constructors therefore require an explicit contract address and throw a descriptive error without one, rather than building an `approve(0x0, maxUint256)` and a payment call to the zero address. Check with `isAgentPaymentsDeployed(chainId)` before assuming a chain is usable.

`buildAcceptPaymentTx` takes the parameters and the payer as **two separate arguments**, and returns a bundle of `{ approval?, tx }`. The currency field is named `currencyToken` and accepts `"native"` for ETH/BNB/AVAX.

```ts
import {
  EvmAgent,
  EvmAgentOffline,
  buildInvoiceWindow,
  isAgentPaymentsDeployed,
} from "@nirholas/agent-payments-sdk/evm";

const AGENT_TOKEN = "0xYourAgentToken00000000000000000000000000";
const AGENT_PAYMENTS = "0xYourDeployedAgentPayments00000000000000";

const offline = new EvmAgentOffline(AGENT_TOKEN, 8453 /* Base */, AGENT_PAYMENTS);

const window = buildInvoiceWindow(600); // 10-minute validity
const bundle = offline.buildAcceptPaymentTx(
  {
    agentToken: AGENT_TOKEN,
    currencyToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
    amount: 1_000_000n,
    memo: 1n,
    startTime: window.startTime,
    endTime: window.endTime,
  },
  "0xPayer000000000000000000000000000000000000",
);

// Send bundle.approval first (ERC-20 only), then bundle.tx.
if (bundle.approval) await wallet.sendTransaction(bundle.approval);
await wallet.sendTransaction(bundle.tx);

const agent = new EvmAgent(AGENT_TOKEN, 8453, undefined /* default RPC */, AGENT_PAYMENTS);
const config = await agent.getAgentConfig();
```

## Public exports map

| Subpath | Description |
|---|---|
| `@nirholas/agent-payments-sdk` | Re-exports the Solana and EVM surfaces; namespaced as `solana`, `evm`, `x402Evm`. See [src/index.ts](src/index.ts). |
| `@nirholas/agent-payments-sdk/solana` | `PumpAgent`, `PumpAgentOffline`, PDAs, decoders, events, the `legacyAgentPayments` namespace, and the `x402` namespace. See [src/solana/index.ts](src/solana/index.ts). |
| `@nirholas/agent-payments-sdk/evm` | `EvmAgent`, `EvmAgentOffline`, ABIs, chain registry, invoice helpers, event parser. See [src/evm/index.ts](src/evm/index.ts). |
| `@nirholas/agent-payments-sdk/x402` | `createEvmX402Fetch` client and EVM facilitator. See [src/x402/index.ts](src/x402/index.ts). |
| `@nirholas/agent-payments-sdk/solana/legacy-agent-payments` | `LegacyPumpAgent`, `LegacyPumpAgentOffline`, legacy PDAs and program ID. See [src/solana/legacy-agent-payments/index.ts](src/solana/legacy-agent-payments/index.ts). |
| `@nirholas/agent-payments-sdk/solana/solana-agent-kit` | `PumpAgentPaymentsPlugin` for solana-agent-kit. See [src/solana/solana-agent-kit/](src/solana/solana-agent-kit/). |
| `@nirholas/agent-payments-sdk/solana-agent-kit` | Alias of the above, kept for existing importers. |

The legacy 1.0.7 client is reachable two ways: through the `legacyAgentPayments` namespace exported from `/solana`, or through its own `./solana/legacy-agent-payments` subpath. Each subpath above also has an `/index` alias in `package.json`'s `exports` field.

## Skills

Each skill folder contains a `SKILL.md` plus a `scripts/` directory of runnable Node CLI scripts. The skills are designed to be loaded as Claude Code skills.

| Skill | Purpose |
|---|---|
| [swap/SKILL.md](swap/SKILL.md) | Buy/sell on the bonding curve and AMM (legacy + v2 paths), balance prints. |
| [create-coin/SKILL.md](create-coin/SKILL.md) | Create coins with optional initial buy, cashback, mayhem mode, and tokenized-agent registration. |
| [coin-fees/SKILL.md](coin-fees/SKILL.md) | Inspect, collect, and distribute creator fees; manage sharing configs. |
| [tokenized-agents/SKILL.md](tokenized-agents/SKILL.md) | Build and verify agent invoice payments using this SDK. |

## vendor/

The [vendor/](vendor/) tree contains reference copies of upstream dependencies. None of them ship in the published `dist/`, and only `vendor/agent-payments-sdk-107/` is wired into the build at all (as a `file:` devDependency used by the cross-version tests).

| Path | What it is |
|---|---|
| [vendor/pump-rust-client/](vendor/pump-rust-client/) | Rust client crate for the pump program; canonical reference for v2 instruction wiring. |
| [vendor/pump-sdk-npm/](vendor/pump-sdk-npm/) | Decompiled `@pump-fun/pump-sdk` source (1.35.x) — used to cross-check helper signatures. |
| [vendor/pump-swap-sdk-npm/](vendor/pump-swap-sdk-npm/) | Decompiled `@pump-fun/pump-swap-sdk` for AMM helpers. |
| [vendor/agent-payments-sdk-npm/](vendor/agent-payments-sdk-npm/) | The 1.0.7 npm bundle the legacy module was reconstructed from. |
| [vendor/agent-payments-sdk-107/](vendor/agent-payments-sdk-107/) | Installed as a `file:` devDependency so the cross-version tests can diff this SDK against the 1.0.7 build. |
| [vendor/pump-segments-sdk/](vendor/pump-segments-sdk/) | Pump segments SDK reference. |
| [vendor/transfer-hook-authority/](vendor/transfer-hook-authority/) | Reference source for the transfer-hook authority program. |

## Build / test / contribute

This package builds with `tsup` to a dual ESM+CJS dist. Scripts from [package.json](package.json):

```bash
npm ci                 # install from the committed package-lock.json
npm run build          # tsup, dual ESM + CJS into dist/
npm run build:prod     # tsup --minify
npm run typecheck      # tsc --noEmit
npm test               # vitest run
npm run test:watch     # vitest
npm run test:coverage  # vitest run --coverage
npm run clean          # rm -rf dist
```

Tests run on [vitest](https://vitest.dev) and live next to the sources they cover (`src/**/*.test.ts`), plus `src/solana/legacy-agent-payments/__tests__/`. Coverage is scoped to the legacy module per [vitest.config.ts](vitest.config.ts).

The package is ESM-first (`"type": "module"`) and Node 18+ is required for the global `fetch` and `BigInt` APIs assumed by the EVM surface.

## License

All rights reserved. See [LICENSE](LICENSE).

## Documentation

Full documentation site: **https://nirholas.github.io/agent-payments-sdk/**

- [Getting started](docs/getting-started.md) covers install and first run.
- [Examples](docs/examples.md) has copy-paste snippets.
