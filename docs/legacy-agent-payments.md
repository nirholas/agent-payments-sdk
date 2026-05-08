# Legacy Agent Payments (1.0.7)

Reference for the legacy `@pump-fun/agent-payments-sdk` 1.0.7 client vendored into this package as [src/solana/legacy-agent-payments/](../src/solana/legacy-agent-payments/) and re-exported under the `legacyAgentPayments` namespace from [src/solana/index.ts](../src/solana/index.ts).

## 1. Background

Two on-chain `pump_agent_payments` deployments coexist:

| Version | Program ID | npm publish date | Notes |
|---|---|---|---|
| 1.0.7 (legacy) | `pUmPFn9WvfaN2WTVGnCEtJTd2ATTpvpsKRz6jVzu6u4` | 2026-02-12 | Targeted by `@pump-fun/pump-sdk@1.35.0`'s `isTokenizedAgent: true` path. |
| 3.0.3 (modern) | `AgenTMiC2hvxGebTsgmsD4HHBa8WEcqGFf87iwRRxLo7` | 2026-03-24 | Targeted by [src/solana/PumpAgent.ts](../src/solana/PumpAgent.ts). |

The legacy program ID is the constant `LEGACY_AGENT_PAYMENTS_PROGRAM_ID` in [src/solana/legacy-agent-payments/pdas.ts](../src/solana/legacy-agent-payments/pdas.ts); the modern program ID is sourced from the IDL in [src/solana/idl/pump_agent_payments.json](../src/solana/idl/pump_agent_payments.json) and re-exported as `PUMP_AGENT_PAYMENTS_PROGRAM_ID` from [src/solana/index.ts](../src/solana/index.ts). Publish dates per `npm view @pump-fun/agent-payments-sdk time`.

The two programs do not share PDAs. An agent registered on one deployment is invisible to the other.

## 2. When to use which

| Situation | Use |
|---|---|
| Coin's tokenized-agent record was created via `pump-sdk` 1.35's `isTokenizedAgent: true` flag | Legacy |
| New tokenized-agent registration on a freshly created coin | Modern (`PumpAgent` / `PumpAgentOffline`) |
| Wallet/tooling has hardcoded `pUmPFn9...` | Legacy |
| You need native-SOL `agentTransferExtraLamports` or `BuildAcceptPaymentParams` compute-budget helpers | Modern (these methods are not exposed on `LegacyPumpAgentOffline`) |
| You are migrating from a legacy agent | Use both — call legacy methods to drain, then use modern `create` |

## 3. API reference: `LegacyPumpAgentOffline`

Defined in [src/solana/legacy-agent-payments/PumpAgentOffline.ts](../src/solana/legacy-agent-payments/PumpAgentOffline.ts). Every method returns a raw `TransactionInstruction`; the caller is responsible for transaction assembly, compute-budget, and signing.

```ts
import { PublicKey } from "@solana/web3.js";
import { legacyAgentPayments } from "@nirholas/agent-payments-sdk/solana";
const { LegacyPumpAgentOffline } = legacyAgentPayments;

const mint = new PublicKey("YourCoinMint1111111111111111111111111111111");
const offline = LegacyPumpAgentOffline.load(mint);
```

### `create(params)`

Registers a tokenized agent for a bonding-curve coin (`agentInitialize`).

| Field | Type | Description |
|---|---|---|
| `authority` | `PublicKey` | Signer; must be the bonding-curve creator. |
| `mint` | `PublicKey` | Coin mint. |
| `agentAuthority` | `PublicKey` | Pubkey that will sign withdraw / update flows. |
| `buybackBps` | `number` | Basis points (0–10000). |

Returns: `Promise<TransactionInstruction>`.

```ts
const ix = await offline.create({
  authority,
  mint,
  agentAuthority,
  buybackBps: 500,
});
```

### `withdraw(params)`

| Field | Type | Description |
|---|---|---|
| `authority` | `PublicKey` | Agent authority signer. |
| `currencyMint` | `PublicKey` | Currency to withdraw. |
| `receiverAta` | `PublicKey` | Recipient ATA for `currencyMint`. |
| `tokenProgram?` | `PublicKey` | Defaults to SPL `TOKEN_PROGRAM_ID`. |

```ts
const ix = await offline.withdraw({
  authority, currencyMint, receiverAta,
});
```

### `updateBuybackBps(params, options)`

| Field | Type | Description |
|---|---|---|
| `params.authority` | `PublicKey` | Agent authority. |
| `params.buybackBps` | `number` | New basis points. |
| `options.supportedCurrenciesMint` | `PublicKey[]` | **Required for offline.** Pass `globalConfig.supportedCurrenciesMint`. |

The offline client requires `options.supportedCurrenciesMint`; the connection-bound `LegacyPumpAgent` overrides this to fetch from chain (see §4). Throws if missing.

```ts
const ix = await offline.updateBuybackBps(
  { authority, buybackBps: 750 },
  { supportedCurrenciesMint: globalConfig.supportedCurrenciesMint },
);
```

### `acceptPayment(params)`

| Field | Type |
|---|---|
| `user` | `PublicKey` |
| `userTokenAccount` | `PublicKey` |
| `currencyMint` | `PublicKey` |
| `amount` | `BN` |
| `memo` | `BN` |
| `startTime` | `BN` |
| `endTime` | `BN` |
| `tokenProgram?` | `PublicKey` |

```ts
import { BN } from "@coral-xyz/anchor";
const ix = await offline.acceptPayment({
  user, userTokenAccount, currencyMint,
  amount: new BN(1_000_000), memo: new BN(1),
  startTime: new BN(now), endTime: new BN(now + 600),
});
```

### `acceptPaymentSimple(params)`

Identical to `acceptPayment` except `amount`, `memo`, `startTime`, `endTime` may be supplied as `number | bigint` and are normalised to `BN` internally.

```ts
const ix = await offline.acceptPaymentSimple({
  user, userTokenAccount, currencyMint,
  amount: 1_000_000n, memo: 1n,
  startTime: BigInt(now), endTime: BigInt(now + 600),
});
```

### `distributePayments(params)`

Permissionless. Splits accumulated payments into the buyback and withdraw vaults.

| Field | Type |
|---|---|
| `user` | `PublicKey` (any signer) |
| `currencyMint` | `PublicKey` |
| `tokenProgram?` | `PublicKey` |

```ts
const ix = await offline.distributePayments({ user, currencyMint });
```

### `buybackTrigger(params)`

CPIs into the supplied swap program and burns the resulting token-mint output.

| Field | Type | Description |
|---|---|---|
| `globalBuybackAuthority` | `PublicKey` | Must match `globalConfig.buybackAuthority`. |
| `currencyMint` | `PublicKey` | Currency consumed by the swap. |
| `swapProgramToInvoke` | `PublicKey` | Program CPI'd into. |
| `swapInstructionData` | `Buffer` | Encoded swap instruction data. |
| `remainingAccounts` | `AccountMeta[]` | All accounts the swap requires. |
| `tokenProgram?` | `PublicKey` |

```ts
const ix = await offline.buybackTrigger({
  globalBuybackAuthority, currencyMint, swapProgramToInvoke,
  swapInstructionData, remainingAccounts,
});
```

### `extendAccount(params)`

| Field | Type |
|---|---|
| `account` | `PublicKey` |
| `user` | `PublicKey` |

```ts
const ix = await offline.extendAccount({ account, user });
```

### `updateAuthority(params)`

| Field | Type |
|---|---|
| `authority` | `PublicKey` (current) |
| `newAuthority` | `PublicKey` |

```ts
const ix = await offline.updateAuthority({ authority, newAuthority });
```

### `closeAccount(params)`

Closes an on-chain account and returns its rent lamports to the signer. Maps to the `closeAccount` IDL instruction (discriminator `[125, 255, 149, 14, 110, 34, 72, 24]`); the program derives `globalConfig` via PDA automatically.

| Field | Type | Description |
|---|---|---|
| `account` | `PublicKey` | The account to close (writable). |
| `user` | `PublicKey` | Signer; receives the reclaimed lamports. |

Returns: `Promise<TransactionInstruction>`.

```ts
const ix = await offline.closeAccount({ account: tokenAgentPaymentsPDA, user: authority });
```

`acceptPaymentBuilt` and compute-budget builders are modern-only additions in [src/solana/PumpAgentOffline.ts](../src/solana/PumpAgentOffline.ts).

## 4. API reference: `LegacyPumpAgent`

Defined in [src/solana/legacy-agent-payments/PumpAgent.ts](../src/solana/legacy-agent-payments/PumpAgent.ts). Extends `LegacyPumpAgentOffline`; constructor takes `(mint, connection)`.

### `getBalances(currencyMint)`

Returns `LegacyAgentBalances` — the address and `bigint` balance of the payment, buyback, and withdraw ATAs for the given currency. Missing ATAs report `0n`.

```ts
import { Connection } from "@solana/web3.js";
const agent = new legacyAgentPayments.LegacyPumpAgent(mint, new Connection(rpc));
const { paymentVault, buybackVault, withdrawVault } = await agent.getBalances(currencyMint);
```

### `updateBuybackBps(params, options?)` (override)

When `options.supportedCurrenciesMint` is omitted the override fetches `globalConfig.supportedCurrenciesMint` from chain, then delegates to `super.updateBuybackBps(params, { supportedCurrenciesMint })`. This mirrors the original 1.0.7 SDK's connection-bound behavior.

```ts
const ix = await agent.updateBuybackBps({ authority, buybackBps: 750 });
```

## 5. PDAs and seeds

All seven helpers live in [src/solana/legacy-agent-payments/pdas.ts](../src/solana/legacy-agent-payments/pdas.ts). The first six derive PDAs under `LEGACY_AGENT_PAYMENTS_PROGRAM_ID` (`pUmPFn9...`); `getBondingCurvePDA` derives under the pump program ID `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`.

| Helper | Seeds | Owning program |
|---|---|---|
| `getGlobalConfigPDA()` | `["global-config"]` | `LEGACY_AGENT_PAYMENTS_PROGRAM_ID` |
| `getTokenAgentPaymentsPDA(mint)` | `["token-agent-payments", mint]` | `LEGACY_AGENT_PAYMENTS_PROGRAM_ID` |
| `getPaymentInCurrencyPDA(mint, currencyMint)` | `["payment-in-currency", mint, currencyMint]` | `LEGACY_AGENT_PAYMENTS_PROGRAM_ID` |
| `getInvoiceIdPDA(mint, currencyMint, amount, memo, startTime, endTime)` | `["invoice-id", mint, currencyMint, amount(LE u64), memo(LE u64), startTime(LE u64), endTime(LE u64)]` | `LEGACY_AGENT_PAYMENTS_PROGRAM_ID` |
| `getBuybackAuthorityPDA(mint)` | `["buyback-authority", mint]` | `LEGACY_AGENT_PAYMENTS_PROGRAM_ID` |
| `getWithdrawAuthorityPDA(mint)` | `["withdraw-authority", mint]` | `LEGACY_AGENT_PAYMENTS_PROGRAM_ID` |
| `getBondingCurvePDA(mint)` | `["bonding-curve", mint]` | `PUMP_PROGRAM_ID` (`6EF8rrec...`) |

The constants `GLOBAL_CONFIG_SEED`, `TOKEN_AGENT_PAYMENTS_SEED`, `PAYMENT_IN_CURRENCY_SEED`, `INVOICE_ID_SEED`, `BUYBACK_AUTHORITY_SEED`, `WITHDRAW_AUTHORITY_SEED`, and `BONDING_CURVE_SEED` are exported as `Buffer` instances.

## 6. Decoders

Defined in [src/solana/legacy-agent-payments/program.ts](../src/solana/legacy-agent-payments/program.ts) and re-exported from [src/solana/legacy-agent-payments/index.ts](../src/solana/legacy-agent-payments/index.ts).

| Decoder | Decodes | Returned shape (from [types.ts](../src/solana/legacy-agent-payments/types.ts)) |
|---|---|---|
| `decodeLegacyGlobalConfig(data)` | `globalConfig` | `LegacyGlobalConfig` — `{ bump, protocolAuthority, buybackAuthority, supportedCurrenciesMint: PublicKey[10], tokenizedAgentSequence: BN }`. |
| `decodeLegacyTokenAgentPaymentInCurrency(data)` | `tokenAgentPaymentInCurrency` | `LegacyTokenAgentPaymentInCurrency` — `{ mint, currencyMint, totalInvoicePaymentsMade, totalBuyback, totalWithdrawals, tokensBoughtBackAndBurned }` (BNs). |
| `decodeLegacyTokenAgentPayments(data)` | `tokenAgentPayments` | `LegacyTokenAgentPayments` — `{ bump, mint, authority, buybackBps }`. |

Each decoder takes a `Buffer` of raw account data and uses the offline Anchor coder — no chain calls.

## 7. Migration to 3.0.x

Tokenized agents are bound to the program they were registered on. There is no on-chain instruction to relocate an agent record between the legacy and modern programs.

Practical migration:

1. **Drain.** Call `LegacyPumpAgentOffline.distributePayments` for each currency, then `LegacyPumpAgentOffline.withdraw` to move funds out.
2. **Close (optional).** Call `LegacyPumpAgentOffline.closeAccount({ account: tokenAgentPaymentsPDA, user: authority })` to reclaim rent lamports from the agent record.
3. **Re-register.** Call `PumpAgentOffline.create` (modern, see [src/solana/PumpAgentOffline.ts](../src/solana/PumpAgentOffline.ts)) on the same mint with the desired `agentAuthority` and `buybackBps`.

The two records can coexist on chain; downstream consumers must read whichever program their tooling targets.
