// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
//
// Agent A — x402 Client & Orchestrator
//
// Discovers Agent B's capabilities via its /.well-known/agent-payments endpoint,
// autonomously pays for services in USDC using the pump-agent x402 scheme, and
// validates the cryptographic service proof returned in X-SERVICE-PROOF.
//
// Usage:
//   node client-a.js discover                  Show Agent B's capabilities
//   node client-a.js sha256 <input>            Pay and compute SHA-256
//   node client-a.js wordcount <text>          Pay and count words
//   node client-a.js benchmark <N>             Call each endpoint N times
//
// Required env vars:
//   SOLANA_RPC_URL        — Mainnet RPC endpoint
//   AGENT_A_PRIVATE_KEY   — Agent A's Solana keypair (base58 or JSON array)
//   AGENT_B_MINT          — Agent B's pump token mint (for proof validation)
//   AGENT_B_BASE_URL      — Agent B's base URL (default: http://localhost:3001)

import { Connection, Keypair, Transaction } from "@solana/web3.js";
import bs58 from "bs58";
import { x402 } from "@nirholas/agent-payments-sdk/solana";
import type {
  AgentCapabilityManifest,
  CallResult,
  ProofValidation,
  ServiceProof,
} from "./types.js";

const {
  createX402Fetch,
  getPaymentRequiredFromResponse,
  SOLANA_MAINNET,
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

const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
const AGENT_B_MINT = requireEnv("AGENT_B_MINT");
const AGENT_B_BASE_URL = process.env.AGENT_B_BASE_URL ?? "http://localhost:3001";

// ─── Wallet ───────────────────────────────────────────────────────────────────

function loadKeypair(raw: string): Keypair {
  const value = raw.trim();
  if (value.startsWith("[")) {
    let arr: number[];
    try {
      arr = JSON.parse(value) as number[];
    } catch {
      throw new Error("AGENT_A_PRIVATE_KEY: JSON array is malformed");
    }
    return Keypair.fromSecretKey(Uint8Array.from(arr));
  }
  try {
    return Keypair.fromSecretKey(bs58.decode(value));
  } catch {
    throw new Error(
      "AGENT_A_PRIVATE_KEY is malformed: expected a base58 keypair or JSON number array",
    );
  }
}

const keypair = loadKeypair(requireEnv("AGENT_A_PRIVATE_KEY"));
const connection = new Connection(SOLANA_RPC_URL, { commitment: "confirmed" });

console.log(`[agent-a] payer: ${keypair.publicKey.toBase58()}`);
console.log(`[agent-a] rpc:   ${SOLANA_RPC_URL}`);
console.log(`[agent-a] agentB: ${AGENT_B_BASE_URL}\n`);

// ─── x402 fetch (handles 402 → pay → retry automatically) ────────────────────

const x402fetch = createX402Fetch({
  payer: keypair.publicKey.toBase58(),
  connection,
  signTransaction: async (txBase64: string): Promise<string> => {
    const tx = Transaction.from(Buffer.from(txBase64, "base64"));
    tx.partialSign(keypair);
    return Buffer.from(tx.serialize({ requireAllSignatures: false })).toString("base64");
  },
  sendTransaction: async (signedTxBase64: string): Promise<string> => {
    const raw = Buffer.from(signedTxBase64, "base64");
    const sig = await connection.sendRawTransaction(raw, {
      skipPreflight: false,
      preflightCommitment: "confirmed",
    });
    console.log(`[pay] sent tx=${sig}`);
    await connection.confirmTransaction(sig, "confirmed");
    console.log(`[pay] confirmed`);
    return sig;
  },
  confirmationTimeoutMs: 60_000,
});

// ─── Part 2.1 — Capability discovery ─────────────────────────────────────────

export async function discoverCapabilities(
  baseUrl: string = AGENT_B_BASE_URL,
): Promise<AgentCapabilityManifest> {
  const response = await fetch(`${baseUrl}/.well-known/agent-payments`);
  if (!response.ok) {
    throw new Error(`Discovery failed: ${response.status} ${response.statusText}`);
  }
  const manifest = (await response.json()) as AgentCapabilityManifest;

  console.log(`[discover] agentMint=${manifest.agentMint}`);
  console.log(`[discover] network=${manifest.network}`);
  for (const cap of manifest.capabilities) {
    console.log(`[discover] path=${cap.path} price=${cap.priceUsdc} USDC — ${cap.description}`);
  }

  return manifest;
}

// ─── Part 2.2 — Autonomous payment & call ────────────────────────────────────
//
// Strategy: probe the endpoint ONCE to capture the invoice memo from the 402
// requirements, then delegate the actual payment to createX402Fetch. Because
// Agent B's gates are static (fixed memo per endpoint), both probes see the
// same memo and x402Fetch pays the correct invoice. This lets us validate that
// Agent B's service proof references the exact memo we paid for.

export async function callAgentB<T = unknown>(
  path: string,
  body: unknown,
  baseUrl: string = AGENT_B_BASE_URL,
): Promise<CallResult<T>> {
  const url = `${baseUrl}${path}`;
  const init: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };

  // Pre-probe: capture payment requirements so we know the invoice memo.
  // The gate is static, so this memo is identical to the one x402Fetch will use.
  let invoiceMemo = "";
  const probe = await fetch(url, init);
  if (probe.status === 402) {
    const pr = getPaymentRequiredFromResponse(probe);
    const accepted = pr?.accepts.find(
      (r) => r.scheme === "pump-agent" && r.network === SOLANA_MAINNET,
    );
    if (accepted) {
      const extra = (accepted as { extra?: { memo?: string } }).extra;
      invoiceMemo = extra?.memo ?? "";
      console.log(
        `[pay] path=${path} memo=${invoiceMemo} amount=${accepted.amount} asset=${accepted.asset}`,
      );
    }
  } else {
    throw new Error(`Expected 402 from ${url}, got ${probe.status}`);
  }

  // x402Fetch: probes again (same memo), builds payment tx, retries with proof
  const response = await x402fetch(url, init);

  if (!response.ok) {
    const errBody = await response.text();
    throw new Error(
      `Request failed after payment: ${response.status} — ${errBody}`,
    );
  }

  // Decode result
  const result = (await response.json()) as T;

  // Decode X-SERVICE-PROOF
  const proofHeader = response.headers.get("X-SERVICE-PROOF");
  if (!proofHeader) {
    throw new Error("Missing X-SERVICE-PROOF header — server did not attach a service proof");
  }
  const serviceProof = parseServiceProof(proofHeader);

  return { result, serviceProof, invoiceMemo };
}

// ─── Part 2.3 — Service proof validation ─────────────────────────────────────

function parseServiceProof(headerValue: string): ServiceProof {
  try {
    return JSON.parse(Buffer.from(headerValue, "base64").toString("utf8")) as ServiceProof;
  } catch {
    throw new Error("X-SERVICE-PROOF header is not valid base64 JSON");
  }
}

export function validateServiceProof(
  proof: ServiceProof,
  expectedMemo: string,
): ProofValidation {
  if (proof.invoiceMemo !== expectedMemo) {
    return {
      valid: false,
      reason: `invoiceMemo mismatch — expected "${expectedMemo}", got "${proof.invoiceMemo}"`,
    };
  }
  if (proof.agentMint !== AGENT_B_MINT) {
    return {
      valid: false,
      reason: `agentMint mismatch — expected "${AGENT_B_MINT}", got "${proof.agentMint}"`,
    };
  }
  if (!proof.paymentSignature) {
    return { valid: false, reason: "paymentSignature is empty" };
  }
  if (!proof.servedAt) {
    return { valid: false, reason: "servedAt is missing" };
  }
  return { valid: true };
}

// ─── Part 2.4 — CLI orchestration ────────────────────────────────────────────

function printProof(proof: ServiceProof, validation: ProofValidation): void {
  console.log(`\n[proof] agentMint:         ${proof.agentMint}`);
  console.log(`[proof] invoiceMemo:        ${proof.invoiceMemo}`);
  console.log(`[proof] paymentSignature:   ${proof.paymentSignature}`);
  console.log(`[proof] servedAt:           ${proof.servedAt}`);
  console.log(`[proof] valid:              ${validation.valid}${validation.reason ? ` (${validation.reason})` : ""}`);
}

async function cmdDiscover(): Promise<void> {
  await discoverCapabilities();
}

async function cmdSha256(input: string): Promise<void> {
  console.log(`[sha256] input="${input}"`);
  const { result, serviceProof, invoiceMemo } = await callAgentB<{ hash: string }>(
    "/compute/sha256",
    { input },
  );
  console.log(`\n[sha256] result: ${result.hash}`);
  const validation = validateServiceProof(serviceProof, invoiceMemo);
  printProof(serviceProof, validation);
  if (!validation.valid) process.exit(1);
}

async function cmdWordcount(text: string): Promise<void> {
  console.log(`[wordcount] text="${text.slice(0, 60)}${text.length > 60 ? "…" : ""}"`);
  const { result, serviceProof, invoiceMemo } = await callAgentB<{
    words: number;
    chars: number;
  }>("/compute/wordcount", { text });
  console.log(`\n[wordcount] words=${result.words} chars=${result.chars}`);
  const validation = validateServiceProof(serviceProof, invoiceMemo);
  printProof(serviceProof, validation);
  if (!validation.valid) process.exit(1);
}

async function cmdBenchmark(n: number): Promise<void> {
  console.log(`[benchmark] discovering Agent B capabilities…`);
  const manifest = await discoverCapabilities();

  if (manifest.capabilities.length === 0) {
    console.error("[benchmark] Agent B has no capabilities");
    process.exit(1);
  }

  // Build test payloads for each capability
  const tests = manifest.capabilities.map((cap) => ({
    cap,
    body:
      cap.path === "/compute/sha256"
        ? { input: "benchmark_test_input_" + Date.now() }
        : { text: "the quick brown fox jumps over the lazy dog" },
  }));

  let totalUsdcSpent = 0;
  let totalCalls = 0;
  let failures = 0;

  console.log(`\n[benchmark] running ${n} round(s) × ${tests.length} endpoint(s)\n`);

  for (let round = 1; round <= n; round++) {
    for (const { cap, body } of tests) {
      const label = `round=${round}/${n} path=${cap.path}`;
      console.log(`[benchmark] ${label} — calling…`);
      const t0 = Date.now();

      try {
        const { result, serviceProof, invoiceMemo } = await callAgentB(cap.path, body);
        const elapsed = Date.now() - t0;
        const validation = validateServiceProof(serviceProof, invoiceMemo);
        const spent = parseFloat(cap.priceUsdc);

        totalUsdcSpent += spent;
        totalCalls++;

        console.log(
          `[benchmark] ${label} | time=${elapsed}ms | result=${JSON.stringify(result)} | proof=${validation.valid ? "✓" : "✗"}`,
        );

        if (!validation.valid) {
          console.error(`[benchmark] proof invalid: ${validation.reason}`);
          failures++;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[benchmark] ${label} FAILED: ${message}`);
        failures++;
      }
    }
  }

  console.log(`\n── Benchmark Summary ─────────────────────────────────────────`);
  console.log(`   Total calls:       ${totalCalls}`);
  console.log(`   Failures:          ${failures}`);
  console.log(`   Total USDC spent:  ${totalUsdcSpent.toFixed(6)} USDC`);
  console.log(`─────────────────────────────────────────────────────────────\n`);

  if (failures > 0) process.exit(1);
}

// ─── Entry point ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [, , command, ...args] = process.argv;

  switch (command) {
    case "discover":
      await cmdDiscover();
      break;

    case "sha256": {
      const input = args.join(" ");
      if (!input) {
        console.error("Usage: node client-a.js sha256 <input>");
        process.exit(1);
      }
      await cmdSha256(input);
      break;
    }

    case "wordcount": {
      const text = args.join(" ");
      if (!text) {
        console.error("Usage: node client-a.js wordcount <text>");
        process.exit(1);
      }
      await cmdWordcount(text);
      break;
    }

    case "benchmark": {
      const n = parseInt(args[0] ?? "1", 10);
      if (isNaN(n) || n < 1) {
        console.error("Usage: node client-a.js benchmark <N>  (N must be a positive integer)");
        process.exit(1);
      }
      await cmdBenchmark(n);
      break;
    }

    default:
      console.log("Usage:");
      console.log("  node client-a.js discover           Show Agent B capabilities");
      console.log("  node client-a.js sha256 <input>     Pay and compute SHA-256");
      console.log("  node client-a.js wordcount <text>   Pay and count words");
      console.log("  node client-a.js benchmark <N>      Benchmark N rounds");
      process.exit(1);
  }
}

main().catch((err: unknown) => {
  if (err instanceof Error) {
    console.error(err.message);
    if (err.stack) console.error(err.stack);
  } else {
    console.error(String(err));
  }
  process.exit(1);
});
