// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { Context } from "hono";
import { Connection, PublicKey, SystemProgram } from "@solana/web3.js";
import { PumpAgent } from "@nirholas/agent-payments-sdk/solana";
import type { AgentAcceptPaymentEvent } from "@nirholas/agent-payments-sdk/solana";
import { TtlCache } from "./cache.js";

// ─── Config ───────────────────────────────────────────────────────────────────

const RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const PORT = Number(process.env.PORT ?? 4000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS ?? 10_000);
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

// ─── Solana connection (singleton) ────────────────────────────────────────────

const connection = new Connection(RPC_URL, "confirmed");

// ─── Caches ───────────────────────────────────────────────────────────────────

// JSON-serializable response cache, keyed by "<mint>-<route>"
const responseCache = new TtlCache<string, unknown>(CACHE_TTL_MS);

// PumpAgent instances are stateless — cache them indefinitely by mint
const agentCache = new Map<string, PumpAgent>();

// Reusable agent for protocol-level calls (getGlobalConfig) that don't depend on mint
const globalAgent = new PumpAgent(SystemProgram.programId, "mainnet", connection);

// Evict stale cache entries every minute
setInterval(() => responseCache.evictExpired(), 60_000).unref();

// ─── Rate limiter (per IP, 30 req/min) ───────────────────────────────────────

interface RateEntry { count: number; resetAt: number }
const rateLimiter = new Map<string, RateEntry>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const entry = rateLimiter.get(ip);
  if (!entry || now > entry.resetAt) {
    rateLimiter.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }
  if (entry.count >= RATE_LIMIT_MAX) return false;
  entry.count++;
  return true;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Well-known currency symbols; unknown mints fall back to the first 8 chars. */
const CURRENCY_SYMBOLS: Record<string, string> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: "USDC",
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: "USDT",
  So11111111111111111111111111111111111111112: "wSOL",
};

/** Token decimal places for human-readable formatting. */
const CURRENCY_DECIMALS: Record<string, number> = {
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6, // USDC
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6, // USDT
  So11111111111111111111111111111111111111112: 9, // wSOL
};

function symbolFor(mint: string): string {
  return CURRENCY_SYMBOLS[mint] ?? mint.slice(0, 8) + "…";
}

function decimalsFor(mint: string): number {
  return CURRENCY_DECIMALS[mint] ?? 6;
}

/** Format a raw token amount (bigint) as a human-readable decimal string. */
function formatBalance(balance: bigint, decimals: number): string {
  const scale = BigInt(10 ** decimals);
  const whole = balance / scale;
  const frac = balance % scale;
  return `${whole}.${frac.toString().padStart(decimals, "0")}`;
}

/** Validate and parse a base58 public key string. Returns null on failure. */
function parsePublicKey(value: string): PublicKey | null {
  try {
    return new PublicKey(value);
  } catch {
    return null;
  }
}

/** Retrieve (or lazily create) a cached PumpAgent for the given mint. */
function getAgent(mintPk: PublicKey): PumpAgent {
  const key = mintPk.toBase58();
  let agent = agentCache.get(key);
  if (!agent) {
    agent = new PumpAgent(mintPk, "mainnet", connection);
    agentCache.set(key, agent);
  }
  return agent;
}

/** Returns true if the error indicates an on-chain account was not found. */
function isAccountNotFound(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("Account does not exist") ||
    msg.includes("could not find account") ||
    msg.includes("Failed to find account")
  );
}

// ─── Generic cached handler ───────────────────────────────────────────────────

/**
 * Wraps a route handler with TTL caching.
 * Respects `Cache-Control: no-cache` to bypass the cache.
 * Sets `X-Cache: HIT | MISS` on the response.
 */
async function handleCached<T>(
  c: Context,
  cacheKey: string,
  fn: () => Promise<T>,
): Promise<Response> {
  const noCache = c.req.header("cache-control") === "no-cache";

  if (!noCache) {
    const cached = responseCache.get(cacheKey) as T | undefined;
    if (cached !== undefined) {
      c.header("X-Cache", "HIT");
      return c.json(cached as Record<string, unknown>);
    }
  }

  try {
    const data = await fn();
    responseCache.set(cacheKey, data);
    c.header("X-Cache", "MISS");
    return c.json(data as Record<string, unknown>);
  } catch (err) {
    if (isAccountNotFound(err)) {
      return c.json({ error: "Agent not found on-chain", code: "AGENT_NOT_FOUND" }, 404);
    }
    console.error("[error]", err);
    return c.json({ error: "Internal server error", code: "INTERNAL_ERROR" }, 500);
  }
}

// ─── App ──────────────────────────────────────────────────────────────────────

const app = new Hono();

// CORS — public read-only API
app.use("*", cors({ origin: "*" }));

// X-Response-Time + request logging + rate limiting
app.use("*", async (c, next) => {
  const start = Date.now();

  const ip =
    c.req.header("x-forwarded-for")?.split(",")[0].trim() ??
    c.req.header("x-real-ip") ??
    "unknown";

  if (!checkRateLimit(ip)) {
    return c.json({ error: "Rate limit exceeded", code: "RATE_LIMITED" }, 429);
  }

  await next();

  const ms = Date.now() - start;
  c.header("X-Response-Time", `${ms}ms`);
  console.log(`${c.req.method} ${c.req.path} ${c.res.status} ${ms}ms [${ip}]`);
});

// ─── GET /health ──────────────────────────────────────────────────────────────

app.get("/health", async (c) => {
  try {
    const slot = await connection.getSlot();
    const rpcHost = new URL(RPC_URL).hostname;
    return c.json({ status: "ok", rpc: rpcHost, slot });
  } catch (err) {
    console.error("[health]", err);
    return c.json({ error: "RPC unavailable", code: "RPC_ERROR" }, 500);
  }
});

// ─── GET /global ──────────────────────────────────────────────────────────────

app.get("/global", async (c) => {
  return handleCached(c, "global", async () => {
    const config = await globalAgent.getGlobalConfig();
    return {
      protocolAuthority: config.protocolAuthority.toBase58(),
      buybackAuthority: config.buybackAuthority.toBase58(),
      supportedCurrenciesMint: config.supportedCurrenciesMint
        .filter((m: PublicKey) => !PublicKey.default.equals(m))
        .map((m: PublicKey) => m.toBase58()),
      tokenizedAgentSequence: config.tokenizedAgentSequence.toString(),
    };
  });
});

// ─── GET /agents/:mint/config ─────────────────────────────────────────────────

app.get("/agents/:mint/config", async (c) => {
  const mint = c.req.param("mint");
  const mintPk = parsePublicKey(mint);
  if (!mintPk) {
    return c.json({ error: "Invalid mint address", code: "INVALID_MINT" }, 400);
  }

  return handleCached(c, `${mint}-config`, async () => {
    const agent = getAgent(mintPk);
    // getAgentConfig throws AccountNotFound if the PDA doesn't exist,
    // so reaching this point means the agent is initialized.
    const cfg = await agent.getAgentConfig();
    return {
      mint: cfg.mint.toBase58(),
      authority: cfg.authority.toBase58(),
      buybackBps: cfg.buybackBps,
      isInitialized: true,
    };
  });
});

// ─── GET /agents/:mint/balances ───────────────────────────────────────────────

app.get("/agents/:mint/balances", async (c) => {
  const mint = c.req.param("mint");
  const mintPk = parsePublicKey(mint);
  if (!mintPk) {
    return c.json({ error: "Invalid mint address", code: "INVALID_MINT" }, 400);
  }

  return handleCached(c, `${mint}-balances`, async () => {
    const agent = getAgent(mintPk);
    const allBalances = await agent.getAllCurrencyBalances();

    const currencies = Array.from(allBalances.entries()).map(
      ([currencyMintStr, balances]) => {
        const decimals = decimalsFor(currencyMintStr);
        return {
          currencyMint: currencyMintStr,
          symbol: symbolFor(currencyMintStr),
          paymentVault: {
            address: balances.paymentVault.address.toBase58(),
            balance: balances.paymentVault.balance.toString(),
            balanceHuman: formatBalance(balances.paymentVault.balance, decimals),
          },
          buybackVault: {
            address: balances.buybackVault.address.toBase58(),
            balance: balances.buybackVault.balance.toString(),
            balanceHuman: formatBalance(balances.buybackVault.balance, decimals),
          },
          withdrawVault: {
            address: balances.withdrawVault.address.toBase58(),
            balance: balances.withdrawVault.balance.toString(),
            balanceHuman: formatBalance(balances.withdrawVault.balance, decimals),
          },
        };
      },
    );

    return { mint, currencies };
  });
});

// ─── GET /agents/:mint/stats ──────────────────────────────────────────────────

app.get("/agents/:mint/stats", async (c) => {
  const mint = c.req.param("mint");
  const mintPk = parsePublicKey(mint);
  if (!mintPk) {
    return c.json({ error: "Invalid mint address", code: "INVALID_MINT" }, 400);
  }

  return handleCached(c, `${mint}-stats`, async () => {
    const agent = getAgent(mintPk);
    const currencies = await agent.getSupportedCurrencies();

    const statsResults = await Promise.allSettled(
      currencies.map((currencyMint) => agent.getPaymentStats(currencyMint)),
    );

    const stats = statsResults
      .map((result, i) => {
        if (result.status === "rejected") return null;
        const s = result.value;
        return {
          currencyMint: currencies[i].toBase58(),
          totalInvoicePaymentsMade: s.totalInvoicePaymentsMade.toString(),
          totalBuybackAmount: s.totalBuyback.toString(),
          totalWithdrawAmount: s.totalWithdrawals.toString(),
          tokensBoughtBackAndBurned: s.tokensBoughtBackAndBurned.toString(),
        };
      })
      .filter(Boolean);

    return { mint, stats };
  });
});

// ─── GET /agents/:mint/payments ───────────────────────────────────────────────

app.get("/agents/:mint/payments", async (c) => {
  const mint = c.req.param("mint");
  const mintPk = parsePublicKey(mint);
  if (!mintPk) {
    return c.json({ error: "Invalid mint address", code: "INVALID_MINT" }, 400);
  }

  const limitStr = c.req.query("limit") ?? "50";
  const limit = parseInt(limitStr, 10);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return c.json(
      { error: "limit must be an integer between 1 and 200", code: "INVALID_LIMIT" },
      400,
    );
  }

  return handleCached(c, `${mint}-payments-${limit}`, async () => {
    const agent = getAgent(mintPk);
    const payments = await agent.getPaymentHistory(limit);

    const serialized = payments.map((p: AgentAcceptPaymentEvent) => {
      const currencyMintStr = p.currencyMint.toBase58();
      const decimals = decimalsFor(currencyMintStr);
      const amountBigInt = BigInt(p.amount.toString());
      return {
        payer: p.user.toBase58(),
        amount: p.amount.toString(),
        amountHuman: formatBalance(amountBigInt, decimals),
        memo: p.memo.toString(),
        startTime: p.startTime.toNumber(),
        endTime: p.endTime.toNumber(),
        currencyMint: currencyMintStr,
        timestamp: p.timestamp.toNumber(),
      };
    });

    return { mint, count: serialized.length, payments: serialized };
  });
});

// ─── GET /agents/:mint/summary ────────────────────────────────────────────────

app.get("/agents/:mint/summary", async (c) => {
  const mint = c.req.param("mint");
  const mintPk = parsePublicKey(mint);
  if (!mintPk) {
    return c.json({ error: "Invalid mint address", code: "INVALID_MINT" }, 400);
  }

  return handleCached(c, `${mint}-summary`, async () => {
    const agent = getAgent(mintPk);

    const [agentCfg, allBalances, currencies, recentPayments] = await Promise.all([
      agent.getAgentConfig(),
      agent.getAllCurrencyBalances(),
      agent.getSupportedCurrencies(),
      agent.getPaymentHistory(10),
    ]);

    // Fetch per-currency stats concurrently; tolerate missing accounts
    const statsResults = await Promise.allSettled(
      currencies.map((currencyMint) => agent.getPaymentStats(currencyMint)),
    );

    const config = {
      mint: agentCfg.mint.toBase58(),
      authority: agentCfg.authority.toBase58(),
      buybackBps: agentCfg.buybackBps,
    };

    const balancesPayload = Array.from(allBalances.entries()).map(
      ([currencyMintStr, bal]) => {
        const dec = decimalsFor(currencyMintStr);
        return {
          currencyMint: currencyMintStr,
          symbol: symbolFor(currencyMintStr),
          paymentVault: {
            address: bal.paymentVault.address.toBase58(),
            balance: bal.paymentVault.balance.toString(),
            balanceHuman: formatBalance(bal.paymentVault.balance, dec),
          },
          buybackVault: {
            address: bal.buybackVault.address.toBase58(),
            balance: bal.buybackVault.balance.toString(),
            balanceHuman: formatBalance(bal.buybackVault.balance, dec),
          },
          withdrawVault: {
            address: bal.withdrawVault.address.toBase58(),
            balance: bal.withdrawVault.balance.toString(),
            balanceHuman: formatBalance(bal.withdrawVault.balance, dec),
          },
        };
      },
    );

    const statsPayload = statsResults
      .map((r, i) => {
        if (r.status === "rejected") return null;
        const s = r.value;
        return {
          currencyMint: currencies[i].toBase58(),
          totalInvoicePaymentsMade: s.totalInvoicePaymentsMade.toString(),
          totalBuybackAmount: s.totalBuyback.toString(),
          totalWithdrawAmount: s.totalWithdrawals.toString(),
          tokensBoughtBackAndBurned: s.tokensBoughtBackAndBurned.toString(),
        };
      })
      .filter(Boolean);

    const paymentsPayload = recentPayments.map((p: AgentAcceptPaymentEvent) => {
      const currencyMintStr = p.currencyMint.toBase58();
      const dec = decimalsFor(currencyMintStr);
      const amountBigInt = BigInt(p.amount.toString());
      return {
        payer: p.user.toBase58(),
        amount: p.amount.toString(),
        amountHuman: formatBalance(amountBigInt, dec),
        memo: p.memo.toString(),
        startTime: p.startTime.toNumber(),
        endTime: p.endTime.toNumber(),
        currencyMint: currencyMintStr,
        timestamp: p.timestamp.toNumber(),
      };
    });

    return {
      mint,
      config,
      balances: balancesPayload,
      stats: statsPayload,
      recentPayments: paymentsPayload,
    };
  });
});

// ─── Start server ─────────────────────────────────────────────────────────────

serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`Stats API listening on http://localhost:${PORT}`);
  console.log(`RPC: ${new URL(RPC_URL).hostname}`);
  console.log(`Cache TTL: ${CACHE_TTL_MS}ms`);
});
