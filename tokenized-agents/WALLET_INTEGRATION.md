# Wallet integration for tokenized-agent flows

This document covers wallet-side concerns that are specific to tokenized
agents: detecting which of the two agent-payments programs a coin is
registered on, signaling that to the user, and gating which instructions a
wallet may auto-sign vs prompt for. The generic `WalletProvider` setup is
covered in pump-fun's general wallet docs; this file assumes those are
already in place.

## 1. Detecting which program a coin's agent lives on

A single mint has at most one agent record, but that record may live on
either of:

| Version | Program ID |
|---|---|
| Legacy 1.0.7 | `pUmPFn9WvfaN2WTVGnCEtJTd2ATTpvpsKRz6jVzu6u4` |
| Current 3.0.x | `AgenTMiC2hvxGebTsgmsD4HHBa8WEcqGFf87iwRRxLo7` |

Both programs use the same PDA seeds (`[b"token-agent-payments", mint]`).
Because the seeds are identical but the **program** segment of the derivation
differs, the two derivations produce two distinct addresses — one for each
program. Detection is two `getAccountInfo` calls and a check that the
returned account's `owner` matches the program we derived against.

```ts
import { Connection, PublicKey } from "@solana/web3.js";

const LEGACY_PROGRAM = new PublicKey(
  "pUmPFn9WvfaN2WTVGnCEtJTd2ATTpvpsKRz6jVzu6u4",
);
const CURRENT_PROGRAM = new PublicKey(
  "AgenTMiC2hvxGebTsgmsD4HHBa8WEcqGFf87iwRRxLo7",
);
const SEED = Buffer.from("token-agent-payments");

export type AgentLocation =
  | { version: "legacy"; pda: PublicKey }
  | { version: "current"; pda: PublicKey }
  | { version: "none" };

export async function detectAgentProgram(
  connection: Connection,
  mint: PublicKey,
): Promise<AgentLocation> {
  const [legacyPda] = PublicKey.findProgramAddressSync(
    [SEED, mint.toBuffer()],
    LEGACY_PROGRAM,
  );
  const [currentPda] = PublicKey.findProgramAddressSync(
    [SEED, mint.toBuffer()],
    CURRENT_PROGRAM,
  );

  const [legacyInfo, currentInfo] = await connection.getMultipleAccountsInfo([
    legacyPda,
    currentPda,
  ]);

  if (legacyInfo && legacyInfo.owner.equals(LEGACY_PROGRAM)) {
    return { version: "legacy", pda: legacyPda };
  }
  if (currentInfo && currentInfo.owner.equals(CURRENT_PROGRAM)) {
    return { version: "current", pda: currentPda };
  }
  return { version: "none" };
}
```

Notes:

- Use `getMultipleAccountsInfo` for the round-trip — one RPC call instead of
  two. Even on slow public RPCs this keeps the detection under ~100ms.
- The `owner` check is not paranoia: an attacker could in principle
  initialize a non-agent account at a colliding seed on either program. The
  `owner` field is set by the runtime to the program that allocated the
  account, so it cannot be forged.
- Cache the result per-mint for the duration of a session. Agent program
  ownership is fixed at registration time and never changes.

After detection, route every subsequent ix builder through the matching
namespace from `@nirholas/agent-payments-sdk`:

```ts
import {
  PumpAgentOffline,
  legacyAgentPayments,
} from "@nirholas/agent-payments-sdk";

function loadAgent(mint: PublicKey, conn: Connection, loc: AgentLocation) {
  if (loc.version === "current") return PumpAgentOffline.load(mint, conn);
  if (loc.version === "legacy")
    return legacyAgentPayments.LegacyPumpAgentOffline.load(mint, conn);
  throw new Error("no agent registered for this mint");
}
```

## 2. UI signaling

Surface the program version to the user when it has implications they care
about — chiefly when an action is unavailable on legacy or when the wallet
needs to disambiguate two coins with the same symbol.

Recommended treatment:

- A small badge next to the agent's name: `Agent v1` (legacy 1.0.7) or
  `Agent v3` (current 3.0.x).
- On hover/tap, expand to: `Registered on <program ID>` with a one-sentence
  explanation that the version was fixed at coin creation.
- If `version === "none"`, do not render anything agent-related; the coin
  has no agent and the corresponding ix builders will fail.
- For legacy agents, gray out the `Sweep extra lamports` action (it maps to
  `agent_transfer_extra_lamports`, which does not exist on 1.0.7).

Do NOT use `v1` and `v3` as the only signal in CLI output or API responses
intended for non-human consumers — emit the program ID itself so downstream
code can branch on a stable identifier.

## 3. Simulation flow

Before submitting any agent-mutating tx (anything from `agent_initialize`,
`agent_accept_payment`, `agent_distribute_payments`, `agent_withdraw`,
`agent_update_authority`, `agent_update_buyback_bps`, `agent_transfer_extra_lamports`,
`extend_account`, `close_account`), simulate it via
`connection.simulateTransaction` and surface any program error code to the
user. The agent-payments error codes are documented in
[`SKILL.md`](SKILL.md#failure-modes); the wallet should map the numeric
code back to a human message rather than displaying the raw log.

```ts
import { Connection, VersionedTransaction } from "@solana/web3.js";

async function simulateAndCheck(
  conn: Connection,
  vtx: VersionedTransaction,
): Promise<void> {
  const sim = await conn.simulateTransaction(vtx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
  });
  if (sim.value.err) {
    const code = extractAnchorErrorCode(sim.value.logs ?? []);
    throw new Error(
      `Simulation failed: ${humanizeAgentPaymentsError(code) ?? sim.value.err}`,
    );
  }
}

function extractAnchorErrorCode(logs: string[]): number | null {
  for (const line of logs) {
    const m = line.match(/Error Code:\s*\w+\.\s*Error Number:\s*(\d+)/);
    if (m) return Number(m[1]);
  }
  return null;
}

function humanizeAgentPaymentsError(code: number | null): string | null {
  switch (code) {
    case 6000: return "Unauthorized signer";
    case 6003: return "Buyback BPS must be <= 10000";
    case 6004: return "Currency not supported by the agent-payments program";
    case 6007: return "Distribute payments first — vault not empty";
    case 6008: return "Invoice account does not match expected PDA";
    case 6009: return "Swap program is not on the buyback allow-list";
    case 6011: return "Swap returned zero output";
    default:   return null;
  }
}
```

If `simulateTransaction` fails the wallet must NOT submit the transaction.
Anchor errors at simulation time will fail at execution time too.

## 4. Cashback claim UX

The pump program's `claim_cashback_v2` (see
[`pump-public-docs/docs/instructions/CLAIM_CASHBACK.md`](../pump-public-docs/docs/instructions/CLAIM_CASHBACK.md)
and [`pump-public-docs/idl/pump.json`](../pump-public-docs/idl/pump.json))
handles two cases through the same instruction. The wallet UX must branch on
which case applies because the on-chain effect — and therefore what the user
sees in their wallet afterward — is different.

| Case | Effect | Pre-claim UI hint |
|---|---|---|
| Legacy SOL cashback | Transfers all lamports above rent-exempt balance from `user_volume_accumulator` to `user`. The `associated_user_volume_accumulator` ATA may not even exist. | "Claim X SOL of cashback" — read the lamports balance of `user_volume_accumulator` minus `getMinimumBalanceForRentExemption(accountSize)`. |
| Per-quote-mint cashback | Transfers SPL tokens from the `associated_user_volume_accumulator` ATA (owned by `user_volume_accumulator`, mint = `quote_mint`) to `associated_quote_user` (owned by `user`). | "Claim X USDC of cashback" — read the token balance of `associated_user_volume_accumulator` for the quote mint. |

The instruction is **permissionless**: `user` is the recipient but does not
need to sign. A wallet may build and submit a `claim_cashback_v2` on behalf
of the connected user without prompting for a signature, provided the wallet
itself is paying for the tx fee. If the wallet wants the user to pay, it
must prompt.

The accounts list (in declaration order) is:

| # | Account | Notes |
|---|---|---|
| 0 | `user` | The recipient. Not a required signer. |
| 1 | `user_volume_accumulator` | PDA `[b"user_volume_accumulator", user]` on `6EF8...`. |
| 2 | `quote_mint` | wSOL for legacy SOL cashback; the relevant SPL mint otherwise. |
| 3 | `quote_token_program` | SPL Token or Token-2022 — pick based on the mint's owner. |
| 4 | `associated_token_program` | `ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL`. |
| 5 | `associated_user_volume_accumulator` | ATA for `quote_mint`, owned by `user_volume_accumulator`. May not exist for legacy SOL. |
| 6 | `associated_quote_user` | ATA for `quote_mint`, owned by `user`. Wallet should pre-create idempotently when the cashback is non-SOL. |
| 7 | `system_program` | |
| 8 | `event_authority` | PDA. |
| 9 | `program` | Self. |

The pre-2026-05-07 `claim_cashback` instruction still exists for backward
compat but should be considered superseded by `claim_cashback_v2` for new
integrations.

## 5. Transaction signing rules

Tokenized-agent flows split cleanly into "user-initiated" (wallet should
prompt the user to sign) and "admin-only" (wallet should refuse to sign or
should not even surface as an option).

| Instruction | Required signer | Wallet behavior |
|---|---|---|
| `agent_initialize` | `authority` (the future agent admin) | Prompt — typically run once at coin creation. |
| `agent_accept_payment` | `user` (the buyer) | Prompt — this is the standard payment flow. |
| `agent_distribute_payments` | `user` (any caller) | Prompt — minor cost, no risk. May be auto-signed when triggered by an automated UI workflow. |
| `agent_withdraw` | `authority` | Prompt — moves funds out of the agent. |
| `agent_update_authority` | `authority` | Prompt with a confirmation step — destructive (rotates control). |
| `agent_update_buyback_bps` | `authority` | Prompt. |
| `agent_transfer_extra_lamports` | none (permissionless, no signer required) | Auto-sign safe; does nothing dangerous. 3.0.x only. |
| `extend_account` | none | Auto-sign safe. |
| `close_account` | `authority` | Prompt with confirmation — terminates the agent. |
| `agent_buyback_trigger` | `global_buyback_authority` (protocol admin) | **NEVER** auto-sign. **NEVER** prompt the user to sign.* |
| `global_add_new_currency`, `global_remove_currency`, `global_config_initialize`, `global_update_authorities` | `protocol_authority` | Wallet should refuse — these are admin ix that no end user would be running. |
| `claim_cashback_v2` | none required (`user` is the recipient but is not a signer) | Auto-sign safe when the wallet pays the tx fee. Prompt if the user pays. |

\* `agent_buyback_trigger` requires the `global_buyback_authority` keypair,
held by the protocol. A wallet UI that asked the user to sign this
instruction would be requesting a signature that the program will reject
(error 6000 `UnauthorizedSigner`), at best wasting the user's tx fee.
End-user wallets must filter out this instruction at the simulation layer
and surface a clear error if it appears in a tx the user is being asked to
sign.

### Auto-sign safety rationale

"Auto-sign safe" above means the instruction has no signer-gated effect that
could be exploited by a malicious dApp. Even so, a wallet that auto-signs
should still:

1. Run `simulateTransaction` and refuse on simulation failure.
2. Cap the number of auto-signs per origin per minute to defend against an
   exhaustion attack on the user's tx-fee budget.
3. Display a non-modal confirmation toast after each auto-sign so the user
   has a record.
