/**
 * watch-usdc-whitelist.ts
 *
 * Watches pump.fun's Global.whitelistedQuoteMints for USDC appearing on-chain.
 * The on-chain signal fires within seconds of the transaction — faster than
 * any Discord announcement.
 *
 * Usage:
 *   SOLANA_RPC_URL=wss://api.mainnet-beta.solana.com \
 *     npx tsx src/solana/examples/watch-usdc-whitelist.ts
 *
 * NOTE: `connection.onAccountChange` requires a WebSocket endpoint (wss://).
 * api.mainnet-beta.solana.com supports both http and wss on the same host.
 * If you pass an http:// URL this script will warn and attempt to continue —
 * some RPC providers implement a polling fallback, but a wss:// URL is
 * strongly recommended for real-time detection.
 */

import { Connection, PublicKey } from "@solana/web3.js";
import { WhitelistMonitor, type WhitelistChangeEvent } from "../WhitelistMonitor.js";

// USDC on Solana mainnet.
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

const rpcUrl = process.env.SOLANA_RPC_URL ?? "wss://api.mainnet-beta.solana.com";

if (rpcUrl.startsWith("http://") || rpcUrl.startsWith("https://")) {
  process.stderr.write(
    [
      "⚠️  WARNING: SOLANA_RPC_URL appears to be an HTTP endpoint.",
      "   connection.onAccountChange requires a WebSocket (wss://) URL for",
      "   real-time delivery. Some providers support polling fallback but",
      "   latency will be much higher. Use wss:// for reliable detection.",
      "",
    ].join("\n"),
  );
}

const connection = new Connection(rpcUrl, "confirmed");

function formatMints(mints: PublicKey[]): string {
  if (mints.length === 0) return "(none)";
  return mints.map((k) => k.toBase58()).join(", ");
}

function onWhitelistChanged(event: WhitelistChangeEvent): void {
  const isInitial = event.addedMints.length > 0 && event.slot === 0;

  if (isInitial) {
    console.log("=".repeat(60));
    console.log("  pump.fun Global whitelist — current state");
    console.log("=".repeat(60));
    console.log(`  Mints : ${formatMints(event.currentWhitelist)}`);
    const usdcListed = event.currentWhitelist.some((k) => k.equals(USDC_MINT));
    console.log(`  USDC  : ${usdcListed ? "ALREADY LISTED ✓" : "not yet listed"}`);
    console.log("=".repeat(60));
    console.log("Watching for USDC to appear... (Ctrl+C to stop)\n");
    return;
  }

  const usdcAdded = event.addedMints.some((k) => k.equals(USDC_MINT));

  if (usdcAdded) {
    const border = "!".repeat(60);
    const alert = [
      "",
      border,
      "!!",
      "!!  🚀  USDC IS NOW LIVE — https://pump.fun/create",
      "!!",
      `!!  Detected at : ${event.timestamp.toISOString()}`,
      `!!  Slot        : ${event.slot}`,
      `!!  Full list   : ${formatMints(event.currentWhitelist)}`,
      "!!",
      border,
      "",
    ].join("\n");

    process.stdout.write(alert);
    process.stderr.write(alert);

    tryNotify();
  } else {
    console.log(`[${event.timestamp.toISOString()}] Whitelist changed (slot ${event.slot})`);
    if (event.addedMints.length > 0) {
      console.log("  Added  :", formatMints(event.addedMints));
    }
    if (event.removedMints.length > 0) {
      console.log("  Removed:", formatMints(event.removedMints));
    }
    console.log("  Full   :", formatMints(event.currentWhitelist));
    console.log();
  }
}

function tryNotify(): void {
  try {
    // node-notifier is optional — only used if installed.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const notifier = require("node-notifier");
    notifier.notify({
      title: "pump.fun — USDC IS LIVE",
      message: "USDC has been added to pump.fun. Go to https://pump.fun/create",
      sound: true,
      wait: false,
    });
  } catch {
    // node-notifier not installed — skip silently.
  }
}

const monitor = new WhitelistMonitor(connection, onWhitelistChanged, {
  commitment: "confirmed",
  watchMints: [USDC_MINT],
});

const stop = monitor.start();

process.on("SIGINT", () => {
  console.log("\nShutting down…");
  stop().then(() => process.exit(0));
});

process.on("SIGTERM", () => {
  stop().then(() => process.exit(0));
});
