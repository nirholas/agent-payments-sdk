#!/usr/bin/env node
/**
 * USDC Whitelist Monitor
 * WebSocket subscription + 15s polling backup on pump.fun Global PDA.
 * The instant USDC appears in whitelistedQuoteMints, fires a create_v2 tx.
 *
 * Usage:
 *   node scripts/usdc-whitelist-monitor.mjs            # live mode
 *   node scripts/usdc-whitelist-monitor.mjs --dry-run  # simulate only, skip send
 *
 * Env:
 *   HELIUS_RPC_URL  — optional Helius RPC (recommended for reliability)
 */

import { readFileSync, writeFileSync } from "fs";
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
import { PUMP_SDK, GLOBAL_PDA } from "@pump-fun/pump-sdk";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const COIN_NAME = "TEST";
const COIN_SYMBOL = "TEST";
const COIN_URI = "https://ipfs.io/ipfs/QmfTCrSFAp7GQG9aByvgwfaCwkzE9KpTXB5tMmFjnAEc89";
const POLL_INTERVAL_MS = 15_000;
const RETRY_DELAY_MS = 5_000;

const IS_DRY_RUN = process.argv.includes("--dry-run");

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
const rpcUrl = process.env.HELIUS_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const connection = new Connection(rpcUrl, "confirmed");

const walletBytes = JSON.parse(readFileSync(join(ROOT, ".wallet.json"), "utf-8"));
const wallet = Keypair.fromSecretKey(Uint8Array.from(walletBytes));

console.log("=".repeat(60));
console.log("USDC Whitelist Monitor");
console.log("=".repeat(60));
console.log(`Wallet : ${wallet.publicKey.toBase58()}`);
console.log(`RPC    : ${rpcUrl}`);
console.log(`Mode   : ${IS_DRY_RUN ? "DRY RUN (simulate only)" : "LIVE"}`);
console.log(`Target : ${GLOBAL_PDA.toBase58()}`);
console.log("=".repeat(60));
console.log("Watching for USDC...\n");

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let fired = false;
let wsSubId = null;
let pollTimer = null;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isUsdcWhitelisted(accountInfo) {
  if (!accountInfo) return false;
  try {
    const global = PUMP_SDK.decodeGlobal(accountInfo);
    const mints = global.whitelistedQuoteMints ?? [];
    return mints.some((m) => m.equals(USDC_MINT));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Core: detect → build → simulate → send → confirm
// ---------------------------------------------------------------------------
async function fireCoin(detectedAt, slot) {
  if (fired) return;
  fired = true;

  stopWatcher();

  console.log("\n" + "!".repeat(60));
  console.log("USDC DETECTED IN WHITELIST!");
  console.log(`Timestamp : ${detectedAt}`);
  if (slot != null) console.log(`Slot      : ${slot}`);
  console.log("!".repeat(60) + "\n");

  const mintKeypair = Keypair.generate();
  const mintPubkey = mintKeypair.publicKey.toBase58();
  console.log(`New mint keypair: ${mintPubkey}`);
  writeFileSync(
    join(ROOT, ".usdc-coin-mint.json"),
    JSON.stringify(Array.from(mintKeypair.secretKey))
  );
  console.log("Mint keypair saved → .usdc-coin-mint.json\n");

  for (let attempt = 1; ; attempt++) {
    try {
      console.log(`[Attempt ${attempt}] Building create_v2 transaction...`);

      const createIx = await PUMP_SDK.createV2Instruction({
        mint: mintKeypair.publicKey,
        name: COIN_NAME,
        symbol: COIN_SYMBOL,
        uri: COIN_URI,
        creator: wallet.publicKey,
        user: wallet.publicKey,
        mayhemMode: false,
        quoteMint: USDC_MINT,
      });

      const cuLimitIx = ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 });
      const cuPriceIx = ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 500_000 });

      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("confirmed");

      const message = new TransactionMessage({
        payerKey: wallet.publicKey,
        recentBlockhash: blockhash,
        instructions: [cuLimitIx, cuPriceIx, createIx],
      }).compileToV0Message();

      const tx = new VersionedTransaction(message);
      tx.sign([wallet, mintKeypair]);

      // Simulate first — even in live mode
      console.log("[Attempt " + attempt + "] Simulating...");
      const sim = await connection.simulateTransaction(tx, { commitment: "confirmed" });

      if (sim.value.err) {
        console.error(`Simulation failed: ${JSON.stringify(sim.value.err)}`);
        if (sim.value.logs?.length) {
          console.error("Program logs:\n" + sim.value.logs.join("\n"));
        }
        console.log(`Retrying in ${RETRY_DELAY_MS / 1000}s...\n`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      console.log(`Simulation OK — CU consumed: ${sim.value.unitsConsumed ?? "?"}`);

      if (IS_DRY_RUN) {
        console.log("\n[DRY RUN] Simulation passed. Send skipped.");
        console.log(`Would create: https://pump.fun/${mintPubkey}`);
        process.exit(0);
      }

      // Send with skipPreflight for max speed
      console.log("Sending transaction (skipPreflight=true)...");
      const sig = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
        maxRetries: 3,
      });
      console.log(`Transaction sent: ${sig}`);

      // Wait for confirmation (up to lastValidBlockHeight expiry)
      console.log("Waiting for confirmation...");
      const confirm = await connection.confirmTransaction(
        { signature: sig, blockhash, lastValidBlockHeight },
        "confirmed"
      );

      if (confirm.value.err) {
        console.error(`On-chain error: ${JSON.stringify(confirm.value.err)}`);
        console.log(`Retrying in ${RETRY_DELAY_MS / 1000}s...\n`);
        await sleep(RETRY_DELAY_MS);
        continue;
      }

      // Success
      const createdAt = new Date().toISOString();
      const result = {
        mint: mintPubkey,
        txSignature: sig,
        pumpUrl: `https://pump.fun/${mintPubkey}`,
        detectedAt,
        createdAt,
      };
      writeFileSync(join(ROOT, ".usdc-coin-result.json"), JSON.stringify(result, null, 2));

      console.log("\n" + "=".repeat(60));
      console.log("COIN CREATED SUCCESSFULLY!");
      console.log(`pump.fun/${mintPubkey}`);
      console.log(`Tx: ${sig}`);
      console.log("=".repeat(60) + "\n");
      break;
    } catch (err) {
      console.error(`Error on attempt ${attempt}: ${err.message}`);
      console.log(`Retrying in ${RETRY_DELAY_MS / 1000}s...\n`);
      await sleep(RETRY_DELAY_MS);
    }
  }

  process.exit(0);
}

// ---------------------------------------------------------------------------
// Account change handler (WebSocket path)
// ---------------------------------------------------------------------------
async function handleAccountChange(accountInfo) {
  if (fired) return;
  if (isUsdcWhitelisted(accountInfo)) {
    const detectedAt = new Date().toISOString();
    console.log(`[WS] Account change detected at ${detectedAt}`);
    let slot = null;
    try {
      slot = await connection.getSlot("confirmed");
    } catch {}
    await fireCoin(detectedAt, slot);
  }
}

// ---------------------------------------------------------------------------
// Poll loop (15s backup)
// ---------------------------------------------------------------------------
async function poll() {
  if (fired) return;
  try {
    const accountInfo = await connection.getAccountInfo(GLOBAL_PDA, "confirmed");
    if (isUsdcWhitelisted(accountInfo)) {
      const detectedAt = new Date().toISOString();
      console.log(`[Poll] USDC detected at ${detectedAt}`);
      let slot = null;
      try {
        slot = await connection.getSlot("confirmed");
      } catch {}
      await fireCoin(detectedAt, slot);
      return;
    }
    const ts = new Date().toLocaleTimeString();
    console.log(`[${ts}] Not whitelisted yet. Next poll in ${POLL_INTERVAL_MS / 1000}s`);
  } catch (err) {
    const ts = new Date().toLocaleTimeString();
    console.error(`[${ts}] Poll error: ${err.message}`);
  }

  if (!fired) {
    pollTimer = setTimeout(poll, POLL_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
function stopWatcher() {
  if (wsSubId !== null) {
    connection.removeAccountChangeListener(wsSubId).catch(() => {});
    wsSubId = null;
  }
  if (pollTimer !== null) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

function shutdown() {
  console.log("\nShutting down gracefully...");
  stopWatcher();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ---------------------------------------------------------------------------
// Start: WebSocket subscription + initial poll
// ---------------------------------------------------------------------------
wsSubId = connection.onAccountChange(GLOBAL_PDA, handleAccountChange, "confirmed");
console.log(`WebSocket subscribed to Global PDA\n`);

// Run first poll immediately, then every 15s
await poll();
