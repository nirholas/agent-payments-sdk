// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
//
// x402 Resource Server — Solana USDC Payment Wall
//
// Every route (except /health) is gated behind an x402 USDC payment verified
// on Solana mainnet using PumpAgentFacilitator. No payment = HTTP 402.
//
// Required env vars:
//   SOLANA_RPC_URL   — Mainnet RPC endpoint
//   AGENT_MINT       — Base58 pump token mint with agent-payments initialized
//   PAYMENT_VAULT    — Base58 address to receive USDC (payment vault PDA)
//   PORT             — HTTP port (default: 3000)
//
// NOTE: PumpAgentFacilitator uses an in-memory SettlementCache (TTL 120 s,
// max 10 000 entries) to prevent replay attacks. This works correctly for a
// single-process deployment. In a multi-replica environment each replica has
// its own in-process cache, so a signature cached on replica A is not visible
// to replica B — a race window exists where both could accept the same
// payment. Replace the in-memory cache with a shared external store (Redis
// SET NX + EXPIRE) before running more than one replica in production.

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Connection } from "@solana/web3.js";
import { x402 } from "@nirholas/agent-payments-sdk/solana";

const {
  PumpAgentFacilitator,
  buildPumpAgentRequirements,
  createResourceServer,
  decodePaymentResponse,
  X402_HEADER_PAYMENT_RESPONSE,
} = x402;

// ─── Config ──────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Fatal: environment variable "${name}" is required but not set.`);
    process.exit(1);
  }
  return value;
}

const SOLANA_RPC_URL = requireEnv("SOLANA_RPC_URL");
const AGENT_MINT = requireEnv("AGENT_MINT");
const PAYMENT_VAULT = requireEnv("PAYMENT_VAULT");
const PORT = parseInt(process.env.PORT ?? "3000", 10);

// ─── Solana + Facilitator ─────────────────────────────────────────────────────

const connection = new Connection(SOLANA_RPC_URL, { commitment: "confirmed" });

// PumpAgentFacilitator: verifies on-chain invoice payments and settles them
// (marks the tx signature as used, preventing replay within the TTL window).
const facilitator = new PumpAgentFacilitator({ connection });

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Build fresh requirements for each request so invoice memos are always unique. */
function priceRequirements(amount: string) {
  return [
    buildPumpAgentRequirements({
      agentMint: AGENT_MINT,
      payTo: PAYMENT_VAULT,
      amount,
      invoiceWindowSeconds: 300,
      maxTimeoutSeconds: 60,
    }),
  ];
}

// ─── App ──────────────────────────────────────────────────────────────────────

const app = new Hono();

// ─── Logging Middleware ───────────────────────────────────────────────────────
// Runs after every route. Extracts payer pubkey and tx signature from the
// PAYMENT-RESPONSE header when present so each log line is self-contained.

app.use("*", async (c, next) => {
  await next();

  let payer = "none";
  let sig = "none";

  const rawPaymentResponse = c.res.headers.get(X402_HEADER_PAYMENT_RESPONSE);
  if (rawPaymentResponse) {
    try {
      const pr = decodePaymentResponse(rawPaymentResponse);
      payer = pr.payer ?? "none";
      sig = pr.transaction ?? "none";
    } catch {
      // malformed header — leave defaults
    }
  }

  console.log(
    `[${c.req.method}] ${c.req.path} | status=${c.res.status} | payer=${payer} | sig=${sig}`,
  );
});

// ─── Health Check (no payment required) ──────────────────────────────────────

app.get("/health", async (c) => {
  try {
    const slot = await connection.getSlot();
    return c.json({ status: "ok", agentMint: AGENT_MINT, slot });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ status: "error", error: message }, 503);
  }
});

// ─── GET /api/price — Live SOL/USD price (1 USDC) ────────────────────────────

app.get("/api/price", async (c) => {
  const gate = createResourceServer({
    facilitator,
    requirements: priceRequirements("1000000"),
    resource: { url: "/api/price", description: "Live SOL price in USD" },
  });

  return gate(c.req.raw, async () => {
    const res = await fetch(
      "https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd",
    );
    if (!res.ok) {
      return Response.json(
        { error: "Upstream price feed unavailable" },
        { status: 502 },
      );
    }
    const data = (await res.json()) as { solana: { usd: number } };
    return Response.json({ price: data.solana.usd });
  });
});

// ─── POST /api/analyze — Word & character count (1 USDC) ─────────────────────

app.post("/api/analyze", async (c) => {
  const gate = createResourceServer({
    facilitator,
    requirements: priceRequirements("1000000"),
    resource: {
      url: "/api/analyze",
      description: "Word and character count for submitted text",
    },
  });

  // Parse the body before passing to the gate so we can return structured
  // validation errors. The raw request is still forwarded untouched.
  let body: { text?: unknown };
  try {
    body = await c.req.json<{ text?: unknown }>();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }

  if (typeof body.text !== "string") {
    return c.json({ error: 'Field "text" must be a string' }, 400);
  }

  const text = body.text;

  return gate(c.req.raw, async () => {
    const words = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
    const chars = text.length;
    return Response.json({ words, chars, text });
  });
});

// ─── GET /api/block — Current Solana slot + block time (0.1 USDC) ────────────

app.get("/api/block", async (c) => {
  const gate = createResourceServer({
    facilitator,
    requirements: priceRequirements("100000"),
    resource: {
      url: "/api/block",
      description: "Current Solana slot and block time from RPC",
    },
  });

  return gate(c.req.raw, async () => {
    const slot = await connection.getSlot();
    const blockTime = await connection.getBlockTime(slot);
    return Response.json({ slot, blockTime });
  });
});

// ─── Global Error Handler ─────────────────────────────────────────────────────
// Catches unhandled throws from route handlers and returns structured JSON.
// Stack traces are never sent to HTTP clients.

app.onError((err, c) => {
  console.error(`[ERROR] ${c.req.method} ${c.req.path} —`, err.message);
  return c.json({ error: "Internal server error" }, 500);
});

// ─── Start ────────────────────────────────────────────────────────────────────

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`\nx402 resource server listening on http://localhost:${info.port}`);
  console.log(`  agentMint:    ${AGENT_MINT}`);
  console.log(`  paymentVault: ${PAYMENT_VAULT}`);
  console.log(`  rpc:          ${SOLANA_RPC_URL}\n`);
  console.log("  Routes:");
  console.log("    GET  /health        — free");
  console.log("    GET  /api/price     — 1 USDC");
  console.log("    POST /api/analyze   — 1 USDC");
  console.log("    GET  /api/block     — 0.1 USDC\n");
});
