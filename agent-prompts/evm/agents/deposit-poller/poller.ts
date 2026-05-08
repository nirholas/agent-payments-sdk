#!/usr/bin/env tsx
// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import type { Server } from "node:http";
import { getPaymentStatus } from "../../../../src/evm/validate.js";
import { PUMP_CROSSCHAIN_API } from "../../../../src/constants.js";
import {
  openDb,
  closeDb,
  registerDeposit,
  getPendingDeposits,
  updateDeposit,
  getAllDeposits,
  getSummary,
} from "./db.js";
import { buildApp, startServer } from "./server.js";

// ── Config ───────────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT ?? "5000", 10);
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "10000", 10);
const DB_PATH = process.env.DB_PATH ?? "./deposits.db";
const CONCURRENCY_CAP = 10;

const CHAIN_NAMES: Record<number, string> = {
  1: "Ethereum",
  8453: "Base",
  42161: "Arbitrum One",
  137: "Polygon",
  56: "BNB Smart Chain",
  43114: "Avalanche",
};

// ── Polling Engine ────────────────────────────────────────────────────────────

let pollTimer: ReturnType<typeof setTimeout> | null = null;

async function pollOnce(): Promise<void> {
  const pending = getPendingDeposits();
  if (pending.length === 0) return;

  // Process in batches of CONCURRENCY_CAP
  for (let i = 0; i < pending.length; i += CONCURRENCY_CAP) {
    const batch = pending.slice(i, i + CONCURRENCY_CAP);
    await Promise.allSettled(
      batch.map(async (row) => {
        let result;
        try {
          result = await getPaymentStatus(row.deposit_id);
        } catch (err) {
          console.error(
            `[poller] depositId=${row.deposit_id} status check error:`,
            err
          );
          return;
        }

        if (result.status !== row.status) {
          console.log(
            `[poller] depositId=${row.deposit_id} ${row.status} → ${result.status}`
          );
          updateDeposit({
            depositId: row.deposit_id,
            status: result.status,
            solanaSignature: result.solanaSignature,
            error: result.error,
          });
        }
      })
    );
  }
}

export function startPoller(): void {
  const tick = async () => {
    try {
      await pollOnce();
    } catch (err) {
      console.error("[poller] unexpected error:", err);
    } finally {
      pollTimer = setTimeout(tick, POLL_INTERVAL_MS);
    }
  };
  // Kick off immediately, then schedule
  tick();
}

function stopPoller(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

// ── Terminal Dashboard (watch mode) ──────────────────────────────────────────

function pad(s: string, len: number): string {
  return s.length >= len ? s.slice(0, len) : s + " ".repeat(len - s.length);
}

function formatAge(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

function statusIcon(status: string): string {
  switch (status) {
    case "arrived_on_solana":
      return "arrived ";
    case "failed":
      return "failed  ";
    case "bridging":
      return "bridging";
    default:
      return "pending ";
  }
}

function renderDashboard(): void {
  const now = Date.now();
  const rows = getAllDeposits();
  const summary = getSummary();
  const ts = new Date(now).toISOString().replace("T", " ").slice(0, 19);

  const W = 79;
  const bar = "═".repeat(W);

  process.stdout.write("\x1B[2J\x1B[H"); // clear screen + home

  console.log(bar);
  console.log(
    `  Bridge Deposit Monitor   [${ts}]   polling every ${POLL_INTERVAL_MS / 1000}s`
  );
  console.log(bar);
  console.log(
    `  ${pad("DepositId", 18)} ${pad("TxHash", 14)} ${pad("Chain", 12)} ${pad("Amount", 12)} ${pad("Status", 10)} Age`
  );
  console.log("  " + "─".repeat(W - 2));

  if (rows.length === 0) {
    console.log("  (no deposits tracked)");
  } else {
    for (const row of rows) {
      const depositId = row.deposit_id.slice(0, 16) + (row.deposit_id.length > 16 ? "…" : " ");
      const txHash = row.tx_hash.slice(0, 12) + (row.tx_hash.length > 12 ? "…" : " ");
      const chain = row.chain_name.slice(0, 12);
      const amount = row.amount_usdc ? `${row.amount_usdc} USDC` : "—";
      const status = statusIcon(row.status);
      const age = formatAge(now - row.created_at);

      console.log(
        `  ${pad(depositId, 18)} ${pad(txHash, 14)} ${pad(chain, 12)} ${pad(amount, 12)} ${pad(status, 10)} ${age}`
      );
    }
  }

  console.log(bar);
  console.log(
    `  Total: ${summary.total}  Pending: ${summary.pending}  Arrived: ${summary.arrived}  Failed: ${summary.failed}`
  );
  console.log(bar);
}

function startWatchMode(): void {
  renderDashboard();
  const interval = setInterval(renderDashboard, 5_000);

  // Also run the actual poller so status updates during watch
  startPoller();

  const cleanup = () => {
    clearInterval(interval);
    stopPoller();
    closeDb();
    process.exit(0);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
}

// ── Import Command ────────────────────────────────────────────────────────────

async function importFromTx(
  txHash: string,
  chainId: number,
  agentMint?: string,
  memo?: string
): Promise<void> {
  const url = `${PUMP_CROSSCHAIN_API}/deposit?txHash=${encodeURIComponent(txHash)}&chainId=${chainId}`;
  const res = await fetch(url);

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Failed to look up deposit (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    depositId?: string;
    deposit_id?: string;
    amountUsdc?: string;
    amount_usdc?: string;
  };

  const depositId = data.depositId ?? data.deposit_id;
  if (!depositId) {
    throw new Error(`API response missing depositId: ${JSON.stringify(data)}`);
  }

  const amountUsdc = data.amountUsdc ?? data.amount_usdc;
  const chainName = CHAIN_NAMES[chainId] ?? `Chain ${chainId}`;

  registerDeposit({
    depositId,
    txHash,
    chainId,
    chainName,
    amountUsdc,
    agentMint,
    memo,
  });

  console.log(`[import] registered depositId=${depositId}`);
}

// ── Graceful Shutdown ─────────────────────────────────────────────────────────

function setupShutdown(httpServer: Server): void {
  const cleanup = async () => {
    console.log("\n[shutdown] stopping...");
    stopPoller();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    closeDb();
    console.log("[shutdown] done");
    process.exit(0);
  };
  process.once("SIGINT", cleanup);
  process.once("SIGTERM", cleanup);
}

// ── Entry Point ───────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;

  openDb(DB_PATH);

  if (command === "watch") {
    startWatchMode();
    return;
  }

  if (command === "import") {
    const [txHash, chainIdStr, agentMint, memo] = args;
    if (!txHash || !chainIdStr) {
      console.error("Usage: poller.ts import <txHash> <chainId> [agentMint] [memo]");
      process.exit(1);
    }
    const chainId = parseInt(chainIdStr, 10);
    if (isNaN(chainId)) {
      console.error(`Invalid chainId: ${chainIdStr}`);
      process.exit(1);
    }
    await importFromTx(txHash, chainId, agentMint, memo);
    closeDb();
    return;
  }

  // Default: start HTTP server + poller
  const app = buildApp(DB_PATH, POLL_INTERVAL_MS);
  const httpServer = await startServer(app, PORT);
  startPoller();
  setupShutdown(httpServer);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exit(1);
});
