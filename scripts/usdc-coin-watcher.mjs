#!/usr/bin/env node
// usdc-coin-watcher.mjs
// Run: node scripts/usdc-coin-watcher.mjs [--dry-run] [--notify-only] [--once]
//
// Polls pump.fun Global account every 15 s. The instant USDC appears in
// whitelistedQuoteMints it creates a v2 pump.fun coin with quoteMint = USDC.
//
// Flags:
//   --dry-run      build + simulate only, do not send
//   --notify-only  detect and log, do not create a coin
//   --once         single poll then exit (for cron / CI use)

import { readFileSync, writeFileSync, existsSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  Connection,
  Keypair,
  PublicKey,
  ComputeBudgetProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import { PUMP_SDK, OnlinePumpSdk, GLOBAL_PDA } from "@pump-fun/pump-sdk";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const PUMP_PROGRAM_ID = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const METADATA_URI =
  "https://ipfs.io/ipfs/QmfTCrSFAp7GQG9aByvgwfaCwkzE9KpTXB5tMmFjnAEc89";
const COIN_NAME = "Agent Payments";
const COIN_SYMBOL = "AGNT";
const RESULT_FILE = join(ROOT, ".usdc-coin-result.json");
const MINT_FILE = join(ROOT, ".usdc-coin-mint.json");
const POLL_INTERVAL_MS = 15_000;
const RETRY_DELAY_MS = 5_000;
const RPC_URL =
  process.env.HELIUS_RPC_URL ||
  process.env.SOLANA_RPC_URL ||
  "https://api.mainnet-beta.solana.com";

// ---------------------------------------------------------------------------
// Parse CLI flags
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const NOTIFY_ONLY = argv.includes("--notify-only");
const ONCE = argv.includes("--once");

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------
function loadWallet() {
  const walletPath = join(ROOT, ".wallet.json");
  if (!existsSync(walletPath)) {
    console.error("ERROR: .wallet.json not found at", walletPath);
    console.error(
      "Create it with:\n" +
        "  node -e \"const k=require('@solana/web3.js').Keypair.generate();" +
        " require('fs').writeFileSync('.wallet.json', JSON.stringify(Array.from(k.secretKey)));\""
    );
    process.exit(1);
  }
  const secretKey = Uint8Array.from(
    JSON.parse(readFileSync(walletPath, "utf8"))
  );
  return Keypair.fromSecretKey(secretKey);
}

// ---------------------------------------------------------------------------
// USDC whitelist check
// ---------------------------------------------------------------------------
async function checkUsdcWhitelisted(onlineSdk) {
  try {
    const global = await onlineSdk.fetchGlobal();
    const mints = global.whitelistedQuoteMints || [];
    const mintStrings = mints.map((m) =>
      m.toBase58 ? m.toBase58() : String(m)
    );
    return {
      isWhitelisted: mintStrings.includes(USDC_MINT.toBase58()),
      whitelistedMints: mintStrings,
      global,
    };
  } catch (err) {
    console.warn("[poll] fetchGlobal error:", err.message);
    return { isWhitelisted: false, whitelistedMints: [], global: null };
  }
}

// ---------------------------------------------------------------------------
// Notification
// ---------------------------------------------------------------------------
async function sendNotification(title, message) {
  // Try node-notifier first (optional dependency)
  try {
    const { default: notifier } = await import("node-notifier");
    notifier.notify({ title, message, sound: true });
    return;
  } catch {
    // not installed — fall through to terminal bell
  }
  process.stdout.write("\x07"); // terminal bell
  console.log("\n" + "=".repeat(60));
  console.log(`NOTIFICATION: ${title}`);
  console.log(message);
  console.log("=".repeat(60) + "\n");
}

// ---------------------------------------------------------------------------
// Mint keypair (persisted so a restart reuses the same mint address)
// ---------------------------------------------------------------------------
function getOrCreateMintKeypair() {
  if (existsSync(MINT_FILE)) {
    console.log("[create] Loading existing mint keypair from", MINT_FILE);
    return Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(readFileSync(MINT_FILE, "utf8")))
    );
  }
  const mintKp = Keypair.generate();
  writeFileSync(MINT_FILE, JSON.stringify(Array.from(mintKp.secretKey)));
  console.log("[create] Generated new mint keypair:", mintKp.publicKey.toBase58());
  return mintKp;
}

// ---------------------------------------------------------------------------
// Build + send the create_v2 coin transaction
// ---------------------------------------------------------------------------
async function createUsdcCoin(wallet, connection) {
  const mintKp = getOrCreateMintKeypair();

  console.log("[create] Building createV2Instruction...");
  const createIx = await PUMP_SDK.createV2Instruction({
    mint: mintKp.publicKey,
    name: COIN_NAME,
    symbol: COIN_SYMBOL,
    uri: METADATA_URI,
    creator: wallet.publicKey,
    user: wallet.publicKey,
    mayhemMode: false,
    quoteMint: USDC_MINT,
  });

  const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
  const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({
    microLamports: 500_000,
  });

  const { blockhash, lastValidBlockHeight } =
    await connection.getLatestBlockhash("confirmed");

  const message = new TransactionMessage({
    payerKey: wallet.publicKey,
    recentBlockhash: blockhash,
    instructions: [cuLimitIx, cuPriceIx, createIx],
  }).compileToV0Message();

  const tx = new VersionedTransaction(message);
  tx.sign([wallet, mintKp]);

  // Always simulate first
  console.log("[create] Simulating transaction...");
  const sim = await connection.simulateTransaction(tx, {
    commitment: "confirmed",
  });

  if (sim.value.err) {
    const logs = sim.value.logs?.join("\n") ?? "";
    throw new Error(
      `Simulation failed: ${JSON.stringify(sim.value.err)}\n${logs}`
    );
  }
  console.log(
    `[create] Simulation OK — CU consumed: ${sim.value.unitsConsumed ?? "?"}`
  );

  if (DRY_RUN) {
    console.log("[dry-run] Send skipped.");
    return {
      dryRun: true,
      mint: mintKp.publicKey.toBase58(),
      pumpUrl: `https://pump.fun/coin/${mintKp.publicKey.toBase58()}`,
      simulationLogs: sim.value.logs,
      simulationError: sim.value.err,
    };
  }

  // Send
  console.log("[create] Sending transaction (skipPreflight=true)...");
  const sig = await connection.sendRawTransaction(tx.serialize(), {
    skipPreflight: true,
    maxRetries: 3,
  });
  console.log("[create] Sent:", sig);

  const conf = await connection.confirmTransaction(
    { signature: sig, blockhash, lastValidBlockHeight },
    "confirmed"
  );
  if (conf.value.err) {
    throw new Error(
      "Transaction confirmed with error: " + JSON.stringify(conf.value.err)
    );
  }

  const mint = mintKp.publicKey.toBase58();
  const pumpUrl = `https://pump.fun/coin/${mint}`;
  console.log("[create] SUCCESS!");
  console.log("[create] Mint:", mint);
  console.log("[create] Tx  :", sig);
  console.log("[create] URL :", pumpUrl);

  return { mint, sig, pumpUrl, dryRun: false };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log("=".repeat(60));
  console.log("[usdc-coin-watcher] Starting...");
  console.log(
    `[usdc-coin-watcher] Flags: DRY_RUN=${DRY_RUN} NOTIFY_ONLY=${NOTIFY_ONLY} ONCE=${ONCE}`
  );
  console.log("=".repeat(60));

  const wallet = loadWallet();
  const connection = new Connection(RPC_URL, "confirmed");
  const onlineSdk = new OnlinePumpSdk(connection);

  console.log("[usdc-coin-watcher] Wallet :", wallet.publicKey.toBase58());
  console.log("[usdc-coin-watcher] RPC    :", RPC_URL);
  if (!ONCE) {
    console.log(
      `[usdc-coin-watcher] Polling every ${POLL_INTERVAL_MS / 1000}s...`
    );
  }

  // Idempotency guard — skip if already completed (unless dry-run)
  if (existsSync(RESULT_FILE)) {
    const prior = JSON.parse(readFileSync(RESULT_FILE, "utf8"));
    console.log("[usdc-coin-watcher] Already completed. Result:", prior);
    if (!DRY_RUN) {
      console.log(
        `[usdc-coin-watcher] Delete ${RESULT_FILE} to re-run.`
      );
      process.exit(0);
    }
  }

  let attempts = 0;

  while (true) {
    attempts++;
    console.log(
      `[poll] Check #${attempts} at ${new Date().toISOString()}`
    );

    const { isWhitelisted, whitelistedMints } =
      await checkUsdcWhitelisted(onlineSdk);

    if (!isWhitelisted) {
      const mintList = whitelistedMints.join(", ") || "(none)";
      console.log(`[poll] USDC not yet whitelisted. Current mints: ${mintList}`);

      if (ONCE) {
        console.log("[once] Exiting.");
        process.exit(0);
      }

      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      continue;
    }

    // USDC is live
    console.log("[poll] USDC IS WHITELISTED! Mints:", whitelistedMints);
    await sendNotification(
      "pump.fun USDC Live!",
      "USDC is now whitelisted on pump.fun v2 bonding curves."
    );

    if (NOTIFY_ONLY) {
      console.log("[notify-only] Detected USDC. Exiting without creating coin.");
      process.exit(0);
    }

    // Retry loop for the create transaction
    let result = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`[create] Attempt ${attempt}/3...`);
        result = await createUsdcCoin(wallet, connection);
        break;
      } catch (err) {
        console.error(`[create] Attempt ${attempt} failed: ${err.message}`);
        if (attempt < 3) {
          console.log(`[create] Retrying in ${RETRY_DELAY_MS / 1000}s...`);
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        }
      }
    }

    if (!result) {
      console.error("[create] All 3 attempts failed. Exiting.");
      process.exit(1);
    }

    const finalResult = {
      ...result,
      timestamp: new Date().toISOString(),
      walletPubkey: wallet.publicKey.toBase58(),
    };

    if (!DRY_RUN) {
      writeFileSync(RESULT_FILE, JSON.stringify(finalResult, null, 2));
      console.log("[result] Saved to", RESULT_FILE);
      await sendNotification(
        "Coin Created!",
        `Mint: ${result.mint}\n${result.pumpUrl}`
      );
    }

    console.log("[done]", JSON.stringify(finalResult, null, 2));
    process.exit(0);
  }
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
