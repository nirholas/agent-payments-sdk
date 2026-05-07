#!/usr/bin/env node
/**
 * `buy_exact_quote_in_v2`: spend exactly `spendable_quote_in` quote, demand
 * at least `min_tokens_out` base tokens. The TS SDK does not expose a helper
 * for this instruction yet (1.35.0) — we drive the Anchor program directly,
 * mirroring the rust client's `buy_exact_quote_in_v2_instructions`.
 *
 * Reference: pump-public-docs/idl/pump.ts (instruction `buyExactQuoteInV2`,
 * discriminator [194,171,28,70,104,77,91,47]) and the rust client at
 * vendor/pump-rust-client/src/sdk/pump_v2.rs.
 */
import { parseArgs } from "node:util";
import BN from "bn.js";
import {
  PUMP_SDK,
  OnlinePumpSdk,
  bondingCurvePda,
  creatorVaultPda,
  feeSharingConfigPda,
  getPumpProgram,
  GLOBAL_PDA,
  GLOBAL_VOLUME_ACCUMULATOR_PDA,
  PUMP_EVENT_AUTHORITY_PDA,
  PUMP_FEE_CONFIG_PDA,
  PUMP_FEE_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  userVolumeAccumulatorPda,
} from "@pump-fun/pump-sdk";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { SystemProgram } from "@solana/web3.js";
import { getConnection } from "./lib/env.mjs";
import { tokenProgramIdFromMint } from "./lib/coin-resolve.mjs";
import { BUY_SELL_DEFAULT_UNITS } from "./lib/constants.mjs";
import {
  exitWithHelp,
  parsePositiveInt,
  printJson,
  requirePublicKey,
  requireString,
} from "./lib/args.mjs";
import { buildAndPartialSignTx, transactionToBase64 } from "./lib/tx-build.mjs";
import { resolveQuoteMint, quoteTokenProgramFromMint } from "./lib/quote-mint.mjs";
import { pickFeeRecipient, pickBuybackFeeRecipient } from "./lib/fee-recipients.mjs";

const HELP = `Usage: node scripts/build-buy-exact-quote-in-v2-tx.mjs [options]

buy_exact_quote_in_v2: spend exactly --spendable-quote-in, require at least
--min-tokens-out base tokens. Coin must have complete === false.

Required:
  --mint <PUBKEY>
  --user <PUBKEY>
  --spendable-quote-in <int>   Exact quote to spend (lamports for SOL, 1e6 for USDC)
  --min-tokens-out <int>       Minimum base tokens out (slippage floor, 1e6 base units)

Optional:
  --quote-mint <PUBKEY>        Override quote mint. Default: bondingCurve.quoteMint || wSOL
  --compute-units <int>        Default ${BUY_SELL_DEFAULT_UNITS}
  --priority-micro-lamports <int>
  --front-runner-protection
  --tip-sol <float>
  -h, --help

Environment:
  SOLANA_RPC_URL or NEXT_PUBLIC_SOLANA_RPC_URL`;

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      mint: { type: "string" },
      user: { type: "string" },
      "spendable-quote-in": { type: "string" },
      "min-tokens-out": { type: "string" },
      "quote-mint": { type: "string" },
      "compute-units": { type: "string" },
      "priority-micro-lamports": { type: "string" },
      "front-runner-protection": { type: "boolean", default: false },
      "tip-sol": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) exitWithHelp("build-buy-exact-quote-in-v2-tx.mjs", HELP);

  const mint = requirePublicKey("--mint", values.mint);
  const user = requirePublicKey("--user", values.user);
  const spendableQuoteIn = new BN(
    requireString("--spendable-quote-in", values["spendable-quote-in"]),
    10,
  );
  const minTokensOut = new BN(
    requireString("--min-tokens-out", values["min-tokens-out"]),
    10,
  );
  if (spendableQuoteIn.lte(new BN(0))) throw new Error("--spendable-quote-in must be > 0");
  if (minTokensOut.lt(new BN(0))) throw new Error("--min-tokens-out must be >= 0");

  const overrideQuoteMint =
    values["quote-mint"] != null && values["quote-mint"] !== ""
      ? requirePublicKey("--quote-mint", values["quote-mint"])
      : null;

  const computeUnits = values["compute-units"]
    ? parsePositiveInt(values["compute-units"], BUY_SELL_DEFAULT_UNITS)
    : BUY_SELL_DEFAULT_UNITS;
  const priorityOverride =
    values["priority-micro-lamports"] != null &&
    values["priority-micro-lamports"] !== ""
      ? parsePositiveInt(values["priority-micro-lamports"], 1)
      : null;
  const frontRunnerProtection = Boolean(values["front-runner-protection"]);
  const tipSol = values["tip-sol"] != null ? Number.parseFloat(values["tip-sol"]) : undefined;
  if (tipSol != null && (Number.isNaN(tipSol) || tipSol < 0))
    throw new Error("--tip-sol must be a non-negative number");

  const connection = getConnection();
  const baseTokenProgram = await tokenProgramIdFromMint(connection, mint);
  const onlineSdk = new OnlinePumpSdk(connection);
  const global = await onlineSdk.fetchGlobal();

  const bondingCurveAddress = bondingCurvePda(mint);
  const [bondingCurveAccountInfo] = await connection.getMultipleAccountsInfo([
    bondingCurveAddress,
  ]);
  if (!bondingCurveAccountInfo) {
    throw new Error("Bonding curve account not found for this mint.");
  }

  const bondingCurve = PUMP_SDK.decodeBondingCurve(bondingCurveAccountInfo);
  if (bondingCurve.complete) {
    throw new Error("On-chain bonding curve is complete. Use AMM script instead.");
  }

  const quoteMint = resolveQuoteMint(bondingCurve, overrideQuoteMint);
  const quoteTokenProgram = await quoteTokenProgramFromMint(connection, quoteMint);
  const creator = bondingCurve.creator;
  const mayhemMode = bondingCurve.isMayhemMode ?? false;

  const feeRecipient = pickFeeRecipient(global, mayhemMode);
  const buybackFeeRecipient = pickBuybackFeeRecipient();

  const associatedQuoteFeeRecipient = getAssociatedTokenAddressSync(
    quoteMint, feeRecipient, true, quoteTokenProgram,
  );
  const associatedQuoteBuybackFeeRecipient = getAssociatedTokenAddressSync(
    quoteMint, buybackFeeRecipient, true, quoteTokenProgram,
  );
  const associatedBaseBondingCurve = getAssociatedTokenAddressSync(
    mint, bondingCurveAddress, true, baseTokenProgram,
  );
  const associatedQuoteBondingCurve = getAssociatedTokenAddressSync(
    quoteMint, bondingCurveAddress, true, quoteTokenProgram,
  );
  const associatedBaseUser = getAssociatedTokenAddressSync(
    mint, user, true, baseTokenProgram,
  );
  const associatedQuoteUser = getAssociatedTokenAddressSync(
    quoteMint, user, true, quoteTokenProgram,
  );
  const creatorVault = creatorVaultPda(creator);
  const associatedCreatorVault = getAssociatedTokenAddressSync(
    quoteMint, creatorVault, true, quoteTokenProgram,
  );
  const userVolAcc = userVolumeAccumulatorPda(user);
  const associatedUserVolumeAccumulator = getAssociatedTokenAddressSync(
    quoteMint, userVolAcc, true, quoteTokenProgram,
  );

  const program = getPumpProgram(connection);
  const buyExactQuoteInIx = await program.methods
    .buyExactQuoteInV2(spendableQuoteIn, minTokensOut)
    .accountsPartial({
      global: GLOBAL_PDA,
      baseMint: mint,
      quoteMint,
      baseTokenProgram,
      quoteTokenProgram,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      feeRecipient,
      associatedQuoteFeeRecipient,
      buybackFeeRecipient,
      associatedQuoteBuybackFeeRecipient,
      bondingCurve: bondingCurveAddress,
      associatedBaseBondingCurve,
      associatedQuoteBondingCurve,
      user,
      associatedBaseUser,
      associatedQuoteUser,
      creatorVault,
      associatedCreatorVault,
      sharingConfig: feeSharingConfigPda(mint),
      globalVolumeAccumulator: GLOBAL_VOLUME_ACCUMULATOR_PDA,
      userVolumeAccumulator: userVolAcc,
      associatedUserVolumeAccumulator,
      feeConfig: PUMP_FEE_CONFIG_PDA,
      feeProgram: PUMP_FEE_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
      eventAuthority: PUMP_EVENT_AUTHORITY_PDA,
      program: PUMP_PROGRAM_ID,
    })
    .instruction();

  // Idempotent ATA creates for the user's base + quote accounts (skipped
  // for native SOL since the program handles the wSOL wrap/unwrap path).
  const isNative = quoteMint.toBase58() === "So11111111111111111111111111111111111111112";
  const ataIxs = [
    createAssociatedTokenAccountIdempotentInstruction(
      user, associatedBaseUser, user, mint, baseTokenProgram,
    ),
    ...(isNative
      ? []
      : [
          createAssociatedTokenAccountIdempotentInstruction(
            user, associatedQuoteUser, user, quoteMint, quoteTokenProgram,
          ),
        ]),
  ];

  const sdkInstructions = [...ataIxs, buyExactQuoteInIx];
  const tx = await buildAndPartialSignTx({
    connection,
    payerKey: user,
    sdkInstructions,
    computeUnits,
    priorityFeeMicroLamports: priorityOverride,
    frontRunnerProtection,
    tipSol,
  });

  printJson({
    transaction: transactionToBase64(tx),
    quoteMint: quoteMint.toBase58(),
    quoteTokenProgram: quoteTokenProgram.toBase58(),
    spendableQuoteIn: spendableQuoteIn.toString(),
    minTokensOut: minTokensOut.toString(),
    feeRecipient: feeRecipient.toBase58(),
    buybackFeeRecipient: buybackFeeRecipient.toBase58(),
    mayhemMode,
    frontRunnerProtection,
  });
}

main().catch((e) => {
  process.stderr.write(`${e?.message ?? e}\n`);
  process.exit(1);
});
