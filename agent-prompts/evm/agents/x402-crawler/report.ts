// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import { writeFileSync } from "fs";
import type { PageRow, CrawlSessionRow } from "./db.js";

export interface CrawlReport {
  session: {
    startedAt: string;
    finishedAt: string;
    duration: string;
  };
  budget: {
    total: string;
    spent: string;
    remaining: string;
  };
  discovery: {
    totalUrls: number;
    freeUrls: number;
    paidUrls: number;
    skippedUrls: number;
  };
  payments: Array<{
    url: string;
    priceUsdc: string;
    txHash: string;
    chainId: number;
  }>;
  errors: string[];
}

export function buildReport(opts: {
  session: CrawlSessionRow;
  pages: PageRow[];
  totalBudgetUsdc: number;
  chainId: number;
  errors: string[];
}): CrawlReport {
  const { session, pages, totalBudgetUsdc, chainId, errors } = opts;

  const startedAt = new Date(session.started_at).toISOString();
  const finishedAt = session.finished_at
    ? new Date(session.finished_at).toISOString()
    : new Date().toISOString();
  const durationSec = Math.round(
    ((session.finished_at ?? Date.now()) - session.started_at) / 1000
  );

  const spent = parseFloat(session.total_spent_usdc);
  const remaining = Math.max(0, totalBudgetUsdc - spent);

  const freeUrls = pages.filter((p) => !p.payment_required).length;
  const paidUrls = pages.filter((p) => p.paid).length;
  const skippedUrls = pages.filter(
    (p) => p.payment_required && !p.paid
  ).length;

  const payments = pages
    .filter((p) => p.paid && p.payment_tx_hash)
    .map((p) => ({
      url: p.url,
      priceUsdc: parseFloat(p.price_usdc ?? "0").toFixed(6),
      txHash: p.payment_tx_hash!,
      chainId,
    }));

  return {
    session: { startedAt, finishedAt, duration: `${durationSec}s` },
    budget: {
      total: totalBudgetUsdc.toFixed(6),
      spent: spent.toFixed(6),
      remaining: remaining.toFixed(6),
    },
    discovery: {
      totalUrls: pages.length,
      freeUrls,
      paidUrls,
      skippedUrls,
    },
    payments,
    errors,
  };
}

export function writeReport(report: CrawlReport): string {
  const ts = Date.now();
  const filename = `crawl-report-${ts}.json`;
  writeFileSync(filename, JSON.stringify(report, null, 2), "utf-8");
  return filename;
}

export function printReport(report: CrawlReport): void {
  const { session, budget, discovery, payments, errors } = report;
  console.log("\n══════════════════════════════════════════════════");
  console.log("  CRAWL REPORT");
  console.log("══════════════════════════════════════════════════");
  console.log(`  Started:   ${session.startedAt}`);
  console.log(`  Finished:  ${session.finishedAt}`);
  console.log(`  Duration:  ${session.duration}`);
  console.log("");
  console.log(`  Budget:    ${budget.spent} / ${budget.total} USDC spent`);
  console.log(`  Remaining: ${budget.remaining} USDC`);
  console.log("");
  console.log(`  URLs discovered: ${discovery.totalUrls}`);
  console.log(`  Free:            ${discovery.freeUrls}`);
  console.log(`  Paid:            ${discovery.paidUrls}`);
  console.log(`  Skipped:         ${discovery.skippedUrls}`);
  if (payments.length > 0) {
    console.log("\n  Payments:");
    for (const p of payments) {
      console.log(`    ${p.priceUsdc} USDC  ${p.url}`);
      console.log(`      tx: ${p.txHash}`);
    }
  }
  if (errors.length > 0) {
    console.log("\n  Errors:");
    for (const e of errors) console.log(`    - ${e}`);
  }
  console.log("══════════════════════════════════════════════════\n");
}
