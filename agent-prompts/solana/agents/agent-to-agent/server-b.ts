// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
//
// Agent B — x402 Resource Server
//
// Exposes two USDC-gated compute endpoints on Solana mainnet:
//   POST /compute/sha256    — 0.1 USDC — SHA-256 hash of input string
//   POST /compute/wordcount — 0.05 USDC — word and character count
//
// A free /.well-known/agent-payments endpoint lets Agent A (or any other
// agent) discover what's for sale and at what price before committing.
//
// After settlement each response carries an X-SERVICE-PROOF header
// (base64 JSON) so the caller can cryptographically verify delivery.
//
// IMPORTANT — gate design:
// Each endpoint's gate is created ONCE at startup, giving every invoice
// a stable memo. This is required because PumpAgentFacilitator validates
// payments using the exact same (memo, startTime, endTime) triple that
// was returned in the 402 response. If the gate were recreated per-request
// the fresh memo would not match the payment the client already submitted.
// Replay attacks are prevented by the in-memory SettlementCache (TTL 120 s)
// and by Solana's global transaction-signature uniqueness guarantee.
//
// Required env vars:
//   SOLANA_RPC_URL         — Mainnet RPC endpoint
//   AGENT_B_MINT           — Base58 pump token mint (agent-payments initialized)
//   AGENT_B_PAYMENT_VAULT  — Base58 address to receive USDC (payment vault PDA)
//   AGENT_B_PORT           — HTTP port (default: 3001)

import { createHash } from "node:crypto";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { Connection } from "@solana/web3.js";
import { x402 } from "@nirholas/agent-payments-sdk/solana";
import type { AgentCapabilityManifest, ServiceProof } from "./types.js";

const {
  PumpAgentFacilitator,
  buildPumpAgentRequirements,
  createResourceServer,
  decodePaymentPayload,
  decodePaymentResponse,
  X402_HEADER_PAYMENT_SIGNATURE,
  X402_HEADER_PAYMENT_RESPONSE,
  SOLANA_MAINNET,
  USDC_MAINNET,
} = x402;

// ─── Config ──────────────────────────────────────────────────────────────────

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Fatal: "${name}" is required but not set.`);
    process.exit(1);
  }
  return value;
}

const SOLANA_RPC_URL = requireEnv("SOLANA_RPC_URL");
const AGENT_B_MINT = requireEnv("AGENT_B_MINT");
const AGENT_B_PAYMENT_VAULT = requireEnv("AGENT_B_PAYMENT_VAULT");
const PORT = parseInt(process.env.AGENT_B_PORT ?? "3001", 10);

// Prices in USDC minor units (6 decimals)
const PRICE_SHA256 = "100000";     // 0.1 USDC
const PRICE_WORDCOUNT = "50000";   // 0.05 USDC

// ─── Solana + Facilitator ─────────────────────────────────────────────────────

const connection = new Connection(SOLANA_RPC_URL, { commitment: "confirmed" });
const facilitator = new PumpAgentFacilitator({ connection });

// ─── Static gates (created once at startup) ───────────────────────────────────
//
// buildPumpAgentRequirements generates a fresh invoice memo each time it is
// called. By calling it here (once) we freeze the memo and window so that
// the requirements returned in the 402 response are identical to those used
// inside verify() when the client retries with PAYMENT-SIGNATURE.
//
// The 24-hour window (86_400 s) keeps the gate valid for the server's
// practical lifetime. For multi-day or production deployments, rotate gates
// by restarting the process or by refreshing them before endTime expires.

const SHA256_GATE = createResourceServer({
  facilitator,
  requirements: [
    buildPumpAgentRequirements({
      agentMint: AGENT_B_MINT,
      payTo: AGENT_B_PAYMENT_VAULT,
      amount: PRICE_SHA256,
      invoiceWindowSeconds: 86_400,
      maxTimeoutSeconds: 60,
    }),
  ],
  resource: { url: "/compute/sha256", description: "SHA-256 hash of input string" },
});

const WORDCOUNT_GATE = createResourceServer({
  facilitator,
  requirements: [
    buildPumpAgentRequirements({
      agentMint: AGENT_B_MINT,
      payTo: AGENT_B_PAYMENT_VAULT,
      amount: PRICE_WORDCOUNT,
      invoiceWindowSeconds: 86_400,
      maxTimeoutSeconds: 60,
    }),
  ],
  resource: { url: "/compute/wordcount", description: "Word and character count" },
});

// ─── Capability manifest (built once so prices and paths are canonical) ───────

const MANIFEST: AgentCapabilityManifest = {
  agentMint: AGENT_B_MINT,
  name: "Agent B Compute Service",
  capabilities: [
    {
      path: "/compute/sha256",
      description: "Compute SHA-256 hash of input",
      priceUsdc: "0.1",
      priceMinorUnits: PRICE_SHA256,
    },
    {
      path: "/compute/wordcount",
      description: "Count words in text",
      priceUsdc: "0.05",
      priceMinorUnits: PRICE_WORDCOUNT,
    },
  ],
  network: SOLANA_MAINNET,
  asset: USDC_MAINNET,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract the invoice memo from the incoming PAYMENT-SIGNATURE header.
 * Returns null if the header is absent, malformed, or not pump-agent scheme.
 */
function extractMemo(request: Request): string | null {
  const header = request.headers.get(X402_HEADER_PAYMENT_SIGNATURE);
  if (!header) return null;
  try {
    const payload = decodePaymentPayload(header);
    if (payload.accepted.scheme !== "pump-agent") return null;
    const extra = (payload.accepted as { extra?: { memo?: string } }).extra;
    return extra?.memo ?? null;
  } catch {
    return null;
  }
}

/**
 * Append X-SERVICE-PROOF to a successful gate response.
 * The header is a base64-encoded ServiceProof JSON object.
 * Returns the original response unchanged for non-200 statuses.
 */
function attachServiceProof(response: Response, invoiceMemo: string | null): Response {
  if (response.status !== 200 || !invoiceMemo) return response;

  let paymentSignature = "";
  const prHeader = response.headers.get(X402_HEADER_PAYMENT_RESPONSE);
  if (prHeader) {
    try {
      const pr = decodePaymentResponse(prHeader);
      paymentSignature = pr.transaction ?? "";
    } catch {
      // Leave empty — proof is still useful without the tx sig
    }
  }

  const proof: ServiceProof = {
    agentMint: AGENT_B_MINT,
    invoiceMemo,
    servedAt: new Date().toISOString(),
    paymentSignature,
  };

  const out = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: new Headers(response.headers),
  });
  out.headers.set(
    "X-SERVICE-PROOF",
    Buffer.from(JSON.stringify(proof)).toString("base64"),
  );
  return out;
}

// ─── App ──────────────────────────────────────────────────────────────────────

const app = new Hono();

// ─── Logging middleware ───────────────────────────────────────────────────────

app.use("*", async (c, next) => {
  await next();

  let payer = "none";
  let sig = "none";
  const prHeader = c.res.headers.get(X402_HEADER_PAYMENT_RESPONSE);
  if (prHeader) {
    try {
      const pr = decodePaymentResponse(prHeader);
      payer = pr.payer ?? "none";
      sig = pr.transaction ?? "none";
    } catch { }
  }

  console.log(
    `[${c.req.method}] ${c.req.path} | status=${c.res.status} | payer=${payer} | sig=${sig.slice(0, 16)}...`,
  );
});

// ─── /.well-known/agent-payments — free capability discovery ─────────────────

app.get("/.well-known/agent-payments", (c) => c.json(MANIFEST));

// ─── GET /health ──────────────────────────────────────────────────────────────

app.get("/health", async (c) => {
  try {
    const slot = await connection.getSlot();
    return c.json({ status: "ok", agentMint: AGENT_B_MINT, slot });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ status: "error", error: message }, 503);
  }
});

// ─── POST /compute/sha256 — 0.1 USDC ─────────────────────────────────────────

app.post("/compute/sha256", async (c) => {
  let body: { input?: unknown };
  try {
    body = await c.req.json<{ input?: unknown }>();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  if (typeof body.input !== "string") {
    return c.json({ error: '"input" must be a string' }, 400);
  }
  const input = body.input;

  const invoiceMemo = extractMemo(c.req.raw);

  const gateResponse = await SHA256_GATE(c.req.raw, async () => {
    const hash = createHash("sha256").update(input).digest("hex");
    return Response.json({ hash });
  });

  return attachServiceProof(gateResponse, invoiceMemo);
});

// ─── POST /compute/wordcount — 0.05 USDC ─────────────────────────────────────

app.post("/compute/wordcount", async (c) => {
  let body: { text?: unknown };
  try {
    body = await c.req.json<{ text?: unknown }>();
  } catch {
    return c.json({ error: "Request body must be valid JSON" }, 400);
  }
  if (typeof body.text !== "string") {
    return c.json({ error: '"text" must be a string' }, 400);
  }
  const text = body.text;

  const invoiceMemo = extractMemo(c.req.raw);

  const gateResponse = await WORDCOUNT_GATE(c.req.raw, async () => {
    const words = text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
    const chars = text.length;
    return Response.json({ words, chars });
  });

  return attachServiceProof(gateResponse, invoiceMemo);
});

// ─── Global error handler ─────────────────────────────────────────────────────

app.onError((err, c) => {
  console.error(`[ERROR] ${c.req.method} ${c.req.path} —`, err.message);
  return c.json({ error: "Internal server error" }, 500);
});

// ─── Start ────────────────────────────────────────────────────────────────────

serve({ fetch: app.fetch, port: PORT }, (info) => {
  console.log(`\nAgent B — x402 Compute Server`);
  console.log(`  listening:    http://localhost:${info.port}`);
  console.log(`  agentMint:    ${AGENT_B_MINT}`);
  console.log(`  paymentVault: ${AGENT_B_PAYMENT_VAULT}`);
  console.log(`  rpc:          ${SOLANA_RPC_URL}`);
  console.log(`\n  Routes:`);
  console.log(`    GET  /.well-known/agent-payments  — free`);
  console.log(`    GET  /health                      — free`);
  console.log(`    POST /compute/sha256              — 0.1 USDC`);
  console.log(`    POST /compute/wordcount           — 0.05 USDC\n`);
});
