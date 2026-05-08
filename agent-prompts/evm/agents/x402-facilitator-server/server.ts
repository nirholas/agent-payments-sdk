// agent-payments-sdk — x402 facilitator server
// Copyright (c) 2026 nirholas | x.com/nichxrt | github.com/nirholas
// All rights reserved.

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import type { Address } from "viem";
import { EVM_CHAINS, SUPPORTED_CHAIN_IDS } from "../../../../src/chains.js";
import {
  createVerifyPaymentMiddleware,
  type AppVariables,
} from "./middleware.js";

// ── Config ────────────────────────────────────────────────────────────────────

const AGENT_MINT = process.env.AGENT_MINT ?? "";
const AGENT_PAYMENT_VAULT = (process.env.AGENT_PAYMENT_VAULT ?? "") as Address;
const PORT = parseInt(process.env.PORT ?? "3002", 10);
const WAIT_FOR_SOLANA = process.env.WAIT_FOR_SOLANA !== "false";
const PRICE_USDC_MINOR = BigInt(process.env.PRICE_USDC_MINOR ?? "1000000");
const PRICE_HUMAN = (Number(PRICE_USDC_MINOR) / 1_000_000).toFixed(6);

if (!AGENT_MINT) throw new Error("Missing required env: AGENT_MINT");
if (!AGENT_PAYMENT_VAULT) throw new Error("Missing required env: AGENT_PAYMENT_VAULT");

// ── App ───────────────────────────────────────────────────────────────────────

const app = new Hono<{ Variables: AppVariables }>();

// Request logger — runs after the full middleware chain settles
app.use("*", async (c, next) => {
  const start = Date.now();
  await next();
  const proof = c.get("paymentProof");
  const payer = proof?.depositId ?? "none";
  console.log(
    `[${c.req.method}] ${c.req.path} ${c.res.status} payer=${payer} time=${Date.now() - start}ms`
  );
});

// ── Unprotected routes ────────────────────────────────────────────────────────

app.get("/health", (c) =>
  c.json({
    status: "ok",
    agentMint: AGENT_MINT,
    priceUsdc: PRICE_HUMAN,
    waitForSolana: WAIT_FOR_SOLANA,
  })
);

app.get("/.well-known/evm-payments", (c) => {
  const usdcAddresses = Object.fromEntries(
    SUPPORTED_CHAIN_IDS.map((id) => [String(id), EVM_CHAINS[id].usdc])
  );
  return c.json({
    agentMint: AGENT_MINT,
    supportedChains: SUPPORTED_CHAIN_IDS,
    usdcAddresses,
    priceUsdc: PRICE_HUMAN,
    routes: ["/api/quote", "/api/echo", "/api/timestamp"],
  });
});

// ── Payment middleware factory ────────────────────────────────────────────────

function payment(description: string) {
  return createVerifyPaymentMiddleware({
    minAmountUsdc: PRICE_USDC_MINOR,
    agentMint: AGENT_MINT,
    payTo: AGENT_PAYMENT_VAULT,
    waitForSolana: WAIT_FOR_SOLANA,
    description,
  });
}

// ── Gated routes ──────────────────────────────────────────────────────────────

// Real-time ETH and SOL USD prices
app.get(
  "/api/quote",
  payment("Real-time ETH and SOL USD prices from CoinGecko"),
  async (c) => {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=ethereum,solana&vs_currencies=usd"
    );
    if (!res.ok) {
      return c.json({ error: "CoinGecko request failed" }, 502);
    }
    const data: { ethereum: { usd: number }; solana: { usd: number } } =
      await res.json();
    return c.json(data);
  }
);

// Echo — returns request body verbatim
app.post(
  "/api/echo",
  payment("Echo the JSON request body verbatim"),
  async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: "Invalid JSON body" }, 400);
    }
    return c.json(body);
  }
);

// Current timestamp
app.get(
  "/api/timestamp",
  payment("Current Unix timestamp and ISO-8601 datetime on Solana mainnet"),
  (c) => {
    const now = new Date();
    return c.json({
      timestamp: Math.floor(now.getTime() / 1_000),
      iso: now.toISOString(),
      network: "solana-mainnet",
    });
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`x402 facilitator server listening on port ${info.port}`);
  console.log(`  agent mint   : ${AGENT_MINT}`);
  console.log(`  payment vault: ${AGENT_PAYMENT_VAULT}`);
  console.log(`  price        : $${PRICE_HUMAN} USDC`);
  console.log(`  wait solana  : ${WAIT_FOR_SOLANA}`);
});
