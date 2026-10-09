#!/usr/bin/env node
/**
 * `buy_v3` / `buy_exact_quote_in_v3` bonding-curve buy (17 accounts).
 *
 * Same price and fees as `buy_v2`, but only the buyback slice of the
 * protocol fee leaves in the trade: the rest of the protocol fee and the
 * creator fee stay on the curve (`BondingCurve.protocolFees` / `creatorFee`)
 * until the permissionless `sweep_protocol_fee` / `sweep_creator_fee` pay
 * them out (coin-fees/scripts/build-collect-fee-tx.mjs and
 * build-distribute-fees-tx.mjs sweep the creator bucket first).
 *
 * A buy past the remaining supply completes the curve and buys the rest
 * from the pool the migration will create (the post-completion leg). Cashback
 * coins are refused (6094): use build-buy-bonding-v2-tx.mjs for those.
 *
 * Reference: pump-public-docs/docs/instructions/BUY.md
 */
import { parseArgs } from "node:util";
import BN from "bn.js";
import {
  PUMP_SDK,
  OnlinePumpSdk,
  getBuyV3QuoteAmountFromTokenAmount,
  getBuyV3TokenAmountFromQuoteAmount,
} from "@pump-fun/pump-sdk";
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
import { pickGlobalBuybackFeeRecipient } from "./lib/fee-recipients.mjs";

const HELP = `Usage: node scripts/build-buy-bonding-v3-tx.mjs [options]

buy_v3 bonding-curve buy. Coin must have complete === false and must not be
a cashback coin.

Required:
  --mint <PUBKEY>
  --user <PUBKEY>
  --amount <int>           Quote to spend (smallest units; lamports for SOL, 1e6 for USDC)

Optional:
  --exact-quote-in         Build buy_exact_quote_in_v3: spend exactly --amount (fees
                           included) and require the quoted tokens less slippage
  --partial-fill           Mayhem curves: fill up to the remaining supply instead of failing
  --slippage <percent>     Default 5
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
      "exact-quote-in": { type: "boolean", default: false },
      "partial-fill": { type: "boolean", default: false },
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

  if (values.help) exitWithHelp("build-buy-bonding-v3-tx.mjs", HELP);

  const mint = requirePublicKey("--mint", values.mint);
  const user = requirePublicKey("--user", values.user);
  const quoteIn = new BN(requireString("--amount", values.amount), 10);
  if (quoteIn.lte(new BN(0))) throw new Error("--amount must be > 0");

  const exactQuoteIn = Boolean(values["exact-quote-in"]);
  const partialFill = Boolean(values["partial-fill"]);
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
  const [global, feeConfig, buyState] = await Promise.all([
    onlineSdk.fetchGlobal(),
    onlineSdk.fetchFeeConfig(),
    onlineSdk.fetchBuyState(mint, user, tokenProgram),
  ]);
  const {
    bondingCurve,
    associatedUserAccountInfo,
    curveBaseTokenBalance,
    quoteMint,
    quoteTokenProgram,
  } = buyState;

  if (bondingCurve.complete) {
    throw new Error("On-chain bonding curve is complete. Use AMM script instead.");
  }
  if (bondingCurve.isCashbackCoin) {
    throw new Error(
      "Cashback coins cannot trade through v3 (6094). Use build-buy-bonding-v2-tx.mjs.",
    );
  }

  const quoteArgs = {
    global,
    feeConfig,
    mintSupply: bondingCurve.tokenTotalSupply,
    bondingCurve,
    curveBaseTokenBalance,
  };
  const tokenAmount = getBuyV3TokenAmountFromQuoteAmount({ ...quoteArgs, amount: quoteIn });
  if (tokenAmount.lte(new BN(0))) {
    throw new Error("Computed token amount is zero: amount too small or reserves exhausted.");
  }
  const quoteAmount = exactQuoteIn
    ? quoteIn
    : getBuyV3QuoteAmountFromTokenAmount({ ...quoteArgs, amount: tokenAmount });

  const buybackFeeRecipient = pickGlobalBuybackFeeRecipient(global);
  const builderArgs = {
    bondingCurve,
    associatedUserAccountInfo,
    mint,
    user,
    amount: tokenAmount,
    quoteAmount,
    slippage,
    tokenProgram,
    quoteTokenProgram,
    partialFill,
    buybackFeeRecipient,
  };
  const sdkInstructions = exactQuoteIn
    ? await PUMP_SDK.buyExactQuoteInV3Instructions(builderArgs)
    : await PUMP_SDK.buyV3Instructions(builderArgs);

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
    instruction: exactQuoteIn ? "buy_exact_quote_in_v3" : "buy_v3",
    quoteMint: quoteMint.toBase58(),
    quoteTokenProgram: quoteTokenProgram.toBase58(),
    quoteAmount: quoteAmount.toString(),
    expectedTokenAmount: tokenAmount.toString(),
    completesCurve: tokenAmount.gt(bondingCurve.realTokenReserves),
    buybackFeeRecipient: buybackFeeRecipient.toBase58(),
    slippagePercent: slippage,
    mayhemMode: bondingCurve.isMayhemMode ?? false,
    partialFill,
    frontRunnerProtection,
  });
}

main().catch((e) => {
  process.stderr.write(`${e?.message ?? e}\n`);
  process.exit(1);
});
