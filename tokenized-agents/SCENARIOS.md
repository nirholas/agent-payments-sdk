# Tokenized-agent end-to-end scenarios

Each scenario walks one realistic flow from pre-state to post-state, with the
exact CLI invocation, account tables for the on-chain ix, and the post-state
checks an agent should run before considering the step done.

All file references are relative to the SDK root. Authoritative IDL sources:
[`src/solana/idl/pump_agent_payments.json`](../src/solana/idl/pump_agent_payments.json)
(3.0.x) and [`src/solana/legacy-agent-payments/idl.json`](../src/solana/legacy-agent-payments/idl.json)
(1.0.7).

---

## Scenario 1 — SOL-paired tokenized agent on the 3.0.x program

This is the modern default. A creator launches a Token-2022 coin with an
attached tokenized agent, accepts a SOL payment from a user, distributes the
payment, and the protocol's buyback authority later triggers a buyback that
swaps wSOL → coin and burns the result.

### Pre-state assumptions

- `SOLANA_RPC_URL` is set to a non-public mainnet-beta RPC that supports
  `sendTransaction` (e.g. `https://rpc.solanatracker.io/public`).
- The creator wallet has at least `0.01 SOL` for rent + initial buy.
- The buyer wallet has at least the invoice amount + tx fees.
- `Global.whitelisted_quote_mints` on `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`
  includes `So11111111111111111111111111111111111111112` (always true on
  mainnet — wSOL is the default quote).
- `GlobalConfig.supported_currencies_mint` on `AgenTMiC2hvxGebTsgmsD4HHBa8WEcqGFf87iwRRxLo7`
  includes wSOL (always true on mainnet).

### Step 1 — Create the coin and register the agent in one transaction

Use [`create-coin/scripts/build-create-coin-tx.mjs`](../create-coin/scripts/build-create-coin-tx.mjs).
The `--tokenized-agent` flag appends a 3.0.x `agent_initialize` ix after the
pump `create_v2 + buy` pair.

```bash
cd create-coin
node scripts/build-create-coin-tx.mjs \
  --user 7s5g...creatorPubkey \
  --name "ChartBot" \
  --symbol "CHB" \
  --metadata-uri https://ipfs.io/ipfs/QmExampleMetadataCid \
  --sol-lamports 1000000 \
  --mint-keypair-out ./mint-CHB.json \
  --tokenized-agent --buyback-bps 5000
```

The script writes a JSON line to stdout:

```json
{
  "transaction": "<base64 partial-signed VersionedTransaction>",
  "mintPublicKey": "9PUMPexampleMintPublicKey...",
  "mintKeypairPath": "./mint-CHB.json",
  "quoteTokenAmount": "...",
  "quoteAmount": "1000000",
  "quoteMint": "So11111111111111111111111111111111111111112",
  "solLamports": "1000000",
  "mayhemMode": false,
  "cashback": false,
  "tokenizedAgent": true,
  "buybackBps": 5000,
  "frontRunnerProtection": false
}
```

The bundle of instructions inside `transaction` is, in order:

1. ComputeBudget `SetComputeUnitLimit`.
2. `create_v2` on `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` — initializes
   the bonding-curve PDA (151B v2 layout, `quote_mint = wSOL`).
3. `createAssociatedTokenAccountIdempotent` for the creator's base ATA
   (Token-2022).
4. `buy` on the bonding curve — converts the `--sol-lamports` amount into
   token-2022 base tokens for the creator.
5. `agent_initialize` on `AgenTMiC2hvxGebTsgmsD4HHBa8WEcqGFf87iwRRxLo7`
   (accounts table: see [`SKILL.md`](SKILL.md#agent_initialize)) with
   `authority = creator`, `buyback_bps = 5000`.

Have the creator wallet sign the partial-signed transaction and submit:

```js
import { Connection, VersionedTransaction } from "@solana/web3.js";

const conn = new Connection(process.env.SOLANA_RPC_URL, "confirmed");
const txBytes = Buffer.from(jsonOut.transaction, "base64");
const vtx = VersionedTransaction.deserialize(txBytes);
await wallet.signTransaction(vtx);
const sig = await conn.sendRawTransaction(vtx.serialize(), {
  skipPreflight: false,
  preflightCommitment: "confirmed",
  encoding: "base64",
});
await conn.confirmTransaction(sig, "confirmed");
```

### Post-state verification — Step 1

Read these accounts and assert each invariant:

| Account | Derivation | Expected after Step 1 |
|---|---|---|
| Bonding curve | `[b"bonding-curve", mint]` on `6EF8...` | exists, length 151 bytes, `quote_mint = wSOL`, `complete = false`. |
| Token agent payments | `[b"token-agent-payments", mint]` on `AgenTMiC...` | exists, `mint = <new mint>`, `authority = creator`, `buyback_bps = 5000`. |
| Global config | `[b"global-config"]` on `AgenTMiC...` | `tokenized_agent_sequence` incremented by 1 vs the value pre-tx. |

```ts
import { Connection, PublicKey } from "@solana/web3.js";
import {
  PUMP_AGENT_PAYMENTS_PROGRAM_ID,
  getTokenAgentPaymentsPDA,
  PumpAgentOffline,
} from "@nirholas/agent-payments-sdk";

const mint = new PublicKey(jsonOut.mintPublicKey);
const conn = new Connection(process.env.SOLANA_RPC_URL);
const [agentPda] = getTokenAgentPaymentsPDA(mint);
const info = await conn.getAccountInfo(agentPda);
if (!info) throw new Error("agent record missing");
if (!info.owner.equals(PUMP_AGENT_PAYMENTS_PROGRAM_ID)) {
  throw new Error("agent record on wrong program");
}
```

### Step 2 — User pays an invoice in SOL

The creator's app generates an invoice and asks the buyer to pay it. Use
`PumpAgentOffline.buildAcceptPaymentInstructions` so wSOL wrap/unwrap is
handled automatically.

```ts
import { Connection, PublicKey, Transaction } from "@solana/web3.js";
import { NATIVE_MINT } from "@solana/spl-token";
import { PumpAgentOffline } from "@nirholas/agent-payments-sdk";

const conn = new Connection(process.env.SOLANA_RPC_URL);
const agent = PumpAgentOffline.load(mint, conn);

const invoice = {
  user: buyerPubkey,
  currencyMint: NATIVE_MINT,
  amount: 1_000_000n,            // 0.001 SOL
  memo: BigInt(Math.floor(Math.random() * 1e12) + 1e6),
  startTime: BigInt(Math.floor(Date.now() / 1000)),
  endTime:   BigInt(Math.floor(Date.now() / 1000) + 86_400),
};

const ixs = await agent.buildAcceptPaymentInstructions(invoice);

const { blockhash } = await conn.getLatestBlockhash("confirmed");
const tx = new Transaction({ feePayer: buyerPubkey, recentBlockhash: blockhash });
tx.add(...ixs);
// buyer signs and submits...
```

The instruction sequence inside `ixs` for SOL payments is:

1. `SetComputeUnitLimit` (default 100k).
2. `createAssociatedTokenAccountIdempotent` for the buyer's wSOL ATA.
3. SystemProgram `transfer` of `amount` lamports into the wSOL ATA.
4. `syncNative` on the wSOL ATA.
5. `agent_accept_payment` (account table:
   [`SKILL.md`](SKILL.md#agent_accept_payment)).
6. `closeAccount` on the wSOL ATA (returns rent + any leftover wSOL).

### Post-state verification — Step 2

| Account | Derivation | Expected |
|---|---|---|
| Invoice ID | `[b"invoice-id", mint, currency_mint, amount, memo, start_time, end_time]` on `AgenTMiC...` | exists. |
| Payment in currency | `[b"payment-in-currency", agent, currency_mint]` on `AgenTMiC...` (an ATA) | balance increased by `amount`. |
| Buyer wSOL ATA | derived | does not exist (closed at end of tx). |

```ts
const ok = await agent.validateInvoicePayment({
  user: buyerPubkey,
  currencyMint: NATIVE_MINT,
  amount: Number(invoice.amount),
  memo: Number(invoice.memo),
  startTime: Number(invoice.startTime),
  endTime: Number(invoice.endTime),
});
if (!ok) throw new Error("payment not landed yet — retry");
```

### Step 3 — Distribute the accumulated payments

`agent_distribute_payments` is permissionless. Anyone (creator, a cron job,
the protocol) can run it to split the per-currency payment vault into
`buyback_vault` and `withdraw_vault` according to `buyback_bps`.

```ts
const ix = await agent.distributePayments({
  user: callerPubkey,
  currencyMint: NATIVE_MINT,
});
```

Account ordering matches [`SKILL.md`](SKILL.md#agent_distribute_payments).

### Post-state verification — Step 3

| Account | Expected |
|---|---|
| `token_agent_payment_in_currency` | balance = 0. |
| `buyback_vault` | balance = `previous_balance * buyback_bps / 10000`. |
| `withdraw_vault` | balance = `previous_balance * (10000 - buyback_bps) / 10000`. |

### Step 4 — Buyback trigger (admin-only)

This step is performed by the protocol's `global_buyback_authority`, not the
creator. The buyback transaction:

1. Reads the `buyback_vault` (wSOL).
2. CPIs into the allow-listed Jupiter program with caller-supplied
   `swap_instruction_data` to swap wSOL → coin.
3. Verifies the agent mint balance increased (else `SwapFailedAmountDidNotIncrease`).
4. CPIs into spl-token to burn the new tokens.

The bundled SDK exposes `PumpAgentOffline.buybackTrigger(...)` for callers who
hold the buyback authority key. Wallet UIs must NEVER offer to sign this — see
[`WALLET_INTEGRATION.md`](WALLET_INTEGRATION.md).

### Post-state verification — Step 4

| Account | Expected |
|---|---|
| `buyback_vault` (wSOL) | balance = 0. |
| Mint supply | decreased by the burned amount. |
| `burn_mint_vault` | balance = 0. |

---

## Scenario 2 — Legacy 1.0.7 tokenized agent

A coin was created via `pump-sdk`'s `createV2AndBuyInstructions` with
`isTokenizedAgent: true`. The agent record lives on
`pUmPFn9WvfaN2WTVGnCEtJTd2ATTpvpsKRz6jVzu6u4`. All operations must use the
`legacyAgentPayments` namespace from `@nirholas/agent-payments-sdk`.

### Pre-state assumptions

- The `tokenAgentPayments` PDA exists on `pUmPFn9...` (not on `AgenTMiC...`).
- Use `legacyAgentPayments.LegacyPumpAgentOffline` (see
  [`src/solana/legacy-agent-payments/PumpAgentOffline.ts`](../src/solana/legacy-agent-payments/PumpAgentOffline.ts)).

### Step 1 — Create the coin via pump-sdk directly

```ts
import { PumpSdk } from "@pump-fun/pump-sdk";
import { Connection, Keypair, PublicKey, VersionedTransaction } from "@solana/web3.js";

const conn = new Connection(process.env.SOLANA_RPC_URL);
const sdk = new PumpSdk(conn);
const mintKp = Keypair.generate();
const global = await sdk.fetchGlobal();

const ixs = await sdk.createV2AndBuyInstructions({
  global,
  mint: mintKp.publicKey,
  name: "LegacyBot",
  symbol: "LGB",
  uri: "https://ipfs.io/ipfs/Qm...",
  creator: creator.publicKey,
  user: creator.publicKey,
  amount: new BN(0),                  // first-buy token amount estimated by SDK
  solAmount: new BN(1_000_000),        // 0.001 SOL
  mayhemMode: false,
  isTokenizedAgent: true,
  buyBackBps: 5000,
});
// Build VersionedTransaction, partial-sign with mintKp, then creator signs and sends.
```

The 5th instruction is `agent_initialize` on `pUmPFn9...` (because `pump-sdk@1.35.0`
imports `@pump-fun/agent-payments-sdk@1.0.7` transitively). Do NOT also append
a 3.0.x `agent_initialize` — only one program can hold the agent record.

### Post-state verification — Step 1

| Account | Derivation | Expected |
|---|---|---|
| Token agent payments | `[b"token-agent-payments", mint]` on `pUmPFn9...` | exists. |
| Token agent payments | `[b"token-agent-payments", mint]` on `AgenTMiC...` | does NOT exist. |

```ts
import { legacyAgentPayments } from "@nirholas/agent-payments-sdk";
const [legacyPda] = legacyAgentPayments.getTokenAgentPaymentsPDA(mintKp.publicKey);
const info = await conn.getAccountInfo(legacyPda);
if (!info) throw new Error("legacy agent record missing");
if (info.owner.toBase58() !== "pUmPFn9WvfaN2WTVGnCEtJTd2ATTpvpsKRz6jVzu6u4") {
  throw new Error("agent record on wrong program");
}
```

### Step 2 — Accept payment, distribute, withdraw

The 1.0.7 API mirrors 3.0.x for the four shared operations
(`acceptPayment`, `distributePayments`, `withdraw`, `buybackTrigger`) but
exposes them via `LegacyPumpAgentOffline`:

```ts
import { legacyAgentPayments } from "@nirholas/agent-payments-sdk";
const { LegacyPumpAgentOffline } = legacyAgentPayments;

const agent = LegacyPumpAgentOffline.load(mint, conn);

const acceptIxs = await agent.buildAcceptPaymentInstructions({
  user: buyerPubkey,
  currencyMint: NATIVE_MINT,
  amount: 1_000_000n,
  memo: 12345n,
  startTime: BigInt(Math.floor(Date.now() / 1000)),
  endTime: BigInt(Math.floor(Date.now() / 1000) + 86_400),
});

// after the buyer pays:
const distributeIx = await agent.distributePayments({
  user: callerPubkey,
  currencyMint: NATIVE_MINT,
});

const withdrawIx = await agent.withdraw({
  authority: creator.publicKey,
  currencyMint: NATIVE_MINT,
  receiverAta: creatorWsolAta,
});
```

### Post-state verification — Step 2

Identical to Scenario 1 Steps 2–3 post-state checks, except every PDA derives
under program `pUmPFn9...` instead of `AgenTMiC...`.

### API differences vs 3.0.x

| Capability | 3.0.x | 1.0.7 |
|---|---|---|
| `agent_transfer_extra_lamports` | available | absent — stray lamports cannot be swept; they accumulate on the agent record. |
| `global_remove_currency` | available (admin-only) | absent — once a currency is added it stays for the lifetime of `global_config`. |
| Discriminator naming | snake_case (`agent_initialize`) | camelCase (`agentInitialize`) — the wire-level Anchor discriminator differs because Anchor hashes the name. |
| Error names | PascalCase (`UnauthorizedSigner`) | camelCase (`unauthorizedSigner`) — same numeric codes (6000–6013). |

### Failure modes specific to legacy

- Calling 3.0.x's `PumpAgentOffline.acceptPayment` against a coin whose agent
  lives on 1.0.7 returns an `Account does not exist` from the RPC because the
  3.0.x code derives the agent PDA under `AgenTMiC...`, where there is no
  account. Always run dual-program detection first
  ([`WALLET_INTEGRATION.md`](WALLET_INTEGRATION.md)).
- The 1.0.7 `agent_buyback_trigger` predates the v2 bonding curve. If the
  swap leg routes directly through the pump program, the caller's
  `swap_instruction_data` MUST encode a v2 buy when the curve has been
  migrated — see Scenario 4.

---

## Scenario 3 — USDC-paired tokenized agent on the 3.0.x program

A creator wants payments and buybacks denominated in USDC. The coin's
bonding curve uses USDC as `quote_mint`; the agent-payments program treats
USDC as `currency_mint`.

### Pre-state assumptions

- USDC mint: `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` (mainnet-beta).
- USDC must appear in `Global.whitelisted_quote_mints` on the pump program AND
  in `GlobalConfig.supported_currencies_mint` on the 3.0.x agent-payments
  program. Both lists are admin-managed; if either is missing, the
  corresponding ix fails (`CurrencyNotSupported` on agent-payments, an account-
  resolution failure on pump). Confirm both lists before attempting; the
  current mainnet contents change over time. **unverified — requires source
  review**: a `docs/mainnet-verification-report.md` was referenced in the
  rewrite spec but does not exist in this branch as of this commit. When that
  report lands, link it from here.

### Step 1 — Create the USDC-paired coin

The script auto-routes through `createV2AndBuyV2Instructions` when
`--quote-mint` is non-SOL.

```bash
cd create-coin
node scripts/build-create-coin-tx.mjs \
  --user 7s5g...creator \
  --name "UsdcBot" \
  --symbol "UBT" \
  --metadata-uri https://ipfs.io/ipfs/Qm... \
  --sol-lamports 0 \
  --quote-mint EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v \
  --mint-keypair-out ./mint-UBT.json \
  --tokenized-agent --buyback-bps 5000
```

For USDC pairs, `--sol-lamports` is interpreted as the **quote amount in USDC
base units** for the initial buy (USDC has 6 decimals — `1000000` = `1 USDC`).
Set it to `0` to skip the initial buy if your launch flow doesn't need one.

Resulting instruction order:

1. `SetComputeUnitLimit`.
2. `create_v2` on the pump program with `quote_mint = USDC`. The bonding curve
   PDA is initialized at the v2 layout (151B).
3. ATA creation for the creator's USDC and base-token ATAs.
4. `buy_v2` (skipped if `--sol-lamports 0`).
5. `agent_initialize` on `AgenTMiC...` — the same ix as Scenario 1; the
   currency choice does not affect this ix.

### Post-state verification — Step 1

Same as Scenario 1 Step 1, plus:

| Account | Field | Expected |
|---|---|---|
| `BondingCurve` | `quote_mint` | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`. |
| `BondingCurve` | size | 151 bytes (v2 layout). |

### Step 2 — Accept a USDC payment

```ts
import { PumpAgentOffline } from "@nirholas/agent-payments-sdk";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

const USDC = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const agent = PumpAgentOffline.load(mint, conn);

const ixs = await agent.buildAcceptPaymentInstructions({
  user: buyerPubkey,
  currencyMint: USDC,
  amount: 5_000_000n,             // 5 USDC
  memo: BigInt(Math.floor(Math.random() * 1e12) + 1e6),
  startTime: BigInt(Math.floor(Date.now() / 1000)),
  endTime:   BigInt(Math.floor(Date.now() / 1000) + 86_400),
  tokenProgram: TOKEN_PROGRAM_ID, // USDC is SPL Token, not Token-2022
});
```

Unlike SOL, no wrap/unwrap is needed — the instruction list is just:

1. `SetComputeUnitLimit`.
2. `agent_accept_payment` (USDC moves directly from buyer's USDC ATA into
   `token_agent_payment_in_currency`).

### Post-state verification — Step 2

| Account | Expected |
|---|---|
| Invoice ID PDA | exists. |
| Buyer USDC ATA | balance decreased by `5_000_000`. |
| `token_agent_payment_in_currency` for `(agent, USDC)` | balance increased by `5_000_000`. |

### Step 3 — Distribute and withdraw

Same as Scenario 1 Step 3 with `currencyMint: USDC`. `withdraw_vault` will
hold USDC; `agent_withdraw` moves USDC into a creator-supplied USDC `receiver_ata`.

### Step 4 — Buyback (USDC → coin)

The buyback authority constructs `swap_instruction_data` for a Jupiter route
that takes USDC as input mint and the agent's coin as output mint, instead
of the wSOL→coin swap from Scenario 1. The pump program leg of that route, if
present, is `buy_v2` or `buy_exact_quote_in_v2` (the v2 family — these are
the only buy ix that accept a non-SOL quote — see
[`pump-public-docs/idl/pump.json`](../pump-public-docs/idl/pump.json) and
[`pump-public-docs/docs/instructions/BUY.md`](../pump-public-docs/docs/instructions/BUY.md)).

### Post-state verification — Step 4

| Account | Expected |
|---|---|
| `buyback_vault` (USDC) | balance = 0. |
| Coin mint supply | decreased by burned amount. |

---

## Scenario 4 — Legacy 1.0.7 agent on a coin whose curve migrated to v2

An agent registered against a coin in the pre-2026-05-07 era. The coin's
bonding curve was originally the legacy 129B layout with no `quote_mint`
field. After 2026-05-07, the first `buy_v2` or `sell_v2` against that coin
triggers the curve's migration to the 151B v2 layout (with `quote_mint`
populated). The agent record itself is unaffected — it still lives on
`pUmPFn9...`.

### Pre-state

- `tokenAgentPayments` exists on `pUmPFn9...`.
- `BondingCurve` is 151B (post-migration).
- `BondingCurve.quote_mint = wSOL` (the curve was always SOL-paired, but the
  field was zeroed pre-migration and is now explicitly set).

### What still works without changes

- `agent_accept_payment`, `agent_distribute_payments`, `agent_withdraw`,
  `agent_update_authority`, `agent_update_buyback_bps` on the legacy program
  all read only their own PDAs and the agent's mint. The bonding-curve layout
  change has no effect on them.
- The 1.0.7 `agent_initialize` derived `bonding_curve` as a PDA of the pump
  program (account #1 in the ix). It runs once at registration; after the
  coin exists the account is never re-initialized, so the v2 layout change
  does not retroactively break anything.

### What requires care — `agent_buyback_trigger`

The 1.0.7 buyback ix forwards `swap_instruction_data` verbatim to
`swap_program_to_invoke`. If the route used pre-migration encoded a legacy
`buy` against the bonding curve, that data will now fail with an account-
size or layout error because the curve is 151B and `buy` (as opposed to
`buy_v2`) does not understand the new fields.

To recover, the buyback authority must re-encode the swap leg:

| Curve state | Use this swap leg |
|---|---|
| Legacy 129B (pre-migration) | legacy `buy` on `6EF8...`. |
| v2 151B, `quote_mint = wSOL` | `buy_v2` on `6EF8...`. |
| v2 151B, `quote_mint = USDC` | `buy_v2` or `buy_exact_quote_in_v2` on `6EF8...`. |

In practice, every buyback should now route through Jupiter (or another
aggregator that already abstracts v1/v2 selection), which avoids the need for
the buyback authority to detect curve state directly.

### Post-state verification — buyback after migration

Same as Scenario 1 Step 4. The relevant assertion is that
`SwapFailedAmountDidNotIncrease` (code 6011) does not fire — that error is
the symptom of submitting stale (legacy) swap-leg bytes against a v2 curve.

### Indexer / dashboard updates

- Bonding-curve account decoders must accept both 129B and 151B layouts.
  Sniff on `data.length` before decoding.
- A coin's quote currency is now `BondingCurve.quote_mint` for v2; for
  legacy curves, infer wSOL.
- Agent program ownership is unchanged: legacy agents stay on `pUmPFn9...`
  forever. Do NOT migrate them to `AgenTMiC...` — there is no migration ix,
  and the two PDAs would collide on seeds across programs.

### What does NOT change

| Artifact | Pre-migration | Post-migration |
|---|---|---|
| Agent record program | `pUmPFn9...` | `pUmPFn9...` (unchanged). |
| Agent record fields (`mint`, `authority`, `buyback_bps`) | unchanged. |
| Invoice ID PDA derivation | unchanged. |
| Per-currency payment vault PDA | unchanged. |
| Distribute / withdraw mechanics | unchanged. |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Account does not exist` when calling 3.0.x `acceptPayment` | Agent is on 1.0.7. | Use `legacyAgentPayments.LegacyPumpAgentOffline`. |
| `CurrencyNotSupported` (6004) on `agent_accept_payment` | The `currencyMint` is not in `GlobalConfig.supported_currencies_mint`. | Use a supported currency, or have the protocol authority add it. |
| `InvalidProgramToInvoke` (6009) on `agent_buyback_trigger` | `swap_program_to_invoke` not on allow-list. | Use a Jupiter program ID; check the live allow-list. |
| `SwapFailedAmountDidNotIncrease` (6011) | Swap leg returned without producing tokens (zero out, wrong route, or stale legacy `buy` against a v2 curve). | Re-build `swap_instruction_data` with current curve layout in mind. |
| `PaymentVaultNotEmpty` (6007) on `close_account` or `agent_update_buyback_bps` | A per-currency vault still has balance. | Call `agent_distribute_payments` first. |
| `validateInvoicePayment` returns `false` after a confirmed pay tx | HTTP indexer lag. | Retry with backoff for ~10 seconds; the SDK has an RPC fallback if `Connection` is supplied to `PumpAgentOffline.load`. |
