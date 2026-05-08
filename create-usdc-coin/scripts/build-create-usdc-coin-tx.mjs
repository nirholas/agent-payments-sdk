#!/usr/bin/env node
/**
 * Build a USDC-paired create_v2 + buy_v2 transaction and partial-sign with
 * the generated mint keypair. User wallet must co-sign and send.
 * Never pass user secret keys to this script.
 *
 * Pre-flight: checks that USDC is whitelisted on-chain before building the tx.
 * If not whitelisted, exits 1 immediately with a clear message.
 */
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
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
import { PumpAgentOffline } from "@pump-fun/agent-payments-sdk";
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
import { buildAndPartialSignTx, transactionToBase64 } from "./lib/tx-build.mjs";
import { USDC_MINT_MAINNET, USDC_MINT_DEVNET } from "./lib/usdc.mjs";

const AGENT_INITIALIZE_DEFAULT_UNITS = 30_000;
const DEFAULT_BUYBACK_BPS = 5000;

const HELP = `Usage: node scripts/build-create-usdc-coin-tx.mjs [options]

Builds createV2AndBuyV2Instructions with USDC as quote mint.
Partial-signs with the generated mint keypair.
Runs a pre-flight whitelist check — exits 1 if USDC is not yet enabled.

Required:
  --user <PUBKEY>           Creator / fee payer (wallet that will co-sign)
  --name <string>
  --symbol <string>
  --metadata-uri <url>      Token metadata JSON URI
  --usdc-amount <int>       Initial buy in USDC base units (1 USDC = 1_000_000)
  --mint-keypair-out <path> Write mint secret key here as JSON byte array (never commit)

Optional:
  --usdc-mint <PUBKEY>      Override USDC mint (default: mainnet USDC)
  --mayhem-mode             (default: off)
  --cashback                (default: off)
  --tokenized-agent         Enable tokenized agent; accepts USDC payments natively (default: off)
  --buyback-bps <int>       Buyback basis points for tokenized agent (default: ${DEFAULT_BUYBACK_BPS} = 50%)
  --alt-address <PUBKEY>    Address Lookup Table override
  --compute-units <int>     Default: ${CREATE_AND_BUY_COMPUTE_UNITS}
  --priority-micro-lamports <int>  Fixed priority fee; omit to use getPriorityFeeEstimate RPC
  --front-runner-protection   Add Jito tip; send ONLY to Jito endpoints
  --tip-sol <float>           Jito tip in SOL (default 0.0001; requires --front-runner-protection)
  --skip-whitelist-check      Skip pre-flight USDC whitelist check
  -h, --help

Decimal note:
  SOL  — 9 decimals: 1 SOL  = 1_000_000_000 lamports
  USDC — 6 decimals: 1 USDC = 1_000_000 base units

Environment:
  SOLANA_RPC_URL or NEXT_PUBLIC_SOLANA_RPC_URL`;

async function checkUsdcWhitelisted(global, quoteMint) {
  const rawList = Array.isArray(global.whitelistedQuoteMints)
    ? global.whitelistedQuoteMints
    : [];
  const ZERO = "11111111111111111111111111111111";
  const mints = rawList
    .map((pk) => pk?.toBase58?.() ?? String(pk))
    .filter((b58) => b58 && b58 !== ZERO);
  return mints.includes(quoteMint.toBase58());
}

async function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      user: { type: "string" },
      name: { type: "string" },
      symbol: { type: "string" },
      "metadata-uri": { type: "string" },
      "usdc-amount": { type: "string" },
      "mint-keypair-out": { type: "string" },
      "usdc-mint": { type: "string" },
      "mayhem-mode": { type: "boolean", default: false },
      cashback: { type: "boolean", default: false },
      "tokenized-agent": { type: "boolean", default: false },
      "buyback-bps": { type: "string" },
      "alt-address": { type: "string" },
      "compute-units": { type: "string" },
      "priority-micro-lamports": { type: "string" },
      "front-runner-protection": { type: "boolean", default: false },
      "tip-sol": { type: "string" },
      "skip-whitelist-check": { type: "boolean", default: false },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
    allowPositionals: false,
  });

  if (values.help) exitWithHelp("build-create-usdc-coin-tx.mjs", HELP);

  const user = requirePublicKey("--user", values.user);
  const name = requireString("--name", values.name);
  const symbol = requireString("--symbol", values.symbol);
  const metadataUri = requireString("--metadata-uri", values["metadata-uri"]);
  const usdcAmountStr = requireString("--usdc-amount", values["usdc-amount"]);
  const usdcAmount = parsePositiveInt(usdcAmountStr, 0);
  if (usdcAmount <= 0) throw new Error("--usdc-amount must be > 0");

  const outPath = requireString("--mint-keypair-out", values["mint-keypair-out"]);
  const resolvedOut = resolve(process.cwd(), outPath);

  const mayhemMode = Boolean(values["mayhem-mode"]);
  const cashback = Boolean(values.cashback);
  const tokenizedAgent = Boolean(values["tokenized-agent"]);
  const buybackBps =
    values["buyback-bps"] != null
      ? parsePositiveInt(values["buyback-bps"], DEFAULT_BUYBACK_BPS)
      : DEFAULT_BUYBACK_BPS;

  const frontRunnerProtection = Boolean(values["front-runner-protection"]);
  const tipSol =
    values["tip-sol"] != null ? Number.parseFloat(values["tip-sol"]) : undefined;
  if (tipSol != null && (Number.isNaN(tipSol) || tipSol < 0)) {
    throw new Error("--tip-sol must be a non-negative number");
  }

  const skipWhitelistCheck = Boolean(values["skip-whitelist-check"]);

  const connection = getConnection();
  const isDevnet = connection.rpcEndpoint.includes("devnet");
  const defaultUsdc = isDevnet ? USDC_MINT_DEVNET : USDC_MINT_MAINNET;
  const quoteMint =
    values["usdc-mint"]?.trim()
      ? requirePublicKey("--usdc-mint", values["usdc-mint"])
      : new PublicKey(defaultUsdc);

  const defaultAlt = isDevnet ? ALT_ADDRESS_DEVNET : ALT_ADDRESS_MAINNET;
  const altAddressStr =
    values["alt-address"]?.trim() ||
    process.env.NEXT_PUBLIC_SOLANA_ALT_ADDRESS?.trim() ||
    defaultAlt;

  const defaultComputeUnits =
    CREATE_AND_BUY_COMPUTE_UNITS +
    (tokenizedAgent ? AGENT_INITIALIZE_DEFAULT_UNITS : 0);
  const computeUnits = values["compute-units"]
    ? parsePositiveInt(values["compute-units"], defaultComputeUnits)
    : defaultComputeUnits;

  const priorityOverride =
    values["priority-micro-lamports"] != null &&
    values["priority-micro-lamports"] !== ""
      ? parsePositiveInt(values["priority-micro-lamports"], 1)
      : null;

  const onlineSdk = new OnlinePumpSdk(connection);
  const [global, feeConfig] = await Promise.all([
    onlineSdk.fetchGlobal(),
    onlineSdk.fetchFeeConfig(),
  ]);

  if (!skipWhitelistCheck) {
    const whitelisted = await checkUsdcWhitelisted(global, quoteMint);
    if (!whitelisted) {
      process.stderr.write(
        `USDC (${quoteMint.toBase58()}) is not yet whitelisted as a quote mint.\n` +
        `pump.fun announced USDC creation is coming but it is not live yet.\n` +
        `Run check-usdc-whitelist.mjs to confirm current chain state.\n` +
        `When live, any create_v2 with this quote mint would fail with: quoteMintNotWhitelisted (6068).\n` +
        `Pass --skip-whitelist-check to bypass this pre-flight if you know what you are doing.\n`,
      );
      process.exit(1);
    }
  }

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

  // getBuyTokenAmountFromSolAmount is quote-mint-agnostic: it uses the
  // virtual/real reserve ratios in the Global config which work for any
  // quote mint (USDC or SOL).
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

  if (tokenizedAgent) {
    const agentInitializeIx = await PumpAgentOffline.load(mint).create({
      authority: user,
      mint,
      agentAuthority: user,
      buybackBps,
    });
    sdkInstructions.push(agentInitializeIx);
  }

  const tx = await buildAndPartialSignTx({
    connection,
    payerKey: user,
    sdkInstructions,
    computeUnits,
    priorityFeeMicroLamports: priorityOverride,
    extraSigners: [mintKeypair],
    addressLookupTableAccounts,
    frontRunnerProtection,
    tipSol,
  });

  mkdirSync(dirname(resolvedOut), { recursive: true });
  writeFileSync(
    resolvedOut,
    `${JSON.stringify(Array.from(mintKeypair.secretKey))}\n`,
    { mode: 0o600 },
  );

  printJson({
    transaction: transactionToBase64(tx),
    mintPublicKey: mint.toBase58(),
    mintKeypairPath: resolvedOut,
    quoteTokenAmount: tokenAmount.toString(),
    quoteMint: quoteMint.toBase58(),
    usdcAmount,
    mayhemMode,
    cashback,
    tokenizedAgent,
    ...(tokenizedAgent ? { buybackBps } : {}),
    frontRunnerProtection,
  });
}

main().catch((e) => {
  process.stderr.write(`${e?.message ?? e}\n`);
  process.exit(1);
});
