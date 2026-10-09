#!/usr/bin/env node
/**
 * `sell_v3` bonding-curve sell (17 accounts). Same price and fees as
 * `sell_v2`; the buyback slice leaves the curve in the trade and the rest of
 * the fees stay on it until swept (the coin-fees collect and distribute
 * scripts sweep the creator bucket first).
 * Cashback coins are refused (6094): use build-sell-bonding-v2-tx.mjs.
 *
 * Reference: pump-public-docs/docs/instructions/SELL.md
 */
import { parseArgs } from "node:util";
import BN from "bn.js";
import {
  PUMP_SDK,
  OnlinePumpSdk,
  getSellSolAmountFromTokenAmount,
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

const HELP = `Usage: node scripts/build-sell-bonding-v3-tx.mjs [options]

sell_v3 bonding-curve sell. Coin must have complete === false and must not
be a cashback coin.

Required:
  --mint <PUBKEY>
  --user <PUBKEY>
  --amount <int>           Base tokens to sell (smallest units, 6 decimals)

Optional:
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

  if (values.help) exitWithHelp("build-sell-bonding-v3-tx.mjs", HELP);

  const mint = requirePublicKey("--mint", values.mint);
  const user = requirePublicKey("--user", values.user);
  const amount = new BN(requireString("--amount", values.amount), 10);
  if (amount.lte(new BN(0))) throw new Error("--amount must be > 0");

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
  const [global, feeConfig, sellState] = await Promise.all([
    onlineSdk.fetchGlobal(),
    onlineSdk.fetchFeeConfig(),
    onlineSdk.fetchSellState(mint, user, tokenProgram),
  ]);
  const { bondingCurve, quoteMint, quoteTokenProgram } = sellState;

  if (bondingCurve.complete) {
    throw new Error("On-chain bonding curve is complete. Use AMM script instead.");
  }
  if (bondingCurve.isCashbackCoin) {
    throw new Error(
      "Cashback coins cannot trade through v3 (6094). Use build-sell-bonding-v2-tx.mjs.",
    );
  }

  const quoteAmount = getSellSolAmountFromTokenAmount({
    global,
    feeConfig,
    mintSupply: bondingCurve.tokenTotalSupply,
    bondingCurve,
    amount,
  });

  const buybackFeeRecipient = pickGlobalBuybackFeeRecipient(global);
  const sdkInstructions = await PUMP_SDK.sellV3Instructions({
    bondingCurve,
    mint,
    user,
    amount,
    quoteAmount,
    slippage,
    tokenProgram,
    quoteTokenProgram,
    buybackFeeRecipient,
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
    instruction: "sell_v3",
    quoteMint: quoteMint.toBase58(),
    quoteTokenProgram: quoteTokenProgram.toBase58(),
    quoteAmount: quoteAmount.toString(),
    tokenAmount: amount.toString(),
    buybackFeeRecipient: buybackFeeRecipient.toBase58(),
    slippagePercent: slippage,
    mayhemMode: bondingCurve.isMayhemMode ?? false,
    frontRunnerProtection,
  });
}

main().catch((e) => {
  process.stderr.write(`${e?.message ?? e}\n`);
  process.exit(1);
});
