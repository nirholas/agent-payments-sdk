#!/usr/bin/env node
/**
 * `buy_v2` bonding-curve buy. Unified interface for SOL- and USDC-paired
 * coins via `quoteMint`. Coin must have `bondingCurve.complete === false`.
 *
 * Reference: pump-public-docs/docs/instructions/BUY.md
 */
import { parseArgs } from "node:util";
import BN from "bn.js";
import {
  PUMP_SDK,
  OnlinePumpSdk,
  getBuyTokenAmountFromSolAmount,
  getBuySolAmountFromTokenAmount,
  bondingCurvePda,
} from "@pump-fun/pump-sdk";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { getConnection } from "./lib/env.mjs";
import { tokenProgramIdFromMint } from "./lib/coin-resolve.mjs";
import { BUY_SELL_DEFAULT_UNITS } from "./lib/constants.mjs";
import {
  exitWithHelp,
  parsePositiveInt,
  parseSlippagePercent,
  printJson,
  requirePublicKey,
  requireString,
} from "./lib/args.mjs";
import { buildAndPartialSignTx, transactionToBase64 } from "./lib/tx-build.mjs";
import { resolveQuoteMint, quoteTokenProgramFromMint } from "./lib/quote-mint.mjs";

const HELP = `Usage: node scripts/build-buy-bonding-v2-tx.mjs [options]

buy_v2 bonding-curve buy. Coin must have complete === false.

Required:
  --mint <PUBKEY>
  --user <PUBKEY>
  --amount <int>           Quote to spend (smallest units; lamports for SOL, 1e6 for USDC)

Optional:
  --quote-mint <PUBKEY>    Override quote mint. Default: bondingCurve.quoteMint || wSOL
  --slippage <percent>     Default 5 (percent, NOT bps — same as legacy buy)
  --compute-units <int>    Default ${BUY_SELL_DEFAULT_UNITS}
  --priority-micro-lamports <int>
  --front-runner-protection
  --tip-sol <float>        Jito tip in SOL (requires --front-runner-protection)
  -h, --help

Environment:
  SOLANA_RPC_URL or NEXT_PUBLIC_SOLANA_RPC_URL`;

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      mint: { type: "string" },
      user: { type: "string" },
      amount: { type: "string" },
      "quote-mint": { type: "string" },
      slippage: { type: "string" },
      "compute-units": { type: "string" },
      "priority-micro-lamports": { type: "string" },
      "front-runner-protection": { type: "boolean", default: false },
      "tip-sol": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) exitWithHelp("build-buy-bonding-v2-tx.mjs", HELP);

  const mint = requirePublicKey("--mint", values.mint);
  const user = requirePublicKey("--user", values.user);
  const inputQuoteUnits = parsePositiveInt(
    requireString("--amount", values.amount),
    0,
  );
  if (inputQuoteUnits <= 0) throw new Error("--amount must be > 0");

  const overrideQuoteMint =
    values["quote-mint"] != null && values["quote-mint"] !== ""
      ? requirePublicKey("--quote-mint", values["quote-mint"])
      : null;

  const slippage = parseSlippagePercent(values.slippage, 5);
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
  const tokenProgram = await tokenProgramIdFromMint(connection, mint);
  const onlineSdk = new OnlinePumpSdk(connection);
  const [global, feeConfig] = await Promise.all([
    onlineSdk.fetchGlobal(),
    onlineSdk.fetchFeeConfig(),
  ]);

  const bondingCurveAddress = bondingCurvePda(mint);
  const userAta = getAssociatedTokenAddressSync(mint, user, true, tokenProgram);

  const [bondingCurveAccountInfo, associatedUserAccountInfo] =
    await connection.getMultipleAccountsInfo([bondingCurveAddress, userAta]);

  if (!bondingCurveAccountInfo) {
    throw new Error("Bonding curve account not found for this mint.");
  }

  const bondingCurve = PUMP_SDK.decodeBondingCurve(bondingCurveAccountInfo);
  if (bondingCurve.complete) {
    throw new Error(
      "On-chain bonding curve is complete. Use AMM script instead.",
    );
  }

  const quoteMint = resolveQuoteMint(bondingCurve, overrideQuoteMint);
  const quoteTokenProgram = await quoteTokenProgramFromMint(connection, quoteMint);

  const inputQuoteAmount = new BN(inputQuoteUnits);
  const mintSupply = bondingCurve.tokenTotalSupply;

  // Two-step quote → tokens → quote (mirrors legacy script). Helpers retain
  // their "Sol" name but operate on virtual/realQuoteReserves under v2.
  const tokenAmount = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply,
    bondingCurve,
    amount: inputQuoteAmount,
  });

  const quoteAmount = getBuySolAmountFromTokenAmount({
    global,
    feeConfig,
    mintSupply,
    bondingCurve,
    amount: tokenAmount,
  });

  const sdkInstructions = await PUMP_SDK.buyV2Instructions({
    global,
    bondingCurveAccountInfo,
    bondingCurve,
    associatedUserAccountInfo,
    mint,
    user,
    amount: tokenAmount,
    quoteAmount,
    slippage,
    tokenProgram,
    quoteTokenProgram,
  });

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
    quoteAmount: quoteAmount.toString(),
    inputQuoteAmount: inputQuoteUnits,
    expectedTokenAmount: tokenAmount.toString(),
    slippagePercent: slippage,
    frontRunnerProtection,
  });
}

main().catch((e) => {
  process.stderr.write(`${e?.message ?? e}\n`);
  process.exit(1);
});
