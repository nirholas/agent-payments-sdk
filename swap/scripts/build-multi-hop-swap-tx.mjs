#!/usr/bin/env node
/**
 * PumpSwap `multi_hop_swap`: exact-in swap along a chain of pump bonding
 * curves and canonical pump pools in one instruction, slippage checked once
 * on the final amount. Fees are charged once per route, not per hop.
 *
 * The route is resolved from chain (each hop uses the coin's curve while it
 * trades, else its canonical pool), simulated for `--user` (who must hold
 * `--amount-in` of the input) to quote the output, then built with
 * `minAmountOut` = simulated output less slippage. Routes longer than three
 * hops need an address lookup table (`--alt`, repeatable).
 *
 * Reference: pump-public-docs/docs/PUMP_SWAP_README.md
 */
import { parseArgs } from "node:util";
import BN from "bn.js";
import { OnlinePumpSdk, PUMP_SDK, multiHopRouteEnds } from "@pump-fun/pump-sdk";
import { getConnection } from "./lib/env.mjs";
import {
  exitWithHelp,
  parsePositiveInt,
  parseSlippagePercent,
  printJson,
  requirePublicKey,
  requireString,
} from "./lib/args.mjs";
import { buildAndPartialSignTx, transactionToBase64 } from "./lib/tx-build.mjs";

/** ~200k CU per hop plus ATA creation and SOL wrapping; 1.4M is the cap. */
const CU_PER_HOP = 200_000;
const CU_BASE = 100_000;
const MAX_CU = 1_400_000;

const HELP = `Usage: node scripts/build-multi-hop-swap-tx.mjs [options]

Exact-in multi_hop_swap along --path (mints in trade order). A buy climbs a
quote chain (SOL,A,B: A quoted in SOL, B quoted in A); a sell walks it down
(B,A,SOL). Every hop must be a pump curve or a canonical, non-mayhem pump pool.

Required:
  --user <PUBKEY>
  --path <MINT,MINT[,...]>  Comma-separated mints; SOL may be wSOL or 1111...1111
  --side <buy|sell>
  --amount-in <int>         Exact input in the first mint's smallest units

Optional:
  --slippage <percent>      Default 5
  --alt <PUBKEY>            Address lookup table (repeatable; needed past 3 hops)
  --compute-units <int>     Default ${CU_BASE} + ${CU_PER_HOP} per hop
  --priority-micro-lamports <int>
  --front-runner-protection
  --tip-sol <float>         Jito tip in SOL (requires --front-runner-protection)
  -h, --help

Environment:
  SOLANA_RPC_URL or NEXT_PUBLIC_SOLANA_RPC_URL`;

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      user: { type: "string" },
      path: { type: "string" },
      side: { type: "string" },
      "amount-in": { type: "string" },
      slippage: { type: "string" },
      alt: { type: "string", multiple: true },
      "compute-units": { type: "string" },
      "priority-micro-lamports": { type: "string" },
      "front-runner-protection": { type: "boolean", default: false },
      "tip-sol": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) exitWithHelp("build-multi-hop-swap-tx.mjs", HELP);

  const user = requirePublicKey("--user", values.user);
  const path = requireString("--path", values.path)
    .split(",")
    .map((s, i) => requirePublicKey(`--path[${i}]`, s.trim()));
  if (path.length < 2) throw new Error("--path needs at least two mints (input and output)");
  const side = requireString("--side", values.side).toLowerCase();
  if (side !== "buy" && side !== "sell") throw new Error('--side must be "buy" or "sell"');
  const amountIn = new BN(requireString("--amount-in", values["amount-in"]), 10);
  if (amountIn.lte(new BN(0))) throw new Error("--amount-in must be > 0");

  const slippage = parseSlippagePercent(values.slippage, 5);
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

  const altKeys = (values.alt ?? []).map((s, i) => requirePublicKey(`--alt[${i}]`, s));
  const addressLookupTables = [];
  for (const key of altKeys) {
    const { value } = await connection.getAddressLookupTable(key);
    if (!value) throw new Error(`Address lookup table not found: ${key.toBase58()}`);
    addressLookupTables.push(value);
  }

  const onlineSdk = new OnlinePumpSdk(connection);
  const hops = await onlineSdk.resolveMultiHopRoute(path, side);
  if (hops.length > 3 && addressLookupTables.length === 0) {
    throw new Error(
      `A ${hops.length}-hop route does not fit a transaction without a lookup table: pass --alt.`,
    );
  }

  const expectedAmountOut = await onlineSdk.simulateMultiHopSwap({
    user,
    hops,
    side,
    amountIn,
    addressLookupTables,
  });
  if (expectedAmountOut.lte(new BN(0))) {
    throw new Error("Simulated output is zero: amount too small for the route.");
  }
  const slippageBps = Math.round(slippage * 100);
  const minAmountOut = expectedAmountOut.muln(10_000 - slippageBps).divn(10_000);

  const sdkInstructions = await PUMP_SDK.multiHopSwapInstructions({
    user,
    hops,
    side,
    amountIn,
    minAmountOut,
  });

  const defaultUnits = Math.min(MAX_CU, CU_BASE + CU_PER_HOP * hops.length);
  const computeUnits = values["compute-units"]
    ? parsePositiveInt(values["compute-units"], defaultUnits)
    : defaultUnits;

  const tx = await buildAndPartialSignTx({
    connection,
    payerKey: user,
    sdkInstructions,
    computeUnits,
    priorityFeeMicroLamports: priorityOverride,
    addressLookupTableAccounts: addressLookupTables,
    frontRunnerProtection,
    tipSol,
  });

  const ends = multiHopRouteEnds(hops, side);
  printJson({
    transaction: transactionToBase64(tx),
    side,
    hops: hops.map((h) => ({
      venue: h.venue,
      baseMint: h.baseMint.toBase58(),
      quoteMint: h.quoteMint.toBase58(),
    })),
    inputMint: ends.input.mint.toBase58(),
    outputMint: ends.output.mint.toBase58(),
    amountIn: amountIn.toString(),
    expectedAmountOut: expectedAmountOut.toString(),
    minAmountOut: minAmountOut.toString(),
    slippagePercent: slippage,
    computeUnits,
    frontRunnerProtection,
  });
}

main().catch((e) => {
  process.stderr.write(`${e?.message ?? e}\n`);
  process.exit(1);
});
