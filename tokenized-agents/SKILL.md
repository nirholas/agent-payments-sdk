---
name: tokenized-agents
description: >
  Build, register, and operate tokenized-agent payment flows against
  pump.fun. Covers both the legacy 1.0.7 agent-payments program and the
  current 3.0.x program, the v2 bonding-curve trade integration introduced
  on 2026-05-07, USDC-paired coins, and the dual-program detection that
  wallets and indexers must perform.
metadata:
  author: pump-fun
  version: "2.0"
---

## Two agent-payments programs coexist on mainnet

Tokenized-agent state lives in **one of two programs**, depending on which SDK
created the agent. Both are live; neither is deprecated; the choice is fixed at
agent-creation time and cannot be migrated after the fact.

| Program | Pubkey | IDL | Source path |
|---|---|---|---|
| Legacy `1.0.7` | `pUmPFn9WvfaN2WTVGnCEtJTd2ATTpvpsKRz6jVzu6u4` | [`src/solana/legacy-agent-payments/idl.json`](../src/solana/legacy-agent-payments/idl.json) | [`src/solana/legacy-agent-payments/`](../src/solana/legacy-agent-payments/) |
| Current `3.0.x` | `AgenTMiC2hvxGebTsgmsD4HHBa8WEcqGFf87iwRRxLo7` | [`src/solana/idl/pump_agent_payments.json`](../src/solana/idl/pump_agent_payments.json) | [`src/solana/`](../src/solana/) |

Both programs use the **same PDA seeds** for the agent account
(`[b"token-agent-payments", mint]`), but each program owns its own copy. A
single mint therefore has at most one agent record, on exactly one program.

### How a coin's agent ends up on one program or the other

- **Legacy 1.0.7 path.** Calling `pump-sdk`'s
  [`createV2AndBuyInstructions({ isTokenizedAgent: true })`](../vendor/pump-sdk-npm/src/sdk.ts)
  appends an `agent_initialize` ix from `@pump-fun/agent-payments-sdk@1.0.7`,
  which `pump-sdk@1.35.0` pins as a transitive dependency. The resulting agent
  lives on `pUmPFn9...`. This is the historical default for any caller that
  uses `pump-sdk` directly without overriding the agent program.
- **Current 3.0.x path.** Calling `PumpAgentOffline.load(mint).create(...)`
  from `@pump-fun/agent-payments-sdk@3.0.3` produces an `agent_initialize`
  ix on `AgenTMiC...`. The bundled
  [`create-coin/scripts/build-create-coin-tx.mjs`](../create-coin/scripts/build-create-coin-tx.mjs)
  uses this path: it builds the create+buy via `pump-sdk` **without**
  `isTokenizedAgent`, then appends the 3.0.x agent ix manually when the
  `--tokenized-agent` flag is set. Coins created through this script — and
  through the equivalent `POST /agents/create-coin` API — register on
  `AgenTMiC...`.

If a caller passes `isTokenizedAgent: true` to `pump-sdk` **and** appends a
3.0.x ix, the transaction will fail with `account already in use` on the second
attempt (same PDA seeds, different program owners — but the bonding-curve
program does not enforce ownership of the agent PDA, so the first one to run
wins and the second fails on its own program). Pick one path and stick with it.

## Lifecycle of a tokenized agent

The lifecycle below is identical across the two programs except where noted.
All instruction names use the 3.0.x snake_case form; the legacy IDL uses the
same names in camelCase (`agent_initialize` ↔ `agentInitialize`, etc.).

| Stage | Instruction | Trigger | Notes |
|---|---|---|---|
| Registration | `agent_initialize` | Once per mint, at coin creation | Sets `authority` and `buyback_bps` (0–10000). PDA: `[b"token-agent-payments", mint]`. |
| Authority change | `agent_update_authority` | Anytime, signer = current authority | Rotates the agent's admin key. |
| Buyback config | `agent_update_buyback_bps` | Anytime, signer = authority | Adjusts the buyback share of incoming payments. Remaining accounts must list every supported currency's payment-vault ATA so the program can rebalance. |
| Payment intake | `agent_accept_payment` | Per invoice, signer = paying user | Creates the per-invoice PDA (`[b"invoice-id", mint, currency_mint, amount, memo, start_time, end_time]`) and credits `token_agent_payment_in_currency`. Duplicate `(mint, currency_mint, amount, memo, start_time, end_time)` is rejected by the PDA. |
| Distribution | `agent_distribute_payments` | Permissionless | Splits the per-currency vault into `buyback_vault` and `withdraw_vault` according to `buyback_bps`. Must run before withdraw or buyback. |
| Withdraw | `agent_withdraw` | Signer = authority | Pulls from `withdraw_vault` into a receiver ATA. |
| Buyback | `agent_buyback_trigger` | Signer = `global_buyback_authority` only | CPIs into `swap_program_to_invoke` to swap the buyback vault into the agent's mint, then CPIs to `spl-token` to burn the resulting tokens. Wallets must NEVER auto-sign this. |
| Account growth | `extend_account` | Permissionless | Reallocates `token_agent_payments` if the layout changes in a future upgrade. |
| Teardown | `close_account` | Signer = authority | Recovers rent. Vaults must be empty. |

The 3.0.x program adds two instructions that 1.0.7 lacks:

- `agent_transfer_extra_lamports` — sweeps stray lamports from the agent PDA's
  associated account into the agent record. No analogue in 1.0.7.
- `global_remove_currency` — removes a currency from the global supported list.
  1.0.7 only supports `global_add_new_currency`; you cannot un-list a currency
  on the legacy program.

## V2 trade integration with `agent_buyback_trigger`

`agent_buyback_trigger` takes a single `swap_instruction_data: bytes` arg plus
a `swap_program_to_invoke` account. The program does no parsing of the swap
data — it CPIs into the named program with the given bytes, then verifies that
the agent's mint balance increased, then burns it.

Two consequences:

1. The buyback transaction caller chooses the swap program. In production this
   is typically a Jupiter aggregator program ID (verified via the
   `InvalidProgramToInvoke` allow-list maintained by `global_buyback_authority`
   on `global_config`). The agent-payments program itself does not call into
   the bonding curve directly.
2. Because the swap program is opaque to agent-payments, **the swap leg's
   instruction shape is whatever the chosen swap program expects.** If the
   route used by Jupiter (or whatever aggregator) goes through the pump
   bonding curve and that curve has been migrated to v2 (account size 151B,
   `quote_mint` field set on the `BondingCurve` struct — see
   [`pump-public-docs/idl/pump.json`](../pump-public-docs/idl/pump.json) ->
   `BondingCurve`), the swap leg must call `buy_v2` or `buy_exact_quote_in_v2`
   rather than the legacy `buy`. Pre-v2 `buy` against a v2 curve will fail
   with an account-layout mismatch.

For SOL-paired coins (legacy or v2), the swap converts the accumulated wSOL in
the buyback vault into the mint's tokens, then burns them. For USDC-paired
coins, the buyback vault holds USDC base units (6 decimals); the swap goes
USDC → token, then burns.

## Quote-mint vs currency-mint terminology

The two programs use different field names for the same concept. Map them
explicitly when reading or writing accounts:

| Concept | pump bonding-curve program | agent-payments (3.0.x and 1.0.7) |
|---|---|---|
| The non-base side of a trade pair | `quote_mint` (field on `BondingCurve` v2) | `currency_mint` (account on every payment ix) |
| Allow-list of acceptable non-base mints | `Global.whitelisted_quote_mints` | `GlobalConfig.supported_currencies_mint` (`[Pubkey; 10]`) |

For a USDC-paired coin to work end-to-end:
- `USDC` must appear in `Global.whitelisted_quote_mints` on
  `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`, AND
- `USDC` must appear in `GlobalConfig.supported_currencies_mint` on the
  agent-payments program the agent lives on (1.0.7 or 3.0.x).

The two allow-lists are independent and may be out of sync at any time.

## Per-instruction account ordering — 3.0.x program

Account order matches the IDL declaration order in
[`src/solana/idl/pump_agent_payments.json`](../src/solana/idl/pump_agent_payments.json).
"PDA seeds" lists the seeds the program derives from; "owner" identifies the
program that owns the account.

### `agent_initialize`

| # | Account | Writable | Signer | Notes |
|---|---|---|---|---|
| 0 | `authority` | yes | yes | Funder + initial agent authority. |
| 1 | `bonding_curve` | no | no | PDA `[b"bonding-curve", mint]` on `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`. Must already exist (coin must already be created). |
| 2 | `global_config` | yes | no | PDA `[b"global-config"]` on agent-payments. Bumped because `tokenized_agent_sequence` increments. |
| 3 | `mint` | no | no | The coin mint. |
| 4 | `token_agent_payments` | yes | no | PDA `[b"token-agent-payments", mint]`. Created here. |
| 5 | `system_program` | no | no | `11111111111111111111111111111111`. |
| 6 | `event_authority` | no | no | PDA `[b"__event_authority"]`. |
| 7 | `program` | no | no | Self. |

Args: `authority: Pubkey`, `buyback_bps: u16`.

### `agent_accept_payment`

| # | Account | Writable | Signer | Notes |
|---|---|---|---|---|
| 0 | `user` | yes | yes | Payer. |
| 1 | `user_token_account` | yes | no | Payer's `currency_mint` ATA. |
| 2 | `token_agent_payments` | no | no | Agent record PDA. |
| 3 | `token_agent_associated_account` | yes | no | PDA-derived ATA owned by the agent record. |
| 4 | `token_agent_payment_in_currency` | yes | no | PDA per `(agent, currency_mint)` — the payment vault for this currency. |
| 5 | `global_config` | no | no | PDA. |
| 6 | `invoice_id` | no | no | PDA `[b"invoice-id", mint, currency_mint, amount, memo, start_time, end_time]`. Initialized here; collision = duplicate-payment rejection. |
| 7 | `currency_mint` | no | no | The currency the user is paying in. |
| 8 | `token_program` | no | no | SPL Token or Token-2022, depending on the currency mint owner. |
| 9 | `associated_token_program` | no | no | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`. |
| 10 | `system_program` | no | no | |
| 11 | `event_authority` | no | no | PDA. |
| 12 | `program` | no | no | Self. |

Args: `amount: u64`, `memo: u64`, `start_time: i64`, `end_time: i64`.

### `agent_distribute_payments`

Permissionless. Splits the per-currency payment vault into `buyback_vault`
and `withdraw_vault`.

| # | Account | Writable | Signer | Notes |
|---|---|---|---|---|
| 0 | `user` | yes | yes | Caller (rent payer; can be anyone). |
| 1 | `global_config` | no | no | PDA. |
| 2 | `currency_mint` | no | no | |
| 3 | `token_agent_payments` | yes | no | |
| 4 | `token_agent_payment_in_currency` | yes | no | PDA. Drained. |
| 5 | `token_agent_associated_account` | yes | no | PDA ATA. |
| 6 | `buyback_authority` | no | no | PDA `[b"buyback-authority", mint]`. |
| 7 | `withdraw_authority` | no | no | PDA `[b"withdraw-authority", mint]`. |
| 8 | `buyback_vault` | yes | no | ATA owned by `buyback_authority`. |
| 9 | `withdraw_vault` | yes | no | ATA owned by `withdraw_authority`. |
| 10 | `token_program` | no | no | |
| 11 | `associated_token_program` | no | no | |
| 12 | `system_program` | no | no | |
| 13 | `event_authority` | no | no | PDA. |
| 14 | `program` | no | no | |

Args: none.

### `agent_withdraw`

| # | Account | Writable | Signer | Notes |
|---|---|---|---|---|
| 0 | `authority` | yes | yes | Agent authority. |
| 1 | `token_agent_payments` | no | no | |
| 2 | `currency_mint` | no | no | |
| 3 | `withdraw_authority` | no | no | PDA. |
| 4 | `withdraw_vault` | yes | no | PDA ATA. |
| 5 | `receiver_ata` | yes | no | Destination — caller picks. |
| 6 | `token_program` | no | no | |
| 7 | `associated_token_program` | no | no | |
| 8 | `system_program` | no | no | |
| 9 | `event_authority` | no | no | PDA. |
| 10 | `program` | no | no | |

Args: none.

### `agent_buyback_trigger`

| # | Account | Writable | Signer | Notes |
|---|---|---|---|---|
| 0 | `global_buyback_authority` | yes | yes | Hard-gated to the key recorded on `global_config.buyback_authority`. Wallet must NEVER auto-sign. |
| 1 | `mint` | yes | no | The agent's mint (writable so the burn can decrement supply). |
| 2 | `token_agent_payments` | no | no | |
| 3 | `token_agent_payment_in_currency` | yes | no | unverified — requires source review whether the buyback reads the per-currency payment vault directly or only via `buyback_vault`. The IDL marks it writable; treat as required. |
| 4 | `currency_mint` | no | no | |
| 5 | `global_config` | no | no | |
| 6 | `swap_program_to_invoke` | no | no | Caller-chosen, must be on the protocol allow-list (else `InvalidProgramToInvoke`). |
| 7 | `burn_authority` | yes | no | PDA. |
| 8 | `burn_mint_vault` | yes | no | PDA ATA — receives the swap output before burn. |
| 9 | `burn_currency_mint_vault` | yes | no | PDA ATA — holds the currency-side balance during the swap. |
| 10 | `token_program` | no | no | For the agent's mint. |
| 11 | `token_program_currency` | no | no | For the currency mint (may differ — USDC is SPL Token, agent mints are Token-2022). |
| 12 | `associated_token_program` | no | no | |
| 13 | `system_program` | no | no | |
| 14 | `event_authority` | no | no | PDA. |
| 15 | `program` | no | no | |

Args: `swap_instruction_data: bytes`. The bytes are forwarded verbatim to the
`swap_program_to_invoke` CPI.

### `agent_update_authority`

| # | Account | Writable | Signer | Notes |
|---|---|---|---|---|
| 0 | `authority` | yes | yes | Current authority. |
| 1 | `global_config` | no | no | |
| 2 | `token_agent_payments` | yes | no | |
| 3 | `system_program` | no | no | |
| 4 | `event_authority` | no | no | PDA. |
| 5 | `program` | no | no | |

Args: `new_authority: Pubkey`.

### `agent_update_buyback_bps`

| # | Account | Writable | Signer | Notes |
|---|---|---|---|---|
| 0 | `authority` | yes | yes | |
| 1 | `token_agent_payments` | yes | no | |
| 2 | `global_config` | no | no | |
| 3 | `event_authority` | no | no | PDA. |
| 4 | `program` | no | no | |

Args: `buyback_bps: u16`. Must include each supported-currency payment-vault
ATA as remaining accounts (see `PumpAgentOffline.updateBuybackBps` in
[`src/solana/PumpAgentOffline.ts`](../src/solana/PumpAgentOffline.ts)).

### `agent_transfer_extra_lamports` (3.0.x only)

| # | Account | Writable | Signer | Notes |
|---|---|---|---|---|
| 0 | `token_agent_payments` | yes | no | |
| 1 | `token_agent_associated_account` | yes | no | PDA. |

Args: none. Sweeps lamports above rent-exempt balance from the agent record
into the associated account. No equivalent on 1.0.7.

## Per-instruction account ordering — 1.0.7 program

The 1.0.7 IDL ([`src/solana/legacy-agent-payments/idl.json`](../src/solana/legacy-agent-payments/idl.json))
declares the same accounts in the same order for every instruction the two
programs share. The deltas are:

- `agent_transfer_extra_lamports` — does not exist on 1.0.7.
- `global_remove_currency` — does not exist on 1.0.7. Once a currency is added
  via `global_add_new_currency` it cannot be removed; a new global state would
  have to be re-initialized.
- Naming: 1.0.7 uses camelCase in its IDL (`tokenAgentPayments`, `bondingCurve`,
  `globalConfig`, `eventAuthority`). Anchor account-resolution code generated
  from the IDL will reflect this; the wire-level discriminators differ from the
  3.0.x discriminators because the names differ.

## Failure modes

Error codes are defined identically (same numeric range, slightly different
PascalCase vs camelCase names) on both programs.

| Code | 3.0.x name | Trigger | Recovery |
|---|---|---|---|
| 6000 | `UnauthorizedSigner` | Wrong authority on a signer-gated ix (most often `agent_buyback_trigger` called by anyone but `global_buyback_authority`, or `agent_withdraw` by anyone but the agent authority). | Use the correct keypair. For buyback, this ix is admin-only. |
| 6001 | `CurrencyAlreadySupported` | `global_add_new_currency` for a mint already in `supported_currencies_mint`. | No-op; nothing to fix. |
| 6002 | `MaxCurrenciesReached` | `supported_currencies_mint` is full (10 slots). | On 3.0.x, call `global_remove_currency` first. On 1.0.7, you are stuck. |
| 6003 | `InvalidBuybackBps` | `buyback_bps > 10000`. | Cap at `10000` (= 100%). |
| 6004 | `CurrencyNotSupported` | The `currency_mint` passed to `agent_accept_payment` is not in `supported_currencies_mint`. | Add it via `global_add_new_currency` (admin only) or use a supported currency. |
| 6005 | `MathOverflow` | u64 overflow in distribution arithmetic. | Distribute more frequently so vault balances stay smaller. |
| 6006 | `InvalidRemainingAccountAddress` | Wrong remaining-account ordering on `agent_update_buyback_bps`. | Re-derive the per-currency ATA list and pass them in the same order as `supported_currencies_mint`. |
| 6007 | `PaymentVaultNotEmpty` | Tried to close an account or change config while a payment vault still has a balance. | Run `agent_distribute_payments` first. |
| 6008 | `InvalidInvoiceAccount` | The `invoice_id` PDA passed to `agent_accept_payment` doesn't match the seeds derived from the args. | Re-derive with `getInvoiceIdPDA(mint, currency_mint, amount, memo, start_time, end_time)`. |
| 6009 | `InvalidProgramToInvoke` | `swap_program_to_invoke` is not on the buyback allow-list. | Use a Jupiter (or other allow-listed) program ID. |
| 6010 | `InvalidCallbackProgram` | The CPI'd swap program returned but with the wrong return-data program. | Indicates a swap program that doesn't conform — switch routes. |
| 6011 | `SwapFailedAmountDidNotIncrease` | After CPI, the agent mint balance in `burn_mint_vault` did not go up. | The swap leg silently failed (e.g. zero output). Check route, slippage, and quote-vault balance. |
| 6012 | `AccountTypeNotSupported` | `extend_account` called on an account type the program doesn't know how to grow. | Wait for an SDK upgrade. |
| 6013 | `InvalidIndex` | Out-of-range index into `supported_currencies_mint`. | Check the index against the live array length. |

Pump bonding-curve errors that may surface during `agent_buyback_trigger`'s
swap leg (when the route touches the pump program directly) — see
[`pump-public-docs/idl/pump.json`](../pump-public-docs/idl/pump.json) `errors`.

## Where the rest of the documentation lives

- End-to-end scenarios: [`SCENARIOS.md`](SCENARIOS.md).
- Wallet integration and dual-program detection:
  [`WALLET_INTEGRATION.md`](WALLET_INTEGRATION.md).
- References folder audit (2026-05-08):
  [`references/AUDIT_2026-05-08.md`](references/AUDIT_2026-05-08.md).
