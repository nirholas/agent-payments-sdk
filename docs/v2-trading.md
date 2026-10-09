<!-- agent-payments-sdk | Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas -->

# v2 Trading Reference

Reference for the 2026-05-07 pump-program upgrade and the v2 trading instructions it shipped. Sources: the IDL at [pump-public-docs/idl/pump.json](../pump-public-docs/idl/pump.json), the Rust client at [vendor/pump-rust-client/src/sdk/pump_v2.rs](../vendor/pump-rust-client/src/sdk/pump_v2.rs), and the vendored npm SDK at [vendor/pump-sdk-npm/src/sdk.ts](../vendor/pump-sdk-npm/src/sdk.ts).

## 1. The 2026-05-07 upgrade

The pump program (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`) shipped a non-breaking upgrade introducing five new instructions: `buy_v2`, `sell_v2`, `buy_exact_quote_in_v2`, `claim_cashback_v2`, and `create_v2`. The legacy `buy`, `sell`, `create`, and `claim_cashback` instructions remain valid; existing coins continue to trade on those paths until they are migrated. The upgrade also enlarges the `BondingCurve` account and adds a `quoteMint` field so the same instructions can drive USDC-paired coins as well as the existing wSOL-paired coins.

## 2. New instructions

Discriminators and arg lists are extracted directly from [pump-public-docs/idl/pump.json](../pump-public-docs/idl/pump.json). TS helper names are from `PumpSdk` in `@pump-fun/pump-sdk` 4.0.0, the version every package in this repo pins (the decompiled 1.35.x copy under [vendor/pump-sdk-npm/](../vendor/pump-sdk-npm/) is a historical reference only).

| Instruction | Discriminator | Args | TS helper | Local script |
|---|---|---|---|---|
| `buy_v2` | `[184, 23, 238, 97, 103, 197, 211, 61]` | `amount: u64`, `max_sol_cost: u64` | `PumpSdk.buyV2Instructions` | [swap/scripts/build-buy-bonding-v2-tx.mjs](../swap/scripts/build-buy-bonding-v2-tx.mjs) |
| `sell_v2` | `[93, 246, 130, 60, 231, 233, 64, 178]` | `amount: u64`, `min_sol_output: u64` | `PumpSdk.sellV2Instructions` | [swap/scripts/build-sell-bonding-v2-tx.mjs](../swap/scripts/build-sell-bonding-v2-tx.mjs) |
| `buy_exact_quote_in_v2` | `[194, 171, 28, 70, 104, 77, 91, 47]` | `spendable_quote_in: u64`, `min_tokens_out: u64`, `partial_fill: OptionBool` | (none, see §6) | [swap/scripts/build-buy-exact-quote-in-v2-tx.mjs](../swap/scripts/build-buy-exact-quote-in-v2-tx.mjs) |
| `claim_cashback_v2` | `[122, 243, 204, 65, 94, 116, 29, 55]` | (none) | `PumpSdk.claimCashbackV2Instruction` | [swap/scripts/build-claim-cashback-v2-tx.mjs](../swap/scripts/build-claim-cashback-v2-tx.mjs) |
| `create_v2` | `[214, 144, 76, 236, 95, 139, 49, 180]` | `name: string`, `symbol: string`, `uri: string`, `creator: pubkey`, `is_mayhem_mode: bool`, `is_cashback_enabled: OptionBool`, `creator_fee_bps: OptionU64`, `is_holder_reward: OptionBool` | `PumpSdk.createV2Instruction` | [create-coin/scripts/](../create-coin/scripts/) |

`is_cashback_enabled` must no longer be set to `true`: the program now rejects new cashback coins with error 6082 `CashbackDeprecated`, and `@pump-fun/pump-sdk` 2.x and later throw `CashbackDeprecatedError` client-side. Existing cashback coins are unaffected: they still trade through `buy_v2`/`sell_v2` and their traders still claim through `claim_cashback_v2`. `creator_fee_bps` and `is_holder_reward` arrived with pump-sdk 2.0 and are set through `createV2Instruction`'s `creatorFeeBps` and `holderReward` params.

The `max_sol_cost` and `min_sol_output` arg names in `buy_v2`/`sell_v2` are inherited verbatim from the v1 instructions; they refer to quote-token amounts when `quoteMint != wSOL`. Account lists are large (~25 accounts each); read them straight from [pump-public-docs/idl/pump.json](../pump-public-docs/idl/pump.json) when wiring a custom client.

## 3. `BondingCurve` account changes

The `BondingCurve` Anchor struct from [vendor/pump-sdk-npm/src/state.ts](../vendor/pump-sdk-npm/src/state.ts) lines 81–92:

| Legacy field | v2 field | Note |
|---|---|---|
| `virtualTokenReserves` | `virtualTokenReserves` | Unchanged. |
| `virtualSolReserves` | `virtualQuoteReserves` | Renamed; semantically the reserves of whichever currency the curve is paired against. |
| `realTokenReserves` | `realTokenReserves` | Unchanged. |
| `realSolReserves` | `realQuoteReserves` | Renamed. |
| `tokenTotalSupply` | `tokenTotalSupply` | Unchanged. |
| `complete` | `complete` | Unchanged. |
| `creator` | `creator` | Unchanged. |
| (none) | `isMayhemMode` | New. |
| (none) | `isCashbackCoin` | New. |
| (none) | `quoteMint` | New — `Pubkey::default()` for legacy SOL coins. |

The account has grown again since. Under `@pump-fun/pump-sdk` 4.0.0, `BONDING_CURVE_NEW_SIZE` is **166** bytes, adding `creatorFeeBps`, `isHolderReward`, the v3 fee buckets `creatorFee` and `protocolFees`, `depth`, `initialVirtualQuoteReserves`, and the post-completion fields. Old curves keep their old size until a trade extends them, so never discriminate on an exact size: decode what fits and zero the rest, as [src/solana/bondingCurveDecoder.ts](../src/solana/bondingCurveDecoder.ts) does (its header lists every offset).

## 4. Quote-mint resolution

The pump program treats two values as "legacy SOL" coins: a literal wSOL mint (`So11111111111111111111111111111111111111112`) and `Pubkey::default()` (the all-zeros pubkey). This is encoded by `isLegacyQuoteMint` at [vendor/pump-sdk-npm/src/pda.ts](../vendor/pump-sdk-npm/src/pda.ts) line 147:

```ts
export const isLegacyQuoteMint = (quoteMint: PublicKey): boolean =>
  quoteMint.equals(NATIVE_MINT) || quoteMint.equals(PublicKey.default);
```

Coins created via legacy `create` carry `bondingCurve.quoteMint = Pubkey::default()`; v2-created coins carry the explicit quote mint. USDC and any other non-wSOL quote mints must appear in `Global.whitelistedQuoteMints` (see [vendor/pump-sdk-npm/src/state.ts](../vendor/pump-sdk-npm/src/state.ts) line 78) before `create_v2` will accept them; the protocol authority controls that list via `add_quote_mint`.

The local quote-mint resolver lives at [swap/scripts/lib/quote-mint.mjs](../swap/scripts/lib/quote-mint.mjs).

## 5. Fee recipients

`buy_v2` and `sell_v2` consume two fee recipients per call: the regular fee recipient and a buyback fee recipient. Their sources differ:

- **Regular**: `Global.feeRecipient` plus `Global.feeRecipients[]`, randomly selected. In mayhem mode the program reads `Global.reservedFeeRecipient` plus `Global.reservedFeeRecipients[]` instead. See `pickFeeRecipient` in [swap/scripts/lib/fee-recipients.mjs](../swap/scripts/lib/fee-recipients.mjs).
- **Buyback**: the program checks the account against the live `Global.buybackFeeRecipients` list. `pickGlobalBuybackFeeRecipient(global)` in [swap/scripts/lib/fee-recipients.mjs](../swap/scripts/lib/fee-recipients.mjs) picks one at random from that list and falls back to the SDK's static mirror (`BUYBACK_FEE_RECIPIENTS`, `getStaticRandomFeeRecipientForBuyback`) only when the decoded global carries none.

## 6. `buy_exact_quote_in_v2`

`@pump-fun/pump-sdk` 4.0.0 still has no helper for the v2 form (it does for v3: `buyExactQuoteInV3Instructions`, see §10). The instruction must be driven by talking to the Anchor program directly: build the account list, pass `spendable_quote_in`, `min_tokens_out` and `partial_fill`, and submit. `partial_fill` is the IDL's `OptionBool` struct, so Anchor wants the object `{ 0: boolean }`; passing a bare boolean fails to encode. It only matters on mayhem curves, where `true` fills up to the remaining supply instead of failing with 6021. The local script [swap/scripts/build-buy-exact-quote-in-v2-tx.mjs](../swap/scripts/build-buy-exact-quote-in-v2-tx.mjs) does exactly this. The canonical reference for the account wiring is the Rust helper `buy_exact_quote_in_v2_instruction` at [vendor/pump-rust-client/src/sdk/pump_v2.rs](../vendor/pump-rust-client/src/sdk/pump_v2.rs) line 281.

## 7. TS samples

These samples rely on `@pump-fun/pump-sdk@4.0.0`; they are not surfaces of `@nirholas/agent-payments-sdk` itself, but they are the canonical pump-program clients used by the local scripts.

### `buy_v2`

```ts
import BN from "bn.js";
import { PumpSdk } from "@pump-fun/pump-sdk";
const sdk = new PumpSdk(connection);
const ixs = await sdk.buyV2Instructions({
  global,
  bondingCurveAccountInfo,
  bondingCurve,
  mint,
  user,
  amount: new BN(tokensOut),
  solAmount: new BN(quoteIn),
  slippage: 0.5,
});
```

### `sell_v2`

```ts
const ixs = await sdk.sellV2Instructions({
  global,
  bondingCurveAccountInfo,
  bondingCurve,
  mint,
  user,
  amount: new BN(tokensIn),
  solAmount: new BN(quoteOut),
  slippage: 0.5,
});
```

### `claim_cashback_v2`

```ts
const ix = await sdk.claimCashbackV2Instruction({ user, mint });
```

## 8. Script samples

Each script accepts `--help`. Canonical CLI form:

| Path | Form |
|---|---|
| [swap/scripts/build-buy-bonding-v2-tx.mjs](../swap/scripts/build-buy-bonding-v2-tx.mjs) | `node swap/scripts/build-buy-bonding-v2-tx.mjs --mint <PUBKEY> --user <PUBKEY> --amount <int> [--slippage <pct>]` |
| [swap/scripts/build-sell-bonding-v2-tx.mjs](../swap/scripts/build-sell-bonding-v2-tx.mjs) | `node swap/scripts/build-sell-bonding-v2-tx.mjs --mint <PUBKEY> --user <PUBKEY> --amount <int> [--slippage <pct>]` |
| [swap/scripts/build-buy-exact-quote-in-v2-tx.mjs](../swap/scripts/build-buy-exact-quote-in-v2-tx.mjs) | `node swap/scripts/build-buy-exact-quote-in-v2-tx.mjs --mint <PUBKEY> --user <PUBKEY> --spendable-quote-in <int> --min-tokens-out <int> [--partial-fill]` |
| [swap/scripts/build-claim-cashback-v2-tx.mjs](../swap/scripts/build-claim-cashback-v2-tx.mjs) | `node swap/scripts/build-claim-cashback-v2-tx.mjs --mint <PUBKEY> --user <PUBKEY>` |

## 9. USDC enablement gate

As of the 2026-05-07 announcement, USDC enablement is pending; verify current state via `docs/mainnet-verification-report.md` (produced by a sibling effort) or by reading `Global.whitelistedQuoteMints` directly from the on-chain global account. Do not assume USDC is live based on the announcement alone.

## 10. October 2026: v3 trades, multi-hop and held fees

The October 2026 release (`@pump-fun/pump-sdk` 4.0.0, `@pump-fun/pump-swap-sdk` 2.1.0) adds a third generation of bonding-curve trades, a cross-venue router and AMM v2 trades. Upstream docs: [pump-public-docs/docs/instructions/BUY.md](../pump-public-docs/docs/instructions/BUY.md), [SELL.md](../pump-public-docs/docs/instructions/SELL.md), [SWEEP_FEES.md](../pump-public-docs/docs/instructions/SWEEP_FEES.md) and [PUMP_SWAP_README.md](../pump-public-docs/docs/PUMP_SWAP_README.md).

| Instruction | Program | TS helper | Local script |
|---|---|---|---|
| `buy_v3` | pump | `PUMP_SDK.buyV3Instructions` | [swap/scripts/build-buy-bonding-v3-tx.mjs](../swap/scripts/build-buy-bonding-v3-tx.mjs) |
| `buy_exact_quote_in_v3` | pump | `PUMP_SDK.buyExactQuoteInV3Instructions` | `build-buy-bonding-v3-tx.mjs --exact-quote-in` |
| `sell_v3` | pump | `PUMP_SDK.sellV3Instructions` | [swap/scripts/build-sell-bonding-v3-tx.mjs](../swap/scripts/build-sell-bonding-v3-tx.mjs) |
| `multi_hop_swap` | pump-amm | `PUMP_SDK.multiHopSwapInstructions` | [swap/scripts/build-multi-hop-swap-tx.mjs](../swap/scripts/build-multi-hop-swap-tx.mjs) |
| `buy_v2` / `sell_v2` | pump-amm | `PUMP_AMM_SDK.buyQuoteInput(..., { v2: true })` etc. | `build-buy-amm-tx.mjs --v2`, `build-sell-amm-tx.mjs --v2` |
| `sweep_creator_fee` | pump | `PUMP_SDK.sweepCreatorFeeInstruction` | inside the coin-fees scripts |
| `sweep_creator_fee` | pump-amm | `PUMP_SDK.sweepPoolCreatorFeeInstruction` | inside the coin-fees scripts |
| `sweep_protocol_fee` | pump | `PUMP_SDK.sweepProtocolFeeInstruction` | `PumpTradeClient.buildSweepCurveFeesInstructions` |

**v3 trades** price exactly like v2 but hold the fees on the curve: only the buyback slice leaves in the trade, and `BondingCurve.creatorFee` / `protocolFees` accumulate until a permissionless sweep. Each takes 17 accounts and costs roughly 45k CU (simulated on mainnet). Cashback coins are refused with 6094 `CashbackCoinNotSupported`; keep them on v2. Quote buys with `getBuyV3TokenAmountFromQuoteAmount` / `getBuyV3QuoteAmountFromTokenAmount`, which take `curveBaseTokenBalance` from `OnlinePumpSdk.fetchBuyState` and price the post-completion leg when a buy runs past the remaining supply.

**AMM v2 trades** do the same on a pool: fees are booked into `Pool.protocolFees` / `Pool.creatorFees`, and `Pool.virtualQuoteReserves` (now a signed `i128`) is lowered by the held amount so it never prices as liquidity. Let the SDK compute effective reserves; anyone pricing a pool by hand must add the signed value to the quote vault balance ([NEGATIVE_VIRTUAL_QUOTE_RESERVES.md](../pump-public-docs/docs/NEGATIVE_VIRTUAL_QUOTE_RESERVES.md)).

**Multi-hop** routes an exact-in swap through any chain of pump curves and canonical pools, charging the protocol fee once and the creator fee once. Resolve with `OnlinePumpSdk.resolveMultiHopRoute(path, side)`, quote with `simulateMultiHopSwap`, then build with `minAmountOut` below the simulated output. It takes 16 accounts plus 5 per hop and about 200k CU per hop; routes past three hops need an address lookup table.

**Sweep before you redirect fees.** While a bucket holds fees, `distribute_creator_fees`, `admin_cto`, `create_fee_sharing_config` and `update_fee_shares` fail (pump 6095, pump-amm 6081, pump-fees 6033). Put the sweep first in the same transaction. `OnlinePumpSdk.buildDistributeCreatorFeesInstructions` does it for distributions; `collectCoinCreatorFeeInstructions` does not, so [coin-fees/scripts/build-collect-fee-tx.mjs](../coin-fees/scripts/build-collect-fee-tx.mjs) prepends it. Details in [coin-fees/SKILL.md](../coin-fees/SKILL.md).

The TypeScript client exposes the same paths: `PumpTradeClient.buildBuyV3Instructions`, `buildBuyExactQuoteInV3Instructions`, `buildSellV3Instructions`, `buildMultiHopSwapInstructions` and `buildSweepCurveFeesInstructions` in [src/solana/PumpTradeClient.ts](../src/solana/PumpTradeClient.ts).
