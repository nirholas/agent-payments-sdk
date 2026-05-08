#!/usr/bin/env node
/**
 * Simulate (do not send) a USDC-paired create+buy transaction. Used as
 * a smoke-test: run daily before USDC creation goes live, and the only
 * expected error should be `quoteMintNotWhitelisted` (code 6068). Any
 * other error indicates a bug to fix before launch.
 */
import { parseArgs } from "node:util";
import BN from "bn.js";
import { Keypair, PublicKey } from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  PUMP_SDK,
  OnlinePumpSdk,
  getBuyTokenAmountFromSolAmount,
} from "@pump-fun/pump-sdk";
import { getConnection } from "./lib/env.mjs";
import {
  exitWithHelp,
  parsePositiveInt,
  printJson,
  requirePublicKey,
  requireString,
} from "./lib/args.mjs";
import {
  CREATE_AND_BUY_COMPUTE_UNITS,
  ALT_ADDRESS_MAINNET,
  ALT_ADDRESS_DEVNET,
} from "./lib/constants.mjs";
import { buildAndPartialSignTx } from "./lib/tx-build.mjs";
import {
  USDC_MINT_MAINNET,
  USDC_MINT_DEVNET,
  PUMP_ERRORS_BY_CODE,
} from "./lib/usdc.mjs";

const HELP = `Usage: node scripts/simulate-create-usdc-coin.mjs [options]

Builds and simulates (sigVerify=false, replaceRecentBlockhash=true) a
USDC-paired createV2+buyV2 transaction. Does not send.

Required:
  --user <PUBKEY>           Creator / fee payer
  --name <string>
  --symbol <string>
  --metadata-uri <url>
  --usdc-amount <int>       Initial buy in USDC base units (1 USDC = 1_000_000)

Optional:
  --network <mainnet|devnet>  Default: mainnet
  --usdc-mint <PUBKEY>        Override USDC mint (defaults per network)
  --mayhem-mode               (default: off)
  --cashback                  (default: off)
  --compute-units <int>       Default: ${CREATE_AND_BUY_COMPUTE_UNITS}
  --alt-address <PUBKEY>      Address Lookup Table override
  -h, --help

Environment:
  SOLANA_RPC_URL or NEXT_PUBLIC_SOLANA_RPC_URL`;

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      user: { type: "string" },
      name: { type: "string" },
      symbol: { type: "string" },
      "metadata-uri": { type: "string" },
      "usdc-amount": { type: "string" },
      network: { type: "string", default: "mainnet" },
      "usdc-mint": { type: "string" },
      "mayhem-mode": { type: "boolean", default: false },
      cashback: { type: "boolean", default: false },
      "compute-units": { type: "string" },
      "alt-address": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) exitWithHelp("simulate-create-usdc-coin.mjs", HELP);

  const user = requirePublicKey("--user", values.user);
  const name = requireString("--name", values.name);
  const symbol = requireString("--symbol", values.symbol);
  const metadataUri = requireString("--metadata-uri", values["metadata-uri"]);
  const usdcAmountStr = requireString("--usdc-amount", values["usdc-amount"]);
  const usdcAmount = parsePositiveInt(usdcAmountStr, 0);
  if (usdcAmount <= 0) throw new Error("--usdc-amount must be > 0");

  const network = values.network === "devnet" ? "devnet" : "mainnet";
  const defaultUsdc = network === "devnet" ? USDC_MINT_DEVNET : USDC_MINT_MAINNET;
  const quoteMint =
    values["usdc-mint"]?.trim()
      ? requirePublicKey("--usdc-mint", values["usdc-mint"])
      : new PublicKey(defaultUsdc);

  const mayhemMode = Boolean(values["mayhem-mode"]);
  const cashback = Boolean(values.cashback);
  const computeUnits = values["compute-units"]
    ? parsePositiveInt(values["compute-units"], CREATE_AND_BUY_COMPUTE_UNITS)
    : CREATE_AND_BUY_COMPUTE_UNITS;

  const connection = getConnection();
  const isDevnet = connection.rpcEndpoint.includes("devnet") || network === "devnet";
  const defaultAlt = isDevnet ? ALT_ADDRESS_DEVNET : ALT_ADDRESS_MAINNET;
  const altAddressStr =
    values["alt-address"]?.trim() ||
    process.env.NEXT_PUBLIC_SOLANA_ALT_ADDRESS?.trim() ||
    defaultAlt;

  const onlineSdk = new OnlinePumpSdk(connection);
  const [global, feeConfig] = await Promise.all([
    onlineSdk.fetchGlobal(),
    onlineSdk.fetchFeeConfig(),
  ]);

  let addressLookupTableAccounts = [];
  if (altAddressStr) {
    const altAccount = await connection.getAddressLookupTable(
      new PublicKey(altAddressStr),
    );
    if (altAccount.value) addressLookupTableAccounts = [altAccount.value];
  }

  const quoteOwnerInfo = await connection.getAccountInfo(quoteMint);
  if (!quoteOwnerInfo) throw new Error(`Quote mint not found: ${quoteMint.toBase58()}`);
  const quoteTokenProgram = quoteOwnerInfo.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;

  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;
  const quoteAmount = new BN(usdcAmount);

  const tokenAmount = getBuyTokenAmountFromSolAmount({
    global,
    feeConfig,
    mintSupply: null,
    bondingCurve: null,
    amount: quoteAmount,
  });

  const sdkInstructions = await PUMP_SDK.createV2AndBuyV2Instructions({
    global,
    mint,
    name,
    symbol,
    uri: metadataUri,
    creator: user,
    user,
    amount: tokenAmount,
    quoteAmount,
    mayhemMode,
    cashback,
    quoteMint,
    quoteTokenProgram,
  });

  const tx = await buildAndPartialSignTx({
    connection,
    payerKey: user,
    sdkInstructions,
    computeUnits,
    priorityFeeMicroLamports: 100_000,
    extraSigners: [mintKeypair],
    addressLookupTableAccounts,
  });

  const result = await connection.simulateTransaction(tx, {
    sigVerify: false,
    replaceRecentBlockhash: true,
    commitment: "confirmed",
  });

  const err = result.value.err ?? null;
  const logs = result.value.logs ?? [];
  const unitsConsumed = result.value.unitsConsumed ?? null;

  let programErrorCode = null;
  let programErrorName = null;
  if (err) {
    const ie = err?.InstructionError;
    if (Array.isArray(ie) && ie[1] && typeof ie[1] === "object") {
      const customCode = ie[1].Custom;
      if (typeof customCode === "number") {
        programErrorCode = customCode;
        programErrorName = PUMP_ERRORS_BY_CODE[customCode] ?? null;
      }
    }
  }

  printJson({
    success: err === null,
    network,
    quoteMint: quoteMint.toBase58(),
    usdcAmount,
    unitsConsumed,
    err,
    programErrorCode,
    programErrorName,
    logs,
  });

  process.exit(err === null ? 0 : 1);
}

main().catch((e) => {
  process.stderr.write(`${e?.message ?? e}\n`);
  process.exit(1);
});
