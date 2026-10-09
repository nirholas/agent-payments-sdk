#!/usr/bin/env node
/**
 * Only use this script when the user explicitly requests it. Default: POST https://fun-block.pump.fun/agents/collect-fees
 * (The API auto-detects sharing config vs direct collect.)
 *
 * Build a transaction to distribute creator fees when a sharing config exists.
 * Uses OnlinePumpSdk.buildDistributeCreatorFeesInstructions, which emits, in
 * order: the creator-fee sweeps (fees v3 curve trades left on the curve and
 * pump-amm v2 trades left in the pool; distribution fails with 6095
 * CreatorFeesNotSwept while the curve bucket is nonzero), the AMM vault
 * consolidation when graduated, then the distribution itself.
 */
import { parseArgs } from "node:util";
import {
  OnlinePumpSdk,
  PUMP_SDK,
  canonicalPumpPoolPda,
  feeSharingConfigPda,
  hasCoinCreatorMigratedToSharingConfig,
} from "@pump-fun/pump-sdk";
import { OnlinePumpAmmSdk } from "@pump-fun/pump-swap-sdk";
import { PublicKey } from "@solana/web3.js";
import { getConnection } from "./lib/env.mjs";
import {
  exitWithHelp,
  parsePositiveInt,
  printJson,
  requirePublicKey,
} from "./lib/args.mjs";
import { buildAndPartialSignTx, transactionToBase64 } from "./lib/tx-build.mjs";

// Up to two sweeps, the AMM consolidation and a ten-shareholder distribution.
const DISTRIBUTE_FEE_DEFAULT_UNITS = 300_000;

const HELP = `Usage: node scripts/build-distribute-fees-tx.mjs [options]

Build a transaction to distribute shared creator fees to shareholders.
Requires the coin to have an active fee sharing config.

Required:
  --mint <PUBKEY>
  --user <PUBKEY>                Fee payer / crank caller

Optional:
  --compute-units <int>          Default ${DISTRIBUTE_FEE_DEFAULT_UNITS}
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
      "compute-units": { type: "string" },
      "priority-micro-lamports": { type: "string" },
      "front-runner-protection": { type: "boolean", default: false },
      "tip-sol": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) exitWithHelp("build-distribute-fees-tx.mjs", HELP);

  const mint = requirePublicKey("--mint", values.mint);
  const user = requirePublicKey("--user", values.user);

  const computeUnits = values["compute-units"]
    ? parsePositiveInt(values["compute-units"], DISTRIBUTE_FEE_DEFAULT_UNITS)
    : DISTRIBUTE_FEE_DEFAULT_UNITS;
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
  const poolCoinCreator = await fetchPoolCoinCreator(connection, mint);
  const effectiveCreator = poolCoinCreator ?? new PublicKey(bondingCurve.creator);

  if (!hasCoinCreatorMigratedToSharingConfig({ mint, creator: effectiveCreator })) {
    throw new Error(
      "This coin does not use a fee sharing config. Use build-collect-fee-tx.mjs instead.",
    );
  }

  const sharingConfigAddress = feeSharingConfigPda(mint);
  const sharingConfigAccountInfo = await connection.getAccountInfo(sharingConfigAddress);
  if (!sharingConfigAccountInfo) {
    throw new Error("Sharing config account not found on-chain.");
  }
  const sharingConfig = PUMP_SDK.decodeSharingConfig(sharingConfigAccountInfo);

  const { instructions, isGraduated, sweepCount } =
    await onlineSdk.buildDistributeCreatorFeesInstructions(mint, {
      quoteMint: bondingCurve.quoteMint,
      payer: user,
    });

  const tx = await buildAndPartialSignTx({
    connection,
    payerKey: user,
    sdkInstructions: instructions,
    computeUnits,
    priorityFeeMicroLamports: priorityOverride,
    frontRunnerProtection,
    tipSol,
  });

  printJson({
    transaction: transactionToBase64(tx),
    sharingConfigAddress: sharingConfigAddress.toBase58(),
    shareholderCount: sharingConfig.shareholders.length,
    isGraduated,
    sweepCount,
    frontRunnerProtection,
  });
}

/** The canonical pool's coin creator, or null before graduation. */
async function fetchPoolCoinCreator(connection, mint) {
  const poolPda = canonicalPumpPoolPda(mint);
  if (!(await connection.getAccountInfo(poolPda))) return null;
  try {
    const pool = await new OnlinePumpAmmSdk(connection).fetchPool(poolPda);
    return pool.coinCreator;
  } catch {
    return null;
  }
}

main().catch((e) => {
  process.stderr.write(`${e?.message ?? e}\n`);
  process.exit(1);
});
