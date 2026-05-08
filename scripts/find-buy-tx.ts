/**
 * Pull the most recent N signatures for the pump bonding-curve program,
 * fetch them, and report event distribution. Used to find a TradeEvent
 * with isBuy=true when the live websocket sample doesn't yield one.
 */
import { Connection } from "@solana/web3.js";
import {
  PUMP_BONDING_CURVE_PROGRAM_ID,
  createPumpEventParser,
} from "../src/solana/pump-events.js";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { BN } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";

function bnReplacer(_key: string, value: unknown): unknown {
  if (value instanceof BN) return { __bn: value.toString() };
  if (value instanceof PublicKey) return value.toBase58();
  if (Buffer.isBuffer(value)) return value.toString("base64");
  return value;
}

async function main() {
  const rpc = process.env.SOLANA_RPC_URL ?? "https://api.mainnet-beta.solana.com";
  const conn = new Connection(rpc, "confirmed");
  const parser = createPumpEventParser();

  const sigInfos = await conn.getSignaturesForAddress(
    PUMP_BONDING_CURVE_PROGRAM_ID,
    { limit: 100 },
  );
  console.log(`fetched ${sigInfos.length} sigs`);

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  for (const s of sigInfos) {
    if (s.err) continue;
    await sleep(1200); // stay under public RPC rate limit
    const tx = await conn.getTransaction(s.signature, {
      maxSupportedTransactionVersion: 0,
    });
    if (!tx?.meta?.logMessages) continue;
    const events = parser.parseLogs(tx.meta.logMessages);
    const buy = events.find(
      (e) => e.name === "TradeEvent" && (e.data as { isBuy: boolean }).isBuy,
    );
    if (!buy) continue;
    console.log("found buy:", s.signature, "slot", tx.slot);
    const fixture = {
      signature: s.signature,
      slot: tx.slot,
      logMessages: tx.meta.logMessages,
      expected: {
        name: buy.name,
        data: JSON.parse(JSON.stringify(buy.data, bnReplacer)),
      },
    };
    writeFileSync(
      join(process.cwd(), "src/solana/fixtures/pump-events/trade-buy.json"),
      JSON.stringify(fixture, null, 2),
    );
    console.log("wrote trade-buy.json");
    return;
  }
  console.log("no buy found in 100 most recent sigs");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
