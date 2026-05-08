#!/usr/bin/env node
// Pump Agent Payment History Analyzer
// Fetches, parses, and reports on-chain USDC payment history for a Pump Agent.
//
// Usage:
//   npx tsx analyzer.ts report  [--limit=200]
//   npx tsx analyzer.ts summary [--limit=200]
//   npx tsx analyzer.ts payers  [--limit=200]
//   npx tsx analyzer.ts export  [--limit=200]
//
// Environment variables:
//   SOLANA_RPC_URL   Mainnet RPC endpoint
//   AGENT_MINT       Agent token mint address

import { Connection, PublicKey } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import { writeFileSync } from "fs";
import {
  PumpAgent,
  parseAgentEvents,
  getTokenAgentPaymentsPDA,
} from "@nirholas/agent-payments-sdk/solana";
import type {
  AgentAcceptPaymentEvent,
  ParsedAgentEvent,
} from "@nirholas/agent-payments-sdk/solana";

// ─── Constants ────────────────────────────────────────────────────────────────

const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const USDC_DECIMALS = 1_000_000n;
const FETCH_DELAY_MS = 100;

// ─── Types ────────────────────────────────────────────────────────────────────

interface EnrichedPaymentEvent extends AgentAcceptPaymentEvent {
  signature: string;
  amountHuman: string;
  solscanUrl: string;
  payerShort: string;
}

interface LiveState {
  paymentVault: string;
  buybackVault: string;
  withdrawVault: string;
  totalInvoicePaymentsMade: string;
}

interface PaymentReport {
  agentMint: string;
  reportGeneratedAt: string;
  totalPaymentsCount: number;
  totalUsdcReceived: string;
  uniquePayers: number;
  avgPaymentUsdc: string;
  largestPaymentUsdc: string;
  smallestPaymentUsdc: string;
  payments: EnrichedPaymentEvent[];
  distributions: ParsedAgentEvent[];
  buybacks: ParsedAgentEvent[];
  liveState: LiveState;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Format a raw integer USDC amount (6 decimals) as a fixed-point string. */
function formatUsdc(amount: bigint): string {
  const whole = amount / USDC_DECIMALS;
  const frac = amount % USDC_DECIMALS;
  return `${whole}.${frac.toString().padStart(6, "0")}`;
}

function bnToBigint(bn: BN): bigint {
  return BigInt(bn.toString());
}

function shortKey(key: PublicKey): string {
  const s = key.toBase58();
  return `${s.slice(0, 8)}...${s.slice(-8)}`;
}

function paymentDedupeKey(e: AgentAcceptPaymentEvent): string {
  return `${e.memo.toString()}_${e.user.toBase58()}_${e.amount.toString()}_${e.startTime.toString()}`;
}

function parseLimit(args: string[]): number {
  const flag = args.find(a => a.startsWith("--limit="));
  if (!flag) return 200;
  const val = parseInt(flag.split("=")[1]!, 10);
  return Number.isNaN(val) || val <= 0 ? 200 : val;
}

// ─── Primary PDA Scan ─────────────────────────────────────────────────────────
// Single rate-limited pass over the TokenAgentPayments PDA transactions.
// Returns all parsed events AND an invoiceId → txSignature map.
// This avoids triple-fetching when combined with the dedup logic in fetchFullHistory.

async function scanPdaTransactions(
  connection: Connection,
  mint: PublicKey,
  limit: number,
): Promise<{ events: ParsedAgentEvent[]; sigMap: Map<string, string> }> {
  const [pda] = getTokenAgentPaymentsPDA(mint);
  const sigs = await connection.getSignaturesForAddress(pda, { limit });
  const events: ParsedAgentEvent[] = [];
  const sigMap = new Map<string, string>();

  for (const sig of sigs) {
    if (sig.err) continue;
    await sleep(FETCH_DELAY_MS);
    const tx = await connection.getTransaction(sig.signature, {
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta?.logMessages) continue;

    for (const event of parseAgentEvents(tx.meta.logMessages, connection)) {
      events.push(event);
      if (event.name === "agentAcceptPaymentEvent") {
        const data = event.data as AgentAcceptPaymentEvent;
        sigMap.set(data.invoiceId.toBase58(), sig.signature);
      }
    }
  }

  return { events, sigMap };
}

// ─── Core Fetch ───────────────────────────────────────────────────────────────
// Merges events from the rate-limited PDA scan with both SDK methods.
// SDK calls provide supplemental deduplication coverage for any events that
// the primary scan may have missed due to ordering or RPC differences.

async function fetchFullHistory(
  agent: PumpAgent,
  connection: Connection,
  mint: PublicKey,
  limit: number,
): Promise<{ allEvents: ParsedAgentEvent[]; sigMap: Map<string, string> }> {
  // Primary scan with rate limiting — builds events + sigMap in one pass.
  const { events: scannedEvents, sigMap } = await scanPdaTransactions(
    connection,
    mint,
    limit,
  );

  // SDK methods called per requirements; run in parallel after the primary scan.
  const [eventHistory, paymentHistory] = await Promise.all([
    agent.getEventHistory(limit),
    agent.getPaymentHistory(limit),
  ]);

  // Deduplicate payment events across all three sources.
  // Primary scan takes priority (it has signatures in the sigMap).
  const seen = new Set<string>();
  const dedupedPayments: ParsedAgentEvent[] = [];

  for (const ev of scannedEvents) {
    if (ev.name === "agentAcceptPaymentEvent") {
      const key = paymentDedupeKey(ev.data as AgentAcceptPaymentEvent);
      if (!seen.has(key)) {
        seen.add(key);
        dedupedPayments.push(ev);
      }
    }
  }

  for (const p of paymentHistory) {
    const key = paymentDedupeKey(p);
    if (!seen.has(key)) {
      seen.add(key);
      dedupedPayments.push({ name: "agentAcceptPaymentEvent" as const, data: p });
    }
  }

  for (const ev of eventHistory) {
    if (ev.name === "agentAcceptPaymentEvent") {
      const key = paymentDedupeKey(ev.data as AgentAcceptPaymentEvent);
      if (!seen.has(key)) {
        seen.add(key);
        dedupedPayments.push(ev);
      }
    }
  }

  // Non-payment events come from the primary scan; sort everything chronologically.
  const nonPaymentEvents = scannedEvents.filter(
    ev => ev.name !== "agentAcceptPaymentEvent",
  );

  const allEvents = [...nonPaymentEvents, ...dedupedPayments].sort((a, b) => {
    const tA = (a.data as { timestamp?: BN }).timestamp?.toNumber() ?? 0;
    const tB = (b.data as { timestamp?: BN }).timestamp?.toNumber() ?? 0;
    return tA - tB;
  });

  return { allEvents, sigMap };
}

// ─── Enrichment ───────────────────────────────────────────────────────────────

function enrichPayment(
  event: AgentAcceptPaymentEvent,
  sigMap: Map<string, string>,
): EnrichedPaymentEvent {
  const sig = sigMap.get(event.invoiceId.toBase58()) ?? "unknown";
  return {
    ...event,
    signature: sig,
    amountHuman: formatUsdc(bnToBigint(event.amount)),
    solscanUrl: `https://solscan.io/tx/${sig}`,
    payerShort: shortKey(event.user),
  };
}

// ─── Report Builder ───────────────────────────────────────────────────────────

async function buildReport(
  agent: PumpAgent,
  connection: Connection,
  mint: PublicKey,
  limit: number,
): Promise<PaymentReport> {
  const { allEvents, sigMap } = await fetchFullHistory(agent, connection, mint, limit);

  // Payments sorted newest-first for display.
  const payments: EnrichedPaymentEvent[] = allEvents
    .filter(ev => ev.name === "agentAcceptPaymentEvent")
    .map(ev => enrichPayment(ev.data as AgentAcceptPaymentEvent, sigMap))
    .sort((a, b) => b.timestamp.toNumber() - a.timestamp.toNumber());

  const distributions = allEvents.filter(
    ev => ev.name === "agentDistributePaymentsEvent",
  );
  const buybacks = allEvents.filter(ev => ev.name === "agentBuybackTriggerEvent");

  // Aggregate stats using only integer arithmetic.
  let totalUsdc = 0n;
  let largest = 0n;
  let smallest = payments.length > 0 ? BigInt("9".repeat(18)) : 0n;
  const payerTotals = new Map<string, bigint>();

  for (const p of payments) {
    const amt = bnToBigint(p.amount);
    totalUsdc += amt;
    if (amt > largest) largest = amt;
    if (amt < smallest) smallest = amt;
    const pk = p.user.toBase58();
    payerTotals.set(pk, (payerTotals.get(pk) ?? 0n) + amt);
  }

  const count = BigInt(payments.length);
  const avg = count > 0n ? totalUsdc / count : 0n;

  // Fetch live vault state; fall back gracefully if accounts don't exist yet.
  const [balances, stats] = await Promise.all([
    agent.getBalances(USDC_MINT).catch(() => null),
    agent.getPaymentStats(USDC_MINT).catch(() => null),
  ]);

  const liveState: LiveState = {
    paymentVault: formatUsdc(balances?.paymentVault.balance ?? 0n),
    buybackVault: formatUsdc(balances?.buybackVault.balance ?? 0n),
    withdrawVault: formatUsdc(balances?.withdrawVault.balance ?? 0n),
    totalInvoicePaymentsMade: stats
      ? formatUsdc(bnToBigint(stats.totalInvoicePaymentsMade as unknown as BN))
      : "0.000000",
  };

  return {
    agentMint: mint.toBase58(),
    reportGeneratedAt: new Date().toISOString(),
    totalPaymentsCount: payments.length,
    totalUsdcReceived: formatUsdc(totalUsdc),
    uniquePayers: payerTotals.size,
    avgPaymentUsdc: formatUsdc(avg),
    largestPaymentUsdc: formatUsdc(payments.length > 0 ? largest : 0n),
    smallestPaymentUsdc: formatUsdc(payments.length > 0 ? smallest : 0n),
    payments,
    distributions,
    buybacks,
    liveState,
  };
}

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatTimestamp(ts: BN): string {
  return new Date(ts.toNumber() * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
}

function printSummary(report: PaymentReport): void {
  const mintShort = `${report.agentMint.slice(0, 8)}...${report.agentMint.slice(-8)}`;
  const line = "══════════════════════════════════════════════════";

  console.log(line);
  console.log("  Pump Agent Payment Summary");
  console.log(`  Mint: ${mintShort}`);
  console.log(line);
  console.log(`  Total payments:      ${report.totalPaymentsCount}`);
  console.log(`  Total USDC received: ${report.totalUsdcReceived}`);
  console.log(`  Unique payers:       ${report.uniquePayers}`);
  console.log(`  Avg per payment:     ${report.avgPaymentUsdc} USDC`);
  console.log(`  Largest payment:     ${report.largestPaymentUsdc} USDC`);
  console.log(`  Smallest payment:    ${report.smallestPaymentUsdc} USDC`);
  console.log(line);

  if (report.payments.length === 0) {
    console.log("  No payments found.");
  } else {
    console.log("  Recent payments:");
    console.log("  #   Payer             Amount      Time");
    report.payments.slice(0, 10).forEach((p, i) => {
      const rank = String(i + 1).padEnd(4);
      const payer = p.payerShort.padEnd(18);
      const amount = p.amountHuman.padEnd(12);
      const time = formatTimestamp(p.timestamp);
      console.log(`  ${rank}${payer}${amount}${time}`);
    });
  }
  console.log(line);
}

function printPayers(report: PaymentReport): void {
  const totals = new Map<string, { count: number; total: bigint }>();

  for (const p of report.payments) {
    const pk = p.user.toBase58();
    const cur = totals.get(pk) ?? { count: 0, total: 0n };
    totals.set(pk, { count: cur.count + 1, total: cur.total + bnToBigint(p.amount) });
  }

  const sorted = [...totals.entries()].sort(([, a], [, b]) =>
    b.total > a.total ? 1 : b.total < a.total ? -1 : 0,
  );

  const sep = "  ──────────────────────────────────────────────────────────────────";
  console.log("\n  Top Payers by Total USDC Paid");
  console.log(sep);
  console.log("  Rank  Payer                                             Count   Total USDC");
  console.log(sep);

  sorted.slice(0, 10).forEach(([pk, { count, total }], i) => {
    const rank = String(i + 1).padEnd(6);
    const addr = pk.padEnd(50);
    const cnt = String(count).padEnd(8);
    console.log(`  ${rank}${addr}${cnt}${formatUsdc(total)}`);
  });
  console.log();
}

// ─── JSON Replacer ────────────────────────────────────────────────────────────
// Serialize BN and PublicKey instances to strings so the report is valid JSON.

function jsonReplacer(_key: string, value: unknown): unknown {
  if (value instanceof PublicKey) return value.toBase58();
  if (value instanceof BN) return value.toString();
  if (typeof value === "bigint") return value.toString();
  return value;
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] ?? "report";
  const limit = parseLimit(args);

  const rpcUrl = process.env.SOLANA_RPC_URL;
  const agentMintStr = process.env.AGENT_MINT;

  if (!rpcUrl) {
    console.error("Error: SOLANA_RPC_URL environment variable is required");
    process.exit(1);
  }
  if (!agentMintStr) {
    console.error("Error: AGENT_MINT environment variable is required");
    process.exit(1);
  }

  let mint: PublicKey;
  try {
    mint = new PublicKey(agentMintStr);
  } catch {
    console.error(`Error: Invalid AGENT_MINT: ${agentMintStr}`);
    process.exit(1);
  }

  const connection = new Connection(rpcUrl, "confirmed");
  const agent = new PumpAgent(mint, "mainnet", connection);

  switch (command) {
    case "report": {
      const report = await buildReport(agent, connection, mint, limit);
      console.log(JSON.stringify(report, jsonReplacer, 2));
      break;
    }
    case "summary": {
      const report = await buildReport(agent, connection, mint, limit);
      printSummary(report);
      break;
    }
    case "payers": {
      const report = await buildReport(agent, connection, mint, limit);
      printPayers(report);
      break;
    }
    case "export": {
      const report = await buildReport(agent, connection, mint, limit);
      const mintShort = mint.toBase58().slice(0, 8);
      const date = new Date().toISOString().slice(0, 10);
      const filename = `payments-${mintShort}-${date}.json`;
      writeFileSync(filename, JSON.stringify(report, jsonReplacer, 2), "utf8");
      console.log(`Report written to ${filename}`);
      break;
    }
    default: {
      console.error(`Unknown command: ${command}`);
      console.error(
        "Usage: npx tsx analyzer.ts [report|summary|payers|export] [--limit=200]",
      );
      process.exit(1);
    }
  }
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
