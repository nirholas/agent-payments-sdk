// agent-payments-sdk
// Copyright (c) 2026 nirholas | x.com/nichxbt | github.com/nirholas
// All rights reserved.

/**
 * One-shot script: listen on the pump bonding-curve program for ~120s,
 * collect signatures + logs that decode as `TradeEvent` (buy + sell) and
 * `CreateEvent`, then serialize as test fixtures.
 *
 * We persist the live websocket logs (rather than re-fetching the tx) because
 * public RPC providers sometimes truncate `meta.logMessages` on fetch — the
 * subscription stream is the source of truth.
 *
 * Usage: SOLANA_RPC_URL=<url> npx tsx scripts/capture-pump-fixtures.ts
 */
import { Connection, PublicKey } from "@solana/web3.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BN } from "@coral-xyz/anchor";
import {
  PUMP_BONDING_CURVE_PROGRAM_ID,
  createPumpEventParser,
} from "../src/solana/pump-events.js";

function bnReplacer(_key: string, value: unknown): unknown {
  if (value instanceof BN) return { __bn: value.toString() };
  if (value instanceof PublicKey) return value.toBase58();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  return value;
}

interface Captured {
  signature: string;
  slot: number;
  logMessages: string[];
  expectedKey: string; // CreateEvent | TradeEventBuy | TradeEventSell
}

async function main() {
  const rpc = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpc, "confirmed");
  const parser = createPumpEventParser();

  const captured = new Map<string, Captured>();
  // Allow narrowing to a single target via env, e.g. ONLY=TradeEventBuy
  const only = process.env.ONLY ? process.env.ONLY.split(",") : null;
  const targets = (only ?? ["TradeEventBuy", "TradeEventSell", "CreateEvent"]);
  const timeoutMs = Number(process.env.TIMEOUT_MS ?? 120_000);

  console.log(
    `Listening on ${PUMP_BONDING_CURVE_PROGRAM_ID.toBase58()} for ~${timeoutMs / 1000}s, targets=${targets.join(",")}`,
  );

  const subId = conn.onLogs(
    PUMP_BONDING_CURVE_PROGRAM_ID,
    (info, ctx) => {
      if (info.err) return;
      const events = parser.parseLogs(info.logs);
      for (const ev of events) {
        let key: string | null = null;
        if (ev.name === "CreateEvent") key = "CreateEvent";
        else if (ev.name === "TradeEvent") {
          const isBuy = (ev.data as { is_buy: boolean }).is_buy;
          key = isBuy ? "TradeEventBuy" : "TradeEventSell";
        }
        if (!key || captured.has(key)) continue;
        if (!targets.includes(key)) continue;
        captured.set(key, {
          signature: info.signature,
          slot: ctx.slot,
          logMessages: info.logs,
          expectedKey: key,
        });
        console.log(`captured ${key}: ${info.signature}`);
      }
    },
    "confirmed",
  );

  const start = Date.now();
  while (Date.now() - start < timeoutMs && captured.size < targets.length) {
    await new Promise((r) => setTimeout(r, 1000));
  }
  await conn.removeOnLogsListener(subId);
  console.log("captured", captured.size, "of", targets.length);

  for (const [key, c] of captured) {
    const events = parser.parseLogs(c.logMessages);
    const expected = events.find((e) => {
      if (key === "CreateEvent") return e.name === "CreateEvent";
      if (key === "TradeEventBuy")
        return e.name === "TradeEvent" && (e.data as { is_buy: boolean }).is_buy;
      return e.name === "TradeEvent" && !(e.data as { is_buy: boolean }).is_buy;
    });
    if (!expected) {
      console.warn("could not re-find expected event for", key);
      continue;
    }
    const fname =
      key === "CreateEvent"
        ? "create"
        : key === "TradeEventBuy"
          ? "trade-buy"
          : "trade-sell";
    const fixture = {
      signature: c.signature,
      slot: c.slot,
      logMessages: c.logMessages,
      expected: {
        name: expected.name,
        data: JSON.parse(JSON.stringify(expected.data, bnReplacer)),
      },
    };
    const outPath = join(
      process.cwd(),
      "src/solana/fixtures/pump-events",
      `${fname}.json`,
    );
    writeFileSync(outPath, JSON.stringify(fixture, null, 2));
    console.log("wrote", outPath);
  }
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
