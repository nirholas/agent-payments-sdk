// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import fs from "node:fs";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import {
  PumpAgent,
  USDC_MINT,
  getTokenAgentPaymentsPDA,
  getBuybackAuthorityPDA,
  getWithdrawAuthorityPDA,
} from "@nirholas/agent-payments-sdk/solana";

// ---------------------------------------------------------------------------
// Config from environment
// ---------------------------------------------------------------------------
const RPC_URL = process.env.SOLANA_RPC_URL;
const PRIVATE_KEY_RAW = process.env.SOLANA_PRIVATE_KEY;
const AGENT_MINT_RAW = process.env.AGENT_MINT;
const THRESHOLD_USDC = parseFloat(process.env.DISTRIBUTION_THRESHOLD ?? "1.0");
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS ?? "15000", 10);
const DISTRIBUTIONS_LOG = "distributions.jsonl";

if (!RPC_URL) throw new Error("SOLANA_RPC_URL is required");
if (!PRIVATE_KEY_RAW) throw new Error("SOLANA_PRIVATE_KEY is required");
if (!AGENT_MINT_RAW) throw new Error("AGENT_MINT is required");

const keypair = Keypair.fromSecretKey(
  Uint8Array.from(JSON.parse(PRIVATE_KEY_RAW)),
);
const agentMint = new PublicKey(AGENT_MINT_RAW);
const thresholdMinor = BigInt(Math.round(THRESHOLD_USDC * 1_000_000));
const usdcMint = USDC_MINT;

// ---------------------------------------------------------------------------
// Derive vault addresses for startup summary
// ---------------------------------------------------------------------------
const [paymentPda] = getTokenAgentPaymentsPDA(agentMint);
const [buybackPda] = getBuybackAuthorityPDA(agentMint);
const [withdrawPda] = getWithdrawAuthorityPDA(agentMint);
const paymentAta = getAssociatedTokenAddressSync(usdcMint, paymentPda, true, TOKEN_PROGRAM_ID);
const buybackAta = getAssociatedTokenAddressSync(usdcMint, buybackPda, true, TOKEN_PROGRAM_ID);
const withdrawAta = getAssociatedTokenAddressSync(usdcMint, withdrawPda, true, TOKEN_PROGRAM_ID);

// ---------------------------------------------------------------------------
// Infra
// ---------------------------------------------------------------------------
const connection = new Connection(RPC_URL, "confirmed");
const agent = new PumpAgent(agentMint, "mainnet", connection);

let distributionInFlight = false;
let pollingIntervalId: ReturnType<typeof setInterval> | undefined;
let wsSubId: number | undefined;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function usdcStr(minor: bigint): string {
  const whole = minor / 1_000_000n;
  const frac = (minor % 1_000_000n).toString().padStart(6, "0");
  return `${whole}.${frac}`;
}

function appendDistributionLog(entry: object): void {
  fs.appendFileSync(DISTRIBUTIONS_LOG, JSON.stringify(entry) + "\n", "utf8");
}

// ---------------------------------------------------------------------------
// Distribution logic
// ---------------------------------------------------------------------------
async function runDistribution(retryCount = 0): Promise<void> {
  const MAX_RETRIES = 3;

  try {
    distributionInFlight = true;

    const pre = await agent.getBalances(usdcMint);
    console.log(
      `[distribute] pre-distribution  payment=${usdcStr(pre.paymentVault.balance)} USDC` +
        `  buyback=${usdcStr(pre.buybackVault.balance)} USDC` +
        `  withdraw=${usdcStr(pre.withdrawVault.balance)} USDC`,
    );

    const ixs = await agent.distributePayments({
      user: keypair.publicKey,
      currencyMint: usdcMint,
    });

    const tx = new Transaction().add(...ixs);
    const signature = await sendAndConfirmTransaction(connection, tx, [keypair], {
      commitment: "confirmed",
    });

    const post = await agent.getBalances(usdcMint);
    const paymentDelta = pre.paymentVault.balance - post.paymentVault.balance;
    console.log(
      `[distribute] post-distribution sig=${signature}` +
        `  payment=${usdcStr(post.paymentVault.balance)} USDC (-${usdcStr(paymentDelta)})` +
        `  buyback=${usdcStr(post.buybackVault.balance)} USDC` +
        `  withdraw=${usdcStr(post.withdrawVault.balance)} USDC`,
    );

    appendDistributionLog({
      timestamp: new Date().toISOString(),
      signature,
      paymentBefore: pre.paymentVault.balance.toString(),
      buybackAfter: post.buybackVault.balance.toString(),
      withdrawAfter: post.withdrawVault.balance.toString(),
    });
  } catch (err) {
    if (retryCount < MAX_RETRIES) {
      console.error(
        `[distribute] attempt ${retryCount + 1} failed: ${(err as Error).message} — retrying in 5s`,
      );
      await new Promise((r) => setTimeout(r, 5_000));
      await runDistribution(retryCount + 1);
      return;
    }
    console.error(
      `[distribute] all ${MAX_RETRIES} retries exhausted:`,
      (err as Error).message,
    );
  } finally {
    distributionInFlight = false;
  }
}

// ---------------------------------------------------------------------------
// Poll cycle (also called directly from WebSocket callback)
// ---------------------------------------------------------------------------
async function checkAndMaybeDistribute(): Promise<void> {
  try {
    const slot = await connection.getSlot("confirmed");
    const balances = await agent.getBalances(usdcMint);
    const { paymentVault, buybackVault, withdrawVault } = balances;

    console.log(
      `[monitor] slot=${slot}` +
        `  payment=${usdcStr(paymentVault.balance)} USDC` +
        `  buyback=${usdcStr(buybackVault.balance)} USDC` +
        `  withdraw=${usdcStr(withdrawVault.balance)} USDC`,
    );

    if (paymentVault.balance >= thresholdMinor && !distributionInFlight) {
      console.log(
        `[monitor] threshold crossed (${usdcStr(paymentVault.balance)} >= ${THRESHOLD_USDC} USDC) — triggering distribution`,
      );
      runDistribution().catch((err) =>
        console.error("[monitor] unexpected runDistribution error:", err),
      );
    }
  } catch (err) {
    console.error("[monitor] poll error:", (err as Error).message);
  }
}

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function shutdown(): void {
  console.log("[shutdown] goodbye");

  if (pollingIntervalId !== undefined) {
    clearInterval(pollingIntervalId);
  }
  if (wsSubId !== undefined) {
    connection.removeAccountChangeListener(wsSubId).catch(() => {});
  }

  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ---------------------------------------------------------------------------
// Startup
// ---------------------------------------------------------------------------
console.log("[vault-monitor] starting");
console.log(`  Agent mint:  ${agentMint.toBase58()}`);
console.log(`  USDC mint:   ${usdcMint.toBase58()}`);
console.log(`  Payment ATA: ${paymentAta.toBase58()}`);
console.log(`  Buyback ATA: ${buybackAta.toBase58()}`);
console.log(`  Withdraw ATA: ${withdrawAta.toBase58()}`);
console.log(`  Threshold:   ${THRESHOLD_USDC} USDC`);
console.log(`  Poll:        ${POLL_INTERVAL_MS} ms`);

// WebSocket subscription — fires immediately on any account change
wsSubId = connection.onAccountChange(
  paymentAta,
  () => {
    checkAndMaybeDistribute().catch((err) =>
      console.error("[ws] callback error:", err),
    );
  },
  "confirmed",
);

// Polling loop as fallback / regular heartbeat
pollingIntervalId = setInterval(() => {
  checkAndMaybeDistribute().catch((err) =>
    console.error("[poll] interval error:", err),
  );
}, POLL_INTERVAL_MS);

// Run once immediately on startup
checkAndMaybeDistribute().catch((err) =>
  console.error("[startup] initial check error:", err),
);
