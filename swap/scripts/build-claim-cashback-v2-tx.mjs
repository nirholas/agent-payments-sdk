#!/usr/bin/env node
/**
 * `claim_cashback_v2`: claim cashback accrued in a user's volume accumulator.
 * Permissionless — caller need not be the cashback recipient.
 *
 * Reference: pump-public-docs/docs/instructions/CLAIM_CASHBACK.md
 */
import { parseArgs } from "node:util";
import { PUMP_SDK } from "@pump-fun/pump-sdk";
import { NATIVE_MINT } from "@solana/spl-token";
import { getConnection } from "./lib/env.mjs";
import { BUY_SELL_DEFAULT_UNITS } from "./lib/constants.mjs";
import {
  exitWithHelp,
  parsePositiveInt,
  printJson,
  requirePublicKey,
} from "./lib/args.mjs";
import { buildAndPartialSignTx, transactionToBase64 } from "./lib/tx-build.mjs";
import { quoteTokenProgramFromMint } from "./lib/quote-mint.mjs";

const HELP = `Usage: node scripts/build-claim-cashback-v2-tx.mjs [options]

claim_cashback_v2: claim cashback for --user. Permissionless — the --payer
signs the transaction; --user is just the recipient and can equal --payer.

Required:
  --user <PUBKEY>          Cashback recipient

Optional:
  --payer <PUBKEY>         Fee payer (defaults to --user)
  --quote-mint <PUBKEY>    Quote mint to claim. Default: wSOL (legacy SOL cashback)
  --compute-units <int>    Default ${BUY_SELL_DEFAULT_UNITS}
  --priority-micro-lamports <int>
  -h, --help

Environment:
  SOLANA_RPC_URL or NEXT_PUBLIC_SOLANA_RPC_URL`;

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      user: { type: "string" },
      payer: { type: "string" },
      "quote-mint": { type: "string" },
      "compute-units": { type: "string" },
      "priority-micro-lamports": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) exitWithHelp("build-claim-cashback-v2-tx.mjs", HELP);

  const user = requirePublicKey("--user", values.user);
  const payer =
    values.payer != null && values.payer !== ""
      ? requirePublicKey("--payer", values.payer)
      : user;
  const quoteMint =
    values["quote-mint"] != null && values["quote-mint"] !== ""
      ? requirePublicKey("--quote-mint", values["quote-mint"])
      : NATIVE_MINT;

  const computeUnits = values["compute-units"]
    ? parsePositiveInt(values["compute-units"], BUY_SELL_DEFAULT_UNITS)
    : BUY_SELL_DEFAULT_UNITS;
  const priorityOverride =
    values["priority-micro-lamports"] != null &&
    values["priority-micro-lamports"] !== ""
      ? parsePositiveInt(values["priority-micro-lamports"], 1)
      : null;

  const connection = getConnection();
  const quoteTokenProgram = await quoteTokenProgramFromMint(connection, quoteMint);

  const claimIx = await PUMP_SDK.claimCashbackV2Instruction({
    user,
    quoteMint,
    quoteTokenProgram,
  });

  const tx = await buildAndPartialSignTx({
    connection,
    payerKey: payer,
    sdkInstructions: [claimIx],
    computeUnits,
    priorityFeeMicroLamports: priorityOverride,
  });

  printJson({
    transaction: transactionToBase64(tx),
    user: user.toBase58(),
    payer: payer.toBase58(),
    quoteMint: quoteMint.toBase58(),
    quoteTokenProgram: quoteTokenProgram.toBase58(),
  });
}

main().catch((e) => {
  process.stderr.write(`${e?.message ?? e}\n`);
  process.exit(1);
});
