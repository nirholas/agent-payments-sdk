# v2 Trading Reference

Reference for the 2026-05-07 pump-program upgrade and the v2 trading instructions it shipped. Sources: the IDL at [pump-public-docs/idl/pump.json](../pump-public-docs/idl/pump.json), the Rust client at [vendor/pump-rust-client/src/sdk/pump_v2.rs](../vendor/pump-rust-client/src/sdk/pump_v2.rs), and the vendored npm SDK at [vendor/pump-sdk-npm/src/sdk.ts](../vendor/pump-sdk-npm/src/sdk.ts).

## 1. The 2026-05-07 upgrade

The pump program (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`) shipped a non-breaking upgrade introducing five new instructions: `buy_v2`, `sell_v2`, `buy_exact_quote_in_v2`, `claim_cashback_v2`, and `create_v2`. The legacy `buy`, `sell`, `create`, and `claim_cashback` instructions remain valid; existing coins continue to trade on those paths until they are migrated. The upgrade also enlarges the `BondingCurve` account and adds a `quoteMint` field so the same instructions can drive USDC-paired coins as well as the existing wSOL-paired coins.

## 2. New instructions

Discriminators and arg lists are extracted directly from [pump-public-docs/idl/pump.json](../pump-public-docs/idl/pump.json). TS helper names are from `PumpSdk` in [vendor/pump-sdk-npm/src/sdk.ts](../vendor/pump-sdk-npm/src/sdk.ts) (the published `@pump-fun/pump-sdk` 1.35.x).

| Instruction | Discriminator | Args | TS helper | Local script |
|---|---|---|---|---|
| `buy_v2` | `[184, 23, 238, 97, 103, 197, 211, 61]` | `amount: u64`, `max_sol_cost: u64` | `PumpSdk.buyV2Instructions` | [swap/scripts/build-buy-bonding-v2-tx.mjs](../swap/scripts/build-buy-bonding-v2-tx.mjs) |
| `sell_v2` | `[93, 246, 130, 60, 231, 233, 64, 178]` | `amount: u64`, `min_sol_output: u64` | `PumpSdk.sellV2Instructions` | [swap/scripts/build-sell-bonding-v2-tx.mjs](../swap/scripts/build-sell-bonding-v2-tx.mjs) |
| `buy_exact_quote_in_v2` | `[194, 171, 28, 70, 104, 77, 91, 47]` | `spendable_quote_in: u64`, `min_tokens_out: u64` | (none — see §6) | [swap/scripts/build-buy-exact-quote-in-v2-tx.mjs](../swap/scripts/build-buy-exact-quote-in-v2-tx.mjs) |
| `claim_cashback_v2` | `[122, 243, 204, 65, 94, 116, 29, 55]` | (none) | `PumpSdk.claimCashbackV2Instruction` | [swap/scripts/build-claim-cashback-v2-tx.mjs](../swap/scripts/build-claim-cashback-v2-tx.mjs) |
| `create_v2` | `[214, 144, 76, 236, 95, 139, 49, 180]` | `name: string`, `symbol: string`, `uri: string`, `creator: pubkey`, `is_mayhem_mode: bool`, `is_cashback_enabled: OptionBool` | `PumpSdk.createV2Instruction` | [create-coin/scripts/](../create-coin/scripts/) |

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

The new account size is `BONDING_CURVE_NEW_SIZE = 151` bytes. The pre-upgrade layout is `BONDING_CURVE_OLD_SIZE = 115` bytes (8-byte discriminator + 107 data bytes). Both constants are exported from [src/solana/index.ts](../src/solana/index.ts):

```ts
import { BONDING_CURVE_OLD_SIZE, BONDING_CURVE_NEW_SIZE } from "@nirholas/agent-payments-sdk/solana";
// BONDING_CURVE_OLD_SIZE === 115  (pre-v2 layout)
// BONDING_CURVE_NEW_SIZE === 151  (post-2026-05-07 layout)
```

Use these named exports for size-based discrimination rather than hardcoding the integers.

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

- **Regular** — `Global.feeRecipient` plus `Global.feeRecipients[]`, randomly selected. In mayhem mode the program reads `Global.reservedFeeRecipient` plus `Global.reservedFeeRecipients[]` instead. See `pickFeeRecipient` in [swap/scripts/lib/fee-recipients.mjs](../swap/scripts/lib/fee-recipients.mjs).
- **Buyback** — a static eight-pubkey list embedded in the SDK's compiled JS (`CURRENT_FEE_RECIPIENTS_FOR_BUYBACK`). The list is mirrored verbatim as `BUYBACK_FEE_RECIPIENTS` at [swap/scripts/lib/fee-recipients.mjs](../swap/scripts/lib/fee-recipients.mjs); `pickBuybackFeeRecipient` picks one at random. The pump-sdk export is `getStaticRandomFeeRecipientForBuyback`.

## 6. `buy_exact_quote_in_v2`

The vendored npm SDK at [vendor/pump-sdk-npm/src/sdk.ts](../vendor/pump-sdk-npm/src/sdk.ts) does not expose a `buyExactQuoteIn*` helper. The instruction must be driven by talking to the Anchor program directly: build the account list, pass `spendable_quote_in` and `min_tokens_out`, and submit. The local script [swap/scripts/build-buy-exact-quote-in-v2-tx.mjs](../swap/scripts/build-buy-exact-quote-in-v2-tx.mjs) does exactly this. The canonical reference for the account wiring is the Rust helper `buy_exact_quote_in_v2_instruction` at [vendor/pump-rust-client/src/sdk/pump_v2.rs](../vendor/pump-rust-client/src/sdk/pump_v2.rs) line 281.

## 7. TS samples

These samples rely on `@pump-fun/pump-sdk@1.35.x` — they are not surfaces of `@nirholas/agent-payments-sdk` itself, but they are the canonical pump-program clients used by the local scripts.

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
| [swap/scripts/build-buy-exact-quote-in-v2-tx.mjs](../swap/scripts/build-buy-exact-quote-in-v2-tx.mjs) | `node swap/scripts/build-buy-exact-quote-in-v2-tx.mjs --mint <PUBKEY> --user <PUBKEY> --quote-in <int>` |
| [swap/scripts/build-claim-cashback-v2-tx.mjs](../swap/scripts/build-claim-cashback-v2-tx.mjs) | `node swap/scripts/build-claim-cashback-v2-tx.mjs --mint <PUBKEY> --user <PUBKEY>` |

## 9. USDC enablement gate

As of the 2026-05-07 announcement, USDC enablement is pending; verify current state via `docs/mainnet-verification-report.md` (produced by a sibling effort) or by reading `Global.whitelistedQuoteMints` directly from the on-chain global account. Do not assume USDC is live based on the announcement alone.
