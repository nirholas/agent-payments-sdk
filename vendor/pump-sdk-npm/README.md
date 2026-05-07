# Pump SDK

Official Pump program SDK

# Updates

## One-Time Creator Reward Distribution Policy

This update only affects fee-sharing configuration. Trading instructions are unchanged and do not require an upgrade.


**TLDR:** After the first configuration, reward distribution is locked and cannot be changed.

What changed:
- Reward distribution can be configured **only once**.
- You can configure it using either `updateFeeShares` or `updateSharingConfigWithSocialRecipients`.
- After it is configured, it is **locked** and cannot be changed again.

What did **not** change:
- Buy and sell instructions are unchanged.

Migration/compatibility notes:
- Reward distributions created before this policy are treated as final (locked).
- `RevokeFeeSharingAuthority` and `TransferFeeSharingAuthority` are no longer supported.
- If you are unsure whether a reward distribution is still editable, call `isSharingConfigEditable`.

```Typescript
import { isSharingConfigEditable } from "@pump-fun/pump-sdk";
```

# Usage

```Typescript
const connection = new Connection(
    "https://api.devnet.solana.com",
    "confirmed",
);
const sdk = new PumpSdk(connection);
```

## Coin creation

```Typescript
const mint = PublicKey.unique();
const creator = PublicKey.unique();
const user = PublicKey.unique();

const instruction = await sdk.createInstruction({
    mint,
    name: "name",
    symbol: "symbol",
    uri: "uri",
    creator,
    user,
});

// or creating and buying instructions in the same tx

const global = await sdk.fetchGlobal();
const solAmount = new BN(0.1 * 10 ** 9); // 0.1 SOL

const instructions = await sdk.createAndBuyInstructions({
    global,
    mint,
    name: "name",
    symbol: "symbol",
    uri: "uri",
    creator,
    user,
    solAmount,
    amount: getBuyTokenAmountFromSolAmount(global, null, solAmount),
});
```

## Buying coins

```Typescript
const mint = PublicKey.unique();
const user = PublicKey.unique();

const global = await sdk.fetchGlobal();
const { bondingCurveAccountInfo, bondingCurve, associatedUserAccountInfo } =
    await sdk.fetchBuyState(mint, user);
const solAmount = new BN(0.1 * 10 ** 9); // 0.1 SOL

const instructions = await sdk.buyInstructions({
    global,
    bondingCurveAccountInfo,
    bondingCurve,
    associatedUserAccountInfo,
    mint,
    user,
    solAmount,
    amount: getBuyTokenAmountFromSolAmount(global, bondingCurve, solAmount),
    slippage: 1,
});
```

## Selling coins

```Typescript
const mint = PublicKey.unique();
const user = PublicKey.unique();

const global = await sdk.fetchGlobal();
const { bondingCurveAccountInfo, bondingCurve } = await sdk.fetchSellState(mint, user);
const amount = new BN(15_828);

const instructions = await sdk.sellInstructions({
    global,
    bondingCurveAccountInfo,
    bondingCurve,
    mint,
    user,
    amount,
    solAmount: getSellSolAmountFromTokenAmount(global, bondingCurve, amount),
    slippage: 1,
});
```

## Creator fees

```Typescript
const user = PublicKey.unique();

// Getting total accumulated creator fees for both Pump and PumpSwap programs
console.log((await sdk.getCreatorVaultBalanceBothPrograms(user)).toString());

// Collecting creator fees instructions
const instructions = await sdk.collectCoinCreatorFeeInstructions(user);
```

## Fee Sharing

Fee sharing allows token creators to set up fee distribution to multiple shareholders. The `OnlinePumpSdk` provides methods to check distributable fees and distribute them.

> **Important:** Reward split can be setup once and once only by calling either `updateFeeShares` or `updateSharingConfigWithSocialRecipients`. Double-check final recipients and `shareBps` before submitting.

```Typescript
import { OnlinePumpSdk } from "@pump-fun/pump-sdk";

const connection = new Connection(
    "https://api.devnet.solana.com",
    "confirmed",
);
const onlineSdk = new OnlinePumpSdk(connection);
const mint = new PublicKey("...");
```

### Check if Creator Has Migrated to Fee Sharing

Before checking or distributing fees, verify that the coin creator has set up fee sharing:

```Typescript
const usingSharingConfig = isCreatorUsingSharingConfig({ mint, creator });

if (!usingSharingConfig) {
    console.log("Creator has not set up fee sharing");
    return;
}

// Creator has migrated, proceed with fee distribution
```

### Get Minimum Distributable Fee

Check whether a coin's fee sharing configuration balance and distributable fees

```Typescript
const result = await onlineSdk.getMinimumDistributableFee(mint);

console.log("Minimum required:", result.minimumRequired.toString());
console.log("Distributable fees:", result.distributableFees.toString());
console.log("Can distribute:", result.canDistribute);
console.log("Is graduated:", result.isGraduated);
```

This method handles both graduated (AMM) and non-graduated (bonding curve) tokens. For graduated tokens, it automatically consolidates fees from the AMM vault before calculating.

### Distribute Creator Fees

Build instructions to distribute accumulated creator fees to shareholders:

```Typescript
const { instructions, isGraduated } = await onlineSdk.buildDistributeCreatorFeesInstructions(mint);

// instructions contains:
// - For graduated tokens: transferCreatorFeesToPump + distributeCreatorFees
// - For non-graduated tokens: distributeCreatorFees only

// Add instructions to your transaction
const tx = new Transaction().add(...instructions);
```

This method automatically handles graduated tokens by including the `transferCreatorFeesToPump` instruction to consolidate fees from the AMM vault before distributing.

## GitHub Recipient and Social Fee PDA Requirements

If you are adding a **GitHub recipient** as a fee recipient in sharing config, make sure to initialize the social fee pda before adding it as a recipient. Use one of these methods:

```ts
import {
  Platform,
  PUMP_SDK,
} from "@pump-fun/pump-sdk";

// 1) Update an existing sharing config
await PUMP_SDK.updateSharingConfigWithSocialRecipients({
  authority,
  mint,
  currentShareholders,
  newShareholders: [
    { address: authority, shareBps: 7000 },
    { userId: "1234567", platform: Platform.GitHub, shareBps: 3000 },
  ],
});

// 2) Create sharing config + set social recipients in one flow
//    - Use pool for graduated coins or null for ungraduated
await PUMP_SDK.createSharingConfigWithSocialRecipients({
  creator,
  mint,
  pool,
  newShareholders: [
    { address: creator, shareBps: 7000 },
    { userId: "1234567", platform: Platform.GitHub, shareBps: 3000 },
  ],
});
```

Method selection:
- `updateSharingConfigWithSocialRecipients`: use when sharing config already exists.
- `createSharingConfigWithSocialRecipients`: use for first-time setup (creates config, then updates shares).

Important:
- Social fee PDA creation is a one-time initialization per `(userId, platform)` and can be reused across coins once created.
- Reward split can be setup once and once only by calling either `updateFeeShares` or `updateSharingConfigWithSocialRecipients`. Double-check final recipients and `shareBps` before submitting.

✅ Checklist

- [ ] The GitHub user must be able to log in to claim fees. **GitHub organizations are not supported** for social fee recipients; adding an organization account can result in fees being permanently lost.
- [ ] Only `Platform.GitHub` is supported. Any attempt to use a different platform value can result in the coin being banned or **fees lost**.
- [ ] Fees in a GitHub vault can only be claimed by the linked GitHub user, and only through Pump.fun (web or mobile). You are responsible for directing users to claim there; we do not support any claim flow outside our apps.
- [ ] You have initialized the social fee recipient pda by using one of the above helper or `createSocialFeePda`
