#!/usr/bin/env node
/**
 * Only use this script when the user explicitly requests it. Default: POST https://fun-block.pump.fun/agents/collect-fees
 *
 * Build a transaction to collect creator fees (crank) for a coin with no sharing config.
 * Uses OnlinePumpSdk.collectCoinCreatorFeeInstructions, permissionless.
 *
 * Fees that v3 curve trades and pump-amm v2 pool trades book are held on the
 * curve (`BondingCurve.creatorFee`) and the canonical pool (`Pool.creatorFees`)
 * until swept into the creator vault. collectCoinCreatorFeeInstructions does
 * not sweep, so the sweeps go first in the same transaction: otherwise a
 * collect pays out only what older trades sent straight to the vault.
 */
import { parseArgs } from "node:util";
import {
  OnlinePumpSdk,
  PUMP_SDK,
  canonicalPumpPoolPda,
  hasCoinCreatorMigratedToSharingConfig,
} from "@pump-fun/pump-sdk";
import { OnlinePumpAmmSdk } from "@pump-fun/pump-swap-sdk";
import { NATIVE_MINT } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { getConnection } from "./lib/env.mjs";
import {
  exitWithHelp,
  parsePositiveInt,
  printJson,
  requirePublicKey,
} from "./lib/args.mjs";
import { buildAndPartialSignTx, transactionToBase64 } from "./lib/tx-build.mjs";

const COLLECT_FEE_DEFAULT_UNITS = 200_000;

const HELP = `Usage: node scripts/build-collect-fee-tx.mjs [options]

Build a transaction to collect creator fees (direct creator, no sharing config).

Required:
  --mint <PUBKEY>
  --user <PUBKEY>                Fee payer / crank caller

Optional:
  --creator <PUBKEY>             Creator to collect for (auto-derived if omitted)
  --compute-units <int>          Default ${COLLECT_FEE_DEFAULT_UNITS}
  --priority-micro-lamports <int>
  --front-runner-protection      Add Jito tip; send ONLY to Jito endpoints
  --tip-sol <float>              Jito tip in SOL (default 0.0001)
  -h, --help

Environment:
  SOLANA_RPC_URL or NEXT_PUBLIC_SOLANA_RPC_URL`;

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      mint: { type: "string" },
      user: { type: "string" },
      creator: { type: "string" },
      "compute-units": { type: "string" },
      "priority-micro-lamports": { type: "string" },
      "front-runner-protection": { type: "boolean", default: false },
      "tip-sol": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) exitWithHelp("build-collect-fee-tx.mjs", HELP);

  const mint = requirePublicKey("--mint", values.mint);
  const user = requirePublicKey("--user", values.user);

  const computeUnits = values["compute-units"]
    ? parsePositiveInt(values["compute-units"], COLLECT_FEE_DEFAULT_UNITS)
    : COLLECT_FEE_DEFAULT_UNITS;
  const priorityOverride =
    values["priority-micro-lamports"] != null &&
    values["priority-micro-lamports"] !== ""
      ? parsePositiveInt(values["priority-micro-lamports"], 1)
      : null;
  const frontRunnerProtection = Boolean(values["front-runner-protection"]);
  const tipSol = values["tip-sol"] != null ? Number.parseFloat(values["tip-sol"]) : undefined;
  if (tipSol != null && (Number.isNaN(tipSol) || tipSol < 0)) throw new Error("--tip-sol must be a non-negative number");

  const connection = getConnection();
  const onlineSdk = new OnlinePumpSdk(connection);

  const bondingCurve = await onlineSdk.fetchBondingCurve(mint);
  const pool = await fetchCanonicalPool(connection, mint);
  const creator = values.creator
    ? requirePublicKey("--creator", values.creator)
    : (pool?.coinCreator ?? new PublicKey(bondingCurve.creator));

  if (!values.creator) {
    if (pool?.isCashbackCoin === true || bondingCurve.isCashbackCoin === true) {
      throw new Error(
        "This is a cashback coin: creator fees are returned to traders. " +
          "There is no creator vault to collect from.",
      );
    }
    if (hasCoinCreatorMigratedToSharingConfig({ mint, creator })) {
      throw new Error(
        "This coin uses a fee sharing config. Use build-distribute-fees-tx.mjs instead.",
      );
    }
  }

  const sweeps = await creatorFeeSweepInstructions({ bondingCurve, pool, mint, creator, user });
  const collect = await onlineSdk.collectCoinCreatorFeeInstructions(creator, user);
  const sdkInstructions = [...sweeps.instructions, ...collect];

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
    creator: creator.toBase58(),
    sweptCurveCreatorFee: sweeps.curve.toString(),
    sweptPoolCreatorFees: sweeps.pool.toString(),
    frontRunnerProtection,
  });
}

/**
 * The coin's canonical WSOL pool, or null before graduation or while the pool
 * account exists but is not initialized yet (it then holds no fees).
 */
async function fetchCanonicalPool(connection, mint) {
  const poolPda = canonicalPumpPoolPda(mint);
  const info = await connection.getAccountInfo(poolPda);
  if (!info) return null;
  try {
    return await new OnlinePumpAmmSdk(connection).fetchPool(poolPda);
  } catch {
    return null;
  }
}

/**
 * The sweeps that move held creator fees into `creator`'s SOL vaults, which
 * collectCoinCreatorFeeInstructions then pays out. Only SOL fees are swept:
 * the collect pays SOL vaults only, so a token-quoted curve's bucket is left
 * for a quote-aware collect. Each sweep is added only when its bucket is
 * nonzero and belongs to `creator` (a sweep pays the bucket owner's vault).
 */
async function creatorFeeSweepInstructions({ bondingCurve, pool, mint, creator, user }) {
  const instructions = [];
  const curveQuote = bondingCurve.quoteMint.equals(PublicKey.default)
    ? NATIVE_MINT
    : bondingCurve.quoteMint;
  const curveFee = bondingCurve.creatorFee;
  const sweepCurve =
    curveQuote.equals(NATIVE_MINT) && curveFee.gtn(0) && bondingCurve.creator.equals(creator);
  if (sweepCurve) {
    instructions.push(
      await PUMP_SDK.sweepCreatorFeeInstruction({
        payer: user,
        mint,
        creator: bondingCurve.creator,
        quoteMint: NATIVE_MINT,
      }),
    );
  }
  const poolFees = pool?.creatorFees;
  const sweepPool = pool != null && poolFees.gtn(0) && pool.coinCreator.equals(creator);
  if (sweepPool) {
    instructions.push(
      await PUMP_SDK.sweepPoolCreatorFeeInstruction({
        payer: user,
        mint,
        coinCreator: pool.coinCreator,
        quoteMint: NATIVE_MINT,
      }),
    );
  }
  return {
    instructions,
    curve: sweepCurve ? curveFee : 0,
    pool: sweepPool ? poolFees : 0,
  };
}

main().catch((e) => {
  process.stderr.write(`${e?.message ?? e}\n`);
  process.exit(1);
});
