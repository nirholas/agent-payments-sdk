#!/usr/bin/env node
/**
 * `sell_v2` bonding-curve sell. Unified interface for SOL- and USDC-paired
 * coins via `quoteMint`. Coin must have `bondingCurve.complete === false`.
 *
 * Reference: pump-public-docs/docs/instructions/SELL.md
 */
import { parseArgs } from "node:util";
import BN from "bn.js";
import {
  PUMP_SDK,
  OnlinePumpSdk,
  getSellSolAmountFromTokenAmount,
  bondingCurvePda,
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
import { resolveQuoteMint, quoteTokenProgramFromMint } from "./lib/quote-mint.mjs";

const HELP = `Usage: node scripts/build-sell-bonding-v2-tx.mjs [options]

sell_v2 bonding-curve sell. Coin must have complete === false.

Required:
  --mint <PUBKEY>
  --user <PUBKEY>
  --amount <int>           Base tokens to sell (smallest units, 6 decimals)

Optional:
  --quote-mint <PUBKEY>    Override quote mint. Default: bondingCurve.quoteMint || wSOL
  --slippage <percent>     Default 5
  --compute-units <int>    Default ${BUY_SELL_DEFAULT_UNITS}
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

  if (values.help) exitWithHelp("build-sell-bonding-v2-tx.mjs", HELP);

  const mint = requirePublicKey("--mint", values.mint);
  const user = requirePublicKey("--user", values.user);
  const tokenAmt = requireString("--amount", values.amount);
  const amount = new BN(tokenAmt, 10);
  if (amount.lte(new BN(0))) throw new Error("--amount must be > 0");

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

  const mintSupply = bondingCurve.tokenTotalSupply;
  const quoteAmount = getSellSolAmountFromTokenAmount({
    global,
    feeConfig,
    mintSupply,
    bondingCurve,
    amount,
  });

  const sdkInstructions = await PUMP_SDK.sellV2Instructions({
    global,
    bondingCurveAccountInfo,
    bondingCurve,
    mint,
    user,
    amount,
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
    tokenAmount: amount.toString(),
    slippagePercent: slippage,
    mayhemMode: bondingCurve.isMayhemMode ?? false,
    cashback: bondingCurve.isCashbackCoin ?? false,
    frontRunnerProtection,
  });
}

main().catch((e) => {
  process.stderr.write(`${e?.message ?? e}\n`);
  process.exit(1);
});
