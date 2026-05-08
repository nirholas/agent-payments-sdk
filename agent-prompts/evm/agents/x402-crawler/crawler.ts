#!/usr/bin/env node
// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

/**
 * EVM USDC Autonomous x402 Endpoint Crawler & Payment Agent
 *
 * Usage:
 *   node crawler.ts crawl <url1> [url2...]      Crawl and pay
 *   node crawler.ts discover <url1> [url2...]   Discovery only, no payments
 *   node crawler.ts report                      Print last session report
 *   node crawler.ts history                     Show all crawl sessions from DB
 *   node crawler.ts purge                       Delete all crawl data from DB
 *
 * Environment variables:
 *   EVM_PRIVATE_KEY        EVM private key (hex, with or without 0x)
 *   EVM_CHAIN_ID           Chain to pay from (default: 8453 = Base)
 *   EVM_RPC_URL            RPC URL for the chain
 *   AGENT_MINT             Pump agent mint
 *   TOTAL_BUDGET_USDC      Max total USDC to spend (default: 10.0)
 *   PER_REQUEST_MAX_USDC   Max per single request (default: 1.0)
 *   SEED_URLS              Comma-separated initial URLs (overridden by CLI args)
 *   DB_PATH                SQLite file (default: ./crawl.db)
 *   MAX_DEPTH              Link-follow depth (default: 2)
 *   MAX_CONCURRENCY        Concurrent requests (default: 3)
 */

import {
  createWalletClient,
  createPublicClient,
  http,
  type Chain,
  type Address,
} from "viem";
import {
  mainnet,
  base,
  arbitrum,
  polygon,
  bsc,
  avalanche,
} from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

import { createEvmX402Fetch } from "../../../../src/x402/evm-client.js";
import type {
  EvmWalletClient,
  EvmX402PaymentRequirements,
} from "../../../../src/x402/evm-client.js";
import type { SupportedEvmChainId } from "../../../../src/types.js";

import {
  openDb,
  closeDb,
  upsertPage,
  markPaid,
  updateBody,
  getPage,
  getPayablePages,
  getAllPages,
  getPaidPages,
  pageExists,
  purgePages,
  startSession,
  finishSession,
  getLastSession,
  getAllSessions,
  purgeSessions,
} from "./db.js";
import { Semaphore } from "./semaphore.js";
import { buildReport, writeReport, printReport } from "./report.js";

// ── Constants ─────────────────────────────────────────────────────────────────

const VIEM_CHAINS: Record<SupportedEvmChainId, Chain> = {
  1: mainnet,
  8453: base,
  42161: arbitrum,
  137: polygon,
  56: bsc,
  43114: avalanche,
};

const APPROVE_SELECTOR = "0x095ea7b3";

// ── Helpers ───────────────────────────────────────────────────────────────────

function isSupportedChainId(id: number): id is SupportedEvmChainId {
  return id in VIEM_CHAINS;
}

/** Normalize a URL: remove fragment, trailing slash (except root), sort query params. */
function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    u.searchParams.sort();
    // Remove trailing slash from non-root paths
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return raw;
  }
}

/** Return null for mailto:, javascript:, anchor-only, or non-http(s) URLs. */
function sanitizeLink(href: string, base: string): string | null {
  if (!href) return null;
  if (href.startsWith("mailto:") || href.startsWith("javascript:")) return null;
  if (href.startsWith("#")) return null;
  try {
    const resolved = new URL(href, base);
    if (resolved.protocol !== "http:" && resolved.protocol !== "https:") return null;
    return normalizeUrl(resolved.toString());
  } catch {
    return null;
  }
}

/** Extract links from HTML or JSON body. */
function extractLinks(body: string, contentType: string | null, baseUrl: string): string[] {
  const links: string[] = [];
  const ct = (contentType ?? "").toLowerCase();

  if (ct.includes("html") || ct === "") {
    // href attributes
    const hrefRe = /href=["']([^"'#][^"']*?)["']/gi;
    let m: RegExpExecArray | null;
    while ((m = hrefRe.exec(body)) !== null) {
      const link = sanitizeLink(m[1], baseUrl);
      if (link) links.push(link);
    }
    // src attributes (scripts / iframes)
    const srcRe = /src=["']([^"'#][^"']*?)["']/gi;
    while ((m = srcRe.exec(body)) !== null) {
      const link = sanitizeLink(m[1], baseUrl);
      if (link) links.push(link);
    }
  }

  if (ct.includes("json")) {
    try {
      const obj: unknown = JSON.parse(body);
      const collect = (val: unknown) => {
        if (typeof val === "string") {
          const link = sanitizeLink(val, baseUrl);
          if (link) links.push(link);
        } else if (Array.isArray(val)) {
          val.forEach(collect);
        } else if (val && typeof val === "object") {
          for (const k of Object.keys(val as object)) {
            const v = (val as Record<string, unknown>)[k];
            if (k === "url" || k === "href" || k === "link") {
              const link = sanitizeLink(String(v), baseUrl);
              if (link) links.push(link);
            } else {
              collect(v);
            }
          }
        }
      };
      collect(obj);
    } catch {
      // Not JSON — ignore
    }
  }

  return [...new Set(links)];
}

/** Parse USDC amount from X-Payment-Required header (maxAmountRequired is 6-decimal units). */
function parseUsdcFromRequirements(req: EvmX402PaymentRequirements): number {
  return Number(BigInt(req.maxAmountRequired)) / 1_000_000;
}

// ── State ─────────────────────────────────────────────────────────────────────

let totalSpentUsdc = 0;
const errors: string[] = [];

// ── Discovery ─────────────────────────────────────────────────────────────────

interface DiscoverResult {
  url: string;
  status: number;
  paymentRequired: boolean;
  links: string[];
}

async function discover(
  url: string,
  depth: number,
  parentUrl: string | null,
  semaphore: Semaphore
): Promise<DiscoverResult> {
  const release = await semaphore.acquire();
  let status = 0;
  let paymentRequired = false;
  const links: string[] = [];

  try {
    const res = await fetch(url, {
      headers: { Accept: "text/html,application/json,*/*" },
      redirect: "follow",
    });
    status = res.status;

    if (status === 402) {
      paymentRequired = true;
      const header = res.headers.get("X-Payment-Required");
      let priceUsdc: string | null = null;
      let scheme: string | null = null;

      if (header) {
        try {
          const req: EvmX402PaymentRequirements = JSON.parse(atob(header));
          scheme = req.scheme;
          priceUsdc = parseUsdcFromRequirements(req).toFixed(6);
        } catch {
          // malformed header — still record as payment-required
        }
      }

      upsertPage({
        url,
        status,
        payment_required: 1,
        payment_scheme: scheme,
        price_usdc: priceUsdc,
        content_type: res.headers.get("content-type"),
        discovered_at: Date.now(),
        depth,
        parent_url: parentUrl,
      });
    } else if (status >= 200 && status < 300) {
      const contentType = res.headers.get("content-type");
      const body = await res.text();

      upsertPage({
        url,
        status,
        payment_required: 0,
        payment_scheme: null,
        price_usdc: null,
        content_type: contentType,
        body,
        discovered_at: Date.now(),
        depth,
        parent_url: parentUrl,
      });

      links.push(...extractLinks(body, contentType, url));
    } else {
      upsertPage({
        url,
        status,
        payment_required: 0,
        payment_scheme: null,
        price_usdc: null,
        content_type: res.headers.get("content-type"),
        discovered_at: Date.now(),
        depth,
        parent_url: parentUrl,
      });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`discover ${url}: ${msg}`);
    upsertPage({
      url,
      status: 0,
      payment_required: 0,
      payment_scheme: null,
      price_usdc: null,
      content_type: null,
      discovered_at: Date.now(),
      depth,
      parent_url: parentUrl,
    });
  } finally {
    release();
  }

  return { url, status, paymentRequired, links };
}

// ── Payment decision ──────────────────────────────────────────────────────────

function shouldPay(
  pageUrl: string,
  priceUsdc: number,
  perRequestMax: number,
  totalBudget: number
): boolean {
  const budgetRemaining = totalBudget - totalSpentUsdc;
  const pay =
    priceUsdc <= perRequestMax && totalSpentUsdc + priceUsdc <= totalBudget;

  console.log(
    `[decision] url=${pageUrl} price=${priceUsdc.toFixed(6)} USDC budget_remaining=${budgetRemaining.toFixed(6)} USDC → ${pay ? "PAY" : "SKIP"}`
  );
  return pay;
}

// ── Payment execution ─────────────────────────────────────────────────────────

async function payAndFetch(
  pageUrl: string,
  evmWalletClient: EvmWalletClient,
  perRequestMax: number,
  totalBudget: number,
  semaphore: Semaphore
): Promise<string[]> {
  const release = await semaphore.acquire();
  const links: string[] = [];

  try {
    let submittedTxHash: `0x${string}` | null = null;

    const x402Fetch = createEvmX402Fetch({
      walletClient: evmWalletClient,

      onPaymentRequired: async (req: EvmX402PaymentRequirements) => {
        const priceUsdc = parseUsdcFromRequirements(req);
        return shouldPay(pageUrl, priceUsdc, perRequestMax, totalBudget);
      },

      onPaymentSubmitted: (txHash: `0x${string}`, _depositId: string) => {
        submittedTxHash = txHash;
        console.log(`[payment] tx=${txHash} url=${pageUrl}`);
      },
    });

    const res = await x402Fetch(pageUrl, {
      headers: { Accept: "text/html,application/json,*/*" },
    });

    if (res.status >= 200 && res.status < 300 && submittedTxHash) {
      const contentType = res.headers.get("content-type");
      const body = await res.text();
      const now = Date.now();

      // Find the price from the DB to update spent
      const row = getPage(pageUrl);
      if (row?.price_usdc) {
        totalSpentUsdc += parseFloat(row.price_usdc);
      }

      markPaid(pageUrl, submittedTxHash, now);
      updateBody(pageUrl, body, contentType, res.status);

      links.push(...extractLinks(body, contentType, pageUrl));
    } else if (res.status === 402) {
      // Payment refused by decision engine or budget exhausted — leave as-is
    } else {
      const msg = `unexpected status ${res.status} after payment attempt for ${pageUrl}`;
      errors.push(msg);
      console.error(`[payment] ${msg}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`payment ${pageUrl}: ${msg}`);
    console.error(`[payment] error for ${pageUrl}: ${msg}`);
  } finally {
    release();
  }

  return links;
}

// ── Progress display ──────────────────────────────────────────────────────────

function printProgress(opts: {
  queued: number;
  inFlight: number;
  done: number;
  paid: number;
  totalBudget: number;
}): void {
  const { queued, inFlight, done, paid, totalBudget } = opts;
  process.stdout.write(
    `\r[crawl] queued=${queued} in-flight=${inFlight} done=${done} paid=${paid} spent=${totalSpentUsdc.toFixed(6)}/${totalBudget.toFixed(6)} USDC   `
  );
}

// ── Orchestrator ──────────────────────────────────────────────────────────────

interface CrawlSession {
  sessionId: number;
  totalSpentUsdc: number;
  pagesDiscovered: number;
  pagesPaid: number;
}

async function crawl(
  seedUrls: string[],
  opts: {
    maxDepth: number;
    maxConcurrency: number;
    totalBudget: number;
    perRequestMax: number;
    evmWalletClient: EvmWalletClient | null;
    discoverOnly: boolean;
  }
): Promise<CrawlSession> {
  const { maxDepth, maxConcurrency, totalBudget, perRequestMax, evmWalletClient, discoverOnly } = opts;
  const semaphore = new Semaphore(maxConcurrency);

  const sessionId = startSession(seedUrls);

  // ── Phase 1: Discovery ────────────────────────────────────────────────────

  console.log(`\n[crawl] phase 1: discovery (depth 0→${maxDepth})`);

  // Queue entries: [url, depth, parentUrl]
  const queue: Array<[string, number, string | null]> = seedUrls.map((u) => [
    normalizeUrl(u),
    0,
    null,
  ]);
  const visited = new Set<string>();
  const inFlight: Set<string> = new Set();
  let done = 0;

  // We need to process concurrently. Use a pool pattern.
  const pending: Array<Promise<void>> = [];

  const processOne = async (url: string, depth: number, parentUrl: string | null) => {
    inFlight.add(url);

    const origin = new URL(url).origin;
    const result = await discover(url, depth, parentUrl, semaphore);
    done++;
    inFlight.delete(url);

    // Enqueue same-origin links within depth limit
    if (depth < maxDepth) {
      for (const link of result.links) {
        try {
          const linkOrigin = new URL(link).origin;
          if (linkOrigin === origin && !visited.has(link) && !inFlight.has(link)) {
            visited.add(link);
            queue.push([link, depth + 1, url]);
          }
        } catch {
          // invalid URL — skip
        }
      }
    }
  };

  // Drain the queue with concurrency control
  for (const [url] of queue) visited.add(url);

  while (queue.length > 0 || pending.length > 0) {
    // Spin up new tasks up to concurrency limit
    while (queue.length > 0 && semaphore.inFlight < maxConcurrency) {
      const item = queue.shift()!;
      const [url, depth, parentUrl] = item;
      const p = processOne(url, depth, parentUrl).then(() => {
        const idx = pending.indexOf(p);
        if (idx !== -1) pending.splice(idx, 1);
      });
      pending.push(p);
    }

    printProgress({
      queued: queue.length,
      inFlight: semaphore.inFlight,
      done,
      paid: 0,
      totalBudget,
    });

    if (pending.length > 0) {
      await Promise.race(pending);
    }
  }

  console.log(`\n[crawl] discovery complete. found ${done} URLs`);

  if (discoverOnly || !evmWalletClient) {
    const allPages = getAllPages();
    finishSession(sessionId, "0.000000", allPages.length, 0);
    return { sessionId, totalSpentUsdc: 0, pagesDiscovered: allPages.length, pagesPaid: 0 };
  }

  // ── Phase 2: Payment ──────────────────────────────────────────────────────

  console.log("[crawl] phase 2: payment");

  const payable = getPayablePages();
  console.log(`[crawl] ${payable.length} payable pages found`);

  let pagesPaid = 0;
  const newLinksFromPaid: Array<[string, number, string | null]> = [];

  const payQueue = [...payable];
  const payPending: Array<Promise<void>> = [];

  const payOne = async (pageUrl: string, priceUsdc: number, depth: number) => {
    const links = await payAndFetch(
      pageUrl,
      evmWalletClient,
      perRequestMax,
      totalBudget,
      semaphore
    );

    const row = getPage(pageUrl);
    if (row?.paid) {
      pagesPaid++;
      // Collect new links from paid pages for phase 3
      for (const link of links) {
        try {
          const linkOrigin = new URL(link).origin;
          const seedOrigin = new URL(seedUrls[0]).origin;
          if (linkOrigin === seedOrigin && !pageExists(link)) {
            newLinksFromPaid.push([link, depth + 1, pageUrl]);
          }
        } catch {
          // skip
        }
      }
    }
  };

  for (const page of payQueue) {
    const priceUsdc = parseFloat(page.price_usdc ?? "0");
    if (!shouldPay(page.url, priceUsdc, perRequestMax, totalBudget)) continue;

    const p = payOne(page.url, priceUsdc, page.depth).then(() => {
      const idx = payPending.indexOf(p);
      if (idx !== -1) payPending.splice(idx, 1);
    });
    payPending.push(p);

    printProgress({
      queued: payQueue.length - payPending.length,
      inFlight: semaphore.inFlight,
      done,
      paid: pagesPaid,
      totalBudget,
    });

    if (semaphore.inFlight >= maxConcurrency) {
      await Promise.race(payPending);
    }
  }

  await Promise.all(payPending);
  console.log(`\n[crawl] payment phase complete. paid=${pagesPaid}`);

  // ── Phase 3: Re-crawl links from paid pages ───────────────────────────────

  if (newLinksFromPaid.length > 0) {
    console.log(
      `[crawl] phase 3: re-crawling ${newLinksFromPaid.length} new links from paid pages`
    );

    const phase3Queue = newLinksFromPaid.filter(
      ([url, depth]) => depth <= maxDepth && !pageExists(url)
    );

    const phase3Pending: Array<Promise<void>> = [];

    for (const [url, depth, parent] of phase3Queue) {
      if (pageExists(url)) continue;

      const p = processOne(url, depth, parent).then(() => {
        done++;
        const idx = phase3Pending.indexOf(p);
        if (idx !== -1) phase3Pending.splice(idx, 1);
      });
      phase3Pending.push(p);

      printProgress({
        queued: phase3Queue.length - phase3Pending.length,
        inFlight: semaphore.inFlight,
        done,
        paid: pagesPaid,
        totalBudget,
      });

      if (semaphore.inFlight >= maxConcurrency) {
        await Promise.race(phase3Pending);
      }
    }

    await Promise.all(phase3Pending);
    console.log("\n[crawl] phase 3 complete.");
  }

  const allPages = getAllPages();
  finishSession(sessionId, totalSpentUsdc.toFixed(6), allPages.length, pagesPaid);

  return {
    sessionId,
    totalSpentUsdc,
    pagesDiscovered: allPages.length,
    pagesPaid,
  };
}

// ── Wallet setup ──────────────────────────────────────────────────────────────

function buildWalletClient(
  chainId: SupportedEvmChainId,
  privateKey: string,
  rpcUrl?: string
): EvmWalletClient {
  const viemChain = VIEM_CHAINS[chainId];
  const transport = http(rpcUrl ?? undefined);
  const normalizedKey: `0x${string}` = privateKey.startsWith("0x")
    ? (privateKey as `0x${string}`)
    : `0x${privateKey}`;

  const account = privateKeyToAccount(normalizedKey);
  const walletClient = createWalletClient({ account, chain: viemChain, transport });
  const publicClient = createPublicClient({ chain: viemChain, transport });

  console.log(`[preflight] address=${account.address} chain=${viemChain.name} (${chainId})`);

  const evmWalletClient: EvmWalletClient = {
    chainId,
    address: account.address,
    sendTransaction: async ({ to, data, value, chainId: txChainId }) => {
      const txChain = isSupportedChainId(txChainId) ? VIEM_CHAINS[txChainId] : viemChain;
      const isApproval = data.startsWith(APPROVE_SELECTOR);

      const hash = await walletClient.sendTransaction({ to, data, value, chain: txChain });

      if (isApproval) {
        console.log(`[approval] tx=${hash}`);
        await publicClient.waitForTransactionReceipt({ hash });
        console.log("[approval] confirmed");
      } else {
        await publicClient.waitForTransactionReceipt({ hash });
      }

      return hash;
    },
  };

  return evmWalletClient;
}

// ── CLI ───────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  // ── Config from env ───────────────────────────────────────────────────────

  const dbPath = process.env.DB_PATH ?? "./crawl.db";
  const totalBudget = parseFloat(process.env.TOTAL_BUDGET_USDC ?? "10.0");
  const perRequestMax = parseFloat(process.env.PER_REQUEST_MAX_USDC ?? "1.0");
  const maxDepth = parseInt(process.env.MAX_DEPTH ?? "2", 10);
  const maxConcurrency = parseInt(process.env.MAX_CONCURRENCY ?? "3", 10);
  const rawChainId = Number(process.env.EVM_CHAIN_ID ?? "8453");
  const chainId: SupportedEvmChainId = isSupportedChainId(rawChainId)
    ? rawChainId
    : 8453;

  openDb(dbPath);

  if (command === "purge") {
    purgePages();
    purgeSessions();
    console.log("[purge] all crawl data deleted");
    closeDb();
    return;
  }

  if (command === "history") {
    const sessions = getAllSessions();
    if (sessions.length === 0) {
      console.log("[history] no sessions found");
    } else {
      for (const s of sessions) {
        const start = new Date(s.started_at).toISOString();
        const end = s.finished_at ? new Date(s.finished_at).toISOString() : "running";
        console.log(
          `[${s.id}] ${start} → ${end} | discovered=${s.pages_discovered} paid=${s.pages_paid} spent=${s.total_spent_usdc} USDC | seeds=${s.seed_urls}`
        );
      }
    }
    closeDb();
    return;
  }

  if (command === "report") {
    const session = getLastSession();
    if (!session) {
      console.log("[report] no session found — run a crawl first");
      closeDb();
      return;
    }
    const pages = getAllPages();
    const report = buildReport({ session, pages, totalBudgetUsdc: totalBudget, chainId, errors: [] });
    printReport(report);
    closeDb();
    return;
  }

  // crawl or discover
  if (command !== "crawl" && command !== "discover") {
    console.error(
      "Usage:\n" +
        "  node crawler.ts crawl <url1> [url2...]    Crawl and pay\n" +
        "  node crawler.ts discover <url1> [url2...] Discovery only\n" +
        "  node crawler.ts report                    Print last session report\n" +
        "  node crawler.ts history                   Show all crawl sessions\n" +
        "  node crawler.ts purge                     Delete all crawl data"
    );
    process.exit(1);
  }

  const discoverOnly = command === "discover";

  // Seed URLs: CLI args take precedence over env
  const cliUrls = args.slice(1).filter(Boolean);
  const envUrls = (process.env.SEED_URLS ?? "").split(",").map((u) => u.trim()).filter(Boolean);
  const seedUrls = cliUrls.length > 0 ? cliUrls : envUrls;

  if (seedUrls.length === 0) {
    console.error("[config] provide seed URLs as CLI args or SEED_URLS env var");
    process.exit(1);
  }

  // Wallet (required for crawl mode)
  let evmWalletClient: EvmWalletClient | null = null;
  if (!discoverOnly) {
    const privateKey = process.env.EVM_PRIVATE_KEY;
    if (!privateKey) {
      console.error("[config] EVM_PRIVATE_KEY is required for crawl mode");
      process.exit(1);
    }
    evmWalletClient = buildWalletClient(chainId, privateKey, process.env.EVM_RPC_URL);
  }

  console.log(`[config] mode=${command} depth=${maxDepth} concurrency=${maxConcurrency} budget=${totalBudget} USDC per-request=${perRequestMax} USDC`);
  console.log(`[config] seeds: ${seedUrls.join(", ")}`);

  const session = await crawl(seedUrls, {
    maxDepth,
    maxConcurrency,
    totalBudget,
    perRequestMax,
    evmWalletClient,
    discoverOnly,
  });

  // ── Report ────────────────────────────────────────────────────────────────

  const dbSession = getLastSession()!;
  const pages = getAllPages();
  const report = buildReport({
    session: dbSession,
    pages,
    totalBudgetUsdc: totalBudget,
    chainId,
    errors,
  });

  printReport(report);
  const reportFile = writeReport(report);
  console.log(`[report] written to ${reportFile}`);

  closeDb();
}

main().catch((err) => {
  console.error("[fatal]", err instanceof Error ? err.message : String(err));
  process.exit(1);
});
